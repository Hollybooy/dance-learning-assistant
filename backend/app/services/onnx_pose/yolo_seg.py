"""YOLO26n-seg 人物掩码（仅取 person 类，输出与 BlazePose 一致的 96×96 alpha PNG）。

模型导出（Ultralytics，AGPL-3.0，仅课程设计等非商业用途）：
    yolo export model=yolo26n-seg.pt format=onnx imgsz=640 opset=17 simplify=True
把导出的 onnx 放到 backend/models/yolo26n-seg-640.onnx，或用
DANCEMATE_YOLO_MODEL 指定路径。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import onnxruntime as ort

logger = logging.getLogger("dancemate.pose")


def _providers(provider: str) -> list[str]:
    available = ort.get_available_providers()
    if provider == "dml" and "DmlExecutionProvider" in available:
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    if provider == "cuda" and "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def letterbox(image: np.ndarray, size: int) -> "tuple[np.ndarray, float, tuple[int, int]]":
    """等比缩放并居中补边（Ultralytics 默认 pad=114）。"""
    height, width = image.shape[:2]
    ratio = min(size / height, size / width)
    new_w, new_h = round(width * ratio), round(height * ratio)
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    pad_w, pad_h = (size - new_w) // 2, (size - new_h) // 2
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[pad_h : pad_h + new_h, pad_w : pad_w + new_w] = resized
    return canvas, ratio, (pad_w, pad_h)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list[int]:
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        current = order[0]
        keep.append(int(current))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(boxes[current, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[current, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[current, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[current, 3], boxes[rest, 3])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        area = (boxes[current, 2] - boxes[current, 0]) * (boxes[current, 3] - boxes[current, 1])
        area_rest = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
        union = area + area_rest - inter
        iou = np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)
        order = rest[iou <= iou_threshold]
    return keep


class YoloSegMasker:
    def __init__(
        self,
        model_path: Path,
        imgsz: int = 640,
        provider: str = "dml",
        conf: float = 0.25,
        iou: float = 0.45,
    ) -> None:
        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(model_path), sess_options=options, providers=_providers(provider))
        self.input_name = self.session.get_inputs()[0].name
        logger.info("YOLO 分割模型已加载：%s（%s）", model_path.name, self.session.get_providers()[0])

    def _mask(self, frame_bgr: np.ndarray) -> Optional[np.ndarray]:
        canvas, ratio, (pad_w, pad_h) = letterbox(frame_bgr, self.imgsz)
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        output, protos = self.session.run(None, {self.input_name: np.ascontiguousarray(blob)})

        # output: [1, 4 + 80 + 32, N]；第 4 行是 person 类分数
        scores = output[0, 4, :]
        candidates = np.where(scores >= self.conf)[0]
        if candidates.size == 0:
            return None

        # 先取完整切片再按候选索引，避免 numpy 把高级索引维度提到前面
        cxcywh = output[0, :4, :][:, candidates].T
        boxes = np.concatenate(
            [cxcywh[:, :2] - cxcywh[:, 2:] / 2, cxcywh[:, :2] + cxcywh[:, 2:] / 2], axis=1
        )
        keep = _nms(boxes, scores[candidates], self.iou)
        if not keep:
            return None
        best = candidates[keep[0]]

        coefficients = output[0, 84:116, best]
        proto = protos[0].reshape(32, -1)
        logits = coefficients @ proto
        mask = 1.0 / (1.0 + np.exp(-logits))
        mask = mask.reshape(int(self.imgsz / 4), int(self.imgsz / 4))
        mask = cv2.resize(mask, (self.imgsz, self.imgsz), interpolation=cv2.INTER_LINEAR)

        height, width = frame_bgr.shape[:2]
        new_w, new_h = round(width * ratio), round(height * ratio)
        mask = mask[pad_h : pad_h + new_h, pad_w : pad_w + new_w]
        return cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)

    def mask_png(self, frame_bgr: np.ndarray, size: int = 96) -> Optional[bytes]:
        mask = self._mask(frame_bgr)
        if mask is None:
            return None
        binary = (mask > 0.5).astype(np.uint8) * 255
        resized = cv2.resize(binary, (size, size), interpolation=cv2.INTER_AREA)
        rgba = np.empty((size, size, 4), dtype=np.uint8)
        rgba[..., 0:3] = 255
        rgba[..., 3] = resized
        ok, buffer = cv2.imencode(".png", rgba)
        return buffer.tobytes() if ok else None
