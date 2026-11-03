"""教学视频离线骨架提取。

输出 pose.json：
    {"sample_fps": 15, "landmarks": 33, "frames": [{"t": 0.0, "pose": [[x,y,z,v], ...] | null}, ...]}
坐标已归一化（0~1），前端按视频显示区域映射即可。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable, Dict, Optional

import cv2

from ..config import POSE_MODEL_COMPLEXITY
from .pose_engine import PoseEngine


def extract_teaching_pose(
    video_path: Path,
    out_path: Path,
    sample_fps: float,
    progress: Optional[Callable[[float], None]] = None,
) -> Dict[str, float]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError("无法读取视频文件（编码不受支持？）")

    engine = PoseEngine(
        model_complexity=POSE_MODEL_COMPLEXITY,
        static_image_mode=False,
        smooth_landmarks=True,
        name="pose-teach",
    )

    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        step = max(1, int(round(fps / max(sample_fps, 1.0))))
        frames = []
        index = 0
        last_report = 0.0

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if index % step == 0:
                frames.append(
                    {"t": round(index / fps, 3), "pose": engine.estimate_sync(frame)}
                )
                if progress and total:
                    now = time.monotonic()
                    if now - last_report > 0.6:
                        progress(min(0.99, index / total))
                        last_report = now
            index += 1
    finally:
        cap.release()
        engine.close()

    payload = {
        "sample_fps": round(sample_fps, 3),
        "landmarks": 33,
        "frames": frames,
    }
    tmp = out_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, out_path)

    if progress:
        progress(1.0)

    return {"frames": len(frames), "fps": round(sample_fps, 3)}


def load_pose_frames(
    pose_path: Path, start: Optional[float] = None, end: Optional[float] = None
) -> Dict[str, object]:
    if not pose_path.exists():
        return {"sample_fps": 0, "frames": [], "ready": False}
    payload = json.loads(pose_path.read_text(encoding="utf-8"))
    frames = payload.get("frames", [])
    if start is not None or end is not None:
        lo = start or 0.0
        hi = end if end is not None else float("inf")
        frames = [f for f in frames if lo <= f["t"] <= hi]
    return {
        "sample_fps": payload.get("sample_fps", 0),
        "landmarks": 33,
        "ready": True,
        "frames": frames,
    }
