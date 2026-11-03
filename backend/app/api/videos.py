"""教学视频接口：上传、切片、搜索、范围流式播放、骨架分析。"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Dict, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from ..config import (
    DATA_DIR,
    MAX_UPLOAD_BYTES,
    MEDIA_TYPES,
    TEACH_SAMPLE_FPS,
    VIDEO_SUFFIXES,
)
from ..services.media_tools import safe_id
from ..services.teach_pose import extract_teaching_pose, load_pose_frames
from ..services.video_store import video_store

logger = logging.getLogger("dancemate.videos")
router = APIRouter(prefix="/api/videos", tags=["videos"])

_analysis_tasks: Dict[str, asyncio.Task] = {}


# ---------------------------------------------------------------- 上传 / 列表


@router.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    original = file.filename or "video.mp4"
    suffix = Path(original).suffix.lower()
    if suffix not in VIDEO_SUFFIXES:
        raise HTTPException(400, f"不支持的视频格式：{suffix or '未知'}")

    tmp_path = DATA_DIR / f"upload-{uuid.uuid4().hex}{suffix}"

    def _copy() -> int:
        size = 0
        with open(tmp_path, "wb") as out:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise ValueError("文件超过大小上限")
                out.write(chunk)
        return size

    try:
        size = await asyncio.to_thread(_copy)
        if size == 0:
            raise HTTPException(400, "上传的文件为空")
        meta = await asyncio.to_thread(video_store.create, tmp_path, original)
    except ValueError as exc:
        raise HTTPException(413, str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    # 上传后立即在后台提取教学视频骨架
    _start_analysis(meta["id"])
    return meta


@router.get("")
async def list_videos():
    return {"items": video_store.list()}


@router.get("/search")
async def search_videos(q: str = Query("", description="视频标题关键词")):
    items = video_store.search(q)
    return {"query": q, "items": items}


@router.get("/{video_id}")
async def get_video(video_id: str):
    if not safe_id(video_id):
        raise HTTPException(400, "非法视频 ID")
    meta = video_store.get(video_id)
    if not meta:
        raise HTTPException(404, "视频不存在")
    return meta


@router.delete("/{video_id}")
async def delete_video(video_id: str):
    if not video_store.get(video_id):
        raise HTTPException(404, "视频不存在")
    video_store.delete(video_id)
    return {"deleted": video_id}


# ---------------------------------------------------------------- 播放（Range）


@router.get("/{video_id}/stream")
async def stream_video(video_id: str, request: Request):
    path = video_store.source_path(video_id)
    if not path:
        raise HTTPException(404, "视频文件不存在")

    media_type = MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    file_size = path.stat().st_size
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})

    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not match:
        raise HTTPException(416, "Range 头格式错误")

    start = int(match.group(1) or 0)
    end = int(match.group(2)) if match.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end:
        raise HTTPException(416, "Range 越界")

    length = end - start + 1

    def _iter_chunks():
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Content-Length": str(length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }
    return StreamingResponse(
        _iter_chunks(), status_code=206, media_type=media_type, headers=headers
    )


# ---------------------------------------------------------------- 骨架分析


@router.post("/{video_id}/analyze")
async def analyze_video(video_id: str):
    meta = video_store.get(video_id)
    if not meta:
        raise HTTPException(404, "视频不存在")
    task = _analysis_tasks.get(video_id)
    if task and not task.done():
        return {"status": "processing", "progress": meta.get("pose_progress", 0.0)}
    _start_analysis(video_id)
    return {"status": "processing", "progress": 0.0}


def _start_analysis(video_id: str) -> None:
    task = _analysis_tasks.get(video_id)
    if task and not task.done():
        return
    _analysis_tasks[video_id] = asyncio.create_task(_run_analysis(video_id))


async def _run_analysis(video_id: str) -> None:
    source = video_store.source_path(video_id)
    if not source:
        return

    video_store.update(
        video_id, pose_status="processing", pose_progress=0.0, pose_error=None
    )

    loop = asyncio.get_running_loop()
    last_report = [0.0]

    def _progress(value: float) -> None:
        now = time.monotonic()
        if value >= 1.0 or now - last_report[0] > 1.0:
            last_report[0] = now
            try:
                video_store.update(video_id, pose_progress=round(min(value, 1.0), 3))
            except KeyError:
                pass

    try:
        info = await asyncio.to_thread(
            extract_teaching_pose,
            source,
            video_store.pose_path(video_id),
            TEACH_SAMPLE_FPS,
            _progress,
        )
        video_store.update(
            video_id,
            pose_status="ready",
            pose_progress=1.0,
            pose_frames=info["frames"],
            pose_sample_fps=info["fps"],
        )
        logger.info("骨架分析完成 video=%s frames=%s", video_id, info["frames"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("骨架分析失败 video=%s", video_id)
        video_store.update(video_id, pose_status="failed", pose_error=str(exc))
    finally:
        _analysis_tasks.pop(video_id, None)
        if loop.is_closed():  # pragma: no cover
            return


@router.get("/{video_id}/pose")
async def get_video_pose(
    video_id: str,
    start: Optional[float] = Query(None, ge=0),
    end: Optional[float] = Query(None, ge=0),
):
    meta = video_store.get(video_id)
    if not meta:
        raise HTTPException(404, "视频不存在")
    if meta.get("pose_status") != "ready":
        raise HTTPException(409, f"骨架尚未就绪（{meta.get('pose_status')}）")
    return load_pose_frames(video_store.pose_path(video_id), start, end)
