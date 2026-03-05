# Claude Fleet Manager

Manage multiple Claude Code terminal sessions from remote clients (phone, laptop, or an orchestrator Claude). Each Claude Code session connects via MCP, state is tracked in SQLite, and input/output flows through tmux.

## Architecture

```
Clients (Phone / Laptop / Orchestrator)
        │
        ▼
┌────────────────────────────────┐
│         The Service            │
│  REST API · WebSocket · Web UI │
│  MCP Server (SSE) · tmux      │
└────┬──────────┬──────────┬─────┘
     │          │          │
  tmux:api   tmux:fe    tmux:ml
  Claude     Claude     Claude
  Code       Code       Code
```

## Prerequisites

- **Python 3.11+**
- **tmux** — required for terminal session management
  ```bash
  # Ubuntu/Debian
  sudo apt install tmux
  # macOS
  brew install tmux
  ```
- **Claude Code** CLI installed and authenticated

## Installation

```bash
cd claude_fleet
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

## Starting the Server

The fleet manager server must be running before any sessions can connect.

```bash
cd claude_fleet
source .venv/bin/activate
python -m fleet_manager.server
```

This starts the server on `http://127.0.0.1:7700` which hosts:

- **MCP Server** (SSE at `/mcp/sse`) — Claude Code sessions connect here
- **REST API** (`/api/`) — sessions, questions, messages
- **WebSocket** (`/ws`) — live state updates to clients
- **Web UI** (`/`) — dashboard for monitoring and control

Environment overrides:
```bash
FLEET_PORT=7700
FLEET_HOST=127.0.0.1
FLEET_AUTH_TOKEN=your-secret-token
```

## Registering the MCP Server (one-time)

Claude Code needs to know about the fleet manager's MCP server. Register it once:

```bash
claude mcp add --transport sse --scope user fleet-manager http://127.0.0.1:7700/mcp/sse
```

This registers it globally for all projects. To register for a specific project only:
```bash
cd /path/to/project
claude mcp add --transport sse --scope project fleet-manager http://127.0.0.1:7700/mcp/sse
```

> **Note:** The fleet manager server must be running when Claude Code starts a session,
> otherwise the MCP connection will fail. If you restart the server, restart Claude Code too.

## Starting Sessions

With the server running, open a new terminal and activate the venv:

```bash
cd claude_fleet
source .venv/bin/activate
```

Now `fleet` is available and can be run from any directory:

```bash
# Start a session (creates tmux + launches Claude Code, then attaches)
fleet start --name api --project /path/to/api

# Start multiple sessions in batch (detached mode)
fleet start --name api --project /path/to/api -d
fleet start --name frontend --project /path/to/frontend -d
fleet start --name ml --project /path/to/ml -d

# Then attach to any session
fleet attach api
```

To detach from a session without stopping it, press **Ctrl+B, D** (the tmux status bar at the bottom reminds you of this). You can reattach later with `fleet attach <name>`.

Open the dashboard at `http://127.0.0.1:7700` to monitor and control all sessions.

### CLI Commands

```bash
fleet start --name <name> --project <path>   # Start a session
fleet start --name <name> --project <path> -d # Start detached
fleet list                                    # List sessions
fleet attach <name>                           # Attach to tmux
fleet stop <name>                             # Stop session + cleanup
fleet clean <project-path>                    # Remove fleet instructions from CLAUDE.md
```

`fleet start` will:
1. Create a tmux session `fleet-<name>`
2. Inject fleet instructions into the project's `CLAUDE.md`
3. Register the MCP server with Claude Code (if not already registered)
4. Launch Claude Code in the tmux session
5. Attach to the session (unless `-d` is passed)

### MCP Tools

Each Claude Code session gets two tools:

| Tool | Purpose |
|---|---|
| `report_status` | Report state transitions (IDLE/WORKING/AWAITING_INPUT/ERROR) |
| `relay_question` | Mirror questions for remote clients before asking in terminal |

### Web UI

Dashboard at `http://127.0.0.1:7700`:
- Session list with state indicators and pending question badges
- Session detail: terminal output, question forms, message input
- Auto-refresh terminal output
- Browser notifications for questions and errors

### Orchestrator

An autonomous AI coordinator that monitors the fleet:

```bash
ANTHROPIC_API_KEY=sk-... fleet-orchestrator

# Options:
fleet-orchestrator --url http://127.0.0.1:7700 --model claude-sonnet-4-6 --interval 10
```

The orchestrator:
- Auto-answers routine questions (yes/no confirmations, obvious defaults)
- Escalates complex decisions to the human
- Monitors fleet health
- Can dispatch tasks to idle sessions

### Notifications

Configure Telegram alerts for session events:

```bash
FLEET_TELEGRAM_TOKEN=bot123:ABC...
FLEET_TELEGRAM_CHAT_ID=12345678
```

Or in `config/default.json`:
```json
{
  "notifications": {
    "on_awaiting_input": true,
    "on_error": true,
    "on_task_complete": true,
    "on_stale": true,
    "telegram_token": "",
    "telegram_chat_id": ""
  }
}
```

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Register a session |
| GET | `/api/sessions/:id` | Session detail + status log |
| GET | `/api/sessions/:id/output` | Terminal output (via tmux) |
| DELETE | `/api/sessions/:id` | Remove session |
| POST | `/api/sessions/:id/message` | Send instructions to session |
| GET | `/api/questions?pending=true` | Pending questions |
| GET | `/api/questions/:session_id` | Questions for a session |
| POST | `/api/questions/:id/answer` | Answer a question |
| GET | `/api/health` | Server health + stats |

## WebSocket Events

| Event | Direction | Data |
|---|---|---|
| `session:update` | server → client | Session object |
| `session:stale` | server → client | `{session_id, minutes_since_update}` |
| `question:new` | server → client | Question object |
| `question:answered` | server → client | Answered question object |
| `session:message` | server → client | Message delivery status |

## Security

- Bind to `127.0.0.1` by default (localhost only)
- Optional bearer token auth on all API/WS endpoints
- For remote access: use Tailscale, WireGuard, or Cloudflare Tunnel
- MCP server accessible only to local Claude Code sessions

## Configuration

See `config/default.json` for all options. Key settings:

| Setting | Default | Description |
|---|---|---|
| `server.port` | 7700 | Server port |
| `server.host` | 127.0.0.1 | Bind address |
| `server.auth_token` | (empty) | Bearer token (disabled if empty) |
| `sessions.stale_timeout_minutes` | 15 | Mark sessions stale after N minutes |
| `sessions.message_prefix` | `[fleet]` | Prefix for remote instructions |
| `tmux.session_prefix` | `fleet-` | tmux session name prefix |

## Project Structure

```
fleet_manager/
  server.py            Main FastAPI app, background loops
  config.py            Configuration loader
  db.py                SQLite schema and CRUD
  mcp_server.py        MCP tools (report_status, relay_question)
  tmux_bridge.py       tmux capture/inject
  ws_manager.py        WebSocket broadcast
  auth.py              Bearer token middleware
  notifications.py     Telegram + notification rules
  orchestrator.py      AI orchestrator client
  prompt_template.py   CLAUDE.md fleet instructions
  cli.py               fleet CLI
  api/
    sessions.py        Session endpoints
    questions.py       Question endpoints
    messages.py        Message endpoints
web/
  index.html           Dashboard UI
  app.js               Client-side JS
  style.css            Styles
config/
  default.json         Default configuration
tests/
  test_e2e.py          End-to-end tests
  test_mcp_client.py   MCP connectivity test
```
