"""SentinelDrive API.

Run:  uvicorn app.main:app --reload --port 8000
"""

import asyncio
import json
import logging
import time
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .config import GEOCODER, MEDIA_DIR
from .engine import engine, get_prefs, set_prefs
from .hub import hub
from .potholes import OPEN_STATUSES, detector, router as potholes_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def _tick_loop():
    while True:
        try:
            await hub.broadcast_many(engine.tick())
        except Exception:  # never let the loop die
            logging.getLogger("sentinel").exception("tick failed")
        await asyncio.sleep(0.5)


@asynccontextmanager
async def lifespan(_app):
    hub.attach_loop()
    task = asyncio.create_task(_tick_loop())
    yield
    task.cancel()


app = FastAPI(title="SentinelDrive API", version="2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(potholes_router)
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    await ws.send_json({"type": "hello", **engine.snapshot()})
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict):
                await hub.broadcast_many(engine.ingest(msg))
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "detector": detector.describe(),
        "geocoder": GEOCODER,
        "clients": len(hub.clients),
    }


@app.get("/api/incidents")
def list_incidents(kind: Optional[str] = None, limit: int = 200):
    return db.query("incidents", kind=kind, limit=limit)


@app.get("/api/incidents/{iid}")
def get_incident(iid: str):
    rec = db.get("incidents", iid)
    if not rec:
        raise HTTPException(404, "No incident with that ID.")
    return rec


@app.post("/api/incidents/{iid}/resolve")
async def resolve_incident(iid: str):
    events = engine.ingest({"type": "crash_response", "id": iid, "response": "resolved"})
    if not events:
        raise HTTPException(409, "This incident cannot be resolved from its current state.")
    await hub.broadcast_many(events)
    return events[0]["incident"]


@app.get("/api/alertness-checks")
def list_checks(limit: int = 100):
    return db.query("talkbacks", limit=limit)


@app.get("/api/settings/preferences")
def read_prefs():
    return get_prefs()


@app.put("/api/settings/preferences")
def write_prefs(values: dict):
    return set_prefs(values)


@app.get("/api/stats")
def stats():
    now = int(time.time() * 1000)
    day = 86_400_000
    potholes = db.query("potholes", limit=100000)
    incidents = db.query("incidents", since=now - 30 * day, limit=100000)
    checks = db.query("talkbacks", since=now - 30 * day, limit=100000)
    open_sites = [p for p in potholes if p["status"] in OPEN_STATUSES]

    days = []
    for i in range(13, -1, -1):
        start = (now // day - i) * day
        days.append(
            {
                "day": time.strftime("%d %b", time.gmtime(start / 1000)),
                "reported": sum(1 for p in potholes if start <= p["created_at"] < start + day),
                "repaired": sum(1 for p in potholes if start <= (p.get("repaired_at") or 0) < start + day),
            }
        )
    by_status = Counter(p["status"] for p in potholes)
    by_sev = Counter(p["severity"] for p in open_sites)
    return {
        "potholes": {
            "total": len(potholes),
            "open": len(open_sites),
            "open_potholes": sum(p.get("count", 1) for p in open_sites),
            "by_status": {s: by_status.get(s, 0) for s in ["reported", "verified", "scheduled", "repaired", "rejected"]},
            "open_by_severity": {s: by_sev.get(s, 0) for s in ["high", "medium", "low"]},
            "open_estimate": round(sum((p.get("estimate") or {}).get("total", 0) for p in open_sites), 2),
            "currency": next(((p.get("estimate") or {}).get("currency") for p in potholes if p.get("estimate")), "INR"),
            "missing_location": sum(1 for p in open_sites if p.get("lat") is None),
        },
        "incidents_30d": {
            "crashes_verified": sum(1 for i in incidents if i["kind"] == "crash" and i.get("verified")),
            "crashes_suppressed": sum(1 for i in incidents if i["kind"] == "crash" and not i.get("verified")),
            "sirens": sum(1 for i in incidents if i["kind"] == "siren"),
        },
        "alertness_30d": {
            "checks": len(checks),
            "passed": sum(1 for c in checks if c.get("correct")),
            "alarms": sum(1 for c in checks if c.get("alarm")),
        },
        "daily": days,
    }


# Serve the built frontend (npm run build) from the same port when present,
# so a single `uvicorn` process is enough for a demo.
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")
    for sub in ("wasm", "models"):
        if (DIST / sub).exists():
            app.mount(f"/{sub}", StaticFiles(directory=str(DIST / sub)), name=sub)

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith(("api/", "media/")):
            raise HTTPException(404, "Not found.")
        f = DIST / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
