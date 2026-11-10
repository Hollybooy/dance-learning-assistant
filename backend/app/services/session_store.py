"""练习录制：保存摄像头 JPEG 帧 + 逐帧骨架，供纠错回放页使用。

写入磁盘的操作全部放在 asyncio.to_thread 中，录制过程不会阻塞实时推理与回包。
"""

from __future__ import annotations

import asyncio
import json
import struct
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import RECORD_FPS, SESSION_DIR


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SessionRecorder:
    """一次练习录制。submit() 为同步非阻塞入队，_writer 协程串行落盘。"""

    def __init__(
        self,
        title: str,
        video_id: Optional[str] = None,
        video_title: Optional[str] = None,
        segment_index: Optional[int] = None,
        segment_start: Optional[float] = None,
        segment_end: Optional[float] = None,
        teach_start: Optional[float] = None,
        teach_rate: Optional[float] = None,
    ) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.dir = SESSION_DIR / self.id
        (self.dir / "frames").mkdir(parents=True, exist_ok=True)

        self.title = title or "练习回放"
        self.video_id = video_id
        self.video_title = video_title
        self.segment_index = segment_index
        self.segment_start = segment_start
        self.segment_end = segment_end
        # 录制开始瞬间教学视频的播放位置，回放时按真实时间对齐教学轮廓
        self.teach_start = teach_start
        # 录制时的教学视频播放速度，回放映射时按同速推进
        self.teach_rate = teach_rate

        self.created_at = _now_iso()
        self.frame_count = 0
        self.poses: List[Dict[str, Any]] = []
        self.duration = 0.0

        self._start = time.time()
        # 帧率采样用累积配额（见 submit），避免输入帧率与目标帧率不成整数倍时丢一半帧
        self._last_tick = self._start
        self._budget = 1.0
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=120)
        self._closed = False
        self._writer = asyncio.create_task(self._run_writer())
        self._masks_path = self.dir / "masks.bin"
        self._masks_buf = open(self._masks_path, "wb")

    # ---------- 写入 ----------

    def submit(
        self,
        jpeg: bytes,
        pose: Optional[List[List[float]]],
        mask: Optional[bytes] = None,
    ) -> None:
        if self._closed:
            return
        now = time.time()
        # 按"时间 × 目标帧率"累积配额决定存不存这一帧：
        # 30fps 输入、24fps 目标时能稳定得到 24fps；
        # 而"上次时间 + 固定间隔"的硬节流会把每两帧丢一帧，只剩 15fps。
        self._budget += (now - self._last_tick) * max(RECORD_FPS, 1.0)
        self._last_tick = now
        if self._budget < 1.0:
            return
        self._budget = min(self._budget - 1.0, 1.0)  # 停顿后不爆发补存
        try:
            self._queue.put_nowait((jpeg, pose, mask, now - self._start))
        except asyncio.QueueFull:
            pass  # 磁盘跟不上时丢弃，优先保证实时链路

    async def _run_writer(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            item = await self._queue.get()
            if item is None:
                break
            jpeg, pose, mask, t = item
            self.frame_count += 1
            index = self.frame_count
            await asyncio.to_thread(
                (self.dir / "frames" / f"{index:05d}.jpg").write_bytes, jpeg
            )
            await loop.run_in_executor(None, self._append_mask, mask or b"")
            self.duration = max(self.duration, round(t, 3))
            self.poses.append({"i": index, "t": round(t, 3), "pose": pose})

    def _append_mask(self, data: bytes) -> None:
        """masks.bin：每帧 uint32(LE) 长度 + PNG 字节，顺序与 poses.json 一致。"""
        self._masks_buf.write(struct.pack("<I", len(data)))
        self._masks_buf.write(data)

    # ---------- 元数据 ----------

    def meta(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "video_id": self.video_id,
            "video_title": self.video_title,
            "segment_index": self.segment_index,
            "segment_start": self.segment_start,
            "segment_end": self.segment_end,
            "teach_start": self.teach_start,
            "teach_rate": self.teach_rate,
            "created_at": self.created_at,
            "duration": round(self.duration, 3),
            "frame_count": self.frame_count,
            "fps": RECORD_FPS,
            "frames_url": f"/media/sessions/{self.id}/frames/",
            "thumbnail_url": f"/media/sessions/{self.id}/frames/00001.jpg",
            "masks_url": f"/media/sessions/{self.id}/masks.bin",
        }

    async def stop(self) -> Dict[str, Any]:
        if not self._closed:
            self._closed = True
            await self._queue.put(None)
            await self._writer
            self._masks_buf.close()

        meta = self.meta()
        await asyncio.to_thread(self._write_files, meta)
        return meta

    def _write_files(self, meta: Dict[str, Any]) -> None:
        (self.dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (self.dir / "poses.json").write_text(
            json.dumps({"frames": self.poses}, separators=(",", ":")), encoding="utf-8"
        )


class SessionStore:
    root = SESSION_DIR

    @staticmethod
    def list() -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        if not SessionStore.root.exists():
            return items
        for folder in SessionStore.root.iterdir():
            meta_path = folder / "meta.json"
            if folder.is_dir() and meta_path.exists():
                try:
                    items.append(json.loads(meta_path.read_text(encoding="utf-8")))
                except json.JSONDecodeError:
                    continue
        items.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        return items

    @staticmethod
    def get(session_id: str) -> Optional[Dict[str, Any]]:
        meta_path = SessionStore.root / session_id / "meta.json"
        if not meta_path.exists():
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        poses_path = SessionStore.root / session_id / "poses.json"
        if poses_path.exists():
            meta["frames"] = json.loads(poses_path.read_text(encoding="utf-8")).get(
                "frames", []
            )
        else:
            meta["frames"] = []
        return meta

    @staticmethod
    def delete(session_id: str) -> None:
        import shutil

        folder = SessionStore.root / session_id
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)


session_store = SessionStore()
