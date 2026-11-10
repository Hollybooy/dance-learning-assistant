"""教学视频库：上传落盘、切片元数据、骨架分析状态。"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import SEGMENT_SECONDS, VIDEO_DIR
from .media_tools import build_segments, extract_segment_thumbs, probe_duration, title_from_filename


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class VideoStore:
    """基于文件系统的视频库，线程安全地读写 meta.json。"""

    def __init__(self, root: Path = VIDEO_DIR) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    # ---------- 基础路径 ----------

    def folder(self, video_id: str) -> Path:
        return self.root / video_id

    def meta_path(self, video_id: str) -> Path:
        return self.folder(video_id) / "meta.json"

    def pose_path(self, video_id: str) -> Path:
        return self.folder(video_id) / "pose.json"

    def masks_path(self, video_id: str) -> Path:
        return self.folder(video_id) / "masks.bin"

    def source_path(self, video_id: str) -> Optional[Path]:
        meta = self.get(video_id)
        if not meta:
            return None
        path = self.folder(video_id) / meta["filename"]
        return path if path.exists() else None

    # ---------- 元数据 ----------

    def _write_meta(self, meta: Dict[str, Any]) -> None:
        path = self.meta_path(meta["id"])
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def create(self, upload_path: Path, original_name: str) -> Dict[str, Any]:
        video_id = uuid.uuid4().hex[:12]
        folder = self.folder(video_id)
        folder.mkdir(parents=True, exist_ok=True)

        suffix = Path(original_name).suffix.lower() or ".mp4"
        final_name = f"source{suffix}"
        os.replace(upload_path, folder / final_name)

        duration = probe_duration(folder / final_name)
        segments = build_segments(duration, SEGMENT_SECONDS)

        # 为每个片段截取封面缩略图（失败不影响入库）
        try:
            extract_segment_thumbs(folder / final_name, segments, folder / "thumbs")
            for segment in segments:
                segment["thumbnail"] = f"/media/videos/{video_id}/thumbs/seg_{int(segment['index']):02d}.jpg"
        except Exception:  # noqa: BLE001
            pass

        meta: Dict[str, Any] = {
            "id": video_id,
            "title": title_from_filename(original_name),
            "filename": final_name,
            "original_name": original_name,
            "duration": duration,
            "created_at": _now_iso(),
            "segment_seconds": SEGMENT_SECONDS,
            "segments": segments,
            "pose_status": "pending",
            "pose_progress": 0.0,
            "pose_frames": 0,
            "pose_error": None,
        }
        self._write_meta(meta)
        return meta

    def get(self, video_id: str) -> Optional[Dict[str, Any]]:
        path = self.meta_path(video_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def update(self, video_id: str, **fields: Any) -> Dict[str, Any]:
        with self._lock:
            meta = self.get(video_id)
            if not meta:
                raise KeyError(video_id)
            meta.update(fields)
            self._write_meta(meta)
            return meta

    def list(self) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for folder in self.root.iterdir():
            if not folder.is_dir():
                continue
            meta = self.get(folder.name)
            if meta:
                items.append(meta)
        items.sort(key=lambda m: m.get("created_at", ""), reverse=True)
        return items

    def search(self, query: str) -> List[Dict[str, Any]]:
        q = query.strip().lower()
        if not q:
            return self.list()
        return [m for m in self.list() if q in m.get("title", "").lower()]

    def delete(self, video_id: str) -> None:
        import shutil

        folder = self.folder(video_id)
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)


video_store = VideoStore()
