from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ServerConfig:
    port: int = 7700
    host: str = "127.0.0.1"
    auth_token: str = ""


@dataclass
class McpConfig:
    path: str = "/mcp"


@dataclass
class SessionsConfig:
    progress_update_interval_minutes: int = 5
    stale_timeout_minutes: int = 15
    message_prefix: str = "[fleet]"
    queue_check_interval_seconds: int = 5


@dataclass
class TmuxConfig:
    session_prefix: str = "fleet-"
    input_inject_delay_ms: int = 150
    default_width: int = 220
    default_height: int = 50


@dataclass
class UiConfig:
    terminal_capture_lines: int = 50
    max_status_history: int = 100


@dataclass
class NotificationsConfig:
    on_awaiting_input: bool = True
    on_error: bool = True
    on_task_complete: bool = True
    on_stale: bool = True
    telegram_token: str = ""
    telegram_chat_id: str = ""


@dataclass
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    mcp: McpConfig = field(default_factory=McpConfig)
    sessions: SessionsConfig = field(default_factory=SessionsConfig)
    tmux: TmuxConfig = field(default_factory=TmuxConfig)
    ui: UiConfig = field(default_factory=UiConfig)
    notifications: NotificationsConfig = field(default_factory=NotificationsConfig)


_config: Config | None = None


def load_config(config_path: str | Path | None = None) -> Config:
    global _config
    if _config is not None:
        return _config

    if config_path is None:
        config_path = Path(__file__).parent.parent / "config" / "default.json"

    config_path = Path(config_path)
    if config_path.exists():
        raw = json.loads(config_path.read_text())
        _config = Config(
            server=ServerConfig(**raw.get("server", {})),
            mcp=McpConfig(**raw.get("mcp", {})),
            sessions=SessionsConfig(**raw.get("sessions", {})),
            tmux=TmuxConfig(**raw.get("tmux", {})),
            ui=UiConfig(**raw.get("ui", {})),
            notifications=NotificationsConfig(**raw.get("notifications", {})),
        )
    else:
        _config = Config()

    # Environment overrides
    if v := os.environ.get("FLEET_PORT"):
        _config.server.port = int(v)
    if v := os.environ.get("FLEET_HOST"):
        _config.server.host = v
    if v := os.environ.get("FLEET_AUTH_TOKEN"):
        _config.server.auth_token = v

    return _config


def get_config() -> Config:
    if _config is None:
        return load_config()
    return _config
