"""Shared session launch/stop logic used by both CLI and API."""

from __future__ import annotations

import logging
import os
import subprocess
import time

from fleet_manager import db
from fleet_manager.config import get_config
from fleet_manager.prompt_template import generate_prompt
from fleet_manager.tmux_bridge import session_exists, kill_session

logger = logging.getLogger(__name__)

TMUX_PREFIX = "fleet-"


class LaunchError(Exception):
    """Raised when session launch fails validation or setup."""


def _tmux_sync(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *args], capture_output=True, text=True)


async def start_session(
    name: str,
    project: str,
    port: int = 7700,
) -> dict:
    """Start a new fleet-managed Claude Code session.

    Validates inputs, creates tmux session, registers MCP, launches Claude.
    Returns the created session dict.

    Raises LaunchError on validation failures.
    """
    tmux_name = f"{TMUX_PREFIX}{name}"

    # Validate project path
    if not os.path.isdir(project):
        raise LaunchError(f"Project path does not exist: {project}")

    # Check for name collision
    if await session_exists(tmux_name):
        raise LaunchError(f"tmux session '{tmux_name}' already exists")
    if db.get_session(name):
        raise LaunchError(f"Session '{name}' already exists")

    # Create tmux session with configured dimensions
    cfg = get_config()
    result = _tmux_sync(
        "new-session", "-d", "-s", tmux_name, "-c", project,
        "-x", str(cfg.tmux.default_width), "-y", str(cfg.tmux.default_height),
    )
    if result.returncode != 0:
        raise LaunchError(f"Failed to create tmux session: {result.stderr.strip()}")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "status-left", f" [{name}] ")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "status-right", " Detach: Ctrl+B, D  %H:%M ")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "status-style", "bg=#0969da,fg=#ffffff")
    # Enable mouse scrollback and increase history buffer
    _tmux_sync("set-option", "-t", f"={tmux_name}", "mouse", "on")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "history-limit", "10000")
    # Set pane colors to match dashboard terminal theme
    _tmux_sync("select-pane", "-t", f"={tmux_name}:0", "-P", "bg=#1e1e2e,fg=#cdd6f4")

    # Build MCP URL and fleet system prompt
    mcp_url = f"http://127.0.0.1:{port}/mcp/mcp"
    fleet_prompt = generate_prompt(name, mcp_url=mcp_url)

    # Build MCP registration command (include auth header if token is set)
    auth_token = cfg.server.auth_token
    mcp_add_cmd = f'claude mcp add --transport http --scope user fleet-manager {mcp_url}'
    if auth_token:
        mcp_add_cmd += f' --header "Authorization: Bearer {auth_token}"'

    # Write a launcher script that handles MCP registration + Claude start
    script_file = f"/tmp/fleet-launch-{name}.sh"
    with open(script_file, "w") as f:
        f.write(f'#!/bin/bash\n')
        f.write(f'{mcp_add_cmd} 2>/dev/null\n')
        f.write(f'sleep 1\n')
        f.write(f'FLEET_SESSION_ID={name} exec claude --permission-mode acceptEdits \\\n')
        f.write(f'  --append-system-prompt "$(cat <<\'FLEET_PROMPT_EOF\'\n')
        f.write(fleet_prompt)
        f.write(f'\nFLEET_PROMPT_EOF\n')
        f.write(f')"\n')
    os.chmod(script_file, 0o755)

    # Register session in DB
    session = db.create_session(name, tmux_name, "0", project)

    # Wait for shell to be ready before sending keys
    time.sleep(1)

    # Launch via the script (avoids send-keys quoting issues)
    _tmux_sync("send-keys", "-t", f"={tmux_name}:0", f"bash {script_file}", "Enter")
    logger.info("Launched Claude Code in session '%s'", name)

    return session


