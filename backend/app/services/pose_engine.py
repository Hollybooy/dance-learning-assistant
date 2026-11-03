"""MediaPipe Pose 封装（兼容 Legacy Solutions 与 Tasks API）。

关键设计（低延时）：
* 每个引擎固定单线程执行器，推理严格串行，避免 MediaPipe 实例并发不安全；
* 实时链路只保留"最新一帧"，旧帧直接丢弃（不排队），端到端延时稳定在 1 帧推理时间；
* 模型复杂度默认 Lite，输入分辨率由前端压到 640x480；
* mediapipe >= 0.10.20 / 1.x 已移除 legacy solutions 时，自动切换到 Tasks API。
"""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

import cv2
import numpy as np

from ..config import POSE_MODEL_COMPLEXITY, POSE_MODEL_VARIANT
from .model_store import ensure_pose_model


class PoseEngine:
    """串行执行 MediaPipe Pose 推理的引擎。"""

    def __init__(
        self,
        model_complexity: int = POSE_MODEL_COMPLEXITY,
        static_image_mode: bool = False,
        smooth_landmarks: bool = True,
        name: str = "pose",
        variant: str = POSE_MODEL_VARIANT,
    ) -> None:
        self._model_complexity = model_complexity
        self._static_image_mode = static_image_mode
        self._smooth = smooth_landmarks
        self._variant = variant
        self._impl: Optional[str] = None
        self._pose = None
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=name)
        self._timestamp_ms = 0

    # ---------- 内部 ----------

    def _ensure_model(self):
        if self._pose is not None:
            return self._pose
        with self._lock:
            if self._pose is not None:
                return self._pose

            import mediapipe as mp

            self._mp = mp
            legacy = getattr(mp, "solutions", None)
            legacy_pose = getattr(legacy, "pose", None) if legacy else None

            if legacy_pose is not None:
                self._impl = "solutions"
                self._pose = legacy_pose.Pose(
                    static_image_mode=self._static_image_mode,
                    model_complexity=self._model_complexity,
                    smooth_landmarks=self._smooth,
                    enable_segmentation=False,
                    min_detection_confidence=0.5,
                    min_tracking_confidence=0.5,
                )
            else:
                from mediapipe.tasks import python as mp_python
                from mediapipe.tasks.python import vision

                self._impl = "tasks"
                model_path = ensure_pose_model(self._variant)
                options = vision.PoseLandmarkerOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
                    running_mode=vision.RunningMode.VIDEO,
                    num_poses=1,
                    min_pose_detection_confidence=0.5,
                    min_pose_presence_confidence=0.5,
                    min_tracking_confidence=0.5,
                )
                self._pose = vision.PoseLandmarker.create_from_options(options)
        return self._pose

    # ---------- 同步接口（离线分析用） ----------

    def estimate_sync(self, frame_bgr: np.ndarray) -> Optional[List[List[float]]]:
        """返回 33 个关键点 [[x, y, z, visibility], ...]，未检测到返回 None。"""
        pose = self._ensure_model()
        mp = self._mp
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False

        if self._impl == "solutions":
            result = pose.process(rgb)
            landmarks = result.pose_landmarks.landmark if result.pose_landmarks else None
        else:
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            self._timestamp_ms += 33
            result = pose.detect_for_video(image, self._timestamp_ms)
            landmarks = result.pose_landmarks[0] if result.pose_landmarks else None

        if not landmarks:
            return None
        return [
            [
                round(lm.x, 4),
                round(lm.y, 4),
                round(lm.z, 4),
                round(getattr(lm, "visibility", 1.0) or 1.0, 3),
            ]
            for lm in landmarks
        ]

    def estimate_jpeg_sync(self, data: bytes) -> Optional[List[List[float]]]:
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return None
        return self.estimate_sync(frame)

    # ---------- 异步接口（实时链路用） ----------

    async def estimate_jpeg(self, data: bytes) -> Optional[List[List[float]]]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self.estimate_jpeg_sync, data)

    async def estimate_frame(self, frame_bgr: np.ndarray) -> Optional[List[List[float]]]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self.estimate_sync, frame_bgr)

    def close(self) -> None:
        try:
            if self._pose is not None:
                self._pose.close()
        finally:
            self._pose = None
            self._executor.shutdown(wait=False)


# 实时链路共享引擎：所有 WebSocket 会话串行使用，保证 CPU 不被多路抢占
live_pose_engine = PoseEngine(model_complexity=POSE_MODEL_COMPLEXITY, name="pose-live")
