"""全局配置：路径、切片参数、实时链路参数。"""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent

DATA_DIR = Path(os.getenv("DANCEMATE_DATA_DIR") or (BACKEND_DIR / "data")).resolve()
VIDEO_DIR = DATA_DIR / "videos"
SESSION_DIR = DATA_DIR / "sessions"
FRONTEND_DIR = PROJECT_DIR

# 教学视频切片间隔（秒），与前端 js/catalog.js 的 SLICE_SECONDS 保持一致
SEGMENT_SECONDS = float(os.getenv("DANCEMATE_SEGMENT_SECONDS", "7"))

# 教学视频骨架采样帧率：15fps 足够逐帧对比，且离线分析速度可接受
TEACH_SAMPLE_FPS = float(os.getenv("DANCEMATE_TEACH_FPS", "15"))

# 录制回放采样帧率：24fps 保证回放流畅；磁盘约 1MB/s，可接受
RECORD_FPS = float(os.getenv("DANCEMATE_RECORD_FPS", "24"))

# MediaPipe 模型复杂度：0 = Lite，实时链路优先低延时
POSE_MODEL_COMPLEXITY = int(os.getenv("DANCEMATE_POSE_COMPLEXITY", "0"))

# Tasks API 模型变体：lite / full
POSE_MODEL_VARIANT = os.getenv("DANCEMATE_POSE_MODEL", "lite")

# 推理后端：mediapipe（默认）/ onnx / auto（有 ONNX Runtime 与模型时走 ONNX）
# 暗光实测（同一段夜间练习录像 322 帧，人体检测+姿态，逐帧统计"完全无结果"）：
#   MediaPipe  丢 40 帧（12%），avg 17.7ms —— VIDEO 模式带跨帧跟踪，抓不住时会沿用 ROI
#   ONNX+DML   丢 122 帧（38%），avg 14.7ms —— 逐帧独立推理，暗光/头部出画/动态模糊下直接失败
# GPU 只快 3ms，却多丢 2.4 倍的帧，实时跟练观感明显更差，所以默认仍用 MediaPipe。
# 显存/算力充足、或换成更大模型（RTMPose 等）时再显式设 onnx。
POSE_BACKEND = os.getenv("DANCEMATE_POSE_BACKEND", "mediapipe").strip().lower()

# ONNX Runtime 执行提供程序：dml（默认，Windows GPU）/ cuda / cpu
# 运行时没有对应 EP 会自动回退 CPU（见 onnx_pose/ort_net.py），跨平台安全。
# 注意：DML 同时跑骨架 + YOLO 两个会话会偶发 0x80004005，阴影默认已走 blazepose，
# 不要再把 DANCEMATE_MASK_BACKEND 设成 yolo。
ORT_PROVIDER = os.getenv("DANCEMATE_ORT_PROVIDER", "dml").strip().lower()

# ONNX 后端每隔多少帧重跑一次人体检测（中间帧沿用上一帧的 ROI，降低耗时）
# 6 帧太保守：跳舞时人动得快，ROI 过期会导致跟丢/骨架停顿，3 帧折中
ORT_DETECT_INTERVAL = max(1, int(os.getenv("DANCEMATE_ORT_DETECT_INTERVAL", "3")))

# 人物阴影来源：blazepose（与骨架同一次推理，默认）或 yolo（YOLO26n-seg）
# 实测同一台机器（录制帧回放）：YOLO 阴影每帧平均 26ms / p95 63ms，
# blazepose 阴影直接复用姿态模型的分割输出，平均 19ms / p95 34ms。
# 阴影只是装饰，默认走 blazepose，不额外抢 CPU、也不会让实时骨架出现长尾卡顿。
MASK_BACKEND = os.getenv("DANCEMATE_MASK_BACKEND", "blazepose").strip().lower()

# YOLO 分割模型输入尺寸与更新间隔（按帧计，中间帧复用上一张掩码）
# 仅当显式切回 MASK_BACKEND=yolo 时生效：640 输入单次约 90ms，每 4 帧跑一次
YOLO_IMGSZ = int(os.getenv("DANCEMATE_YOLO_IMGSZ", "640"))
YOLO_MASK_INTERVAL = max(1, int(os.getenv("DANCEMATE_YOLO_MASK_INTERVAL", "4")))

# 本地语音助手：麦克风常驻 + 唤醒词 + faster-whisper + Ollama 意图解析
VOICE_ENABLED = os.getenv("DANCEMATE_VOICE", "1").strip() != "0"
VOICE_WAKE_WORD = os.getenv("DANCEMATE_WAKE_WORD", "小教练").strip() or "小教练"
VOICE_SAMPLE_RATE = 16000
WHISPER_MODEL = os.getenv("DANCEMATE_WHISPER_MODEL", "whisper-base").strip()
WHISPER_COMPUTE = os.getenv("DANCEMATE_WHISPER_COMPUTE", "int8").strip()
OLLAMA_URL = os.getenv("DANCEMATE_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("DANCEMATE_OLLAMA_MODEL", "qwen2.5:1.5b-instruct").strip()

# 中文语音合成（播报）：kokoro（本地 Kokoro-82M，固定普通话音色，不依赖系统语音包）/ off
# 音色：zf_xiaoxiao（女声，标准普通话）；另有 zf_xiaobei/zf_xiaoni/zf_xiaoyi、zm_yunxi 等
TTS_BACKEND = os.getenv("DANCEMATE_TTS_BACKEND", "kokoro").strip().lower()
TTS_VOICE = os.getenv("DANCEMATE_TTS_VOICE", "zf_xiaoxiao").strip() or "zf_xiaoxiao"

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
