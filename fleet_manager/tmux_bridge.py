"""tmux bridge — read output from and inject input into tmux panes."""

from __future__ import annotations

import asyncio
import re
import shutil


def _ensure_tmux() -> str:
    path = shutil.which("tmux")
    if not path:
        raise RuntimeError("tmux is not installed or not in PATH")
    return path


async def _run(cmd: list[str]) -> tuple[str, str, int]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return stdout.decode().strip(), stderr.decode().strip(), proc.returncode or 0


# Strip ANSI escape sequences
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b\[[\d;]*m")


def strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


async def capture_output(tmux_session: str, pane: str = "0", lines: int = 50) -> str:
    """Capture the last N lines of a tmux pane."""
    _ensure_tmux()
    target = f"{tmux_session}:{pane}"
    stdout, stderr, rc = await _run([
        "tmux", "capture-pane", "-t", target, "-p", "-S", f"-{lines}",
    ])
    if rc != 0:
        raise RuntimeError(f"tmux capture-pane failed: {stderr}")
    return strip_ansi(stdout)


async def inject_input(tmux_session: str, pane: str = "0", text: str = "", submit: bool = True) -> None:
    """Send keystrokes to a tmux pane.

    When submit=True, sends the text followed by two Enter keys — the first
    enters the text into Claude Code's input, the second submits it.
    """
    _ensure_tmux()
    target = f"{tmux_session}:{pane}"

    # Send the text content
    _, stderr, rc = await _run(["tmux", "send-keys", "-t", target, text, "Enter"])
    if rc != 0:
        raise RuntimeError(f"tmux send-keys failed: {stderr}")

    if submit:
        # Small delay then send a second Enter to submit
        await asyncio.sleep(0.1)
        _, stderr, rc = await _run(["tmux", "send-keys", "-t", target, "Enter"])
        if rc != 0:
            raise RuntimeError(f"tmux send-keys (submit) failed: {stderr}")


async def inject_sequential(
    tmux_session: str,
    pane: str,
    answers: list[str],
    delay_ms: int = 150,
) -> None:
    """Send multiple answers sequentially with delays between them."""
    for answer in answers:
        await inject_input(tmux_session, pane, answer, submit=True)
        await asyncio.sleep(delay_ms / 1000)


async def list_sessions() -> list[str]:
    """List all tmux session names."""
    _ensure_tmux()
    stdout, stderr, rc = await _run([
        "tmux", "list-sessions", "-F", "#{session_name}",
    ])
    if rc != 0:
        # tmux returns error if no server is running
        if "no server running" in stderr or "no sessions" in stderr:
            return []
        raise RuntimeError(f"tmux list-sessions failed: {stderr}")
    return [s for s in stdout.split("\n") if s]


async def get_working_directory(tmux_session: str, pane: str = "0") -> str:
    """Get the current working directory of a tmux pane."""
    _ensure_tmux()
    target = f"{tmux_session}:{pane}"
    stdout, stderr, rc = await _run([
        "tmux", "display-message", "-t", target, "-p", "#{pane_current_path}",
    ])
    if rc != 0:
        raise RuntimeError(f"tmux display-message failed: {stderr}")
    return stdout


async def session_exists(tmux_session: str) -> bool:
    """Check if a tmux session exists."""
    _ensure_tmux()
    _, _, rc = await _run(["tmux", "has-session", "-t", tmux_session])
    return rc == 0