async def fork_session(
    source_name: str,
    new_name: str,
    port: int = 7700,
) -> dict:
    """Fork an existing session — creates a new fleet session that branches
    from the source session's Claude conversation history.

    Requires the source session to have reported its claude_session_id.

    Raises LaunchError on validation failures.
    """
    source = db.get_session(source_name)
    if not source:
        raise LaunchError(f"Source session '{source_name}' not found")

    claude_sid = source.get("claude_session_id")
    if not claude_sid:
        raise LaunchError(
            f"Session '{source_name}' has no Claude session ID — "
            "it must report status at least once before it can be forked"
        )

    project = source.get("project_root")
    if not project:
        raise LaunchError(f"Session '{source_name}' has no project root")

    tmux_name = f"{TMUX_PREFIX}{new_name}"

    # Check for name collision
    if await session_exists(tmux_name):
        raise LaunchError(f"tmux session '{tmux_name}' already exists")
    if db.get_session(new_name):
        raise LaunchError(f"Session '{new_name}' already exists")

    # Create tmux session with configured dimensions
    cfg = get_config()
    result = _tmux_sync(
        "new-session", "-d", "-s", tmux_name, "-c", project,
        "-x", str(cfg.tmux.default_width), "-y", str(cfg.tmux.default_height),
    )
    if result.returncode != 0:
        raise LaunchError(f"Failed to create tmux session: {result.stderr.strip()}")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "status-left", f" [{new_name}] ")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "status-right", " Detach: Ctrl+B, D  %H:%M ")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "status-style", "bg=#0969da,fg=#ffffff")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "mouse", "on")
    _tmux_sync("set-option", "-t", f"={tmux_name}", "history-limit", "10000")
    _tmux_sync("select-pane", "-t", f"={tmux_name}:0", "-P", "bg=#1e1e2e,fg=#cdd6f4")

    # Build MCP URL and fleet system prompt
    mcp_url = f"http://127.0.0.1:{port}/mcp/mcp"
    fleet_prompt = generate_prompt(new_name, mcp_url=mcp_url)

    # Build MCP registration command (include auth header if token is set)
    auth_token = cfg.server.auth_token
    mcp_add_cmd = f'claude mcp add --transport http --scope user fleet-manager {mcp_url}'
    if auth_token:
        mcp_add_cmd += f' --header "Authorization: Bearer {auth_token}"'

    # Build the fork notification
    fork_msg = (
        f"You have been forked from session '{source_name}' into a new fleet session. "
        f"Your new fleet session_id is '{new_name}' — use this for ALL fleet tool calls from now on. "
        f"Your claude_session_id has also changed. Re-read it now "
        f"(run: ls -t ~/.claude/projects/.../*.jsonl — first result is yours, extract the UUID from the filename) "
        f"and immediately call report_status with state IDLE and the new claude_session_id."
    )

    # Write launcher script.
    # A background subshell polls tmux until Claude is running, then injects
    # the fork notification as a [fleet] message.
    script_file = f"/tmp/fleet-launch-{new_name}.sh"
    tmux_target = f"={TMUX_PREFIX}{new_name}:0"
    with open(script_file, "w") as f:
        f.write(f'#!/bin/bash\n')
        f.write(f'{mcp_add_cmd} 2>/dev/null\n')
        f.write(f'sleep 1\n')
        # Background: poll until claude is the active process, then inject
        f.write(f'(\n')
        f.write(f'  for i in $(seq 1 30); do\n')
        f.write(f'    CMD=$(tmux display-message -t "{tmux_target}" -p "#{{pane_current_command}}" 2>/dev/null)\n')
        f.write(f'    [ "$CMD" = "claude" ] && break\n')
        f.write(f'    sleep 1\n')
        f.write(f'  done\n')
        f.write(f'  sleep 2\n')
        f.write(f'  tmux send-keys -t "{tmux_target}" "[fleet] {fork_msg}" Enter\n')
        f.write(f'  sleep 0.2\n')
        f.write(f'  tmux send-keys -t "{tmux_target}" Enter\n')
        f.write(f') &\n')
        f.write(f'FLEET_SESSION_ID={new_name} exec claude --resume {claude_sid} --fork-session \\\n')
        f.write(f'  --permission-mode acceptEdits \\\n')
        f.write(f'  --append-system-prompt "$(cat <<\'FLEET_PROMPT_EOF\'\n')
        f.write(fleet_prompt)
        f.write(f'\nFLEET_PROMPT_EOF\n')
        f.write(f')"\n')
    os.chmod(script_file, 0o755)

    # Register session in DB
    session = db.create_session(new_name, tmux_name, "0", project)

    # Wait for shell to be ready before sending keys
    time.sleep(1)

    _tmux_sync("send-keys", "-t", f"={tmux_name}:0", f"bash {script_file}", "Enter")
    logger.info("Forked session '%s' from '%s' (claude_sid=%s)", new_name, source_name, claude_sid)

    return session


async def stop_session(name: str) -> bool:
    """Stop a fleet session — kill tmux, clean up prompt file, remove from DB.

    Returns True if the session was found and stopped.
    """
    tmux_name = f"{TMUX_PREFIX}{name}"

    tmux_killed = await kill_session(tmux_name)

    # Clean up temp files
    for f in (f"/tmp/fleet-prompt-{name}.txt", f"/tmp/fleet-launch-{name}.sh"):
        if os.path.exists(f):
            os.remove(f)

    db.delete_session(name)
    return tmux_killed
