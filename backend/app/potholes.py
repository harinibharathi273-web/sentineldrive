"""Road defect reports: upload -> detect -> measure -> locate -> estimate ->
work order.

One upload (photo or short clip) taken at one place becomes one *site*. A site
holds every pothole visible in that capture. A later upload within a few metres
of an open site is added to it as another report instead of creating a
duplicate.
"""

import asyncio
import csv
import io
import json
import time
import uuid
from typing import List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from . import db, geocode, rates
from .config import API_KEY, DEDUP_RADIUS_M, MEDIA_DIR
from .gps import gps_from_exif
from .hub import hub
from .reports import work_order_pdf
from .vision.depth import DepthEngine
from .vision.detector import PotholeDetector
from .vision.geometry import compute_measurements, horizon_row

router = APIRouter(tags=["potholes"])

VIDEO_EXTS = {"mp4", "mov", "avi", "mkv", "webm", "m4v", "3gp"}
STATUSES = ["reported", "verified", "scheduled", "repaired", "rejected"]
OPEN_STATUSES = ["reported", "verified", "scheduled"]
MAX_UPLOAD_BYTES = 80 * 1024 * 1024

detector = PotholeDetector()
depth_engine = DepthEngine()


def _ts():
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Image processing (runs in a worker thread)
# ---------------------------------------------------------------------------

AMBER = (0, 170, 245)  # BGR


def _annotate(bgr, defects):
    out = bgr.copy()
    h = out.shape[0]
    thick = max(2, h // 300)
    font_scale = max(0.5, h / 1100)
    for i, d in enumerate(defects, 1):
        b = d["bbox"]
        x, y, w, hh = b["x"], b["y"], b["w"], b["h"]
        cv2.rectangle(out, (x, y), (x + w, y + hh), AMBER, thick, cv2.LINE_AA)
        label = f"{i}  {int(round(d['confidence'] * 100))}%"
        (tw, th), base = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thick)
        ty = max(th + 8, y)
        cv2.rectangle(out, (x, ty - th - 8), (x + tw + 10, ty), AMBER, -1)
        cv2.putText(out, label, (x + 5, ty - 5), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (20, 20, 20), thick, cv2.LINE_AA)
    return out


def _measure(bgr, dets):
    depth_map = depth_engine.estimate(bgr) if depth_engine.tier != "camera-model" else None
    horizon = horizon_row(bgr)
    defects = []
    for d in dets:
        m = compute_measurements(bgr, d["bbox"], depth_map, horizon)
        defects.append(
            {
                "bbox": m["bbox"],
                "confidence": d["confidence"],
                "area_m2": m["area"],
                "depth_m": m["depth"],
                "volume_m3": m["volume"],
                "distance_m": m["distance_m"],
                "scale_reference": m["accuracy"]["reference"],
                "depth_signal": m["accuracy"]["depth_signal"],
            }
        )
    return defects


def _decode_image(data):
    bgr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("This file could not be read as an image. Use JPG, PNG or WebP.")
    return bgr


