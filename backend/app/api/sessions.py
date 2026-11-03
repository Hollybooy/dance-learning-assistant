"""练习回放接口。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..services.media_tools import safe_id
from ..services.session_store import session_store

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("")
async def list_sessions():
    return {"items": session_store.list()}


@router.get("/{session_id}")
async def get_session(session_id: str):
    if not safe_id(session_id):
        raise HTTPException(400, "非法回放 ID")
    session = session_store.get(session_id)
    if not session:
        raise HTTPException(404, "回放不存在")
    return session


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    if not safe_id(session_id):
        raise HTTPException(400, "非法回放 ID")
    if not (session_store.root / session_id).exists():
        raise HTTPException(404, "回放不存在")
    session_store.delete(session_id)
    return {"deleted": session_id}
