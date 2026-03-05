"""CLI wrapper for managing fleet sessions."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from fleet_manager.prompt_template import inject_into_claude_md, remove_from_claude_md


def _tmux(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *args], capture_output=True, text=True)


def _fleet_api(port: int, method: str, path: str) -> dict | list | None:
    """Quick helper to call the fleet manager API. Returns None on failure."""
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}", method=method,
        )
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _get_tmux_cwd(tmux_name: str) -> str | None:
    """Get the working directory of a tmux session's active pane."""
    result = _tmux("display-message", "-t", tmux_name, "-p", "#{pane_current_path}")
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    return None


def _cleanup_claude_md(project_path: str | None) -> None:
    """Best-effort removal of fleet section from CLAUDE.md."""
    if not project_path:
        return
    try:
        if remove_from_claude_md(project_path):
            print(f"Cleaned fleet instructions from {project_path}/CLAUDE.md")
    except Exception as e:
        print(f"Warning: could not clean CLAUDE.md in {project_path}: {e}")


def cmd_start(args: argparse.Namespace) -> None:
    name = args.name
    project = str(Path(args.project).resolve())
    prefix = "fleet-"
    tmux_name = f"{prefix}{name}"
    port = args.port

    # Check if tmux session with this name already exists
    result = _tmux("has-session", "-t", tmux_name)
    if result.returncode == 0:
        print(f"Session '{name}' already exists. Use 'fleet attach {name}' to attach.")
        sys.exit(1)

    # Check if another session is already using this project directory
    sessions = _fleet_api(port, "GET", "/api/sessions")
    if isinstance(sessions, list):
        for s in sessions:
            if s.get("project_root") == project:
                stale_tmux = f"{prefix}{s['session_id']}"
                # Verify the tmux session actually exists — if not, clean up the stale entry
                check = _tmux("has-session", "-t", stale_tmux)
                if check.returncode != 0:
                    print(f"Cleaning up stale session '{s['session_id']}' (tmux session gone)")
                    _fleet_api(port, "DELETE", f"/api/sessions/{s['session_id']}")
                    _cleanup_claude_md(s.get("project_root"))
                    continue
                print(f"Project '{project}' is already managed by session '{s['session_id']}'.")
                print(f"  Attach: fleet attach {s['session_id']}")
                sys.exit(1)

    # Create tmux session
    _tmux("new-session", "-d", "-s", tmux_name, "-c", project)
    _tmux("set-option", "-t", tmux_name, "status-left", f" [{name}] ")
    _tmux("set-option", "-t", tmux_name, "status-right", " Detach: Ctrl+B, D  %H:%M ")
    _tmux("set-option", "-t", tmux_name, "status-style", "bg=#0969da,fg=#ffffff")
    print(f"Created tmux session '{tmux_name}'")

    # Inject fleet prompt into project CLAUDE.md
    claude_md = inject_into_claude_md(project, name)
    print(f"Injected fleet instructions into {claude_md}")

    # Register fleet-manager MCP server via Claude CLI (user scope = global)
    claude_bin = shutil.which("claude")
    if claude_bin:
        reg = subprocess.run(
            [claude_bin, "mcp", "add", "--transport", "sse", "--scope", "user",
             "fleet-manager", f"http://127.0.0.1:{port}/mcp/sse"],
            capture_output=True, text=True,
        )
        if reg.returncode == 0:
            print(f"Registered fleet-manager MCP server (user scope)")
        else:
            print(f"Warning: could not register MCP server: {reg.stderr.strip()}")

    # Pre-register session with fleet manager so it shows up in the dashboard
    reg_data = {
        "session_id": name,
        "tmux_session": tmux_name,
        "tmux_pane": "0",
        "project_root": project,
    }
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/sessions",
            method="POST",
            data=json.dumps(reg_data).encode(),
        )
        req.add_header("Content-Type", "application/json")
        urllib.request.urlopen(req, timeout=2)
        print(f"Registered session with fleet manager")
    except Exception:
        print(f"Warning: could not register with fleet manager (is the server running?)")

    # Try to launch Claude Code in the tmux session
    claude_bin = shutil.which("claude")
    if claude_bin:
        claude_cmd = f"FLEET_SESSION_ID={name} claude"
        _tmux("send-keys", "-t", tmux_name, claude_cmd, "Enter")
        print(f"Launched Claude Code in session")
    else:
        print(f"Claude Code not found in PATH — start it manually after attaching.")

    print(f"\n  Project:  {project}")
    print(f"  tmux:     {tmux_name}")
    print(f"  Web UI:   http://127.0.0.1:{port}")

    if args.detach:
        print(f"  Attach:   fleet attach {name}")
    else:
        print(f"\nAttaching to session (detach with Ctrl+B, D)...")
        os.execvp("tmux", ["tmux", "attach-session", "-t", tmux_name])


