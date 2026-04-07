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


def clean_output(text: str) -> str:
    """Strip Claude Code TUI chrome from captured terminal output.

    Removes the input field, separator lines, hints bar, and status line
    that Claude Code renders at the bottom of the terminal. Also collapses
    duplicate blank lines and strips trailing whitespace-only lines.
    """
    lines = text.split("\n")

    # Strip Claude Code's bottom chrome by walking backwards from the end.
    # The bottom of a Claude Code pane typically looks like:
    #   ─────────────────────── (separator)
    #   ❯ ▮                    (input prompt)
    #   ─────────────────────── (separator)
    #   ⏵⏵ accept edits on ... (hints/mode bar)
    #   (blank padding)
    while lines:
        plain = strip_ansi(lines[-1]).strip()
        if not plain:
            lines.pop()
            continue
        # Hints/mode bar: contains ⏵ with shift+tab or permission mode keywords
        if "shift+tab" in plain or "esc to interrupt" in plain or "esc to cancel" in plain:
            lines.pop()
            continue
        # Separator: line is mostly ─ (U+2500) or ━ (U+2501)
        stripped_chars = plain.replace(" ", "")
        if stripped_chars and all(c in "─━" for c in stripped_chars):
            lines.pop()
            continue
        # Input prompt: starts with ❯ or is just a cursor block
        if plain.startswith("❯") or plain == "▮" or (len(stripped_chars) <= 3 and "❯" in plain):
            lines.pop()
            continue
        break

    # Strip trailing blank lines
    while lines and not strip_ansi(lines[-1]).strip():
        lines.pop()

    return "\n".join(lines)


async def capture_output(tmux_session: str, pane: str = "0", lines: int = 50) -> str:
    """Capture the last N lines of a tmux pane, with TUI chrome stripped."""
    _ensure_tmux()
    target = f"={tmux_session}:{pane}"
    stdout, stderr, rc = await _run([
        "tmux", "capture-pane", "-t", target, "-p", "-e", "-S", f"-{lines}",
    ])
    if rc != 0:
        raise RuntimeError(f"tmux capture-pane failed: {stderr}")
    return clean_output(stdout)


async def inject_input(tmux_session: str, pane: str = "0", text: str = "", submit: bool = True) -> None:
    """Send keystrokes to a tmux pane.

    When submit=True, sends the text followed by two Enter keys — the first
    enters the text into Claude Code's input, the second submits it.
    """
    _ensure_tmux()
    target = f"={tmux_session}:{pane}"

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


async def send_raw_keys(tmux_session: str, pane: str = "0", keys: list[str] | None = None) -> None:
    """Send raw tmux key names (e.g. Up, Down, Enter, Escape) without any prefix or submit."""
    _ensure_tmux()
    target = f"={tmux_session}:{pane}"
    for key in (keys or []):
        if key == "ScrollUp":
            # opencode: map to PageUp for scrolling up
            _, stderr, rc = await _run(["tmux", "send-keys", "-t", target, "PageUp"])
        elif key == "ScrollDown":
            # opencode: map to PageDown for scrolling down
            _, stderr, rc = await _run(["tmux", "send-keys", "-t", target, "PageDown"])
        else:
            _, stderr, rc = await _run(["tmux", "send-keys", "-t", target, key])
        if rc != 0:
            raise RuntimeError(f"tmux send-keys failed for '{key}': {stderr}")


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
    target = f"={tmux_session}:{pane}"
    stdout, stderr, rc = await _run([
        "tmux", "display-message", "-t", target, "-p", "#{pane_current_path}",
    ])
    if rc != 0:
        raise RuntimeError(f"tmux display-message failed: {stderr}")
    return stdout


async def session_exists(tmux_session: str) -> bool:
    """Check if a tmux session exists (exact match)."""
    _ensure_tmux()
    _, _, rc = await _run(["tmux", "has-session", "-t", f"={tmux_session}"])
    return rc == 0


async def kill_session(tmux_session: str) -> bool:
    """Kill a tmux session (exact match). Returns True if it was running."""
    _ensure_tmux()
    _, _, rc = await _run(["tmux", "kill-session", "-t", f"={tmux_session}"])
    return rc == 0
