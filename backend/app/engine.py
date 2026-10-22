"""Live in-vehicle state: driver alertness, the spoken alertness check,
emergency-vehicle (siren) events and crash verification.

Nothing here invents data. Every value comes from a sensor in the driver's
browser (camera, microphone, accelerometer, GPS). When a sensor is off, the
state says so instead of filling in numbers.
"""

import json
import logging
import random
import threading
import time
import urllib.request
import uuid

from . import db, geocode
from .config import ALERT_WEBHOOK
from .hub import hub

log = logging.getLogger("sentinel.engine")

DRIVER_TTL_S = 3.0  # camera reports ~1/s; older than this = camera off

# Alertness check
CRITICAL_SCORE = 8.0
RECOVERED_SCORE = 5.0
RESPONSE_WINDOW_S = 8.0
COOLDOWN_AFTER_PASS_S = 45.0
COOLDOWN_AFTER_RECOVERY_S = 20.0

# Crash verification
IMPACT_G = 4.0  # dynamic acceleration (gravity removed) that counts as an impact
SEVERE_G = 8.0  # decisive on its own
SPEED_DROP_KMH = 20.0
ACOUSTIC_JUMP_DB = 20.0  # sudden loudness jump above the cabin's recent median
DRIVER_RESPONSE_S = 20.0  # "Are you OK?" countdown before escalating

# Siren
SIREN_QUIET_S = 6.0

DEFAULT_PREFS = {"traffic_side": "left", "emergency_number": "112"}


def _ts():
    return int(time.time() * 1000)


def get_prefs():
    p = dict(DEFAULT_PREFS)
    p.update(db.kv_get("prefs", {}) or {})
    return p


def set_prefs(values):
    p = get_prefs()
    if values.get("traffic_side") in ("left", "right"):
        p["traffic_side"] = values["traffic_side"]
    if values.get("emergency_number"):
        num = str(values["emergency_number"]).strip()
        if num.replace("+", "").isdigit() and len(num) <= 15:
            p["emergency_number"] = num
    db.kv_set("prefs", p)
    return p


def _make_question():
    kind = random.choice(("sub", "add", "sub"))
    if kind == "add":
        a, b = random.randint(4, 15), random.randint(2, 9)
        return f"What is {a} plus {b}?", a + b
    a, b = random.randint(9, 19), random.randint(2, 8)
    return f"What is {a} minus {b}?", a - b


def _post_webhook(payload):
    if not ALERT_WEBHOOK:
        return

    def run():
        try:
            req = urllib.request.Request(
                ALERT_WEBHOOK,
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=8).read()
        except Exception as exc:
            log.warning("alert webhook failed: %s", exc)

    threading.Thread(target=run, daemon=True).start()


