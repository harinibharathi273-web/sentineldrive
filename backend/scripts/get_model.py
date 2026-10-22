"""Download the fine-tuned pothole detector and convert it to ONNX.

    pip install -r requirements-ml.txt     # ultralytics + onnx (one time)
    python scripts/get_model.py

Model: YOLOv8n fine-tuned on the Annotated Potholes Image Dataset
(A. R. Chitholian, Kaggle) by Shushruth18/pothole-detection-project.
Held-out test set: precision 0.63, recall 0.70, mAP@50 0.72, mAP@50-95 0.44.

The checkpoint is fetched from its public GitHub repository (pinned commit,
SHA-256 verified) instead of being bundled, because its author has not declared
a licence. Ultralytics YOLO weights are AGPL-3.0. If you deploy commercially,
train your own model on data you are allowed to use (README, "Train your own").

After conversion only OpenCV is needed at runtime; the backend picks up
models/pothole.onnx automatically on its next start.
"""

import hashlib
import shutil
import sys
import urllib.request
from pathlib import Path

COMMIT = "8d2432eb34c01df6f16c427bbc6616b3da678b90"
URL = f"https://raw.githubusercontent.com/Shushruth18/pothole-detection-project/{COMMIT}/models/best.pt"
SHA256 = "273f77ec361371ec1d4e344ad3443c85a965aebd073469c9deca8ab315a58a6a"

MODELS = Path(__file__).resolve().parent.parent / "models"


def main():
    MODELS.mkdir(parents=True, exist_ok=True)
    pt = MODELS / "pothole.pt"
    if not pt.exists():
        print(f"Downloading {URL}")
        with urllib.request.urlopen(URL, timeout=60) as r, open(pt, "wb") as f:
            shutil.copyfileobj(r, f)
    digest = hashlib.sha256(pt.read_bytes()).hexdigest()
    if digest != SHA256:
        pt.unlink()
        sys.exit(f"Checksum mismatch ({digest}). The file was removed; try again.")
    print(f"Checkpoint OK: {pt}")

    try:
        from ultralytics import YOLO
    except ImportError:
        print(
            "Downloaded, but converting it needs ultralytics, which is not installed.\n"
            "Run `pip install -r requirements-ml.txt`, then run this script again."
        )
        return

    out = YOLO(str(pt)).export(format="onnx", imgsz=640, opset=12, simplify=True, dynamic=False)
    onnx = Path(out)
    if onnx.resolve() != (MODELS / "pothole.onnx").resolve():
        shutil.move(str(onnx), MODELS / "pothole.onnx")
    print(f"ONNX model ready: {MODELS / 'pothole.onnx'}\nRestart the backend to use it.")


if __name__ == "__main__":
    main()
