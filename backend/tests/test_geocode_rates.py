from app import geocode, rates


def test_nominatim_summary():
    payload = {
        "display_name": "Sardar Patel Road, Guindy, Chennai, Tamil Nadu, 600025, India",
        "address": {"road": "Sardar Patel Road", "suburb": "Guindy", "city": "Chennai",
                    "state": "Tamil Nadu", "postcode": "600025", "country": "India"},
    }
    s = geocode._summarise(payload)
    assert s["label"] == "Sardar Patel Road, Guindy, Chennai"
    assert geocode.jurisdiction(s) == {"authority": "Chennai", "ward": "Guindy"}


def test_severity_bands():
    assert rates.grade_severity(0.05, 0.02) == "low"
    assert rates.grade_severity(0.05, 0.03) == "medium"
    assert rates.grade_severity(0.05, 0.06) == "high"
    assert rates.grade_severity(0.6, 0.02) == "high"


def test_cost_lines_add_up():
    est = rates.estimate_cost(0.5, 0.05, 0.015, rates.DEFAULT_RATE_CARD)
    assert round(sum(l["amount"] for l in est["lines"]), 2) == est["subtotal"]
    assert est["total"] == round(est["subtotal"] + est["gst"], 2)
    mat = est["lines"][0]
    assert mat["qty"] == round(0.015 * 2.3 * 1.1, 4)
