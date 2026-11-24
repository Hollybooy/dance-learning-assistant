"""本地中文语音合成：Kokoro-82M（ONNX）+ misaki 中文 G2P。

为什么不用浏览器 speechSynthesis：音色来自操作系统，机器上装了粤语/台湾音色时
会被选中，用户也无法分辨哪个是普通话。这里固定一个普通话音色，播报与系统解耦。

链路：
1. misaki.zh 把中文转成带声调的 IPA 音素（与 Kokoro 训练数据一致）；
2. Kokoro ONNX 生成 24kHz 单声道音频；
3. 打包成 WAV 返回，前端用 <audio> 播放。

性能（本机 CPU，fp32 模型）：RTF≈0.6，一句 4.5s 的提示约 2.7s 合成；
合成放在独立线程里，不阻塞姿态推理；重复文本走 LRU 缓存直接返回。
"""

from __future__ import annotations

import io
import logging
import threading
import time
import wave
from collections import OrderedDict
from typing import Optional

import numpy as np

from ..config import TTS_VOICE
from .model_store import ensure_kokoro_models, kokoro_models_ready

logger = logging.getLogger("dancemate.tts")

SAMPLE_RATE = 24000
MAX_TEXT = 200  # 再长合成时间会超过前端 10s 超时，播报本来也都是短句
CACHE_SIZE = 64


class KokoroTTS:
    def __init__(self, voice: str = TTS_VOICE) -> None:
        self.voice = voice
        # RLock：synthesize 持有锁时还会调用 ensure_loaded
        self._lock = threading.RLock()
        self._kokoro = None
        self._g2p = None
        self._cache: "OrderedDict[tuple[str, float], bytes]" = OrderedDict()
        self._error: Optional[str] = None

    # ---------------------------------------------------------------- 生命周期
    def models_ready(self) -> bool:
        return kokoro_models_ready()

    @property
    def error(self) -> Optional[str]:
        return self._error

    def ensure_loaded(self) -> None:
        """首次调用时加载模型与 G2P（含缺失模型的下载），之后直接复用。"""
        if self._kokoro is not None:
            return
        with self._lock:
            if self._kokoro is not None:
                return
            started = time.perf_counter()
            model_path, voices_path = ensure_kokoro_models()

            import onnxruntime as ort
            from kokoro_onnx import Kokoro
            from misaki import zh

            # 这个模型在 DirectML 上会直接抛 UnicodeDecodeError（EP 内部报错解码失败），
            # 固定 CPU：82M 模型 RTF≈0.6，且姿态推理已经走 MediaPipe，不抢同一条链路。
            session = ort.InferenceSession(
                str(model_path), providers=["CPUExecutionProvider"]
            )
            self._kokoro = Kokoro.from_session(session, str(voices_path))
            if self.voice not in self._kokoro.get_voices():
                raise RuntimeError(f"Kokoro 音色不存在：{self.voice}")

            self._g2p = zh.ZHG2P()  # jieba 首次构建词典约 0.8s
            self._error = None
            logger.info(
                "Kokoro TTS 已就绪：voice=%s（加载 %.1fs，模型 %s）",
                self.voice,
                time.perf_counter() - started,
                model_path.name,
            )

    def warm(self) -> None:
        """后台预热：加载模型并合成一句，避免第一条提示等两秒。"""
        try:
            self.ensure_loaded()
            self.synthesize("你好", 1.0)
            logger.info("Kokoro TTS 预热完成")
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc)
            logger.exception("Kokoro TTS 预热失败，前端会自动回退浏览器语音")

    # ---------------------------------------------------------------- 合成
    def synthesize(self, text: str, speed: float = 1.0) -> bytes:
        text = (text or "").strip()
        if not text:
            raise ValueError("文本为空")
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT]
        speed = min(2.0, max(0.5, float(speed or 1.0)))
        key = (text, round(speed, 2))

        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                self._cache.move_to_end(key)
                return cached

        self.ensure_loaded()
        if self._kokoro is None or self._g2p is None:  # pragma: no cover - 防御
            raise RuntimeError("TTS 未就绪")

        with self._lock:  # misaki/jieba 不是线程安全的，串行合成
            phonemes = self._g2p(text)
            if not phonemes.strip():
                raise ValueError("没有可合成的音素")
            audio, sample_rate = self._kokoro.create(
                phonemes, voice=self.voice, speed=speed, is_phonemes=True
            )
            wav = self._to_wav(audio, sample_rate)
            self._cache[key] = wav
            if len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)
            return wav

    @staticmethod
    def _to_wav(audio: np.ndarray, sample_rate: int) -> bytes:
        pcm = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
        pcm = (pcm * 32767.0).astype(np.int16)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as fp:
            fp.setnchannels(1)
            fp.setsampwidth(2)
            fp.setframerate(sample_rate)
            fp.writeframes(pcm.tobytes())
        return buffer.getvalue()


tts = KokoroTTS()