def cmd_list(args: argparse.Namespace) -> None:
    result = _tmux("list-sessions", "-F", "#{session_name}")
    if result.returncode != 0:
        print("No tmux sessions running.")
        return

    prefix = "fleet-"
    found = False
    for line in result.stdout.strip().split("\n"):
        if line.startswith(prefix):
            name = line[len(prefix):]
            cwd_result = _tmux("display-message", "-t", line, "-p", "#{pane_current_path}")
            cwd = cwd_result.stdout.strip() if cwd_result.returncode == 0 else "?"
            print(f"  {name:20s} {cwd}")
            found = True
    if not found:
        print("No fleet sessions running.")


def cmd_attach(args: argparse.Namespace) -> None:
    tmux_name = f"fleet-{args.name}"
    result = _tmux("has-session", "-t", tmux_name)
    if result.returncode != 0:
        print(f"Session '{args.name}' not found.")
        sys.exit(1)
    os.execvp("tmux", ["tmux", "attach-session", "-t", tmux_name])


def cmd_stop(args: argparse.Namespace) -> None:
    tmux_name = f"fleet-{args.name}"
    result = _tmux("has-session", "-t", tmux_name)
    if result.returncode != 0:
        print(f"Session '{args.name}' not found.")
        sys.exit(1)

    # Get project directory before killing the session
    project_path = _get_tmux_cwd(tmux_name)

    # Also check the fleet manager for the project_root
    if not project_path:
        session_data = _fleet_api(args.port, "GET", f"/api/sessions/{args.name}")
        if isinstance(session_data, dict):
            project_path = session_data.get("project_root")

    _tmux("kill-session", "-t", tmux_name)
    print(f"Stopped session '{args.name}'")

    # Clean up CLAUDE.md
    _cleanup_claude_md(project_path)

    # Remove from fleet manager
    _fleet_api(args.port, "DELETE", f"/api/sessions/{args.name}")


def cmd_clean(args: argparse.Namespace) -> None:
    """Remove fleet instructions from a project's CLAUDE.md."""
    project = str(Path(args.project).resolve())
    if remove_from_claude_md(project):
        print(f"Removed fleet instructions from {project}/CLAUDE.md")
    else:
        print(f"No fleet instructions found in {project}/CLAUDE.md")


def main() -> None:
    parser = argparse.ArgumentParser(prog="fleet", description="Claude Fleet Manager CLI")
    sub = parser.add_subparsers(dest="command")

    start_p = sub.add_parser("start", help="Start a new fleet-managed Claude Code session")
    start_p.add_argument("--name", required=True, help="Session name")
    start_p.add_argument("--project", default=".", help="Project directory")
    start_p.add_argument("--port", type=int, default=7700, help="Fleet manager port")
    start_p.add_argument("-d", "--detach", action="store_true",
                         help="Don't attach to the session (useful for batch-starting multiple sessions)")

    sub.add_parser("list", help="List fleet sessions")

    attach_p = sub.add_parser("attach", help="Attach to a fleet session")
    attach_p.add_argument("name", help="Session name")

    stop_p = sub.add_parser("stop", help="Stop a fleet session")
    stop_p.add_argument("name", help="Session name")
    stop_p.add_argument("--port", type=int, default=7700, help="Fleet manager port")

    clean_p = sub.add_parser("clean", help="Remove fleet instructions from a project's CLAUDE.md")
    clean_p.add_argument("project", help="Project directory path")

    args = parser.parse_args()
    if args.command == "start":
        cmd_start(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "attach":
        cmd_attach(args)
    elif args.command == "stop":
        cmd_stop(args)
    elif args.command == "clean":
        cmd_clean(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
