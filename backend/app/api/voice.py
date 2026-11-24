"""语音助手接口：状态查询、指令推送 WebSocket、本地中文语音合成。"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..config import TTS_BACKEND
from ..services.tts import tts
from ..services.voice_assistant import voice_assistant

logger = logging.getLogger("dancemate.voice")
router = APIRouter()


class TtsRequest(BaseModel):
    text: str
    speed: float = 1.0


@router.get("/api/voice/status")
async def voice_status():
    return voice_assistant.state


@router.get("/api/voice/tts/status")
async def tts_status():
    """前端用它判断是否需要回退浏览器语音。"""
    return {
        "enabled": TTS_BACKEND == "kokoro",
        "ready": TTS_BACKEND == "kokoro" and tts.models_ready(),
        "voice": tts.voice,
        "error": tts.error,
    }


@router.post("/api/voice/tts")
async def voice_tts(payload: TtsRequest) -> Response:
    """文本 → WAV（24kHz 单声道）。合成放线程池，避免阻塞事件循环。"""
    if TTS_BACKEND != "kokoro":
        raise HTTPException(status_code=503, detail="未启用本地语音合成")
    if not (payload.text or "").strip():
        raise HTTPException(status_code=400, detail="文本为空")
    # 模型缺失时会触发 350MB 下载，不能挂在 HTTP 请求里等：启动时后台线程负责下载
    if not tts.models_ready():
        raise HTTPException(status_code=503, detail="语音模型尚未就绪（后台下载中）")
    try:
        audio = await asyncio.to_thread(tts.synthesize, payload.text, payload.speed)
    except Exception as exc:  # noqa: BLE001
        logger.warning("语音合成失败：%s", exc)
        raise HTTPException(status_code=503, detail=f"语音合成不可用：{exc}") from exc
    return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


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
