"""本地语音助手：唤醒词 + faster-whisper + Ollama 意图解析。

流程：
1. 麦克风常驻采集 16kHz 单声道 PCM，能量 VAD 切出一句话；
2. faster-whisper（CPU int8）识别中文，必须包含唤醒词「小教练」；
3. 固定指令先用规则解析（低延迟），播放指定课程等模糊意图交给 Ollama
   Qwen2.5-1.5B 输出 JSON；Ollama 不可用时自动回退规则与标题模糊匹配；
4. 通过 /ws/voice 把识别文本与指令推给前端执行。

依赖：faster-whisper、sounddevice；Ollama 可选（默认 http://127.0.0.1:11434）。
"""

from __future__ import annotations

import asyncio
import difflib
import json
import logging
import queue
import re
import threading
import time
import urllib.request
from typing import Any, Dict, List, Optional

import numpy as np

from ..config import (
    BACKEND_DIR,
    OLLAMA_MODEL,
    OLLAMA_URL,
    VOICE_ENABLED,
    VOICE_SAMPLE_RATE,
    VOICE_WAKE_WORD,
    WHISPER_COMPUTE,
    WHISPER_MODEL,
)
from .net_download import ensure_whisper_dir, whisper_repo_id
from .video_store import video_store

logger = logging.getLogger("dancemate.voice")

_INITIAL_PROMPT = (
    "小教练，暂停，继续播放，上一片段，下一片段，重播本段，开始跟练，"
    "播放古风燃脂第一课，播放 Hip-Hop 律动入门。"
)

_ACTION_REPLY = {
    "pause": "好的，已暂停",
    "resume": "继续播放",
    "next_segment": "切换到下一段",
    "prev_segment": "切换到上一段",
    "restart_segment": "重播本段",
    "start_practice": "开始跟练",
}


def _normalize(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]", "", text or "").lower()


def _fuzzy_title(query: str, titles: List[str], threshold: float = 0.45):
    query_norm = _normalize(query)
    if not query_norm:
        return None, 0.0
    best, best_score = None, 0.0
    for title in titles:
        title_norm = _normalize(title)
        if not title_norm:
            continue
        score = difflib.SequenceMatcher(None, query_norm, title_norm).ratio()
        if query_norm in title_norm:
            score = max(score, 0.95)
        elif title_norm in query_norm:
            score = max(score, 0.9)
        if score > best_score:
            best, best_score = title, score
    return (best, best_score) if best_score >= threshold else (None, best_score)


def parse_rule_intent(query: str) -> Optional[Dict[str, Any]]:
    """固定指令的快速解析，避免每条都要等 LLM。"""
    q = _normalize(query)
    if not q:
        return None
    if any(key in q for key in ("暂停", "停一下", "先停", "别放")):
        return {"action": "pause"}
    if any(key in q for key in ("继续", "接着", "恢复")):
        return {"action": "resume"}
    if any(key in q for key in ("下一段", "下个片段", "下一片段", "下一个")):
        return {"action": "next_segment"}
    if any(key in q for key in ("上一段", "上个片段", "上一片段", "上一个")):
        return {"action": "prev_segment"}
    if any(key in q for key in ("重播", "再来一遍", "重新放")):
        return {"action": "restart_segment"}
    if any(key in q for key in ("开始跟练", "开始练习", "进入跟练")):
        return {"action": "start_practice"}
    if any(key in q for key in ("播放", "打开", "想看", "看一", "放一")):
        title = re.sub(r"(播放|打开|我想看|我要看|想看|看一|放一|教学视频|视频|课程)", "", q)
        return {"action": "play_video", "video": title}
    return None


