"""WebSocket connection manager for broadcasting live events to clients."""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections and broadcasts events."""

    def __init__(self) -> None:
        self._connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.append(ws)
        logger.info("WebSocket client connected (%d total)", len(self._connections))

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.remove(ws)
        logger.info("WebSocket client disconnected (%d remaining)", len(self._connections))

    async def broadcast(self, event: str, data: Any) -> None:
        """Send an event to all connected clients."""
        message = json.dumps({"event": event, "data": data})
        stale: list[WebSocket] = []
        for ws in self._connections:
            try:
                await ws.send_text(message)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self._connections.remove(ws)

    @property
    def client_count(self) -> int:
        return len(self._connections)


# Singleton
ws_manager = ConnectionManager()
