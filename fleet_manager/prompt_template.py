"""Fleet Manager prompt template for Claude Code sessions.

This generates the CLAUDE.md addition that instructs a Claude Code session
how to participate in the fleet.

The fleet section is wrapped in marker comments so it can be safely
added/updated/removed without touching any other content in the file.
"""

import os

# Unique markers that won't collide with user content
_MARKER_START = "<!-- FLEET_MANAGER_START -->"
_MARKER_END = "<!-- FLEET_MANAGER_END -->"

FLEET_PROMPT_TEMPLATE = """\
## Fleet Manager Integration

You are part of a managed fleet of Claude Code sessions. You have two MCP tools
for fleet communication. Follow these rules strictly:

### Status Reporting (MANDATORY)
- Call `report_status` on EVERY state transition:
  - When you start working on a task -> state: WORKING
  - When you finish a task and have nothing to do -> state: IDLE
  - When you encounter an error -> state: ERROR
  - When you are about to ask the user a question -> state: AWAITING_INPUT
  - When the user answers and you resume -> state: WORKING
- During long-running work (more than 5 minutes), call `report_status` with
  state: WORKING and an updated summary of progress.
- Summaries should be concise (under 200 chars) and meaningful:
  "Refactored auth module, running tests" not "Working on stuff"

### Question Relay (MANDATORY)
- BEFORE you ask ANY question in the terminal -- whether it is a simple yes/no,
  a choice, or a multi-part questionnaire -- call `relay_question` first.
- Structure the question properly using the item types: confirm, choice,
  multi_select, freetext.
- After calling relay_question, ask the question in the terminal as you
  normally would. Do NOT wait for the relay_question response.
- The user's answer will arrive through the terminal as usual.

### Remote Instructions
- Messages prefixed with `{prefix}` come from your remote operator via the
  fleet manager. Treat them exactly like normal user instructions.
- When you receive a `{prefix}` message, transition to WORKING and execute
  the instructions.

### Your Session Identity
- Your session_id is: {session_id}
- Always use this session_id in all tool calls.
"""


def generate_prompt(session_id: str, prefix: str = "[fleet]") -> str:
    """Generate the fleet prompt for a specific session."""
    return FLEET_PROMPT_TEMPLATE.format(session_id=session_id, prefix=prefix)


def _build_block(session_id: str, prefix: str = "[fleet]") -> str:
    """Build the full marked block for insertion."""
    prompt = generate_prompt(session_id, prefix)
    return f"{_MARKER_START}\n{prompt}{_MARKER_END}\n"


def inject_into_claude_md(project_path: str, session_id: str, prefix: str = "[fleet]") -> str:
    """Safely add/update fleet instructions in the project CLAUDE.md file.

    Uses marker comments to isolate the fleet block. Never touches content
    outside the markers. Returns the path to the modified file.
    """
    claude_md_path = os.path.join(project_path, "CLAUDE.md")
    block = _build_block(session_id, prefix)

    existing = ""
    if os.path.exists(claude_md_path):
        with open(claude_md_path) as f:
            existing = f.read()

    if _MARKER_START in existing and _MARKER_END in existing:
        # Replace only the content between markers (inclusive)
        start_idx = existing.index(_MARKER_START)
        end_idx = existing.index(_MARKER_END) + len(_MARKER_END)
        # Consume trailing newline if present
        if end_idx < len(existing) and existing[end_idx] == "\n":
            end_idx += 1
        updated = existing[:start_idx] + block + existing[end_idx:]
        with open(claude_md_path, "w") as f:
            f.write(updated)
    else:
        # Append
        with open(claude_md_path, "a") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write("\n" + block)

    return claude_md_path


def remove_from_claude_md(project_path: str) -> bool:
    """Remove fleet instructions from the project CLAUDE.md file.

    Returns True if the block was found and removed.
    """
    claude_md_path = os.path.join(project_path, "CLAUDE.md")
    if not os.path.exists(claude_md_path):
        return False

    with open(claude_md_path) as f:
        content = f.read()

    if _MARKER_START not in content:
        return False

    start_idx = content.index(_MARKER_START)
    end_idx = content.index(_MARKER_END) + len(_MARKER_END)
    if end_idx < len(content) and content[end_idx] == "\n":
        end_idx += 1
    # Also strip the blank line before the block if present
    if start_idx > 0 and content[start_idx - 1] == "\n":
        start_idx -= 1

    cleaned = content[:start_idx] + content[end_idx:]
    with open(claude_md_path, "w") as f:
        f.write(cleaned)

    return True