class WhisperAsr:
    def __init__(self) -> None:
        self._model = None
        self._lock = threading.Lock()

    def ensure(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            from faster_whisper import WhisperModel

            models_root = BACKEND_DIR / "models"
            model_dir = models_root / WHISPER_MODEL
            # 预下载走镜像直连（失败再回退官方源/代理），下完就是本地目录，后续启动不联网
            if not (model_dir / "model.bin").exists():
                try:
                    model_dir = ensure_whisper_dir(WHISPER_MODEL, models_root)
                except Exception as exc:  # noqa: BLE001 - 交给 faster-whisper 自带下载
                    logger.warning("Whisper 模型预下载失败（%s），改用内置下载器重试", exc)
            logger.info("加载 Whisper 模型：%s", model_dir)
            if (model_dir / "model.bin").exists():
                self._model = WhisperModel(str(model_dir), device="cpu", compute_type=WHISPER_COMPUTE)
            else:
                self._model = WhisperModel(
                    whisper_repo_id(WHISPER_MODEL),
                    device="cpu",
                    compute_type=WHISPER_COMPUTE,
                    download_root=str(models_root),
                )

    def transcribe(self, pcm: np.ndarray) -> str:
        self.ensure()
        audio = pcm.astype(np.float32) / 32768.0
        segments, _info = self._model.transcribe(
            audio,
            language="zh",
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
            initial_prompt=_INITIAL_PROMPT,
        )
        return "".join(segment.text for segment in segments).strip()


def _ollama_intent(query: str, titles: List[str]) -> Optional[Dict[str, Any]]:
    """让本地 Qwen 输出 JSON 意图；模型未启动/超时则由调用方回退规则。"""
    title_list = "\n".join(f"- {title}" for title in titles[:20])
    system = (
        "你是舞蹈教学 App 的语音指令解析器。只输出一个 JSON 对象，不要解释。"
        '格式：{"action":"...","video":"课程标题或空字符串"}。'
        "action 只能是：play_video、pause、resume、next_segment、prev_segment、"
        "restart_segment、start_practice、none。"
        f"\n课程标题列表：\n{title_list}"
    )
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": query},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "num_predict": 64},
    }
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        # 显式绕过系统代理，Ollama 只在本机回环地址
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
        content = data.get("message", {}).get("content", "")
        intent = json.loads(content)
        if isinstance(intent, dict) and intent.get("action"):
            return intent
    except Exception as exc:  # noqa: BLE001
        logger.debug("Ollama 意图解析不可用：%s", exc)
    return None


class MicrophoneVad:
    """能量阈值 VAD：100ms 一帧，前 0.8 秒校准底噪。"""

    def __init__(self, on_utterance, samplerate: int = VOICE_SAMPLE_RATE) -> None:
        self._on_utterance = on_utterance
        self._samplerate = samplerate
        self._block = samplerate // 10
        self._queue: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=240)
        self._stop = threading.Event()
        self._stream = None
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        import sounddevice as sd

        self._stream = sd.InputStream(
            samplerate=self._samplerate,
            channels=1,
            dtype="int16",
            blocksize=self._block,
            callback=self._callback,
        )
        self._stream.start()
        self._thread = threading.Thread(target=self._consume, name="voice-vad", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._stream is not None:
                self._stream.stop()
                self._stream.close()
        except Exception:  # noqa: BLE001
            pass
        self._stream = None

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        if status:
            logger.debug("麦克风状态：%s", status)
        try:
            self._queue.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass

    def _consume(self) -> None:
        noise = 0.008
        calibrated = 0
        speaking = False
        frames: List[np.ndarray] = []
        preroll: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=3)
        silence = 0.0
        while not self._stop.is_set():
            try:
                chunk = self._queue.get(timeout=0.4)
            except queue.Empty:
                continue
            rms = float(np.sqrt(np.mean((chunk.astype(np.float32) / 32768.0) ** 2)))
            if calibrated < 8:
                if rms < 0.02:
                    noise = noise * 0.8 + rms * 0.2
                calibrated += 1
                continue

            threshold = max(0.008, noise * 2.6)
            if not speaking:
                if preroll.full():
                    preroll.get()
                preroll.put(chunk)
                if rms > threshold:
                    speaking = True
                    frames = list(preroll.queue)
                    preroll = queue.Queue(maxsize=3)
                    silence = 0.0
                continue

            frames.append(chunk)
            silence = silence + 0.1 if rms < threshold * 0.8 else 0.0
            if (silence >= 0.6 and len(frames) >= 5) or len(frames) >= 60:
                audio = np.concatenate(frames)
                speaking = False
                frames = []
                silence = 0.0
                if audio.size >= self._samplerate // 2:
                    try:
                        self._on_utterance(audio)
                    except Exception:  # noqa: BLE001
                        logger.exception("语音处理失败")


