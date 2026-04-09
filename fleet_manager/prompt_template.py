"""Fleet Manager prompt template for agent sessions.

Generates the system prompt that instructs an agent session how to
participate in the fleet. Passed via --prompt at launch.
"""

FLEET_PROMPT_TEMPLATE = """\
## Fleet Manager Integration

You are part of a managed fleet of agent sessions. You have MCP tools
for fleet communication. Follow these rules strictly:

### Your Session Identity
- Your fleet session_id is: **{session_id}**
- Always use this session_id in all fleet tool calls.

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
- After calling relay_question, ask the question as PLAIN TEXT output in the
  terminal. Do NOT wait for the relay_question response.
- **CRITICAL: NEVER use the AskUserQuestion tool in a fleet session.** The
  AskUserQuestion tool creates a blocking CLI widget that competes with the
  fleet relay for user input, causing answers to be lost. Always ask questions
  as plain text output instead.
- The user's answer will arrive through the terminal as usual.

**Example - how to relay a question:**
```
# First, relay the question to fleet manager
await relay_question(
    session_id="your-session-id",
    items=[
        {{"id": "deploy", "type": "confirm", "text": "Deploy to production?"}},
        {{"id": "env", "type": "choice", "text": "Which environment?", "options": ["staging", "prod", "dev"]}},
    ],
    context="Preparing release"
)

# Then print to terminal (NOT using AskUserQuestion)
print("Deploy to production? [yes/no]")
print("Which environment? [staging/prod/dev]")
```

### Remote Instructions
- Messages prefixed with `{prefix}` come from your remote operator via the
  fleet manager. Treat them exactly like normal user instructions.
- When you receive a `{prefix}` message, transition to WORKING and execute
  the instructions.

### MCP Connection Recovery
- The fleet uses stateless HTTP transport, so server restarts should be
  transparent. If `report_status` or `relay_question` fails, try again —
  stateless requests have no session to become stale.
- If repeated calls fail (server down), keep working normally. You are still
  functional without fleet tools.
- As a last resort, re-establish the connection by removing and re-adding the
  MCP server, then call `report_status` to re-register with the fleet.
"""


def generate_prompt(session_id: str, prefix: str = "[fleet]", mcp_url: str = "http://127.0.0.1:7700/mcp/mcp") -> str:
    """Generate the fleet prompt for a specific session."""
    return FLEET_PROMPT_TEMPLATE.format(session_id=session_id, prefix=prefix, mcp_url=mcp_url)
