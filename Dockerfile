FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DANCEMATE_HOST=0.0.0.0 \
    DANCEMATE_PORT=8000

# MediaPipe / OpenCV 运行时依赖
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install -r /app/backend/requirements.txt

COPY . /app

# 构建期预下载姿态模型（约 5.5MB），避免运行时依赖外网
RUN cd /app/backend \
    && python -c "from app.services.model_store import ensure_pose_model; ensure_pose_model('lite')"

WORKDIR /app/backend
EXPOSE 8000

CMD ["python", "run.py"]
