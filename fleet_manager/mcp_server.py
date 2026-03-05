"""MCP server exposing report_status and relay_question tools over SSE."""

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
)


@mcp.tool()
async def report_status(
    session_id: str,
    state: str,
    summary: str,
    project_root: str,
    detail: str = "",
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
    """
    if state not in VALID_STATES:
        return {"error": f"Invalid state '{state}'. Must be one of {sorted(VALID_STATES)}"}

    session = db.update_status(session_id, state, summary, project_root, detail or None)
    await ws_manager.broadcast("session:update", session)
    await notify_state_change(session_id, state, summary)
    logger.info("[%s] %s → %s: %s", session_id, state, summary, detail or "")
    return {"ok": True, "session": session}


@mcp.tool()
async def relay_question(
    session_id: str,
    items: list[dict[str, Any]],
    context: str = "",
) -> dict[str, bool]:
    """Mirror a question to the fleet manager BEFORE you print it to the terminal.

    This allows remote clients to see and answer your question. Always call
    this before asking anything in the terminal. Then proceed to ask normally —
    the answer will arrive via terminal input regardless of whether the user is
    local or remote.

    Args:
        session_id: Your session identifier.
        items: One or more question items. Each must have id (str), type (confirm|choice|multi_select|freetext), text (str), and optionally options (list[str]) and default (str).
        context: Brief context about why you're asking.
    """
    items_json = json.dumps(items)
    question = db.create_question(session_id, items_json, context or None)
    await ws_manager.broadcast("question:new", question)
    await notify_question(session_id, context or "", items)
    logger.info("[%s] Question relayed: %s", session_id, context or items)
    return {"relayed": True}
