"""ONNX Runtime 版姿态引擎：保留 MediaPipe 的 33 关键点与人物掩码输出格式。

模型来自 OpenCV Zoo（Apache License 2.0）：
* 人体检测：person_detection_mediapipe_2023mar.onnx（224x224，SSD）
* 姿态关键点：pose_estimation_mediapipe_2023mar.onnx（256x256，33 点 + 掩码）

推理后端默认 DirectML（Windows 上无需安装 CUDA），可用
DANCEMATE_ORT_PROVIDER=cpu 强制回退 CPU。
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

import cv2
import numpy as np

from ...config import ORT_DETECT_INTERVAL, ORT_PROVIDER
from ..model_store import ensure_onnx_pose_models
from .mp_persondet import MPPersonDet
from .mp_pose import MPPose
from .ort_net import OrtNet

logger = logging.getLogger("dancemate.pose")


class OnnxPoseEngine:
    MASK_SIZE = 96

    def __init__(
        self,
        model_complexity: int = 0,
        static_image_mode: bool = False,
        smooth_landmarks: bool = True,
        name: str = "pose-onnx",
        variant: str = "lite",
        with_segmentation: bool = False,
        provider: str = ORT_PROVIDER,
        detect_interval: int = ORT_DETECT_INTERVAL,
    ) -> None:
        self._with_segmentation = with_segmentation
        self._provider = provider
        self._detect_interval = max(1, detect_interval)
        self._pose: Optional[MPPose] = None
        self._det: Optional[MPPersonDet] = None
        self._person: Optional[np.ndarray] = None
        self._since_detect = 0
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=name)
        self.providers: List[str] = []

    def _ensure_model(self) -> None:
        if self._pose is not None:
            return
        with self._lock:
            if self._pose is not None:
                return
            pose_path, det_path = ensure_onnx_pose_models()
            det_net = OrtNet(str(det_path), provider=self._provider)
            pose_net = OrtNet(str(pose_path), provider=self._provider)
            self._det = MPPersonDet(str(det_path), net=det_net)
            self._pose = MPPose(str(pose_path), net=pose_net)
            self.providers = pose_net.providers
            logger.info("ONNX 姿态模型已加载：%s", self.providers)

    def _encode_mask(self, mask: Optional[np.ndarray]) -> Optional[bytes]:
        if mask is None:
            return None
        binary = (np.asarray(mask) > 127).astype(np.uint8) * 255
        resized = cv2.resize(binary, (self.MASK_SIZE, self.MASK_SIZE), interpolation=cv2.INTER_AREA)
        rgba = np.empty((self.MASK_SIZE, self.MASK_SIZE, 4), dtype=np.uint8)
        rgba[..., 0:3] = 255
        rgba[..., 3] = resized
        ok, buffer = cv2.imencode(".png", rgba)
        return buffer.tobytes() if ok else None

    def _detect_person(self, frame_bgr: np.ndarray) -> Optional[np.ndarray]:
        # 检测器比姿态模型更贵，中间帧沿用上一帧的 ROI；丢人时立即重检
        if self._person is not None and self._since_detect < self._detect_interval:
            self._since_detect += 1
            return self._person
        persons = self._det.infer(frame_bgr)
        self._since_detect = 0
        if persons is None or len(persons) == 0:
            self._person = None
            return None
        # 实时跟练只保留画面中最可信的一个人
        self._person = persons[int(np.argmax(persons[:, 12]))]
        return self._person

    def _infer(self, frame_bgr: np.ndarray):
        self._ensure_model()
        height, width = frame_bgr.shape[:2]
        person = self._detect_person(frame_bgr)
        if person is None:
            return None, None
        result = self._pose.infer(frame_bgr, person)
        if result is None:
            self._person = None  # 姿态失败，下一帧强制重新检测
            return None, None
        _bbox, landmarks, _world, mask, _heatmap, _conf = result
        pose = [
            [
                round(float(x) / width, 4),
                round(float(y) / height, 4),
                round(float(z) / width, 4),
                round(float(visibility), 3),
            ]
            for x, y, z, visibility, _presence in landmarks[:-6]
        ]
        return pose, self._encode_mask(mask) if self._with_segmentation else None

    # ---------- 同步接口 ----------
    def estimate_sync_with_mask(self, frame_bgr: np.ndarray):
        return self._infer(frame_bgr)

    def estimate_sync(self, frame_bgr: np.ndarray):
        pose, _mask = self._infer(frame_bgr)
        return pose

    def estimate_jpeg_sync(self, data: bytes):
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return None
        return self.estimate_sync(frame)

    # ---------- 异步接口（实时链路用） ----------
    async def estimate_jpeg_with_mask(self, data: bytes):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._estimate_jpeg_sync, data)

    async def estimate_jpeg_with_mask_timed(self, data: bytes):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._estimate_jpeg_timed, data)

    async def estimate_jpeg(self, data: bytes):
        pose, _mask = await self.estimate_jpeg_with_mask(data)
        return pose

    async def estimate_frame(self, frame_bgr: np.ndarray):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self.estimate_sync, frame_bgr)

    def _estimate_jpeg_sync(self, data: bytes):
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return None, None
        return self._infer(frame)

    def _estimate_jpeg_timed(self, data: bytes):
        started = time.perf_counter()
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        decoded = time.perf_counter()
        if frame is None:
            empty = {"decode_ms": round((decoded - started) * 1000, 1), "infer_ms": 0.0, "mask_ms": 0.0}
            return None, None, empty
        pose, mask = self._infer(frame)
        finished = time.perf_counter()
        return pose, mask, {
            "decode_ms": round((decoded - started) * 1000, 1),
            "infer_ms": round((finished - decoded) * 1000, 1),
            "mask_ms": 0.0,
        }

    def close(self) -> None:
        self._pose = None
        self._det = None
        self._executor.shutdown(wait=False)