class LiveEngine:
    def __init__(self):
        self.driver = {"active": False}
        self._driver_at = 0.0
        self.talkback = None
        self._cooldown_until = 0.0
        self.siren = None
        self._siren_last = 0.0
        self._pending_crashes = {}  # id -> deadline (epoch s)

    # ------------------------------------------------------------------
    def snapshot(self):
        return {
            "driver": self.driver,
            "talkback": self._public_talkback(),
            "siren": self.siren,
            "prefs": get_prefs(),
        }

    def _public_talkback(self):
        if not self.talkback:
            return None
        tb = self.talkback
        now = time.time()
        return {
            "id": tb["id"],
            "question": tb["question"],
            "phase": tb["phase"],
            "attempts": len(tb["attempts"]),
            "remaining_s": max(0.0, round(tb["deadline"] - now, 1)) if tb["phase"] == "asked" else 0,
            "window_s": RESPONSE_WINDOW_S,
            "started_at": tb["started_at"],
        }

    # ------------------------------------------------------------------
    def ingest(self, msg):
        """Handle one message from a browser. Returns events to broadcast."""
        t = msg.get("type")
        if t == "fatigue":
            return self._on_fatigue(msg)
        if t == "talkback_answer":
            return self._on_answer(msg)
        if t == "crash_candidate":
            return self._on_crash(msg)
        if t == "crash_response":
            return self._on_crash_response(msg)
        if t == "siren_detected":
            return self._on_siren(msg)
        if t == "siren_clear":
            return self._end_siren("signal-lost")
        return []

    # -- driver alertness ---------------------------------------------------
    def _on_fatigue(self, msg):
        try:
            score = max(0.0, min(10.0, float(msg["score"])))
        except (KeyError, TypeError, ValueError):
            return []
        tier = "critical" if score >= CRITICAL_SCORE else "elevated" if score >= RECOVERED_SCORE else "normal"
        self.driver = {
            "active": True,
            "score": round(score, 1),
            "tier": tier,
            "perclos": _num(msg.get("perclos")),
            "face": bool(msg.get("face", True)),
            "calibrated": bool(msg.get("calibrated", False)),
            "blink_rate": _num(msg.get("blink_rate")),
            "eyes_closed_ms": _num(msg.get("eyes_closed_ms")),
            "droop_ms": _num(msg.get("droop_ms")),
            "microsleeps": _num(msg.get("microsleeps")),
            "ts": _ts(),
        }
        self._driver_at = time.time()
        events = [{"type": "driver", "driver": self.driver}]
        events += self._maybe_start_talkback()
        if self.talkback and self.talkback["phase"] == "alarm" and score < RECOVERED_SCORE:
            events += self._finish_talkback("recovered", correct=False)
        return events

    def _maybe_start_talkback(self):
        if self.talkback or time.time() < self._cooldown_until:
            return []
        if not self.driver.get("active") or not self.driver.get("calibrated"):
            return []
        if self.driver.get("score", 0) < CRITICAL_SCORE:
            return []
        q, a = _make_question()
        now = time.time()
        self.talkback = {
            "id": uuid.uuid4().hex[:10],
            "question": q,
            "answer": a,
            "phase": "asked",
            "started_at": _ts(),
            "deadline": now + RESPONSE_WINDOW_S,
            "attempts": [],
            "score_at_start": self.driver.get("score"),
        }
        return [{"type": "talkback", "talkback": self._public_talkback()}]

    def _on_answer(self, msg):
        tb = self.talkback
        if not tb or msg.get("id") != tb["id"]:
            return []
        try:
            parsed = int(msg["answer"])
        except (KeyError, TypeError, ValueError):
            return []
        correct = parsed == tb["answer"]
        tb["attempts"].append(
            {
                "heard": (msg.get("transcript") or "")[:200],
                "parsed": parsed,
                "correct": correct,
                "method": msg.get("method", "speech"),
                "ts": _ts(),
            }
        )
        if correct:
            return self._finish_talkback("answered", correct=True)
        if tb["phase"] == "asked":
            tb["deadline"] = time.time() + RESPONSE_WINDOW_S
        return [
            {
                "type": "talkback_retry",
                "talkback": self._public_talkback(),
                "heard": tb["attempts"][-1]["heard"],
            }
        ]

    def _finish_talkback(self, outcome, correct):
        tb = self.talkback
        self.talkback = None
        self._cooldown_until = time.time() + (COOLDOWN_AFTER_PASS_S if correct else COOLDOWN_AFTER_RECOVERY_S)
        record = {
            "id": tb["id"],
            "created_at": tb["started_at"],
            "kind": "alertness_check",
            "status": outcome,
            "question": tb["question"],
            "expected": tb["answer"],
            "attempts": tb["attempts"],
            "outcome": outcome,
            "correct": correct,
            "alarm": tb["phase"] == "alarm",
            "response_ms": _ts() - tb["started_at"],
            "score_at_start": tb["score_at_start"],
        }
        db.put("talkbacks", record)
        return [{"type": "talkback_done", "result": record}]

    # -- crash ---------------------------------------------------------------
    def _on_crash(self, msg):
        g = max(0.0, _num(msg.get("g")) or 0.0)
        gps = msg.get("gps") or {}
        audio = msg.get("audio") or {}
        speed = _num(gps.get("speed_kmh"))
        prior = _num(gps.get("speed_prior_kmh"))
        speed_drop = (prior - speed) if (speed is not None and prior is not None) else None
        jump = _num(audio.get("jump_db"))

        impact = g >= IMPACT_G
        severe = g >= SEVERE_G
        gps_agree = speed_drop is not None and speed_drop >= SPEED_DROP_KMH
        audio_agree = jump is not None and jump >= ACOUSTIC_JUMP_DB
        verified = severe or (impact and (gps_agree or audio_agree))

        if severe:
            reason = f"Impact of {g:.1f} g is above the {SEVERE_G:.0f} g severe threshold."
        elif verified:
            corroborated = " and ".join(
                x for x, ok in (("a sudden speed drop", gps_agree), ("a loud impact sound", audio_agree)) if ok
            )
            reason = f"{g:.1f} g impact confirmed by {corroborated}."
        elif impact:
            reason = f"{g:.1f} g impact, but neither GPS speed nor sound confirmed a collision."
        else:
            reason = f"{g:.1f} g spike is below the {IMPACT_G:.0f} g impact threshold (phone movement or a bump)."

        lat, lng = _num(gps.get("lat")), _num(gps.get("lng"))
        rec = {
            "id": "CR-" + uuid.uuid4().hex[:8].upper(),
            "kind": "crash",
            "created_at": int(_num(msg.get("ts")) or _ts()),
            "status": "awaiting_driver" if verified else "suppressed",
            "verified": verified,
            "reason": reason,
            "lat": lat,
            "lng": lng,
            "gps_accuracy_m": _num(gps.get("accuracy_m")),
            "address": None,
            "signals": {
                "g_force": {"value": round(g, 2), "threshold": IMPACT_G, "agree": impact},
                "speed_drop": {
                    "value": None if speed_drop is None else round(speed_drop, 1),
                    "threshold": SPEED_DROP_KMH,
                    "agree": gps_agree,
                    "available": speed_drop is not None,
                },
                "sound": {
                    "value": None if jump is None else round(jump, 1),
                    "peak_dbfs": _num(audio.get("peak_dbfs")),
                    "threshold": ACOUSTIC_JUMP_DB,
                    "agree": audio_agree,
                    "available": jump is not None,
                },
            },
            "driver_state": msg.get("driver") or None,
            "response_deadline": _ts() + int(DRIVER_RESPONSE_S * 1000) if verified else None,
            "timeline": [{"ts": _ts(), "event": "detected" if verified else "suppressed"}],
        }
        db.put("incidents", rec)
        if verified:
            self._pending_crashes[rec["id"]] = time.time() + DRIVER_RESPONSE_S
        self._geocode_async("incidents", rec)
        return [{"type": "incident", "incident": rec}]

    def _on_crash_response(self, msg):
        rid = msg.get("id")
        rec = db.get("incidents", rid) if rid else None
        if not rec or rec.get("kind") != "crash" or rec["status"] not in ("awaiting_driver", "escalated"):
            return []
        resp = msg.get("response")
        if resp == "ok" and rec["status"] == "awaiting_driver":
            rec["status"] = "driver_ok"
            rec["timeline"].append({"ts": _ts(), "event": "driver confirmed OK"})
        elif resp == "help":
            rec["status"] = "escalated"
            rec["timeline"].append({"ts": _ts(), "event": "driver requested help"})
            self._alert(rec, "driver requested help")
        elif resp == "resolved":
            rec["status"] = "resolved"
            rec["timeline"].append({"ts": _ts(), "event": "marked resolved"})
        else:
            return []
        self._pending_crashes.pop(rid, None)
        db.put("incidents", rec)
        return [{"type": "incident", "incident": rec}]

    def _alert(self, rec, why):
        prefs = get_prefs()
        _post_webhook(
            {
                "event": "crash_escalated",
                "why": why,
                "incident_id": rec["id"],
                "detected_at": rec["created_at"],
                "lat": rec.get("lat"),
                "lng": rec.get("lng"),
                "maps_url": f"https://maps.google.com/?q={rec['lat']},{rec['lng']}" if rec.get("lat") is not None else None,
                "address": (rec.get("address") or {}).get("label"),
                "g_force": rec["signals"]["g_force"]["value"],
                "emergency_number": prefs["emergency_number"],
            }
        )

    # -- siren ---------------------------------------------------------------
    def _guidance(self):
        side = get_prefs()["traffic_side"]
        return (
            f"Emergency vehicle nearby. Check your mirrors, slow down and move to the {side} to let it pass. "
            "Do not stop in a junction."
        )

    def _on_siren(self, msg):
        freq = _num(msg.get("freq_hz"))
        score = _num(msg.get("score")) or 0.0
        now = _ts()
        self._siren_last = time.time()
        if self.siren is None:
            self.siren = {
                "id": "SR-" + uuid.uuid4().hex[:8].upper(),
                "kind": "siren",
                "created_at": now,
                "status": "active",
                "guidance": self._guidance(),
                "freq_min": freq,
                "freq_max": freq,
                "peak_score": score,
                "pattern": msg.get("pattern"),
                "lat": _num((msg.get("gps") or {}).get("lat")),
                "lng": _num((msg.get("gps") or {}).get("lng")),
                "last_heard": now,
            }
            db.put("incidents", self.siren)
        else:
            s = self.siren
            if freq is not None:
                s["freq_min"] = min(x for x in (s["freq_min"], freq) if x is not None)
                s["freq_max"] = max(x for x in (s["freq_max"], freq) if x is not None)
            s["peak_score"] = max(s["peak_score"] or 0, score)
            s["pattern"] = msg.get("pattern") or s.get("pattern")
            s["last_heard"] = now
        return [{"type": "siren", "siren": self.siren}]

    def _end_siren(self, why):
        if not self.siren:
            return []
        s = self.siren
        self.siren = None
        s["status"] = "cleared"
        s["cleared_reason"] = why
        s["duration_s"] = round((s["last_heard"] - s["created_at"]) / 1000.0, 1)
        db.put("incidents", s)
        return [{"type": "siren", "siren": s}]

    # -- periodic ------------------------------------------------------------
    def tick(self):
        events = []
        now = time.time()
        if self.driver.get("active") and now - self._driver_at > DRIVER_TTL_S:
            self.driver = {"active": False, "ts": _ts()}
            events.append({"type": "driver", "driver": self.driver})

        tb = self.talkback
        if tb and tb["phase"] == "asked" and now >= tb["deadline"]:
            tb["phase"] = "alarm"
            events.append({"type": "talkback", "talkback": self._public_talkback()})

        if self.siren and now - self._siren_last > SIREN_QUIET_S:
            events += self._end_siren("quiet")

        for rid, deadline in list(self._pending_crashes.items()):
            if now >= deadline:
                self._pending_crashes.pop(rid, None)
                rec = db.get("incidents", rid)
                if rec and rec["status"] == "awaiting_driver":
                    rec["status"] = "escalated"
                    rec["timeline"].append({"ts": _ts(), "event": "no response from driver — escalated"})
                    db.put("incidents", rec)
                    self._alert(rec, "no response from driver")
                    events.append({"type": "incident", "incident": rec})
        return events

    # -- helpers ---------------------------------------------------------------
    def _geocode_async(self, table, rec):
        if rec.get("lat") is None or rec.get("lng") is None:
            return

        def run():
            addr = geocode.reverse(rec["lat"], rec["lng"])
            if not addr:
                return
            fresh = db.get(table, rec["id"])
            if not fresh:
                return
            fresh["address"] = addr
            db.put(table, fresh)
            hub.broadcast_threadsafe({"type": "incident", "incident": fresh})

        threading.Thread(target=run, daemon=True).start()


def _num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


engine = LiveEngine()
