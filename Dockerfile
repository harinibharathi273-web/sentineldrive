# One container: builds the web app, prepares the pothole model, and serves
# everything (API + website) from a single port.

# ---- 1. Build the website ---------------------------------------------------
FROM node:20-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. Get the pothole model as ONNX ----------------------------------------
# Skipped automatically if backend/models/pothole.onnx is already in the repo.
FROM python:3.12-slim AS model
WORKDIR /backend
COPY backend/ ./
RUN if [ ! -f models/pothole.onnx ]; then \
      apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && \
      pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu && \
      pip install --no-cache-dir -r requirements-ml.txt onnxslim && \
      python scripts/get_model.py && \
      test -f models/pothole.onnx ; \
    fi

# ---- 3. Runtime --------------------------------------------------------------
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    SENTINEL_DATA_DIR=/data
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=model /backend/models/pothole.onnx ./models/pothole.onnx
COPY --from=web /web/dist /app/frontend/dist
RUN mkdir -p /data
EXPOSE 8000
# Hosting platforms pass the port in $PORT.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
