"""Reverse geocoding (coordinates -> street, ward, city) via OpenStreetMap
Nominatim.

Nominatim's usage policy asks for at most one request per second and an
identifying User-Agent; both are respected here and results are cached in the
database by ~11 m grid cell, so repeat reports of the same spot never call out.
When the geocoder is unreachable the record keeps its coordinates and the UI
shows them instead of an address.
"""

import json
import logging
import threading
import time
import urllib.parse
import urllib.request

from . import db
from .config import GEOCODER, GEOCODER_URL, GEOCODER_USER_AGENT

log = logging.getLogger("sentinel.geocode")
_lock = threading.Lock()
_last_call = 0.0


def _cache_key(lat, lng):
    return f"geo:{lat:.4f},{lng:.4f}"


def _summarise(payload):
    a = payload.get("address") or {}
    road = a.get("road") or a.get("pedestrian") or a.get("residential") or a.get("highway")
    locality = a.get("suburb") or a.get("neighbourhood") or a.get("quarter") or a.get("city_district")
    city = a.get("city") or a.get("town") or a.get("municipality") or a.get("village") or a.get("county")
    district = a.get("state_district") or a.get("county")
    parts = [p for p in (road, locality, city) if p]
    return {
        "label": ", ".join(parts) if parts else payload.get("display_name"),
        "road": road,
        "locality": locality,
        "city": city,
        "district": district,
        "state": a.get("state"),
        "postcode": a.get("postcode"),
        "country": a.get("country"),
        "display_name": payload.get("display_name"),
        "source": "openstreetmap-nominatim",
    }


def reverse(lat, lng, timeout=6.0):
    """Return an address dict, or None when unavailable. Blocking; call from a thread."""
    if lat is None or lng is None or GEOCODER == "off":
        return None
    key = _cache_key(lat, lng)
    cached = db.kv_get(key)
    if cached:
        return cached
    global _last_call
    with _lock:
        wait = 1.05 - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()
        q = urllib.parse.urlencode(
            {"format": "jsonv2", "lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "zoom": 18, "addressdetails": 1}
        )
        req = urllib.request.Request(
            f"{GEOCODER_URL}?{q}",
            headers={"User-Agent": GEOCODER_USER_AGENT, "Accept-Language": "en"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # network down, rate limited, blocked
            log.warning("reverse geocode failed for %.5f,%.5f: %s", lat, lng, exc)
            return None
    if not payload or "error" in payload:
        return None
    out = _summarise(payload)
    db.kv_set(key, out)
    return out


def jurisdiction(address):
    """Which civic body a defect is routed to (city + ward/locality)."""
    if not address:
        return {"authority": None, "ward": None}
    return {"authority": address.get("city") or address.get("district"), "ward": address.get("locality")}
