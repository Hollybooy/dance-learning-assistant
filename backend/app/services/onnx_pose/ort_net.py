"""把 ONNX Runtime 包装成 cv2.dnn.Net 的最小接口，便于复用 OpenCV Zoo 的前后处理。"""

from __future__ import annotations

import numpy as np
import onnxruntime as ort


class OrtNet:
    def __init__(self, model_path: str, provider: str = "dml") -> None:
        available = ort.get_available_providers()
        if provider == "dml" and "DmlExecutionProvider" in available:
            providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
        elif provider == "cuda" and "CUDAExecutionProvider" in available:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(model_path, sess_options=options, providers=providers)
        self.providers = self.session.get_providers()
        self._input = self.session.get_inputs()[0]
        self._output_names = [output.name for output in self.session.get_outputs()]
        self._blob: np.ndarray | None = None

    # ---- cv2.dnn.Net 兼容接口 ----
    def setPreferableBackend(self, _backend_id: int) -> None:  # noqa: N802
        pass

    def setPreferableTarget(self, _target_id: int) -> None:  # noqa: N802
        pass

    def setInput(self, blob: np.ndarray) -> None:  # noqa: N802
        data = np.ascontiguousarray(blob, dtype=np.float32)
        shape = self._input.shape
        # 模型要 NCHW 而传入 NHWC（或反之）时自动转置，避免两套模型各写一份预处理
        if len(shape) == 4 and isinstance(shape[1], int) and shape[1] == 3 and data.shape[1] != 3:
            data = np.transpose(data, (0, 3, 1, 2))
        elif len(shape) == 4 and isinstance(shape[3], int) and shape[3] == 3 and data.shape[3] != 3:
            data = np.transpose(data, (0, 2, 3, 1))
        self._blob = data

    def forward(self, _names=None):  # noqa: N802
        if self._blob is None:
            raise RuntimeError("OrtNet.forward 前必须先 setInput")
        results = self.session.run(self._output_names, {self._input.name: self._blob})
        # 检测模型的 ONNX 输出顺序是 [score, box]，而 OpenCV Zoo 的后处理按 [box, score] 取用
        if len(results) == 2:
            first, second = results
            if first.shape[-1] == 1 and second.shape[-1] == 12:
                results = [second, first]
        return results

    def getUnconnectedOutLayersNames(self):  # noqa: N802
        return self._output_names