def _video_frames(data, suffix):
    import os
    import tempfile

    with tempfile.NamedTemporaryFile(suffix="." + suffix, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    frames = []
    try:
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        step = max(1, int(round(fps * 1.0)))
        idx = 0
        while len(frames) < 20:
            if total:
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                break
            frames.append((idx, frame))
            idx += step
            if not total:
                for _ in range(step - 1):
                    if not cap.grab():
                        break
        cap.release()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if not frames:
        raise ValueError("This video could not be decoded. Try MP4 (H.264) or upload a photo.")
    return frames


def analyse_capture(data, ext, extra_frames=()):
    """Return (best_frame_bgr, detections, frames_checked).

    `extra_frames` are additional stills from the same capture (the browser
    sends a redacted clip as a handful of frames)."""
    if ext in VIDEO_EXTS or extra_frames:
        if ext in VIDEO_EXTS:
            frames = _video_frames(data, ext)
        else:
            frames = [(i, _decode_image(b)) for i, b in enumerate([data, *extra_frames])]
        best = None
        for _, frame in frames:
            dets = detector.detect(frame)
            key = (len(dets), sum(d["confidence"] for d in dets))
            if best is None or key > best[0]:
                best = (key, frame, dets)
        return best[1], best[2], len(frames)
    bgr = _decode_image(data)
    return bgr, detector.detect(bgr), 1


# ---------------------------------------------------------------------------
# Record helpers
# ---------------------------------------------------------------------------


def _summarise(defects):
    area = sum(d["area_m2"] for d in defects)
    volume = sum(d["volume_m3"] for d in defects)
    depth = max((d["depth_m"] for d in defects), default=0.0)
    severity = max(
        (rates.grade_severity(d["area_m2"], d["depth_m"]) for d in defects),
        key=lambda s: rates.SEVERITY_WEIGHT[s],
        default="low",
    )
    return {
        "count": len(defects),
        "area_m2": round(area, 4),
        "volume_m3": round(volume, 5),
        "depth_max_m": round(depth, 4),
        "severity": severity,
        "confidence": max((d["confidence"] for d in defects), default=0.0),
    }


def _estimate(defects):
    """Sum per-pothole bills of quantities into one site estimate."""
    card = rates.get_rate_card()
    per = [rates.estimate_cost(d["area_m2"], d["depth_m"], d["volume_m3"], card) for d in defects]
    if not per:
        return None
    merged = {}
    for est in per:
        for ln in est["lines"]:
            m = merged.setdefault(ln["item"], {**ln, "qty": 0.0, "amount": 0.0})
            m["qty"] = round(m["qty"] + ln["qty"], 4)
            m["amount"] = round(m["amount"] + ln["amount"], 2)
    lines = list(merged.values())
    subtotal = round(sum(ln["amount"] for ln in lines), 2)
    gst = round(subtotal * card["gst_pct"] / 100.0, 2)
    return {
        "currency": card["currency"],
        "lines": lines,
        "subtotal": subtotal,
        "gst_pct": card["gst_pct"],
        "gst": gst,
        "total": round(subtotal + gst, 2),
        "rate_card_note": card["source_note"],
        "computed_at": _ts(),
    }


def _with_priority(rec):
    age_days = (_ts() - rec["created_at"]) / 86_400_000
    rec["priority"] = rates.priority_score(
        rec.get("severity", "low"), rec.get("reports", 1), age_days, rec.get("count", 1), rec.get("area_m2", 0.0)
    )
    return rec


def _save_media(site_id, n, photo_bgr, annotated_bgr):
    folder = MEDIA_DIR / site_id
    folder.mkdir(parents=True, exist_ok=True)
    photo = folder / f"{n}_photo.jpg"
    ann = folder / f"{n}_annotated.jpg"
    # Keep files reasonably small: max 1600 px on the long side.
    def shrink(img):
        h, w = img.shape[:2]
        s = 1600.0 / max(h, w)
        return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img

    cv2.imwrite(str(photo), shrink(photo_bgr), [cv2.IMWRITE_JPEG_QUALITY, 85])
    cv2.imwrite(str(ann), shrink(annotated_bgr), [cv2.IMWRITE_JPEG_QUALITY, 85])
    return f"/media/{site_id}/{photo.name}", f"/media/{site_id}/{ann.name}"


def _geocode_site_async(site_id):
    import threading

    def run():
        rec = db.get("potholes", site_id)
        if not rec or rec.get("lat") is None:
            return
        addr = geocode.reverse(rec["lat"], rec["lng"])
        if not addr:
            return
        rec = db.get("potholes", site_id)  # re-read, it may have changed meanwhile
        if not rec:
            return
        rec["address"] = addr
        rec["jurisdiction"] = geocode.jurisdiction(addr)
        db.put("potholes", rec)
        hub.broadcast_threadsafe({"type": "pothole", "action": "updated", "pothole": _with_priority(rec)})

    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/api/detector")
def detector_info():
    return {**detector.describe(), "depth": depth_engine.tier}


@router.post("/api/potholes/upload")
async def upload(
    file: UploadFile = File(...),
    frames: List[UploadFile] = File(default=[]),
    lat: Optional[float] = Form(None),
    lng: Optional[float] = Form(None),
    accuracy_m: Optional[float] = Form(None),
    gps_source: str = Form("device"),
    redaction: Optional[str] = Form(None),
    note: Optional[str] = Form(None),
):
    data = await file.read()
    if not data:
        raise HTTPException(400, "The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File is larger than 80 MB. Trim the clip or upload a photo.")
    name = (file.filename or "").lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    if not ext and (file.content_type or "").startswith("video/"):
        ext = (file.content_type or "video/webm").split("/")[-1]

    if lat is None or lng is None:
        exif = gps_from_exif(data) if ext not in VIDEO_EXTS else None
        if exif:
            lat, lng, gps_source, accuracy_m = exif["lat"], exif["lng"], "photo-exif", None
        else:
            lat = lng = None
            gps_source = "none"
    if lat is not None and not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(400, "Location is out of range.")

    extra = [await f.read() for f in frames[:24]]
    loop = asyncio.get_running_loop()
    try:
        frame, dets, frames_checked = await loop.run_in_executor(None, analyse_capture, data, ext, extra)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    info = detector.describe()
    result = {
        "detector": info,
        "frames_checked": frames_checked,
        "detections": len(dets),
        "location": {"lat": lat, "lng": lng, "source": gps_source, "accuracy_m": accuracy_m},
    }
    if not dets:
        result["site"] = None
        result["message"] = "No potholes found in this capture."
        return result

    defects = await loop.run_in_executor(None, _measure, frame, dets)
    annotated = _annotate(frame, defects)
    summary = _summarise(defects)
    privacy = None
    if redaction:
        try:
            privacy = json.loads(redaction)
        except ValueError:
            privacy = None

    existing, dist = (None, None)
    if lat is not None:
        existing, dist = db.nearest("potholes", lat, lng, DEDUP_RADIUS_M, exclude_status=("repaired", "rejected"))

    now = _ts()
    if existing:
        rec = existing
        n = len(rec.get("evidence", [])) + 1
        photo_url, ann_url = await loop.run_in_executor(None, _save_media, rec["id"], n, frame, annotated)
        rec["reports"] = rec.get("reports", 1) + 1
        rec["evidence"].append(
            {"ts": now, "photo": photo_url, "annotated": ann_url, "privacy": privacy, "count": len(defects), "note": note}
        )
        # Keep the measurement set from the clearest capture.
        if summary["count"] >= rec["count"] and summary["confidence"] >= rec["confidence"] - 0.05:
            rec["defects"] = defects
            rec.update(summary)
            rec["estimate"] = _estimate(defects)
        rec["history"].append({"ts": now, "status": rec["status"], "note": f"New report added ({dist:.0f} m away)."})
        action = "merged"
    else:
        site_id = "PH-" + uuid.uuid4().hex[:6].upper()
        photo_url, ann_url = await loop.run_in_executor(None, _save_media, site_id, 1, frame, annotated)
        rec = {
            "id": site_id,
            "kind": "pothole",
            "created_at": now,
            "status": "reported",
            "lat": lat,
            "lng": lng,
            "gps_source": gps_source,
            "gps_accuracy_m": accuracy_m,
            "address": None,
            "jurisdiction": None,
            "defects": defects,
            **summary,
            "detector": info,
            "measurement_method": "Monocular estimate from a single camera (no stereo or LiDAR).",
            "estimate": _estimate(defects),
            "reports": 1,
            "evidence": [
                {"ts": now, "photo": photo_url, "annotated": ann_url, "privacy": privacy, "count": len(defects), "note": note}
            ],
            "history": [{"ts": now, "status": "reported", "note": note or "Reported from camera upload."}],
        }
        action = "created"

    db.put("potholes", rec)
    rec = _with_priority(rec)
    await hub.broadcast({"type": "pothole", "action": action, "pothole": rec})
    if rec.get("lat") is not None and not rec.get("address"):
        _geocode_site_async(rec["id"])
    result.update({"site": rec, "action": action, "merged_distance_m": None if dist is None else round(dist, 1)})
    return result


@router.get("/api/potholes")
def list_potholes(status: Optional[str] = None, limit: int = 500):
    st = status.split(",") if status else None
    return [_with_priority(r) for r in db.query("potholes", status=st, limit=limit)]


@router.get("/api/potholes/export.csv")
def export_csv():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        ["id", "reported_at", "status", "severity", "priority", "potholes", "area_m2", "max_depth_mm",
         "volume_m3", "estimate_total", "currency", "lat", "lng", "address", "authority", "ward", "reports"]
    )
    for r in db.query("potholes", limit=10000):
        r = _with_priority(r)
        est = r.get("estimate") or {}
        addr = r.get("address") or {}
        jur = r.get("jurisdiction") or {}
        w.writerow([
            r["id"], time.strftime("%Y-%m-%d %H:%M", time.localtime(r["created_at"] / 1000)), r["status"],
            r["severity"], r["priority"], r["count"], r["area_m2"], round(r["depth_max_m"] * 1000),
            r["volume_m3"], est.get("total"), est.get("currency"), r.get("lat"), r.get("lng"),
            addr.get("label"), jur.get("authority"), jur.get("ward"), r.get("reports", 1),
        ])
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="sentineldrive-potholes.csv"'},
    )


