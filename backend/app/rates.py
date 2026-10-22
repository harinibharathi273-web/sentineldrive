"""Repair rate card, cost estimate and severity grading.

The rate card is stored in the database and editable from Settings, because
rates differ by city and by year (each corporation publishes its own Schedule
of Rates). The defaults below are working assumptions for a cold-mix patch
repair and are labelled as such in the UI and on every work order.
"""

import copy

from . import db

DEFAULT_RATE_CARD = {
    "currency": "INR",
    "authority": "",  # e.g. "Greater Chennai Corporation — Bus Route Roads Dept."
    "material_name": "Ready-mix cold bituminous patching material",
    "material_rate_per_tonne": 9500.0,
    "material_density_t_per_m3": 2.3,
    "wastage_pct": 10.0,
    "tack_coat_rate_per_m2": 60.0,
    "edge_cutting_rate_per_m": 45.0,
    "labour_per_patch": 900.0,
    "traffic_management_per_patch": 350.0,
    "gst_pct": 18.0,
    "source_note": "Default assumptions — replace with your corporation's Schedule of Rates.",
}

KEY = "rate_card"


def get_rate_card():
    card = copy.deepcopy(DEFAULT_RATE_CARD)
    card.update(db.kv_get(KEY, {}) or {})
    return card


def set_rate_card(values):
    card = get_rate_card()
    for k, v in values.items():
        if k not in DEFAULT_RATE_CARD:
            continue
        if isinstance(DEFAULT_RATE_CARD[k], float):
            v = float(v)
            if v < 0:
                raise ValueError(f"{k} cannot be negative")
        card[k] = v
    db.kv_set(KEY, card)
    return card


def estimate_cost(area_m2, depth_m, volume_m3, card=None):
    """Bill of quantities for one patch repair.

    Material = volume x density x (1 + wastage) tonnes x rate
    Tack coat = area x rate
    Edge cutting = perimeter of a squared-off patch (area grown 15 % each side)
    + fixed labour and traffic management per patch, then GST.
    """
    card = card or get_rate_card()
    tonnes = volume_m3 * card["material_density_t_per_m3"] * (1 + card["wastage_pct"] / 100.0)
    # Repairs are cut square around the defect with a margin.
    side = (max(area_m2, 0.0) ** 0.5) * 1.15
    perimeter = 4 * side
    patch_area = side * side
    lines = [
        {
            "item": card["material_name"],
            "qty": round(tonnes, 4),
            "unit": "t",
            "rate": card["material_rate_per_tonne"],
        },
        {"item": "Tack coat (bitumen emulsion)", "qty": round(patch_area, 3), "unit": "m²", "rate": card["tack_coat_rate_per_m2"]},
        {"item": "Edge cutting and squaring", "qty": round(perimeter, 2), "unit": "m", "rate": card["edge_cutting_rate_per_m"]},
        {"item": "Labour (patch crew)", "qty": 1, "unit": "job", "rate": card["labour_per_patch"]},
        {"item": "Traffic management and barricading", "qty": 1, "unit": "job", "rate": card["traffic_management_per_patch"]},
    ]
    for ln in lines:
        ln["amount"] = round(ln["qty"] * ln["rate"], 2)
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
    }


def grade_severity(area_m2, depth_m):
    """Low / medium / high from depth and opening area.

    Depth bands follow common pavement-distress practice (under 25 mm, 25-50 mm,
    over 50 mm); a wide but shallow defect is upgraded because it affects a whole
    wheel path.
    """
    depth_mm = depth_m * 1000
    if depth_mm >= 50 or area_m2 >= 0.5:
        return "high"
    if depth_mm >= 25 or area_m2 >= 0.15:
        return "medium"
    return "low"


SEVERITY_WEIGHT = {"low": 20, "medium": 45, "high": 70}


def priority_score(severity, reports=1, age_days=0.0, count=1, area_m2=0.0):
    """0-100 repair priority. Severity sets the band; within it, larger total
    damage, more potholes, repeat reports and waiting time push a site up."""
    score = (
        SEVERITY_WEIGHT.get(severity, 20)
        + min(10.0, area_m2 * 2.5)
        + min(8.0, (count - 1) * 2.0)
        + min(8.0, (reports - 1) * 4.0)
        + min(4.0, age_days * 0.25)
    )
    return int(min(100, round(score)))
