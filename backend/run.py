"""开发启动脚本：关闭 WebSocket 心跳以降低链路开销。"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
        ws_ping_interval=None,
        ws_ping_timeout=None,
        log_level="info",
    )
