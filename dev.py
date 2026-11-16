"""本地开发预览服务器（仅用标准库，无需 npm / 构建）。

作用：
  1. 以 no-cache 方式托管前端静态文件，改完刷新即可看到最新界面；
  2. 监听 html/css/js 变更，通过 SSE 自动刷新浏览器（真正的"改完即时生效"）；
  3. 自动注入后端地址，/api、/media、/ws 全部指向已启动的 FastAPI（默认 8000）；
  4. 支持 --host 0.0.0.0，队友可在同一局域网内打开预览地址一起看效果。

用法：
    python dev.py                     # http://127.0.0.1:5500
    python dev.py --port 5501
    python dev.py --host 0.0.0.0      # 局域网协作预览
    python dev.py --api http://127.0.0.1:8001

注意：摄像头需要安全上下文，本机用 http://127.0.0.1 / localhost 即可；
局域网 http 访问只能看界面，无法打开摄像头（这是浏览器限制）。
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import socket
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WATCH_SUFFIXES = {".html", ".css", ".js"}
IGNORED_DIRS = {"backend", "node_modules", ".git", "dist", "deploy"}

LIVE_CLIENT = """
<script>
(function () {
  if (!window.EventSource) return;
  window.addEventListener('load', function () {
    setTimeout(function () {
      var source = new EventSource('/__dev/events');
      source.addEventListener('reload', function () { location.reload(); });
      source.onerror = function () { /* 服务重启时浏览器会自动重连 */ };
    }, 400);
  });
})();
</script>
"""


def snapshot() -> dict:
    """前端文件的修改时间快照，用于判断是否需要刷新。"""
    state = {}
    for path in ROOT.rglob("*"):
        if path.suffix not in WATCH_SUFFIXES or not path.is_file():
            continue
        if any(part in IGNORED_DIRS for part in path.relative_to(ROOT).parts):
            continue
        try:
            state[str(path)] = path.stat().st_mtime_ns
        except OSError:
            continue
    return state


class DevHandler(http.server.SimpleHTTPRequestHandler):
    api_base = "http://127.0.0.1:8000"

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/__dev/events"):
            self._serve_events()
            return
        if self.path.startswith("/__dev/live.js"):
            body = LIVE_CLIENT.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def send_head(self):
        """HTML 文件注入后端地址与自动刷新脚本。"""
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            path = path / "index.html"
        if not path.is_file() or path.suffix != ".html":
            return super().send_head()

        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return super().send_head()

        inject = (
            f'<script>window.__DANCEMATE_API__="{self.api_base}";</script>\n'
            + LIVE_CLIENT.strip()
            + "\n"
        )
        text = text.replace("</head>", inject + "</head>", 1)
        body = text.encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        import io

        return io.BytesIO(body)

    def _serve_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b": connected\n\n")
        self.wfile.flush()

        last = snapshot()
        try:
            while True:
                time.sleep(0.7)
                current = snapshot()
                if current != last:
                    last = current
                    self.wfile.write(b"event: reload\ndata: changed\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def log_message(self, fmt: str, *args) -> None:  # 只保留错误，避免刷屏
        if args and str(args[0]).startswith(("4", "5")):
            super().log_message(fmt, *args)


class DevServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        """浏览器刷新 / 断开 SSE 会产生大量无害的连接中断，这里静默处理。"""
        import sys

        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main() -> None:
    parser = argparse.ArgumentParser(description="DanceMate 前端开发预览服务器")
    parser.add_argument("--port", type=int, default=5500)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api", default="http://127.0.0.1:8000", help="后端地址")
    args = parser.parse_args()

    DevHandler.api_base = args.api.rstrip("/")
    handler = functools.partial(DevHandler, directory=str(ROOT))
    server = DevServer((args.host, args.port), handler)

    print("DanceMate 开发预览已启动（保存文件后浏览器自动刷新）")
    print(f"  前端预览 : http://127.0.0.1:{args.port}")
    if args.host in ("0.0.0.0", "::"):
        print(f"  局域网   : http://{lan_ip()}:{args.port}")
    print(f"  后端接口 : {DevHandler.api_base}")
    print("  提示     : 先启动后端 python backend/run.py，摄像头页面才能工作")
    print("  退出     : Ctrl+C")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
