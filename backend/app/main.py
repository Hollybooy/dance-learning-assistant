"""DanceMate 后端入口。

启动：
    cd backend
    python -m venv .venv && .venv\\Scripts\\activate
    pip install -r requirements.txt
    python run.py            # http://127.0.0.1:8000
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import sessions, videos, voice, ws_practice
from .config import DATA_DIR, FRONTEND_DIR, ensure_dirs
from .services.pose_engine import live_pose_engine
from .services.voice_assistant import voice_assistant

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)


def _warmup_pose_engine() -> None:
    """提前加载模型并跑一帧，避免用户第一帧等 2 秒以上。"""
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    live_pose_engine.estimate_sync_with_mask(frame)


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_dirs()
    try:
        await asyncio.to_thread(_warmup_pose_engine)
    except Exception:  # noqa: BLE001
        logging.getLogger("dancemate.startup").exception("姿态引擎预热失败，首帧会稍慢")
    await voice_assistant.start()
    yield
    voice_assistant.stop()
    live_pose_engine.close()


app = FastAPI(title="DanceMate API", version="1.0.0", lifespan=lifespan)

# 本地开发时前端可能跑在其它端口（如 Live Server 5500）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(videos.router)
app.include_router(sessions.router)
app.include_router(voice.router)
app.include_router(ws_practice.router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "dancemate"}


# 练习帧、缩略图等静态资源
app.mount("/media", StaticFiles(directory=DATA_DIR), name="media")

# 前端静态页面（放在最后，避免覆盖 /api 路由）
class _NoCacheStaticFiles(StaticFiles):
    """前端脚本改动频繁：禁止浏览器强缓存旧 JS，每次都向服务端校验 ETag。"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", _NoCacheStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
