"""下载 ONNX 姿态 / 人体检测模型（约 17MB）。

用法（在 backend 目录）：
    .venv\\Scripts\\python.exe download_onnx_models.py

下载失败时可用代理重试，或手动把两个 .onnx 放到 backend/models/：
    DANCEMATE_ONNX_POSE_MODEL / DANCEMATE_ONNX_PERSON_MODEL 也可指定自备路径。
"""

import sys

from app.services.model_store import ensure_onnx_pose_models


def main() -> int:
    try:
        pose, person = ensure_onnx_pose_models()
    except Exception as exc:  # noqa: BLE001
        print(f"下载失败：{exc}")
        print("可设置 HTTP_PROXY/HTTPS_PROXY 后重试，或手动下载后放到 backend/models/。")
        return 1
    print(f"姿态模型：{pose}")
    print(f"检测模型：{person}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
