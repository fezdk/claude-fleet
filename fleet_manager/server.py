"""Main server — FastAPI app with REST API, WebSocket, and MCP server."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import uvicorn
from fastapi import FastAPI, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pathlib import Path

from fleet_manager.config import load_config, get_config
from fleet_manager.db import (
    init_db, get_all_sessions, get_queued_messages,
    mark_message_delivered, update_status, create_session, get_session,
)
from fleet_manager.tmux_bridge import inject_input, session_exists, list_sessions as list_tmux_sessions
from fleet_manager.ws_manager import ws_manager
from fleet_manager.mcp_server import mcp
from fleet_manager.auth import AuthMiddleware, verify_ws_token
from fleet_manager.notifications import init_notifications, notify_stale
from fleet_manager.api.sessions import router as sessions_router
from fleet_manager.api.questions import router as questions_router
from fleet_manager.api.messages import router as messages_router
from fleet_manager.api.filesystem import router as filesystem_router

logger = logging.getLogger(__name__)

_start_time: datetime | None = None


async def _queue_delivery_loop(interval: int, prefix: str) -> None:
    """Periodically deliver queued messages to sessions that become IDLE."""
    while True:
        await asyncio.sleep(interval)
        try:
            sessions = get_all_sessions()
            for session in sessions:
                if session["state"] != "IDLE":
                    continue
                queued = get_queued_messages(session["session_id"])
                for msg in queued:
                    content = msg["content"] if msg.get("raw") else f"{prefix} {msg['content']}"
                    try:
                        await inject_input(session["tmux_session"], session["tmux_pane"], content)
                        mark_message_delivered(msg["message_id"])
                        logger.info("Delivered queued message %s to %s", msg["message_id"], session["session_id"])
                    except RuntimeError as e:
                        logger.warning("Failed to deliver message %s: %s", msg["message_id"], e)
                    break  # One message at a time per session per cycle
        except Exception:
            logger.exception("Error in queue delivery loop")


async def _heartbeat_loop(stale_minutes: int) -> None:
    """Detect stale sessions that stopped reporting."""
    while True:
        await asyncio.sleep(60)
        try:
            sessions = get_all_sessions()
            for session in sessions:
                if session["state"] == "IDLE":
                    continue
                last_seen = session.get("last_seen")
                if not last_seen:
                    continue
                try:
                    last_dt = datetime.fromisoformat(last_seen).replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                age_minutes = (datetime.now(timezone.utc) - last_dt).total_seconds() / 60
                if age_minutes > stale_minutes:
                    alive = await session_exists(session["tmux_session"])
                    if not alive:
                        logger.warning("Session %s: tmux session gone, marking ERROR", session["session_id"])
                        updated = update_status(
                            session["session_id"], "ERROR",
                            "tmux session no longer exists",
                            detail=f"Last seen {int(age_minutes)}m ago, tmux session not found"
                        )
                        await ws_manager.broadcast("session:update", updated)
                        await notify_stale(session["session_id"], int(age_minutes))
                    else:
                        logger.warning("Session %s: stale (%dm since last report)", session["session_id"], int(age_minutes))
                        await ws_manager.broadcast("session:stale", {
                            "session_id": session["session_id"],
                            "minutes_since_update": int(age_minutes),
                        })
                        await notify_stale(session["session_id"], int(age_minutes))
        except Exception:
            logger.exception("Error in heartbeat loop")


async def _auto_discover_tmux(prefix: str) -> None:
    """Discover existing fleet tmux sessions and auto-register them."""
    try:
        tmux_sessions = await list_tmux_sessions()
        for name in tmux_sessions:
            if not name.startswith(prefix):
                continue
            session_id = name[len(prefix):]
            if not get_session(session_id):
                create_session(session_id, name)
                logger.info("Auto-discovered tmux session: %s -> %s", name, session_id)
    except RuntimeError:
        pass  # tmux not running


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _start_time
    _start_time = datetime.now(timezone.utc)

    cfg = load_config()
    init_db()
    logger.info("Database initialized")

    # Initialize notifications
    notifications_cfg = getattr(cfg, "notifications", None)
    init_notifications(notifications_cfg.__dict__ if notifications_cfg else None)

    # Auto-discover existing fleet tmux sessions
    await _auto_discover_tmux(cfg.tmux.session_prefix)

    # Start background tasks
    queue_task = asyncio.create_task(
        _queue_delivery_loop(cfg.sessions.queue_check_interval_seconds, cfg.sessions.message_prefix)
    )
    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(cfg.sessions.stale_timeout_minutes)
    )

    yield

    queue_task.cancel()
    heartbeat_task.cancel()
    for t in (queue_task, heartbeat_task):
        try:
            await t
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Claude Fleet Manager", version="0.1.0", lifespan=lifespan)

# Auth middleware
app.add_middleware(AuthMiddleware)

# REST API routes
app.include_router(sessions_router)
app.include_router(questions_router)
app.include_router(messages_router)
app.include_router(filesystem_router)

# Mount MCP SSE server
app.mount("/mcp", mcp.sse_app())


# Auth check endpoint (skips auth middleware)
@app.get("/api/auth/check")
async def auth_check(authorization: str | None = Header(None)):
    token = get_config().server.auth_token
    if not token:
        return {"auth_required": False}
    result = {"auth_required": True}
    if authorization and authorization == f"Bearer {token}":
        result["valid"] = True
    elif authorization:
        result["valid"] = False
    return result


# Health endpoint
@app.get("/api/health")
async def health():
    sessions = get_all_sessions()
    return {
        "status": "ok",
        "uptime_seconds": int((datetime.now(timezone.utc) - _start_time).total_seconds()) if _start_time else 0,
        "sessions": len(sessions),
        "sessions_by_state": {
            state: sum(1 for s in sessions if s["state"] == state)
            for state in {"IDLE", "WORKING", "AWAITING_INPUT", "ERROR"}
            if any(s["state"] == state for s in sessions)
        },
        "ws_clients": ws_manager.client_count,
    }


# WebSocket endpoint
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    if not verify_ws_token(ws):
        await ws.close(code=4001, reason="Unauthorized")
        return
    await ws_manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)


# No-cache middleware for static web assets (edit HTML/CSS/JS without restarting)
class _NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.endswith(('.html', '.css', '.js')) or request.url.path == '/':
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        return response

app.add_middleware(_NoCacheStaticMiddleware)

# Serve static web UI
web_dir = Path(__file__).parent.parent / "web"
if web_dir.exists():
    app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")


class _TokenRedactFilter(logging.Filter):
    """Redact auth tokens from uvicorn access logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if hasattr(record, "args") and isinstance(record.args, tuple):
            record.args = tuple(
                str(a).replace(a.split("token=")[1].split("&")[0].split(" ")[0].split('"')[0], "***")
                if isinstance(a, str) and "token=" in a
                else a
                for a in record.args
            )
        msg = record.getMessage()
        if "token=" in msg:
            import re
            record.msg = re.sub(r"token=[^&\s\"']+", "token=***", record.msg)
            record.args = None
        return True


def _handle_sighup(*_args) -> None:
    """Re-exec the server process on SIGHUP for graceful restart."""
    logger.info("SIGHUP received — restarting server")
    os.execv(sys.executable, [sys.executable] + sys.argv)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
    logging.getLogger("uvicorn.access").addFilter(_TokenRedactFilter())

    signal.signal(signal.SIGHUP, _handle_sighup)

    cfg = load_config()
    logger.info("Starting Fleet Manager on %s:%d", cfg.server.host, cfg.server.port)
    uvicorn.run(app, host=cfg.server.host, port=cfg.server.port)


if __name__ == "__main__":
    main()