@router.get("/api/potholes/{site_id}")
def get_pothole(site_id: str):
    rec = db.get("potholes", site_id)
    if not rec:
        raise HTTPException(404, "No pothole site with that ID.")
    return _with_priority(rec)


class PotholePatch(BaseModel):
    status: Optional[str] = None
    note: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


@router.patch("/api/potholes/{site_id}")
async def patch_pothole(site_id: str, body: PotholePatch):
    rec = db.get("potholes", site_id)
    if not rec:
        raise HTTPException(404, "No pothole site with that ID.")
    now = _ts()
    relocate = False
    if body.lat is not None and body.lng is not None:
        if not (-90 <= body.lat <= 90 and -180 <= body.lng <= 180):
            raise HTTPException(400, "Location is out of range.")
        rec["lat"], rec["lng"] = body.lat, body.lng
        rec["gps_source"] = "set-on-map"
        rec["address"] = None
        rec["history"].append({"ts": now, "status": rec["status"], "note": "Location set on map."})
        relocate = True
    if body.status:
        if body.status not in STATUSES:
            raise HTTPException(400, f"Status must be one of: {', '.join(STATUSES)}.")
        if body.status != rec["status"]:
            rec["status"] = body.status
            rec["history"].append({"ts": now, "status": body.status, "note": body.note or ""})
            if body.status == "repaired":
                rec["repaired_at"] = now
    elif body.note:
        rec["history"].append({"ts": now, "status": rec["status"], "note": body.note})
    db.put("potholes", rec)
    rec = _with_priority(rec)
    await hub.broadcast({"type": "pothole", "action": "updated", "pothole": rec})
    if relocate:
        _geocode_site_async(rec["id"])
    return rec


