"""下载 ONNX 姿态 / 人体检测模型（约 17MB）。

下载顺序：GitHub 镜像直连 → 官方源直连 → 镜像/官方 + 本机代理
（策略见 app/services/net_download.py）。

用法（在 backend 目录）：
    .venv\\Scripts\\python.exe download_onnx_models.py

失败时可手动把两个 .onnx 放到 backend/models/，或指定代理重试：
    $env:DANCEMATE_PROXY="http://127.0.0.1:7890"
"""

import logging
import sys

from app.services import net_download
from app.services.model_store import MODEL_DIR, ensure_onnx_pose_models


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(f"下载路由：镜像直连优先，代理 = {net_download.proxy_url() or '未启用'}")
    try:
        pose, person = ensure_onnx_pose_models()
    except Exception as exc:  # noqa: BLE001
        print(f"下载失败：{exc}")
        print(f"可手动下载后放到 {MODEL_DIR}，或用 DANCEMATE_PROXY 指定代理重试。")
        return 1
    print(f"姿态模型：{pose}")
    print(f"检测模型：{person}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
