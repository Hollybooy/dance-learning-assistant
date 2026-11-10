"""MediaPipe Pose 封装（兼容 Legacy Solutions 与 Tasks API）。

关键设计（低延时）：
* 每个引擎固定单线程执行器，推理严格串行，避免 MediaPipe 实例并发不安全；
* 实时链路只保留"最新一帧"，旧帧直接丢弃（不排队），端到端延时稳定在 1 帧推理时间；
* 模型复杂度默认 Lite，输入分辨率由前端压到 640x480；
* mediapipe >= 0.10.20 / 1.x 已移除 legacy solutions 时，自动切换到 Tasks API。
"""

from __future__ import annotations

import asyncio
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

import cv2
import numpy as np

from ..config import POSE_MODEL_COMPLEXITY, POSE_MODEL_VARIANT
from .model_store import ensure_pose_model


class PoseEngine:
    """串行执行 MediaPipe Pose 推理的引擎。"""

    MASK_SIZE = 96  # 人物分割掩码统一缩放到的边长（前端再拉伸绘制）

    def __init__(
        self,
        model_complexity: int = POSE_MODEL_COMPLEXITY,
        static_image_mode: bool = False,
        smooth_landmarks: bool = True,
        name: str = "pose",
        variant: str = POSE_MODEL_VARIANT,
        with_segmentation: bool = False,
    ) -> None:
        self._model_complexity = model_complexity
        self._static_image_mode = static_image_mode
        self._smooth = smooth_landmarks
        self._variant = variant
        self._with_segmentation = with_segmentation
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
                    enable_segmentation=self._with_segmentation,
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
                    output_segmentation_masks=self._with_segmentation,
                )
                self._pose = vision.PoseLandmarker.create_from_options(options)
        return self._pose

    # ---------- 同步接口（离线分析用） ----------

    def _encode_mask(self, result) -> Optional[bytes]:
        """提取人物分割掩码并编码为 PNG。

        形状信息必须放在 alpha 通道（RGB 全白、A=人物区域），
        前端用 source-in 合成直接染色；灰度亮度通道无法参与 canvas 合成。
        掩码来自与骨架同一次推理（MediaPipe 自带人物分割），无需额外模型。
        """
        masks = getattr(result, "segmentation_masks", None)
        if not masks:
            return None
        raw = masks[0].numpy_view()
        binary = (raw[..., 0] > 0.5).astype(np.uint8) * 255
        resized = cv2.resize(binary, (self.MASK_SIZE, self.MASK_SIZE), interpolation=cv2.INTER_AREA)
        rgba = np.empty((self.MASK_SIZE, self.MASK_SIZE, 4), dtype=np.uint8)
        rgba[..., 0:3] = 255
        rgba[..., 3] = resized
        ok, buf = cv2.imencode(".png", rgba)
        return bytes(buf) if ok else None

    def _format_landmarks(self, landmarks) -> List[List[float]]:
        return [
            [
                round(lm.x, 4),
                round(lm.y, 4),
                round(lm.z, 4),
                round(getattr(lm, "visibility", 1.0) or 1.0, 3),
            ]
            for lm in landmarks
        ]

    def _detect(self, frame_bgr: np.ndarray):
        """执行一次推理，返回 (landmarks, result)。"""
        pose = self._ensure_model()
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False

        if self._impl == "solutions":
            result = pose.process(rgb)
            landmarks = result.pose_landmarks.landmark if result.pose_landmarks else None
        else:
            image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
            self._timestamp_ms += 33
            result = pose.detect_for_video(image, self._timestamp_ms)
            landmarks = result.pose_landmarks[0] if result.pose_landmarks else None
        return landmarks, result

    def estimate_sync(self, frame_bgr: np.ndarray) -> Optional[List[List[float]]]:
        """返回 33 个关键点 [[x, y, z, visibility], ...]，未检测到返回 None。"""
        landmarks, _ = self._detect(frame_bgr)
        if not landmarks:
            return None
        return self._format_landmarks(landmarks)

    def estimate_sync_with_mask(
        self, frame_bgr: np.ndarray
    ) -> "tuple[Optional[List[List[float]]], Optional[bytes]]":
        """返回 (关键点, 人物掩码 PNG)；未检测到人时返回 (None, None)。"""
        landmarks, result = self._detect(frame_bgr)
        if not landmarks:
            return None, None
        return self._format_landmarks(landmarks), self._encode_mask(result)

    def estimate_jpeg_sync(self, data: bytes) -> Optional[List[List[float]]]:
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return None
        return self.estimate_sync(frame)

    # ---------- 异步接口（实时链路用） ----------

    async def estimate_jpeg(self, data: bytes) -> Optional[List[List[float]]]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self.estimate_jpeg_sync, data)

    async def estimate_jpeg_with_mask(
        self, data: bytes
    ) -> "tuple[Optional[List[List[float]]], Optional[bytes]]":
        """推理并返回 (关键点, 人物掩码 PNG)，供实时阴影绘制。"""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._estimate_jpeg_mask_sync, data)

    def _estimate_jpeg_mask_sync(self, data: bytes):
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return None, None
        return self.estimate_sync_with_mask(frame)

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


