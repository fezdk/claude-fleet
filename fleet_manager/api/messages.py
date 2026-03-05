"""REST API routes for sending messages (instructions) to sessions."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fleet_manager import db
from fleet_manager.config import get_config
from fleet_manager.tmux_bridge import inject_input
from fleet_manager.ws_manager import ws_manager

router = APIRouter(prefix="/api/sessions", tags=["messages"])


class MessagePayload(BaseModel):
    content: str
    from_client: str = "web"
    urgent: bool = False


@router.post("/{session_id}/message")
async def send_message(session_id: str, payload: MessagePayload):
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(404, f"Session '{session_id}' not found")

    cfg = get_config()
    prefix = cfg.sessions.message_prefix
    prefixed_content = f"{prefix} {payload.content}"

    message = db.create_inbox_message(session_id, payload.content, payload.from_client)

    state = session["state"]

    # Decide delivery strategy based on session state
    if state == "IDLE" or payload.urgent:
        # Inject immediately
        await inject_input(session["tmux_session"], session["tmux_pane"], prefixed_content)
        db.mark_message_delivered(message["message_id"])
        message["delivered"] = True
        message["delivery_method"] = "immediate"
    elif state == "AWAITING_INPUT":
        # Inject immediately (answering a pending question)
        await inject_input(session["tmux_session"], session["tmux_pane"], payload.content)
        db.mark_message_delivered(message["message_id"])
        message["delivered"] = True
        message["delivery_method"] = "awaiting_input"
    else:
        # WORKING — queue for later delivery
        message["delivery_method"] = "queued"

    await ws_manager.broadcast("session:message", message)
    return message
