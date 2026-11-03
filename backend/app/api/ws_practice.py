"""实时跟练 WebSocket：低延时骨架推流 + 练习录制。

协议：
    客户端 → 服务端
        binary                 JPEG 帧（建议 640x480, q=0.6）
        {"type":"record_start","video_id":..,"segment_index":..,"title":..}
        {"type":"record_stop"}
        {"type":"ping"}
    服务端 → 客户端
        {"type":"ready","record_fps":12,"server_ms":..}
        {"type":"pose","pose":[[x,y,z,v],..]|null,"server_ms":..,"dropped":n,"ts":..}
        {"type":"record_started","session_id":..}
        {"type":"record_stopped","session":{...}}
        {"type":"pong"}
        {"type":"error","message":..}

低延时策略：每帧推理未完成时直接丢弃新帧（不排队），链路始终只处理最新画面。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import RECORD_FPS
from ..services.pose_engine import live_pose_engine
from ..services.session_store import SessionRecorder
from ..services.video_store import video_store

logger = logging.getLogger("dancemate.ws")
router = APIRouter()


@router.websocket("/ws/practice")
async def practice_socket(ws: WebSocket) -> None:
    await ws.accept()

    send_lock = asyncio.Lock()
    state: Dict[str, Any] = {"busy": False, "dropped": 0, "closed": False}
    recorder: Optional[SessionRecorder] = None

    async def send_json(payload: Dict[str, Any]) -> None:
        async with send_lock:
            await ws.send_json(payload)

    async def process_frame(data: bytes) -> None:
        if state["closed"]:
            return
        if state["busy"]:
            # 上一帧还在推理 → 丢弃，保证端到端只有 1 帧延时
            state["dropped"] += 1
            return
        state["busy"] = True
        try:
            started = time.perf_counter()
            pose = await live_pose_engine.estimate_jpeg(data)
            server_ms = (time.perf_counter() - started) * 1000.0
            await send_json(
                {
                    "type": "pose",
                    "pose": pose,
                    "server_ms": round(server_ms, 1),
                    "dropped": state["dropped"],
                    "ts": round(time.time(), 4),
                }
            )
            state["dropped"] = 0
            if recorder is not None:
                recorder.submit(data, pose)
        except (WebSocketDisconnect, RuntimeError):
            state["closed"] = True
        except Exception:  # noqa: BLE001
            logger.exception("实时推理失败")
        finally:
            state["busy"] = False

    await send_json({"type": "ready", "record_fps": RECORD_FPS})

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break

            data = message.get("bytes")
            if data is not None:
                asyncio.create_task(process_frame(data))
                continue

            text = message.get("text")
            if not text:
                continue

            try:
                command = json.loads(text)
            except json.JSONDecodeError:
                continue

            kind = command.get("type")

            if kind == "record_start":
                if recorder is not None:
                    await recorder.stop()
                    recorder = None

                video_id = command.get("video_id")
                segment_index = command.get("segment_index")
                video_meta = video_store.get(video_id) if video_id else None
                segment = None
                if video_meta and isinstance(segment_index, int):
                    segments = video_meta.get("segments") or []
                    if 0 <= segment_index < len(segments):
                        segment = segments[segment_index]

                title = command.get("title") or (
                    f"{video_meta['title']} · 片段 {segment_index + 1}"
                    if video_meta and isinstance(segment_index, int)
                    else "自由练习回放"
                )

                teach_time = command.get("teach_time")
                recorder = SessionRecorder(
                    title=title,
                    video_id=video_id,
                    video_title=video_meta["title"] if video_meta else None,
                    segment_index=segment_index,
                    segment_start=segment["start"] if segment else None,
                    segment_end=segment["end"] if segment else None,
                    teach_start=float(teach_time) if isinstance(teach_time, (int, float)) else None,
                )
                await send_json(
                    {"type": "record_started", "session_id": recorder.id, "title": title}
                )

            elif kind == "record_stop":
                if recorder is None:
                    await send_json({"type": "error", "message": "当前没有进行中的录制"})
                    continue
                meta = await recorder.stop()
                recorder = None
                await send_json({"type": "record_stopped", "session": meta})

            elif kind == "ping":
                await send_json({"type": "pong", "ts": round(time.time(), 4)})

    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("WebSocket 异常关闭")
    finally:
        state["closed"] = True
        if recorder is not None:
            try:
                await recorder.stop()
            except Exception:  # noqa: BLE001
                logger.exception("关闭时保存录制失败")
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
