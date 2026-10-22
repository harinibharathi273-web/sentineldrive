"""Pothole detector with three tiers, picked automatically at start-up:

1. ``yolo-onnx``  — a YOLOv8/YOLO11 pothole model exported to ONNX, run with
   OpenCV's DNN module. No PyTorch needed. File: models/pothole.onnx
2. ``yolo``       — the same model as a PyTorch checkpoint via ``ultralytics``.
   File: models/pothole.pt (requires ``pip install ultralytics``)
3. ``classical``  — OpenCV heuristics for dark holes and water-filled holes.
   Works with zero model files, but misses more and is reported as such.

``python scripts/get_model.py`` downloads a fine-tuned YOLOv8n pothole model
and converts it to ONNX (see README).
"""

import logging
import os

import cv2
import numpy as np

from ..config import MIN_CONFIDENCE, MODELS_DIR
from .geometry import horizon_row

log = logging.getLogger("sentinel.detector")


def _iou(a, b):
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    ix = max(0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / max(1, union)


def _letterbox(img, size):
    h, w = img.shape[:2]
    r = min(size / h, size / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    top = (size - nh) // 2
    left = (size - nw) // 2
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[top : top + nh, left : left + nw] = resized
    return canvas, r, left, top


class PotholeDetector:
    def __init__(self, models_dir=None):
        self.models_dir = str(models_dir or MODELS_DIR)
        self.onnx_path = os.getenv("SENTINEL_ONNX_MODEL", os.path.join(self.models_dir, "pothole.onnx"))
        self.pt_path = os.getenv("SENTINEL_PT_MODEL", os.path.join(self.models_dir, "pothole.pt"))
        self.imgsz = int(os.getenv("SENTINEL_MODEL_IMGSZ", "640"))
        self.net = None
        self.model = None
        self.tier = "classical"
        self.model_name = None
        if os.path.exists(self.onnx_path) and self._load_onnx():
            self.tier = "yolo-onnx"
            self.model_name = os.path.basename(self.onnx_path)
        elif os.path.exists(self.pt_path) and self._load_pt():
            self.tier = "yolo"
            self.model_name = os.path.basename(self.pt_path)
        log.info("pothole detector tier: %s", self.tier)

    # -- loading -----------------------------------------------------------
    def _load_onnx(self):
        try:
            self.net = cv2.dnn.readNetFromONNX(self.onnx_path)
            # Probe once so a broken export fails here, not on the first upload.
            probe = cv2.dnn.blobFromImage(np.zeros((self.imgsz, self.imgsz, 3), np.uint8), 1 / 255.0, swapRB=True)
            self.net.setInput(probe)
            self.net.forward()
            return True
        except Exception as exc:
            log.warning("could not load ONNX model %s: %s", self.onnx_path, exc)
            self.net = None
            return False

    def _load_pt(self):
        try:
            from ultralytics import YOLO

            self.model = YOLO(self.pt_path)
            return True
        except Exception as exc:
            log.warning("could not load YOLO checkpoint %s: %s", self.pt_path, exc)
            self.model = None
            return False

    # -- public ------------------------------------------------------------
    def describe(self):
        return {
            "tier": self.tier,
            "model": self.model_name,
            "label": {
                "yolo-onnx": "Fine-tuned YOLO model (ONNX)",
                "yolo": "Fine-tuned YOLO model",
                "classical": "Classical image analysis (no model installed)",
            }[self.tier],
        }

    def detect(self, bgr):
        if self.tier == "yolo-onnx":
            dets = self._detect_onnx(bgr)
        elif self.tier == "yolo":
            dets = self._detect_pt(bgr)
        else:
            dets = self._detect_classical(bgr)
        return [d for d in dets if d["confidence"] >= MIN_CONFIDENCE]

    # -- YOLO via OpenCV DNN ----------------------------------------------
    def _detect_onnx(self, bgr):
        img_h, img_w = bgr.shape[:2]
        canvas, r, left, top = _letterbox(bgr, self.imgsz)
        blob = cv2.dnn.blobFromImage(canvas, 1 / 255.0, (self.imgsz, self.imgsz), swapRB=True, crop=False)
        self.net.setInput(blob)
        out = self.net.forward()
        out = np.squeeze(out)  # (4 + nc, N) for YOLOv8/11 exports
        if out.ndim != 2:
            return []
        if out.shape[0] > out.shape[1]:
            out = out.T
        boxes_xywh = out[:4].T
        scores = out[4:].max(axis=0)
        keep = scores >= MIN_CONFIDENCE * 0.8
        boxes_xywh, scores = boxes_xywh[keep], scores[keep]
        rects = []
        for cx, cy, w, h in boxes_xywh:
            x = (cx - w / 2 - left) / r
            y = (cy - h / 2 - top) / r
            rects.append([float(x), float(y), float(w / r), float(h / r)])
        idx = cv2.dnn.NMSBoxes(rects, scores.astype(float).tolist(), MIN_CONFIDENCE * 0.8, 0.45)
        dets = []
        for i in np.array(idx).flatten() if len(idx) else []:
            x, y, w, h = rects[i]
            x0, y0 = max(0, int(round(x))), max(0, int(round(y)))
            x1, y1 = min(img_w, int(round(x + w))), min(img_h, int(round(y + h)))
            if x1 - x0 < 4 or y1 - y0 < 4:
                continue
            dets.append(
                {
                    "bbox": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
                    "confidence": round(float(scores[i]), 3),
                    "detection_source": "yolo",
                }
            )
        return dets

    # -- YOLO via ultralytics ---------------------------------------------
    def _detect_pt(self, bgr):
        results = self.model.predict(bgr, verbose=False, imgsz=self.imgsz, conf=MIN_CONFIDENCE * 0.8)
        dets = []
        if not results:
            return dets
        for box in results[0].boxes:
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            dets.append(
                {
                    "bbox": {"x": round(x1), "y": round(y1), "w": round(x2 - x1), "h": round(y2 - y1)},
                    "confidence": round(float(box.conf[0]), 3),
                    "detection_source": "yolo",
                }
            )
        return dets

    # -- classical fallback ------------------------------------------------
    def _detect_classical(self, bgr):
        """Two cues, both restricted to the road surface below the horizon:

        * dark holes: local dark structure (black-hat) on low-saturation asphalt
        * water-filled holes: smooth, bright, low-saturation patches that are
          much brighter than the road around them (sky reflection)
        """
        img_h, img_w = bgr.shape[:2]
        scale = 960.0 / max(img_w, img_h) if max(img_w, img_h) > 960 else 1.0
        small = cv2.resize(bgr, None, fx=scale, fy=scale) if scale != 1.0 else bgr
        h, w = small.shape[:2]
        horizon = horizon_row(small)

        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        sat = hsv[:, :, 1]

        # Road mask: low saturation (drops grass, sky tint, painted kerbs).
        road = (sat < 90).astype(np.uint8) * 255
        road[:horizon, :] = 0

        k = max(31, (min(h, w) // 12) | 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)
        tophat = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel)

        dark = cv2.threshold(blackhat, 22, 255, cv2.THRESH_BINARY)[1]
        # Water: bright relative to surroundings AND smooth (low local variance).
        mean = cv2.blur(gray.astype(np.float32), (7, 7))
        var = cv2.blur(gray.astype(np.float32) ** 2, (7, 7)) - mean ** 2
        smooth = (var < 60).astype(np.uint8) * 255
        bright = cv2.threshold(tophat, 28, 255, cv2.THRESH_BINARY)[1]
        water = cv2.bitwise_and(bright, smooth)

        dets = []
        for mask, kind in ((dark, "dark"), (water, "water")):
            m = cv2.bitwise_and(mask, road)
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
            contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for c in contours:
                area = cv2.contourArea(c)
                x, y, bw, bh = cv2.boundingRect(c)
                # Expected on-screen size grows towards the bottom of the frame.
                depth_frac = (y + bh - horizon) / max(1, h - horizon)
                min_area = (h * w) * (0.0004 + 0.0025 * depth_frac)
                if area < min_area or area > h * w * 0.12:
                    continue
                aspect = bw / max(1, bh)
                if aspect > 7 or aspect < 0.6:  # potholes seen in perspective are wide, not tall
                    continue
                fill = area / max(1, bw * bh)
                if fill < 0.35:
                    continue
                hull = cv2.convexHull(c)
                solidity = area / max(1.0, cv2.contourArea(hull))
                if solidity < 0.7:
                    continue
                conf = 0.32 + 0.25 * fill + 0.2 * solidity + 0.1 * min(1.0, depth_frac)
                dets.append(
                    {
                        "bbox": {
                            "x": int(x / scale),
                            "y": int(y / scale),
                            "w": int(bw / scale),
                            "h": int(bh / scale),
                        },
                        "confidence": round(float(min(0.75, conf)), 3),
                        "detection_source": "classical",
                        "cue": kind,
                    }
                )

        dets.sort(key=lambda d: d["confidence"], reverse=True)
        kept = []
        for d in dets:
            if not any(_iou(d["bbox"], k["bbox"]) > 0.3 for k in kept):
                kept.append(d)
        return kept[:12]
