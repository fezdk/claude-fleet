"""MCP server exposing report_status and relay_question tools over Streamable HTTP."""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.server.fastmcp import FastMCP

from fleet_manager import db
from fleet_manager.ws_manager import ws_manager
from fleet_manager.notifications import notify_state_change, notify_question

logger = logging.getLogger(__name__)

VALID_STATES = {"IDLE", "WORKING", "AWAITING_INPUT", "ERROR"}

mcp = FastMCP(
    "fleet-manager",
    instructions=(
        "Fleet manager MCP server. Use report_status to report state changes "
        "and relay_question to mirror questions for remote clients."
    ),
    stateless_http=True,
    json_response=True,
)


@mcp.tool()
async def report_status(
    session_id: str,
    state: str,
    summary: str,
    project_root: str,
    detail: str = "",
    claude_session_id: str = "",
) -> dict[str, Any]:
    """Report your current status to the fleet manager.

    MANDATORY on every state change. During WORKING state, call every 5-10
    minutes with a progress update.

    Args:
        session_id: Your assigned session identifier.
        state: Current session state — one of IDLE, WORKING, AWAITING_INPUT, ERROR.
        summary: Human-readable summary of what you did/are doing/went wrong. Under 200 chars.
        project_root: Absolute path to the project you're working in.
        detail: Optional longer context — accomplishments, blockers, next steps.
        claude_session_id: Your Claude Code session UUID. Include on your FIRST report_status call.
    """
    if state not in VALID_STATES:
        return {"error": f"Invalid state '{state}'. Must be one of {sorted(VALID_STATES)}"}

    session = db.update_status(session_id, state, summary, project_root, detail or None)

    if claude_session_id:
        db.update_claude_session_id(session_id, claude_session_id)
        session = db.get_session(session_id)
        logger.info("[%s] Claude session ID registered: %s", session_id, claude_session_id)

    await ws_manager.broadcast("session:update", session)
    await notify_state_change(session_id, state, summary)
    logger.info("[%s] %s → %s: %s", session_id, state, summary, detail or "")

    # Immediately deliver queued messages when session becomes IDLE
    if state == "IDLE" and session:
        from fleet_manager.server import deliver_queued_for_session
        from fleet_manager.config import get_config
        prefix = get_config().sessions.message_prefix
        await deliver_queued_for_session(session, prefix)

    return {"ok": True, "session": session}


@mcp.tool()
async def relay_question(
    session_id: str,
    items: list[dict[str, Any]],
    context: str = "",
) -> dict[str, Any]:
    """Mirror a question to the fleet manager BEFORE you print it to the terminal.

    This allows remote clients to see and answer your question. Always call
    this before asking anything in the terminal. Then proceed to ask normally —
    the answer will arrive through terminal input regardless of whether the user is
    local or remote.

    Args:
        session_id: Your session identifier.
        items: One or more question items. Each must have id (str), type (confirm|choice|multi_select|freetext), text (str), and optionally options (list[str]) and default (str).
        context: Brief context about why you're asking.
    """
    # Validate items structure - reject non-dict objects or missing required fields
    if not isinstance(items, list):
        return {"error": "items must be a list of question objects", "relayed": False}
    
    valid_types = {"confirm", "choice", "multi_select", "freetext"}
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            return {"error": f"items[{idx}] must be a dict, got {type(item).__name__}", "relayed": False}
        if "id" not in item:
            return {"error": f"items[{idx}] missing required 'id' field", "relayed": False}
        if "type" not in item:
            return {"error": f"items[{idx}] missing required 'type' field", "relayed": False}
        if item.get("type") not in valid_types:
            return {"error": f"items[{idx}] type must be one of {valid_types}, got '{item.get('type')}'", "relayed": False}
        if "text" not in item:
            return {"error": f"items[{idx}] missing required 'text' field", "relayed": False}
    
    items_json = json.dumps(items)
    question = db.create_question(session_id, items_json, context or None)
    await ws_manager.broadcast("question:new", question)
    await notify_question(session_id, context or "", items)
    logger.info("[%s] Question relayed: %s", session_id, context or items)
    return {"relayed": True}
