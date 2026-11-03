"""全局配置：路径、切片参数、实时链路参数。"""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent

DATA_DIR = Path(os.getenv("DANCEMATE_DATA_DIR") or (BACKEND_DIR / "data")).resolve()
VIDEO_DIR = DATA_DIR / "videos"
SESSION_DIR = DATA_DIR / "sessions"
FRONTEND_DIR = PROJECT_DIR

# 教学视频切片间隔（秒），与前端轮播图一致
SEGMENT_SECONDS = float(os.getenv("DANCEMATE_SEGMENT_SECONDS", "10"))

# 教学视频骨架采样帧率：15fps 足够逐帧对比，且离线分析速度可接受
TEACH_SAMPLE_FPS = float(os.getenv("DANCEMATE_TEACH_FPS", "15"))

# 录制回放采样帧率：12fps 保证回放流畅且磁盘占用可控
RECORD_FPS = float(os.getenv("DANCEMATE_RECORD_FPS", "12"))

# MediaPipe 模型复杂度：0 = Lite，实时链路优先低延时
POSE_MODEL_COMPLEXITY = int(os.getenv("DANCEMATE_POSE_COMPLEXITY", "0"))

# Tasks API 模型变体：lite / full
POSE_MODEL_VARIANT = os.getenv("DANCEMATE_POSE_MODEL", "lite")

# 关键点可见度阈值
POSE_MIN_VISIBILITY = float(os.getenv("DANCEMATE_POSE_MIN_VIS", "0.3"))

MAX_UPLOAD_BYTES = int(os.getenv("DANCEMATE_MAX_UPLOAD_MB", "800")) * 1024 * 1024

VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".m4v", ".mkv"}

MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
}


def ensure_dirs() -> None:
    for path in (DATA_DIR, VIDEO_DIR, SESSION_DIR):
        path.mkdir(parents=True, exist_ok=True)
