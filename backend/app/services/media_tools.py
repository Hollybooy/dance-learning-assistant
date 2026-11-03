"""视频探测、转码与通用小工具。"""

from __future__ import annotations

import math
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List

import cv2


def ffmpeg_exe() -> str:
    """返回内置 ffmpeg 可执行文件路径（imageio-ffmpeg 自带，免安装）。"""
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def transcode_to_h264(src: Path, dst: Path) -> None:
    """转码为浏览器兼容的 H.264 + AAC（微信等来源常见 HEVC，Chrome 无法解码）。

    * yuv420p：保证所有显卡/浏览器都能渲染
    * +faststart：moov 前置，边下边播、拖动进度条秒响应
    """
    cmd = [
        ffmpeg_exe(),
        "-y",
        "-i",
        str(src),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(dst),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )
    if result.returncode != 0:
        raise RuntimeError(f"视频转码失败：{result.stderr[-500:]}")


def probe_duration(path: Path) -> float:
    """读取视频时长（秒）。失败返回 0。"""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return 0.0
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        if fps > 0 and frames > 0:
            return round(frames / fps, 3)
        return 0.0
    finally:
        cap.release()


def build_segments(duration: float, segment_seconds: float) -> List[Dict[str, Any]]:
    """按固定时间间隔切片。"""
    if duration <= 0 or segment_seconds <= 0:
        return []
    segments: List[Dict[str, Any]] = []
    count = int(math.ceil(duration / segment_seconds))
    for i in range(count):
        start = i * segment_seconds
        end = min(start + segment_seconds, duration)
        segments.append(
            {
                "index": i,
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
            }
        )
    return segments


def safe_id(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{6,32}", value))


def title_from_filename(filename: str) -> str:
    return Path(filename).stem or "未命名教学视频"
