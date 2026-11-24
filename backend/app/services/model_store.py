"""姿态模型文件管理（MediaPipe Tasks API 使用）。"""

from __future__ import annotations

import os
from pathlib import Path

from ..config import BACKEND_DIR
from .net_download import fetch_file, url_candidates

MODEL_DIR = BACKEND_DIR / "models"

_MODELS = {
    "lite": (
        "pose_landmarker_lite.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    ),
    "full": (
        "pose_landmarker_full.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    ),
}

# OpenCV Zoo 的 ONNX 模型（Apache 2.0），与 MediaPipe 的 33 点 / 掩码输出对齐
_ONNX_MODELS = {
    "pose": (
        "pose_estimation_mediapipe_2023mar.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/"
        "pose_estimation_mediapipe/pose_estimation_mediapipe_2023mar.onnx",
        "DANCEMATE_ONNX_POSE_MODEL",
    ),
    "person": (
        "person_detection_mediapipe_2023mar.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/"
        "person_detection_mediapipe/person_detection_mediapipe_2023mar.onnx",
        "DANCEMATE_ONNX_PERSON_MODEL",
    ),
}


def ensure_pose_model(variant: str = "lite") -> Path:
    """返回模型路径，缺失时自动下载（约 5.5MB）。"""
    name, url = _MODELS.get(variant, _MODELS["lite"])
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    target = MODEL_DIR / name
    return fetch_file(
        url_candidates(url),
        target,
        timeout=60,
        hint=f"姿态模型 {name}（也可手动下载放到 {MODEL_DIR}）",
    )


def _download(target: Path, url: str, hint: str) -> Path:
    return fetch_file(
        url_candidates(url),
        target,
        timeout=180,
        hint=f"{hint}（也可手动下载放到 {target}）",
    )


def ensure_onnx_pose_models() -> tuple[Path, Path]:
    """返回 (姿态模型, 人体检测模型) 路径，缺失时自动下载。"""
    resolved = {}
    for key, (name, url, env_key) in _ONNX_MODELS.items():
        override = os.getenv(env_key)
        target = Path(override).expanduser() if override else MODEL_DIR / name
        resolved[key] = _download(target, url, f"ONNX 模型 {name}")
    return resolved["pose"], resolved["person"]


def yolo_mask_model_path(imgsz: int = 640) -> Path:
    override = os.getenv("DANCEMATE_YOLO_MODEL")
    return Path(override).expanduser() if override else MODEL_DIR / f"yolo26n-seg-{imgsz}.onnx"


def onnx_models_ready() -> bool:
    """两个 ONNX 模型是否已在本机，避免离线时自动切到 GPU 后端后首帧失败。"""
    for name, _url, env_key in _ONNX_MODELS.values():
        override = os.getenv(env_key)
        target = Path(override).expanduser() if override else MODEL_DIR / name
        if not target.exists() or target.stat().st_size == 0:
            return False
    return True


# Kokoro-82M 中文语音合成（Apache 2.0），模型 325MB + 音色包 28MB
KOKORO_DIR = MODEL_DIR / "kokoro"
_KOKORO_RELEASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)
_KOKORO_FILES = {
    "model": ("kokoro-v1.0.onnx", f"{_KOKORO_RELEASE}/kokoro-v1.0.onnx", "DANCEMATE_KOKORO_MODEL"),
    "voices": (
        "voices-v1.0.bin",
        f"{_KOKORO_RELEASE}/voices-v1.0.bin",
        "DANCEMATE_KOKORO_VOICES",
    ),
}


def _kokoro_path(key: str) -> Path:
    name, _url, env_key = _KOKORO_FILES[key]
    override = os.getenv(env_key)
    return Path(override).expanduser() if override else KOKORO_DIR / name


def kokoro_models_ready() -> bool:
    """模型与音色包是否都在本机（大小下限用于识别下载中断的半成品）。"""
    limits = {"model": 300 * 1024 * 1024, "voices": 20 * 1024 * 1024}
    for key, minimum in limits.items():
        target = _kokoro_path(key)
        if not target.exists() or target.stat().st_size < minimum:
            return False
    return True


def ensure_kokoro_models() -> tuple[Path, Path]:
    """返回 (模型, 音色包) 路径，缺失时自动下载（合计约 350MB，只下一次）。"""
    KOKORO_DIR.mkdir(parents=True, exist_ok=True)
    resolved = {}
    hints = {"model": "Kokoro 语音模型（325MB）", "voices": "Kokoro 音色包（28MB）"}
    for key, (name, url, _env) in _KOKORO_FILES.items():
        target = _kokoro_path(key)
        resolved[key] = fetch_file(
            url_candidates(url),
            target,
            timeout=120,
            hint=f"{hints[key]} {name}（也可手动下载放到 {target}）",
        )
    return resolved["model"], resolved["voices"]
