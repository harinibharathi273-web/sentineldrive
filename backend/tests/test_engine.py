import time

import pytest


@pytest.fixture()
def eng(tmp_path, monkeypatch):
    monkeypatch.setenv("SENTINEL_GEOCODER", "off")
    from app import db, engine

    db.reset_for_tests(tmp_path / "e.db")
    monkeypatch.setattr(engine.geocode, "reverse", lambda *a, **k: None)
    return engine.LiveEngine()


def fatigue(e, score, calibrated=True):
    return e.ingest({"type": "fatigue", "score": score, "perclos": 0.1, "calibrated": calibrated, "face": True})


def test_driver_goes_inactive_without_camera(eng, monkeypatch):
    fatigue(eng, 2)
    assert eng.driver["active"]
    eng._driver_at -= 10
    ev = eng.tick()
    assert ev[0]["driver"]["active"] is False


def test_no_alertness_check_until_calibrated(eng):
    ev = fatigue(eng, 9, calibrated=False)
    assert not any(e["type"] == "talkback" for e in ev)


def test_alertness_check_flow_never_leaks_answer(eng):
    ev = fatigue(eng, 9)
    tb = [e for e in ev if e["type"] == "talkback"][0]["talkback"]
    assert "answer" not in tb
    expected = eng.talkback["answer"]
    wrong = eng.ingest({"type": "talkback_answer", "id": tb["id"], "answer": expected + 1, "transcript": "x"})
    assert wrong[0]["type"] == "talkback_retry"
    done = eng.ingest({"type": "talkback_answer", "id": tb["id"], "answer": expected, "transcript": "y"})
    assert done[0]["type"] == "talkback_done" and done[0]["result"]["correct"]
    assert len(done[0]["result"]["attempts"]) == 2
    # Cool-down: a critical score right after does not re-arm.
    assert not any(e["type"] == "talkback" for e in fatigue(eng, 9.5))


def test_no_answer_escalates_to_alarm_then_recovers(eng):
    fatigue(eng, 9)
    eng.talkback["deadline"] = time.time() - 1
    ev = eng.tick()
    assert ev[0]["talkback"]["phase"] == "alarm"
    ev = fatigue(eng, 3)
    done = [e for e in ev if e["type"] == "talkback_done"][0]["result"]
    assert done["outcome"] == "recovered" and done["alarm"] and not done["correct"]


@pytest.mark.parametrize(
    "msg,verified",
    [
        ({"g": 9.0}, True),  # severe on its own
        ({"g": 5.0, "gps": {"speed_kmh": 2, "speed_prior_kmh": 40}}, True),  # speed drop
        ({"g": 5.0, "audio": {"jump_db": 30}}, True),  # loud bang
        ({"g": 5.0, "audio": {"jump_db": 5}}, False),  # impact but nothing agrees
        ({"g": 2.6}, False),  # phone bump
    ],
)
def test_crash_verification(eng, msg, verified):
    ev = eng.ingest({"type": "crash_candidate", **msg})
    inc = ev[0]["incident"]
    assert inc["verified"] is verified
    assert inc["status"] == ("awaiting_driver" if verified else "suppressed")
    assert inc["reason"]


def test_crash_escalates_without_response(eng):
    inc = eng.ingest({"type": "crash_candidate", "g": 9.0})[0]["incident"]
    eng._pending_crashes[inc["id"]] = time.time() - 1
    ev = eng.tick()
    assert ev[0]["incident"]["status"] == "escalated"


def test_driver_ok_cancels(eng):
    inc = eng.ingest({"type": "crash_candidate", "g": 9.0})[0]["incident"]
    ev = eng.ingest({"type": "crash_response", "id": inc["id"], "response": "ok"})
    assert ev[0]["incident"]["status"] == "driver_ok"
    assert eng.tick() == []


def test_siren_lifecycle(eng):
    a = eng.ingest({"type": "siren_detected", "freq_hz": 700, "score": 0.6})[0]["siren"]
    b = eng.ingest({"type": "siren_detected", "freq_hz": 1400, "score": 0.8})[0]["siren"]
    assert a["id"] == b["id"] and b["freq_min"] == 700 and b["freq_max"] == 1400
    assert "left" in b["guidance"]
    eng._siren_last -= 10
    ev = eng.tick()
    assert ev[0]["siren"]["status"] == "cleared"
