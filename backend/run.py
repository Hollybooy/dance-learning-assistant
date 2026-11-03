"""开发/生产启动脚本：关闭 WebSocket 心跳以降低链路开销。

环境变量：
    DANCEMATE_HOST  监听地址（默认 127.0.0.1，容器内为 0.0.0.0）
    DANCEMATE_PORT  监听端口（默认 8000）
"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.getenv("DANCEMATE_HOST", "127.0.0.1"),
        port=int(os.getenv("DANCEMATE_PORT", "8000")),
        reload=False,
        workers=1,  # MediaPipe 引擎单例共享，禁止多 worker
        ws_ping_interval=None,
        ws_ping_timeout=None,
        log_level="info",
    )
