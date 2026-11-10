"""教学视频离线骨架提取。

输出 pose.json：
    {"sample_fps": 15, "landmarks": 33, "frames": [{"t": 0.0, "pose": [[x,y,z,v], ...] | null}, ...]}
坐标已归一化（0~1），前端按视频显示区域映射即可。

同时输出 masks.bin（人物分割掩码，与 pose.json 帧一一对应）：
    每帧 = uint32(LE) 长度 + PNG 字节（灰度 0/255），无人帧长度为 0。
"""

from __future__ import annotations

import json
import os
import struct
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

import cv2

from ..config import POSE_MODEL_COMPLEXITY
from .pose_engine import PoseEngine


def extract_teaching_pose(
    video_path: Path,
    out_path: Path,
    sample_fps: float,
    progress: Optional[Callable[[float], None]] = None,
    masks_out_path: Optional[Path] = None,
) -> Dict[str, float]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError("无法读取视频文件（编码不受支持？）")

    engine = PoseEngine(
        model_complexity=POSE_MODEL_COMPLEXITY,
        static_image_mode=False,
        smooth_landmarks=True,
        name="pose-teach",
        with_segmentation=masks_out_path is not None,
    )

    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        step = max(1, int(round(fps / max(sample_fps, 1.0))))
        frames = []
        masks: List[bytes] = []
        index = 0
        last_report = 0.0

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if index % step == 0:
                pose, mask = engine.estimate_sync_with_mask(frame)
                frames.append({"t": round(index / fps, 3), "pose": pose})
                masks.append(mask or b"")
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

    if masks_out_path is not None:
        tmp_masks = masks_out_path.with_suffix(".tmp")
        with open(tmp_masks, "wb") as fh:
            for data in masks:
                fh.write(struct.pack("<I", len(data)))
                fh.write(data)
        os.replace(tmp_masks, masks_out_path)

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
