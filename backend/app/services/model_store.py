"""姿态模型文件管理（MediaPipe Tasks API 使用）。"""

from __future__ import annotations

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
