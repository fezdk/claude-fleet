"""REST API routes for sessions."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fleet_manager import db
from fleet_manager.config import get_config
from fleet_manager.tmux_bridge import capture_output

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class RegisterPayload(BaseModel):
    session_id: str
    tmux_session: str | None = None
    tmux_pane: str = "0"
    project_root: str | None = None


@router.get("")
async def list_sessions():
    return db.get_all_sessions()


@router.post("")
async def register_session(payload: RegisterPayload):
    existing = db.get_session(payload.session_id)
    if existing:
        raise HTTPException(409, f"Session '{payload.session_id}' already exists")
    tmux_session = payload.tmux_session or f"fleet-{payload.session_id}"
    session = db.create_session(payload.session_id, tmux_session, payload.tmux_pane, payload.project_root)
    return session


@router.get("/{session_id}")
async def get_session(session_id: str):
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(404, f"Session '{session_id}' not found")

    cfg = get_config()
    session["status_log"] = db.get_status_log(session_id, cfg.ui.max_status_history)
    return session


@router.get("/{session_id}/output")
async def get_session_output(session_id: str):
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(404, f"Session '{session_id}' not found")

    cfg = get_config()
    try:
        output = await capture_output(
            session["tmux_session"],
            session["tmux_pane"],
            cfg.ui.terminal_capture_lines,
        )
        return {"output": output}
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    if not db.delete_session(session_id):
        raise HTTPException(404, f"Session '{session_id}' not found")
    return {"deleted": True}
