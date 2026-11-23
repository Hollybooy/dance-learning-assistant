"""姿态模型文件管理（MediaPipe Tasks API 使用）。"""

from __future__ import annotations

import os
import urllib.request
from pathlib import Path

from ..config import BACKEND_DIR

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
    if target.exists() and target.stat().st_size > 0:
        return target

    tmp = target.with_suffix(".tmp")
    try:
        with urllib.request.urlopen(url, timeout=60) as response, open(tmp, "wb") as out:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        tmp.replace(target)
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise RuntimeError(
            f"姿态模型下载失败，请手动下载 {name} 放到 {MODEL_DIR}：{exc}"
        ) from exc
    return target


def _download(target: Path, url: str, hint: str) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return target
    tmp = target.with_suffix(".tmp")
    try:
        with urllib.request.urlopen(url, timeout=180) as response, open(tmp, "wb") as out:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        tmp.replace(target)
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{hint} 下载失败，可手动下载后放到 {target}：{exc}") from exc
    return target


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
