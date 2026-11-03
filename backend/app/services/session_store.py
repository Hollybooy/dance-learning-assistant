"""练习录制：保存摄像头 JPEG 帧 + 逐帧骨架，供纠错回放页使用。

写入磁盘的操作全部放在 asyncio.to_thread 中，录制过程不会阻塞实时推理与回包。
"""

from __future__ import annotations

import asyncio
import json
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

        self.created_at = _now_iso()
        self.frame_count = 0
        self.poses: List[Dict[str, Any]] = []
        self.duration = 0.0

        self._start = time.time()
        self._last_submit = 0.0
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=120)
        self._closed = False
        self._writer = asyncio.create_task(self._run_writer())

    # ---------- 写入 ----------

    def submit(self, jpeg: bytes, pose: Optional[List[List[float]]]) -> None:
        if self._closed:
            return
        now = time.time()
        if now - self._last_submit < 1.0 / max(RECORD_FPS, 1.0):
            return
        self._last_submit = now
        try:
            self._queue.put_nowait((jpeg, pose, now - self._start))
        except asyncio.QueueFull:
            pass  # 磁盘跟不上时丢弃，优先保证实时链路

    async def _run_writer(self) -> None:
        while True:
            item = await self._queue.get()
            if item is None:
                break
            jpeg, pose, t = item
            self.frame_count += 1
            index = self.frame_count
            await asyncio.to_thread(
                (self.dir / "frames" / f"{index:05d}.jpg").write_bytes, jpeg
            )
            self.duration = max(self.duration, round(t, 3))
            self.poses.append({"i": index, "t": round(t, 3), "pose": pose})

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
            "created_at": self.created_at,
            "duration": round(self.duration, 3),
            "frame_count": self.frame_count,
            "fps": RECORD_FPS,
            "frames_url": f"/media/sessions/{self.id}/frames/",
            "thumbnail_url": f"/media/sessions/{self.id}/frames/00001.jpg",
        }

    async def stop(self) -> Dict[str, Any]:
        if not self._closed:
            self._closed = True
            await self._queue.put(None)
            await self._writer

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