@router.delete("/api/potholes/{site_id}")
async def delete_pothole(site_id: str):
    if not db.delete("potholes", site_id):
        raise HTTPException(404, "No pothole site with that ID.")
    import shutil

    shutil.rmtree(MEDIA_DIR / site_id, ignore_errors=True)
    await hub.broadcast({"type": "pothole", "action": "deleted", "id": site_id})
    return {"deleted": site_id}


@router.get("/api/potholes/{site_id}/work-order.pdf")
def work_order(site_id: str):
    rec = db.get("potholes", site_id)
    if not rec:
        raise HTTPException(404, "No pothole site with that ID.")
    pdf = work_order_pdf(_with_priority(rec), rates.get_rate_card())
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="WorkOrder-{site_id}.pdf"'},
    )


@router.post("/api/potholes/recalculate")
async def recalculate():
    """Re-price every open site with the current rate card."""
    n = 0
    for rec in db.query("potholes", status=OPEN_STATUSES, limit=10000):
        rec["estimate"] = _estimate(rec["defects"])
        db.put("potholes", rec)
        n += 1
    await hub.broadcast({"type": "refresh"})
    return {"updated": n}


# -- settings ----------------------------------------------------------------


@router.get("/api/settings/rate-card")
def get_rate_card():
    return {"rate_card": rates.get_rate_card(), "defaults": rates.DEFAULT_RATE_CARD}


@router.put("/api/settings/rate-card")
def put_rate_card(values: dict):
    try:
        return {"rate_card": rates.set_rate_card(values)}
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


# -- municipal integration ----------------------------------------------------


@router.get("/api/b2g/work-orders")
def b2g_work_orders(x_api_key: Optional[str] = Header(None), authority: Optional[str] = None):
    """Open work orders for a civic body's own systems. Requires X-API-Key."""
    if x_api_key != API_KEY:
        raise HTTPException(401, "Missing or invalid X-API-Key header.")
    out = []
    for r in db.query("potholes", status=OPEN_STATUSES, limit=10000):
        jur = r.get("jurisdiction") or {}
        if authority and (jur.get("authority") or "").lower() != authority.lower():
            continue
        r = _with_priority(r)
        out.append({
            "id": r["id"], "status": r["status"], "severity": r["severity"], "priority": r["priority"],
            "lat": r.get("lat"), "lng": r.get("lng"), "address": (r.get("address") or {}).get("label"),
            "authority": jur.get("authority"), "ward": jur.get("ward"), "potholes": r["count"],
            "estimate_total": (r.get("estimate") or {}).get("total"),
            "currency": (r.get("estimate") or {}).get("currency"),
            "reported_at": r["created_at"], "reports": r.get("reports", 1),
            "work_order_pdf": f"/api/potholes/{r['id']}/work-order.pdf",
        })
    out.sort(key=lambda x: x["priority"], reverse=True)
    return out
