"""REST API route for filesystem path completion."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/api/filesystem", tags=["filesystem"])


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