class VoiceAssistant:
    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._clients: "set[asyncio.Queue]" = set()
        self._asr = WhisperAsr()
        self._mic: Optional[MicrophoneVad] = None
        self._mic_lock = threading.Lock()
        self._enabled = False
        self._state = "disabled"
        self._detail = ""
        self._client_titles: List[str] = []

    @property
    def state(self) -> Dict[str, str]:
        return {"state": self._state, "detail": self._detail}

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if not VOICE_ENABLED:
            self._set_state("disabled", "已通过环境变量关闭")
            return
        # 先把 Whisper 加载好，但麦克风等前端页面连上后再开，避免后台常驻录音
        self._set_state("paused", "等待页面连接")
        threading.Thread(target=self._warm_asr, name="voice-assistant-warm", daemon=True).start()

    def _warm_asr(self) -> None:
        try:
            self._asr.ensure()
            logger.info("Whisper 已就绪，等待页面开启语音指令")
        except Exception:  # noqa: BLE001
            logger.exception("Whisper 预热失败")

    def _boot(self) -> None:
        self._set_state("loading", "正在加载 Whisper 与麦克风")
        try:
            self._asr.ensure()
            with self._mic_lock:
                if self._mic is None:
                    self._mic = MicrophoneVad(self._on_audio)
                    self._mic.start()
            self._set_state("listening", f"说「{VOICE_WAKE_WORD}」+ 指令")
        except Exception as exc:  # noqa: BLE001
            logger.exception("语音助手启动失败")
            self._set_state("error", str(exc)[:120])

    def set_client_titles(self, titles: List[str]) -> None:
        self._client_titles = [str(title) for title in titles if title][:80]

    def add_client(self, client: asyncio.Queue) -> None:
        self._clients.add(client)

    def remove_client(self, client: asyncio.Queue) -> None:
        self._clients.discard(client)

    @property
    def has_clients(self) -> bool:
        return bool(self._clients)

    def stop(self) -> None:
        self._enabled = False
        with self._mic_lock:
            if self._mic is not None:
                self._mic.stop()
                self._mic = None
        self._set_state("disabled", "服务已停止")

    def set_enabled(self, enabled: bool) -> None:
        if enabled == self._enabled:
            return
        self._enabled = enabled
        if enabled:
            threading.Thread(target=self._boot, name="voice-assistant-resume", daemon=True).start()
        else:
            with self._mic_lock:
                if self._mic is not None:
                    self._mic.stop()
                    self._mic = None
            self._set_state("paused", "语音助手已暂停")

    def _broadcast(self, payload: Dict[str, Any]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        for client in list(self._clients):
            try:
                loop.call_soon_threadsafe(client.put_nowait, payload)
            except RuntimeError:
                pass

    def _set_state(self, state: str, detail: str = "") -> None:
        self._state = state
        self._detail = detail
        self._broadcast({"type": "status", "state": state, "detail": detail})

    def _on_audio(self, pcm: np.ndarray) -> None:
        if not self._enabled:
            return
        started = time.perf_counter()
        try:
            text = self._asr.transcribe(pcm)
        except Exception:  # noqa: BLE001
            logger.exception("Whisper 识别失败")
            return
        if not text:
            return
        asr_ms = round((time.perf_counter() - started) * 1000)
        self._broadcast({"type": "asr", "text": text, "asr_ms": asr_ms})
        logger.info("语音识别（%sms）：%s", asr_ms, text)
        self._handle_text(text)

    def _handle_text(self, raw: str) -> None:
        normalized = _normalize(raw)
        wake = _normalize(VOICE_WAKE_WORD)
        if wake not in normalized:
            return
        query = normalized.split(wake, 1)[-1]
        if not query:
            self._broadcast({"type": "reply", "text": "我在，请说指令"})
            return

        titles = [video.get("title", "") for video in video_store.list()]
        titles += [title for title in self._client_titles if title not in titles]
        intent = parse_rule_intent(query)
        # 播放指令先做标题匹配；已有明确候选就不打扰 Qwen，避免每条都多等一秒
        confident = False
        if intent and intent.get("action") == "play_video":
            _title, score = _fuzzy_title(intent.get("video") or query, titles)
            confident = score >= 0.55
        if intent is None or (intent.get("action") == "play_video" and not confident):
            llm = _ollama_intent(query, titles)
            if llm:
                intent = llm
        if not intent:
            self._broadcast({"type": "reply", "text": "没听清，请再说一次"})
            return

        action = str(intent.get("action") or "none")
        video_title = str(intent.get("video") or "")
        video_id = ""
        if action == "play_video":
            query_title = video_title or query
            title, _score = _fuzzy_title(query_title, titles)
            # 内置课程只存在前端，后端匹配不到时保留原话，由前端再匹配一次
            video_title = title or query_title
            for video in video_store.list():
                if video.get("title") == video_title:
                    video_id = video.get("id", "")
                    break

        reply = _ACTION_REPLY.get(action, "")
        if action == "play_video":
            reply = f"开始播放{video_title}"
        payload = {
            "type": "command",
            "action": action,
            "video": video_title,
            "video_id": video_id,
            "raw": raw,
            "reply": reply,
        }
        self._broadcast(payload)
        if reply:
            self._broadcast({"type": "reply", "text": reply})


voice_assistant = VoiceAssistant()
