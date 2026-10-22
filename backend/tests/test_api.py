import io
import time

import cv2
import numpy as np
import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SENTINEL_GEOCODER", "off")
    from app import config, db, potholes

    monkeypatch.setattr(config, "MEDIA_DIR", tmp_path / "media")
    monkeypatch.setattr(potholes, "MEDIA_DIR", tmp_path / "media")
    (tmp_path / "media").mkdir()
    db.reset_for_tests(tmp_path / "test.db")

    # Deterministic detector so tests do not depend on model files.
    def fake_detect(bgr):
        if bgr.mean() > 250:  # pure white image = empty road
            return []
        h, w = bgr.shape[:2]
        return [{"bbox": {"x": w // 3, "y": int(h * 0.7), "w": w // 4, "h": h // 8}, "confidence": 0.82,
                 "detection_source": "yolo"}]

    monkeypatch.setattr(potholes.detector, "detect", fake_detect)
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def _jpeg(color=(90, 90, 90), sky=True):
    img = np.full((480, 640, 3), color, np.uint8)
    if sky:
        img[:160] = (235, 206, 135)
    ok, buf = cv2.imencode(".jpg", img)
    return io.BytesIO(buf.tobytes())


def _upload(c, lat=13.0105, lng=80.2354, img=None):
    data = {} if lat is None else {"lat": str(lat), "lng": str(lng), "accuracy_m": "5"}
    return c.post("/api/potholes/upload", files={"file": ("road.jpg", img or _jpeg(), "image/jpeg")}, data=data)


def test_health(client):
    r = client.get("/api/health").json()
    assert r["ok"] and r["detector"]["tier"] in ("yolo-onnx", "yolo", "classical")


def test_upload_creates_site_with_inr_estimate(client):
    r = _upload(client)
    assert r.status_code == 200
    site = r.json()["site"]
    assert site["id"].startswith("PH-")
    assert site["count"] == 1 and site["status"] == "reported"
    est = site["estimate"]
    assert est["currency"] == "INR"
    assert est["total"] == pytest.approx(est["subtotal"] * 1.18, abs=0.02)
    d = site["defects"][0]
    assert 0.02 <= d["depth_m"] <= 0.12 and 0 < d["area_m2"] < 5
    assert site["evidence"][0]["annotated"].startswith("/media/")


def test_empty_road_creates_nothing(client):
    r = _upload(client, img=_jpeg((255, 255, 255), sky=False))
    assert r.json()["site"] is None
    assert client.get("/api/potholes").json() == []


def test_nearby_report_merges(client):
    first = _upload(client).json()["site"]
    second = _upload(client, lat=13.01053, lng=80.23542).json()  # ~4 m away
    assert second["action"] == "merged"
    assert second["site"]["id"] == first["id"]
    assert second["site"]["reports"] == 2
    far = _upload(client, lat=13.02, lng=80.24).json()
    assert far["action"] == "created"
    assert len(client.get("/api/potholes").json()) == 2


def test_no_gps_then_set_on_map(client):
    site = _upload(client, lat=None).json()["site"]
    assert site["lat"] is None and site["gps_source"] == "none"
    r = client.patch(f"/api/potholes/{site['id']}", json={"lat": 12.97, "lng": 77.59})
    assert r.json()["gps_source"] == "set-on-map"


def test_status_workflow(client):
    sid = _upload(client).json()["site"]["id"]
    assert client.patch(f"/api/potholes/{sid}", json={"status": "fixed"}).status_code == 400
    for s in ("verified", "scheduled", "repaired"):
        assert client.patch(f"/api/potholes/{sid}", json={"status": s}).json()["status"] == s
    rec = client.get(f"/api/potholes/{sid}").json()
    assert [h["status"] for h in rec["history"]] == ["reported", "verified", "scheduled", "repaired"]
    stats = client.get("/api/stats").json()
    assert stats["potholes"]["open"] == 0 and stats["potholes"]["by_status"]["repaired"] == 1


def test_work_order_pdf_and_csv(client):
    sid = _upload(client).json()["site"]["id"]
    r = client.get(f"/api/potholes/{sid}/work-order.pdf")
    assert r.status_code == 200 and r.content[:5] == b"%PDF-"
    csv = client.get("/api/potholes/export.csv").text
    assert sid in csv and "INR" in csv
    assert client.get("/api/potholes/PH-NOPE/work-order.pdf").status_code == 404


def test_rate_card_update_and_recalculate(client):
    sid = _upload(client).json()["site"]["id"]
    before = client.get(f"/api/potholes/{sid}").json()["estimate"]["total"]
    client.put("/api/settings/rate-card", json={"labour_per_patch": 5000, "gst_pct": 0})
    client.post("/api/potholes/recalculate")
    after = client.get(f"/api/potholes/{sid}").json()["estimate"]
    assert after["gst"] == 0 and after["total"] != before
    assert client.put("/api/settings/rate-card", json={"gst_pct": -1}).status_code == 400


def test_b2g_requires_key(client):
    _upload(client)
    assert client.get("/api/b2g/work-orders").status_code == 401
    rows = client.get("/api/b2g/work-orders", headers={"X-API-Key": "change-me"}).json()
    assert len(rows) == 1 and rows[0]["work_order_pdf"].endswith(".pdf")


def test_delete(client):
    sid = _upload(client).json()["site"]["id"]
    assert client.delete(f"/api/potholes/{sid}").status_code == 200
    assert client.get(f"/api/potholes/{sid}").status_code == 404


def test_multi_frame_upload_picks_a_frame(client):
    r = client.post(
        "/api/potholes/upload",
        files=[("file", ("f0.jpg", _jpeg((255, 255, 255), sky=False), "image/jpeg")),
               ("frames", ("f1.jpg", _jpeg(), "image/jpeg")),
               ("frames", ("f2.jpg", _jpeg((255, 255, 255), sky=False), "image/jpeg"))],
        data={"lat": "13.05", "lng": "80.25"},
    )
    j = r.json()
    assert j["frames_checked"] == 3 and j["detections"] == 1