# 实时链路共享引擎：所有 WebSocket 会话串行使用，保证 CPU 不被多路抢占；
# 开启人物分割掩码（与骨架同一次推理，供前端绘制人物阴影）
live_pose_engine = PoseEngine(model_complexity=POSE_MODEL_COMPLEXITY, name="pose-live", with_segmentation=True)


class PoseStabilizer:
    """实时骨架稳定器：异常漂移帧剔除 + 自适应平滑 + 丢帧补齐。

    - 漂移检测：用可见关节位移的**中位数**衡量整帧跳变（对个别点噪声不敏感），
      超过阈值判定为漂移帧，连续少量漂移帧直接沿用上一帧（等于补帧）；
      连续多帧大跳变则接受——那是真实的快速移动或重新入镜，不能永久冻结。
    - 逐点钳制：整帧平稳但个别关节瞬间飞出（典型误识别），单独钳回上一帧位置。
    - 自适应平滑：位移越大 alpha 越高（跟手），位移越小越平滑（去抖动）。
    - 丢帧补齐：短暂检测不到人（丢帧/遮挡）时沿用上一骨架，超过时限才置空。
    """

    JUMP_THRESHOLD = 0.14   # 整帧跳变阈值（归一化坐标）
    PER_JOINT_LIMIT = 0.45  # 单关节最大跳变（超过则钳制，写实快速摆臂也难超过）
    MAX_HOLD_DRIFT = 2      # 连续漂移帧沿用上一帧的上限
    HOLD_SECONDS = 0.5      # 丢帧补齐的最长时长
    ALPHA_MIN = 0.35        # 静止时的平滑系数（越小越稳）
    ALPHA_MAX = 0.85        # 快速动作时的平滑系数（越大越跟手）
    # 核心关节：头/肩/肘/腕/髋/膝/踝——漂移检测只看这些，
    # 避免大量低可见度或静止点稀释中位数信号
    CORE_JOINTS = (0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28)

    def __init__(self) -> None:
        self._prev: Optional[List[List[float]]] = None
        self._hold_until = 0.0
        self._drift_streak = 0

    @classmethod
    def _median_jump(cls, pose: List[List[float]], prev: List[List[float]]) -> float:
        dists: List[float] = []
        for i in cls.CORE_JOINTS:
            if i >= len(pose) or i >= len(prev):
                continue
            cur, old = pose[i], prev[i]
            if not cur or not old or len(cur) < 4 or len(old) < 4:
                continue
            if cur[3] < 0.3 or old[3] < 0.3:
                continue
            dists.append(math.hypot(cur[0] - old[0], cur[1] - old[1]))
        if not dists:
            return 0.0
        dists.sort()
        return dists[len(dists) // 2]

    def filter(self, pose: Optional[List[List[float]]]) -> Optional[List[List[float]]]:
        now = time.perf_counter()

        # 没检测到人：短时间内补帧（沿用上一骨架），超时才承认丢失
        if not pose:
            if self._prev is not None and now < self._hold_until:
                return self._prev
            return None

        if self._prev is None:
            self._prev = [list(p) if p else None for p in pose]  # type: ignore[arg-type]
            self._hold_until = now + self.HOLD_SECONDS
            return self._prev

        jump = self._median_jump(pose, self._prev)
        if jump > self.JUMP_THRESHOLD and self._drift_streak < self.MAX_HOLD_DRIFT:
            # 异常漂移帧：剔除，沿用上一帧
            self._drift_streak += 1
            return self._prev
        self._drift_streak = 0

        # 自适应平滑：动得越快越跟手，动得越慢越稳
        alpha = min(self.ALPHA_MAX, self.ALPHA_MIN + jump * 6.0)
        out: List[List[float]] = []
        for cur, old in zip(pose, self._prev):
            if not cur:
                out.append(old)
                continue
            if not old or len(old) < 4 or len(cur) < 4:
                out.append(list(cur))
                continue
            d = math.hypot(cur[0] - old[0], cur[1] - old[1])
            if d > self.PER_JOINT_LIMIT and jump <= self.JUMP_THRESHOLD:
                # 个别关节瞬间飞出（误识别）：钳回上一帧位置，可见度取当前值
                out.append([old[0], old[1], old[2], cur[3]])
                continue
            out.append(
                [
                    round(old[0] + (cur[0] - old[0]) * alpha, 4),
                    round(old[1] + (cur[1] - old[1]) * alpha, 4),
                    round(old[2] + (cur[2] - old[2]) * alpha, 4),
                    cur[3],
                ]
            )
        self._prev = out
        self._hold_until = now + self.HOLD_SECONDS
        return out
