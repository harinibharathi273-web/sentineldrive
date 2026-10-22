# SentinelDrive

Road safety operations for Indian cities, in one web app:

- **Pothole reporting to repair.** Upload a road photo or dashcam clip. A fine-tuned YOLOv8 model finds every pothole, estimates its size, and prices the repair from an editable INR rate card with GST. Each site gets an address from OpenStreetMap, a priority score, a status workflow (reported → verified → scheduled → repaired) and a printable PDF work order with the photo evidence.
- **Driver alertness.** The browser camera tracks the driver’s eyes and head (MediaPipe, on the device; video never leaves it). Thresholds are calibrated to each driver. When drowsy, the driver gets a spoken question and answers by voice; no answer sounds an alarm.
- **Crash detection.** A phone on the dashboard watches for impacts and confirms them with GPS speed and the impact sound before anything is escalated. The driver gets 20 seconds to tap “I’m OK”, then one-tap buttons to call 112 or text a contact their location.
- **Emergency vehicles.** The microphone recognises wail, yelp and hi-lo sirens and tells the driver to give way.

No numbers in the app are made up. If a sensor is off, the screen says so.

---

## Run it

You need **Python 3.10+** and **Node.js 18+**.

### 1. Backend (port 8000)

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate      macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

**Install the pothole model (one time, recommended).** Without it the app falls back to a basic image method that misses many potholes.

```bash
pip install -r requirements-ml.txt     # ultralytics + onnx, only needed for this step
python scripts/get_model.py            # downloads and converts to models/pothole.onnx
```

After this the backend only needs OpenCV to run the model. You can uninstall `ultralytics` if you want.

Start the server:

```bash
uvicorn app.main:app --reload --port 8000
```

Check http://localhost:8000/api/health. It should say `"tier": "yolo-onnx"`.

### 2. Frontend (port 5173)

```bash
cd frontend
npm install
npm run dev
```

Open the **https** address Vite prints. Your browser warns once about the self-signed certificate; choose *Advanced → Proceed*. HTTPS is required because browsers only allow the camera, microphone, motion sensor and GPS on secure pages.

### 3. Use a phone as the in-car device

1. Put the phone and laptop on the same Wi-Fi (or the phone’s hotspot).
2. On the phone, open the **Network** address Vite printed, e.g. `https://192.168.1.20:5173`, and accept the certificate warning.
3. Tap **Start monitoring** and allow camera, microphone, motion and location.
4. Mount it facing the driver. The laptop dashboard updates live.

Crash detection needs a real phone; laptops have no accelerometer. On iPhone, motion access is asked for when you tap Start monitoring.

### One-process demo

`npm run build` in `frontend/`, then the backend serves the built app at http://localhost:8000 (no Vite needed). Use the Vite HTTPS setup when a phone is involved.

---

## Deploy online (free, with a real HTTPS link)

