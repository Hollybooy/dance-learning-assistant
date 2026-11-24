"""预下载 faster-whisper 模型（默认 whisper-base，约 145MB）。

下载顺序：hf-mirror.com 直连 → huggingface.co 直连 → 镜像/官方 + 本机代理。
下完落到 backend/models/<模型名>，语音助手启动时直接加载本地目录，不再联网。

用法（在 backend 目录）：
    .venv\\Scripts\\python.exe download_whisper_model.py
    .venv\\Scripts\\python.exe download_whisper_model.py --model whisper-small
"""

import argparse
import logging
import sys

from app.config import BACKEND_DIR, WHISPER_MODEL
from app.services.net_download import HF_MIRROR, ensure_whisper_dir, proxy_url, whisper_repo_id


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 faster-whisper 模型")
    parser.add_argument("--model", default=WHISPER_MODEL, help="模型名，如 whisper-base / whisper-small")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(f"仓库：{whisper_repo_id(args.model)}；镜像：{HF_MIRROR}；代理：{proxy_url() or '未启用'}")
    try:
        path = ensure_whisper_dir(args.model, BACKEND_DIR / "models")
    except Exception as exc:  # noqa: BLE001
        print(f"下载失败：{exc}")
        print("可设置 DANCEMATE_PROXY 指定代理后重试，或手动下载后放到 backend/models/。")
        return 1
    print(f"模型目录：{path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
