"""DanceMate 后端入口。

启动：
    cd backend
    python -m venv .venv && .venv\\Scripts\\activate
    pip install -r requirements.txt
    python run.py            # http://127.0.0.1:8000
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import sessions, videos, ws_practice
from .config import DATA_DIR, FRONTEND_DIR, ensure_dirs
from .services.pose_engine import live_pose_engine

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_dirs()
    yield
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
app.include_router(ws_practice.router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "dancemate"}


# 练习帧、缩略图等静态资源
app.mount("/media", StaticFiles(directory=DATA_DIR), name="media")

# 前端静态页面（放在最后，避免覆盖 /api 路由）
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