The `Dockerfile` builds the website, downloads and converts the pothole model, and serves everything from one port. `render.yaml` sets it up on [Render](https://render.com).

1. Push this folder to a GitHub repository.
2. On Render: **New → Blueprint**, pick the repository, then **Apply**. The first build takes about 10–15 minutes.
3. Open the `https://…onrender.com` address. `/api/health` should show `"tier": "yolo-onnx"`.
4. Open the same address on a phone; it already has a valid certificate, so the sensors work.

Free-plan limits: the service sleeps after 15 minutes without visitors and takes about a minute to wake, and its disk is wiped when it sleeps or redeploys, so reports disappear. For data that stays, use a paid instance and attach a persistent disk mounted at `/data`.

The same image runs anywhere Docker runs (Railway, Fly.io, a VPS): `docker build -t sentineldrive . && docker run -p 8000:8000 -v sentinel-data:/data sentineldrive`.

---

## Trying each feature

| Feature | How to try it |
|---|---|
| Pothole detection | **Report a pothole** → take or choose a photo of a damaged road (or a short MP4 dashcam clip). |
| Duplicate merging | Report the same spot twice with location on: the second is added to the first site. |
| Missing location | Upload without location → open the site → click on the map to place it. |
| Work order PDF | Open a site → **Work order PDF**. |
| Rate card | Settings → change a rate → Save. All open sites are re-priced. |
| Alertness | Driver monitor → Start monitoring → look ahead 5 s to calibrate → close your eyes for 4–5 s. |
| Siren | Play an ambulance siren video near the microphone while monitoring. |
| Crash | On a phone with monitoring on, give it a sharp knock against your palm near the mic. A knock is checked and usually filtered as “not a crash”; a hard impact with a loud bang is confirmed. Never test in a moving vehicle. |

---

## How it works

```
Phone / laptop browser                         Backend (FastAPI, SQLite)
──────────────────────                         ─────────────────────────
Camera → MediaPipe face mesh → eye & head      /ws   live events both ways
  scores (video stays on device)  ─────────▶   alertness check, crash checks,
Microphone → siren & impact-sound analysis        siren events
Accelerometer + GPS → impact candidates
Photo/clip → faces & plates blurred ───────▶   /api/potholes/upload
  on device, then uploaded                        YOLOv8 (ONNX via OpenCV)
                                                  → size estimate → rate card
                                                  → OpenStreetMap address
                                                  → site, PDF work order
```

- **Storage.** `backend/data/sentinel.db` (SQLite) and `backend/data/media/` for photos. Delete the folder to start fresh.
- **Pothole size** is estimated from one camera using the camera height, field of view and the horizon line in the frame. It is labelled as an estimate everywhere; confirm on site before cutting. Stereo cameras or LiDAR would be needed for measured volumes.
- **Severity:** high if deeper than 50 mm or larger than 0.5 m²; medium from 25 mm or 0.15 m²; otherwise low.
- **Priority (0–100):** severity band plus total area, number of potholes, repeat reports and days waiting.
- **Cost:** material tonnes (volume × density × wastage) × rate + tack coat + edge cutting + labour + barricading, then GST. Every rate is editable.
- **Alertness score (0–10):** PERCLOS (share of the last minute with eyes closed) scaled so 20 % → 5 and 32 % → 8, plus a bonus for an eye closure longer than 1.5 s, or a sustained head drop, whichever is higher. The eye threshold is 72 % of the driver’s own open-eye level.
- **Crash rule:** ≥ 8 g on its own, or ≥ 4 g with a GPS speed drop of 20 km/h or an impact sound 20 dB over the cabin level.

## Configuration

Environment variables (see `backend/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `SENTINEL_GEOCODER` | `nominatim` | `off` to skip address lookups (no internet at a venue) |
| `SENTINEL_API_KEY` | `change-me` | Key for `GET /api/b2g/work-orders` (municipal integration) |
| `SENTINEL_ALERT_WEBHOOK` | empty | URL that receives a JSON POST when a crash is escalated (Slack, n8n, Zapier, a Telegram bot) |
| `SENTINEL_DEDUP_RADIUS_M` | `8` | Reports closer than this join the same site |
| `SENTINEL_MIN_CONFIDENCE` | `0.30` | Detector confidence cut-off |
| `SENTINEL_DATA_DIR` | `backend/data` | Where the database and photos live |

## API

| Method | Path | |
|---|---|---|
| POST | `/api/potholes/upload` | multipart `file` (+ `frames`, `lat`, `lng`, `accuracy_m`, `note`) |
| GET | `/api/potholes` | all sites; `?status=reported,verified` |
| GET/PATCH/DELETE | `/api/potholes/{id}` | PATCH `{status, note, lat, lng}` |
| GET | `/api/potholes/{id}/work-order.pdf` | printable work order |
| GET | `/api/potholes/export.csv` | spreadsheet export |
| GET | `/api/b2g/work-orders` | open work orders by priority, header `X-API-Key` |
| GET | `/api/incidents`, `/api/alertness-checks`, `/api/stats`, `/api/health` | |
| GET/PUT | `/api/settings/rate-card`, `/api/settings/preferences` | |
| WS | `/ws` | live events |

## Tests

```bash
cd backend && pip install pytest httpx && python -m pytest
cd frontend && npm test
```

## Model and data credits

- Pothole model: YOLOv8n fine-tuned by [Shushruth18/pothole-detection-project](https://github.com/Shushruth18/pothole-detection-project) on the [Annotated Potholes Image Dataset](https://www.kaggle.com/datasets/chitholian/annotated-potholes-dataset) (A. R. Chitholian). Held-out test: precision 0.63, recall 0.70, mAP@50 0.72. It is downloaded at setup rather than bundled because its author has not declared a licence; Ultralytics YOLO weights are AGPL-3.0. For a commercial deployment, train your own model on Indian road images you have rights to (Ultralytics `yolo train` on a YOLO-format dataset, then export to ONNX and save as `backend/models/pothole.onnx`).
- Face tracking: Google MediaPipe Tasks (Apache-2.0).
- Maps and addresses: © OpenStreetMap contributors, tiles by CARTO. Nominatim allows at most one request per second; results are cached.

## Known limits

- Sizes are camera estimates (see above). Night, rain glare and heavy shadow reduce detection quality.
- Siren detection can be triggered by music with siren-like sweeps. It only gives advice; it never takes control.
- Crash detection depends on the phone being firmly mounted. It is a driver aid, not a certified eCall system.
- One vehicle per server in this MVP: the live driver state is shared by all connected screens.
