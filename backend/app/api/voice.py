"""语音助手接口：状态查询与指令推送 WebSocket。"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..services.voice_assistant import voice_assistant

logger = logging.getLogger("dancemate.voice")
router = APIRouter()


@router.get("/api/voice/status")
async def voice_status():
    return voice_assistant.state


async def _read_control(ws: WebSocket) -> None:
    while True:
        message = await ws.receive_json()
        if message.get("type") == "set_enabled":
            voice_assistant.set_enabled(bool(message.get("value")))
        elif message.get("type") == "sync_titles":
            titles = message.get("titles")
            if isinstance(titles, list):
                voice_assistant.set_client_titles(titles)


@router.websocket("/ws/voice")
async def voice_socket(ws: WebSocket) -> None:
    await ws.accept()
    client: asyncio.Queue = asyncio.Queue()
    voice_assistant.add_client(client)
    voice_assistant.set_enabled(True)
    await ws.send_json({"type": "status", **voice_assistant.state})
    reader = asyncio.create_task(_read_control(ws))
    try:
        while True:
            payload = await client.get()
            await ws.send_json(payload)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
        voice_assistant.remove_client(client)
        if not voice_assistant.has_clients:
            voice_assistant.set_enabled(False)
