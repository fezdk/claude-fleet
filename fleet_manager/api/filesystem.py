"""REST API routes for filesystem operations: path completion, file browsing, read/write."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fleet_manager import db

router = APIRouter(prefix="/api/filesystem", tags=["filesystem"])

MAX_FILE_SIZE = 512_000  # 500KB


def _resolve_session_path(session_id: str, rel_path: str) -> tuple[Path, Path, dict]:
    """Resolve a relative path within a session's project root.

    Returns (project_root, full_path, session_dict).
    Raises HTTPException on invalid session, missing project_root, or path traversal.
    """
    session = db.get_session(session_id)
    if not session or not session.get("project_root"):
        raise HTTPException(404, "Session not found or has no project_root")

    project_root = Path(session["project_root"]).resolve()
    if not project_root.is_dir():
        raise HTTPException(404, "Project root directory does not exist")

    rel_path = rel_path.lstrip("/")
    full_path = (project_root / rel_path).resolve()

    if not str(full_path).startswith(str(project_root)):
        raise HTTPException(400, "Path is outside the project directory")

    return project_root, full_path, session


@router.get("/complete")
async def complete_path(path: str = ""):
    """Return directory entries matching a partial path.

    - If path ends with '/', list all directories inside it.
    - Otherwise, list directories in the parent that start with the basename.
    """
    if not path or not path.startswith("/"):
        return {"entries": []}

    expanded = os.path.expanduser(path)

    if expanded.endswith("/"):
        parent = Path(expanded)
        prefix = ""
    else:
        parent = Path(expanded).parent
        prefix = Path(expanded).name

    if not parent.is_dir():
        return {"entries": []}

    entries = []
    try:
        for entry in sorted(parent.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name.startswith("."):
                continue
            if prefix and not entry.name.lower().startswith(prefix.lower()):
                continue
            entries.append({
                "name": entry.name,
                "path": str(entry),
            })
    except PermissionError:
        pass

    return {"entries": entries[:30]}


@router.get("/list")
async def list_directory(session_id: str, path: str = "", show_hidden: bool = False):
    """Browse directory contents within a session's project root."""
    project_root, full_path, _ = _resolve_session_path(session_id, path)

    if not full_path.is_dir():
        raise HTTPException(404, "Directory not found")

    rel_path = str(full_path.relative_to(project_root))
    if rel_path == ".":
        rel_path = ""
    parent_path = str(Path(rel_path).parent) if rel_path else None
    if parent_path == ".":
        parent_path = ""

    entries = []
    try:
        for entry in sorted(full_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if not show_hidden and entry.name.startswith("."):
                continue
            try:
                is_dir = entry.is_dir()
                item = {"name": entry.name, "type": "dir" if is_dir else "file"}
                if not is_dir:
                    item["size"] = entry.stat().st_size
                    item["writable"] = os.access(entry, os.W_OK)
                entries.append(item)
            except (PermissionError, OSError):
                continue
    except PermissionError:
        raise HTTPException(403, "Cannot read directory")

    return {
        "project_root": str(project_root),
        "current_path": rel_path,
        "parent_path": parent_path,
        "entries": entries[:200],
    }


@router.get("/read")
async def read_file(session_id: str, path: str):
    """Read a file's content within a session's project root."""
    project_root, full_path, _ = _resolve_session_path(session_id, path)

    if not full_path.is_file():
        raise HTTPException(404, "File not found")

    if not os.access(full_path, os.R_OK):
        raise HTTPException(403, "File is not readable")

    size = full_path.stat().st_size
    if size > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large ({size:,} bytes, max {MAX_FILE_SIZE:,})")

    try:
        content = full_path.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(400, "Binary file — cannot edit")

    return {
        "path": str(full_path.relative_to(project_root)),
        "content": content,
        "size": size,
        "writable": os.access(full_path, os.W_OK),
    }


class WritePayload(BaseModel):
    session_id: str
    path: str
    content: str


@router.post("/write")
async def write_file(payload: WritePayload):
    """Write content to an existing file within a session's project root."""
    project_root, full_path, _ = _resolve_session_path(payload.session_id, payload.path)

    if not full_path.is_file():
        raise HTTPException(404, "File not found — editor cannot create new files")

    if not os.access(full_path, os.W_OK):
        raise HTTPException(403, "File is read-only")

    content_bytes = payload.content.encode("utf-8")
    if len(content_bytes) > MAX_FILE_SIZE:
        raise HTTPException(400, f"Content too large ({len(content_bytes):,} bytes, max {MAX_FILE_SIZE:,})")

    # Atomic write: temp file in same directory, then replace
    try:
        fd, tmp_path = tempfile.mkstemp(dir=str(full_path.parent), suffix=".tmp")
        try:
            os.write(fd, content_bytes)
            os.close(fd)
            os.replace(tmp_path, str(full_path))
        except Exception:
            os.close(fd) if not os.get_inheritable(fd) else None
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise
    except OSError as e:
        raise HTTPException(500, f"Write failed: {e}")

    return {
        "path": str(full_path.relative_to(project_root)),
        "size": len(content_bytes),
        "written": True,
    }
