"""Monocular size estimates for a detected pothole.

A single camera has no absolute scale, so sizes are estimated from a ground-
plane camera model (camera height, field of view, and the horizon line found
in the frame).
Results are clamped to physically plausible ranges and always labelled as
estimates; stereo vision or LiDAR is needed for measured volumes.
"""

import math

import cv2
import numpy as np

CAM_HEIGHT_M = 1.30  # dashcam / phone on windscreen
FOV_V_DEG = 55.0
MAX_RANGE_M = 15.0  # beyond this a pothole is too small in frame to size reliably

# Plausibility limits for a single pothole.
MAX_WIDTH_M = 2.0
MIN_DEPTH_M = 0.02
MAX_DEPTH_M = 0.12


def horizon_row(bgr):
    """Row where the road surface ends (first row from the top that is not
    mostly sky or vegetation). Falls back to 35 % of the height."""
    h = bgr.shape[0]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    for r in range(int(h * 0.12), int(h * 0.65), max(1, h // 80)):
        line = hsv[r]
        sky = np.mean((line[:, 2] > 170) & (line[:, 1] < 60))
        green = np.mean((line[:, 0] > 30) & (line[:, 0] < 90) & (line[:, 1] > 60))
        if sky + green < 0.5:
            return int(max(r, h * 0.12))
    return int(h * 0.35)


class CameraModel:
    def __init__(self, img_w, img_h, horizon=None, fov_v_deg=FOV_V_DEG, cam_h_m=CAM_HEIGHT_M):
        self.img_w = int(img_w)
        self.img_h = int(img_h)
        self.cam_h_m = cam_h_m
        self.horizon_row = float(horizon if horizon is not None else img_h * 0.35)
        self.f_px = (self.img_h / 2.0) / math.tan(math.radians(fov_v_deg) / 2.0)

    def ground_distance(self, row):
        """Distance along the road to the point imaged at `row` (m), capped."""
        dpx = max(1.0, row - self.horizon_row)
        return min(MAX_RANGE_M, self.cam_h_m * self.f_px / dpx)

    def m_per_px_h(self, row):
        return self.ground_distance(row) / self.f_px


def _contrast(gray, x, y, w, h):
    sub = gray[y : y + h, x : x + w]
    if sub.size == 0:
        return 0.0
    pad = max(4, min(w, h) // 3)
    y0, y1 = max(0, y - pad), min(gray.shape[0], y + h + pad)
    x0, x1 = max(0, x - pad), min(gray.shape[1], x + w + pad)
    ring = gray[y0:y1, x0:x1].astype(np.float32)
    inner = float(np.median(sub))
    outer = float(np.median(ring))
    return abs(outer - inner) / (outer + 1e-6)


def compute_measurements(bgr, bbox, depth_map=None, horizon=None):
    img_h, img_w = bgr.shape[:2]
    if horizon is None:
        horizon = horizon_row(bgr)
    cam = CameraModel(img_w, img_h, horizon)
    x, y, w, h = (int(v) for v in (bbox["x"], bbox["y"], bbox["w"], bbox["h"]))
    x, y = max(0, x), max(0, y)
    w, h = max(1, min(w, img_w - x)), max(1, min(h, img_h - y))
    bottom = min(y + h - 1, img_h - 1)
    top = max(y, int(horizon) + 2)

    mpp = cam.m_per_px_h(bottom)
    width_m = min(MAX_WIDTH_M, w * mpp)
    # Along-road length from the ground-plane distance between top and bottom
    # edges, kept within a sane aspect of the width (perspective compresses it).
    length_m = cam.ground_distance(top) - cam.ground_distance(bottom)
    length_m = float(np.clip(length_m, width_m * 0.6, width_m * 1.4))
    area_m2 = width_m * length_m * math.pi / 4.0  # ellipse inside the box

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if depth_map is not None and depth_map.shape[:2] == (img_h, img_w):
        signal = "depth-map"
        c = _contrast((depth_map * 255).astype(np.uint8), x, y, w, h)
    else:
        signal = "brightness-contrast"
        c = _contrast(gray, x, y, w, h)
    # Wider holes tend to be deeper; contrast (shadow / water) adds to it.
    depth_m = float(np.clip(0.015 + 0.03 * min(1.0, width_m) + 0.06 * min(1.0, c * 2), MIN_DEPTH_M, MAX_DEPTH_M))
    # Bowl-shaped profile: mean depth ~ 60 % of max.
    volume_m3 = area_m2 * depth_m * 0.6

    return {
        "bbox": {"x": x, "y": y, "w": w, "h": h},
        "area": round(area_m2, 4),
        "depth": round(depth_m, 4),
        "volume": round(volume_m3, 6),
        "distance_m": round(cam.ground_distance(bottom), 1),
        "volume_estimated": True,
        "accuracy": {
            "mode": "monocular-estimate",
            "reference": "camera-model",
            "depth_signal": signal,
        },
    }
