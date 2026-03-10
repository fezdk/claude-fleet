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

### Remote Access

The server binds to localhost by default. For remote access (e.g. from a laptop or phone), use an SSH tunnel:

```bash
# One-time tunnel (survives server restarts)
ssh -f -N -L 7700:127.0.0.1:7700 your-server

# Auto-reconnecting tunnel
autossh -M 0 -f -N -L 7700:127.0.0.1:7700 your-server
```

Then access the dashboard at `http://127.0.0.1:7700` on your local machine.

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
> otherwise the MCP connection will fail. If you restart the server, Claude Code sessions
> will attempt to reconnect automatically (see [MCP Connection Recovery](#mcp-connection-recovery)).

## Starting Sessions

### From the CLI

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

### From the Web UI

Click **+ New Session** in the dashboard header. Enter the project path (absolute path on the server) and optionally a session name (defaults to the directory name). The session launches detached — use the dashboard to monitor and interact.

### Session Lifecycle

To detach from a session without stopping it, press **Ctrl+B, D** (the tmux status bar at the bottom reminds you of this). You can reattach later with `fleet attach <name>`.

Stopping a session (via `fleet stop <name>` or the **Stop** button in the web UI) kills the tmux session, terminates Claude Code, and removes the session from the database.

### Forking Sessions

Fork creates a new session that branches from an existing session's conversation history using Claude's `--resume --fork-session` flags. The forked session starts with full context of what the original session was doing.

```bash
# Fork from CLI
fleet fork api api-refactor
fleet fork api api-refactor -d   # Forked session, detached

# Fork from the Web UI
# Click "Open" on a session, then click the "Fork" button in the focus modal header
```

Forking requires the source session to have reported its Claude session ID (happens automatically on first `report_status` call). If the Fork button is not visible in the UI, the session hasn't reported yet.

### CLI Commands

```bash
fleet start --name <name> --project <path>   # Start a session
fleet start --name <name> --project <path> -d # Start detached
fleet list                                    # List sessions
fleet attach <name>                           # Attach to tmux
fleet fork <name> <new-name>                  # Fork session (branch conversation)
fleet stop <name>                             # Stop session + cleanup
```

`fleet start` will:
1. Create a tmux session `fleet-<name>`
2. Register the MCP server with Claude Code (if not already registered)
3. Launch Claude Code with fleet instructions via `--append-system-prompt`
4. Attach to the session (unless `-d` is passed)

Fleet instructions are injected as a system prompt at launch time — no modifications to the project's `CLAUDE.md` are needed.

### MCP Tools

Each Claude Code session gets two tools:

| Tool | Purpose |
|---|---|
| `report_status` | Report state transitions (IDLE/WORKING/AWAITING_INPUT/ERROR) |
| `relay_question` | Mirror questions for remote clients before asking in terminal |

### MCP Connection Recovery

If the fleet manager server restarts, active Claude Code sessions will lose their MCP connection (typically showing error `-32602`). The fleet system prompt instructs sessions to:

1. Continue working normally without fleet tools
2. Attempt to re-register the MCP server via `claude mcp remove/add`
3. Re-report status after reconnecting
4. Fall back gracefully if reconnection fails

### Web UI

Dashboard at `http://127.0.0.1:7700`:

- **Session list** — cards with state indicators, pending question badges, and Open/detail buttons
- **Focus view** — click "Open" on a session card to get a large terminal output modal with auto-refresh (3s) and an input bar for sending instructions
- **Multi view** — click "Multi View" in the header to see all session terminals side-by-side in a responsive grid, auto-refreshing. Click any pane to open its focus view
- **Session detail** — click the session name for the full detail page with questions, messages, terminal output, and status history
- **Question modals** — when a session asks a question, a modal appears on top of the focus view for answering
- **New Session** — start sessions directly from the dashboard with project path auto-naming
- **Login** — when auth is enabled, a login prompt appears; token is stored in localStorage

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

## Authentication

Set `FLEET_AUTH_TOKEN` to protect all API, WebSocket, and Web UI access:

```bash
FLEET_AUTH_TOKEN=your-secret-token python -m fleet_manager.server
```

When auth is enabled:
- The **Web UI** shows a login prompt on first visit. Enter the token to authenticate — it's stored in `localStorage` and persists across page reloads.
- **API requests** must include `Authorization: Bearer <token>` header.
- **WebSocket** connections must include `?token=<token>` query parameter.
- A **logout** button appears in the header to clear the stored token.
- The `/api/auth/check` endpoint is publicly accessible and returns whether auth is enabled, so the UI can detect when login is needed.

When `FLEET_AUTH_TOKEN` is empty or unset, auth is disabled and everything works without a token.

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Register a session |
| POST | `/api/sessions/start` | Start a new session (creates tmux + launches Claude) |
| GET | `/api/sessions/:id` | Session detail + status log |
| GET | `/api/sessions/:id/output` | Terminal output (via tmux) |
| POST | `/api/sessions/:id/fork` | Fork session (branch conversation into new session) |
| DELETE | `/api/sessions/:id` | Stop + remove session (kills tmux) |
| POST | `/api/sessions/:id/message` | Send instructions to session |
| GET | `/api/questions?pending=true` | Pending questions |
| GET | `/api/questions/:session_id` | Questions for a session |
| POST | `/api/questions/:id/answer` | Answer a question |
| GET | `/api/health` | Server health + stats |
| GET | `/api/auth/check` | Check if auth is required + validate token |

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
- Optional bearer token auth on all API/WS/Web UI endpoints (see [Authentication](#authentication))
- For remote access: use SSH tunnel, Tailscale, WireGuard, or Cloudflare Tunnel
- MCP server accessible only to local Claude Code sessions
- tmux exact session matching (`=` prefix) prevents cross-session interference

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
  tmux_bridge.py       tmux capture/inject (exact session matching)
  ws_manager.py        WebSocket broadcast
  auth.py              Bearer token middleware
  session_launcher.py  Shared session start/stop logic (CLI + API)
  notifications.py     Telegram + notification rules
  orchestrator.py      AI orchestrator client
  prompt_template.py   Fleet system prompt generator
  cli.py               fleet CLI (thin wrapper around session_launcher)
  api/
    sessions.py        Session endpoints (incl. start/stop)
    questions.py       Question endpoints
    messages.py        Message endpoints
web/
  index.html           Dashboard UI (modals: login, new session, focus, multi, question)
  app.js               Client-side JS
  style.css            Styles
config/
  default.json         Default configuration
tests/
  test_e2e.py          End-to-end tests
  test_mcp_client.py   MCP connectivity test
```
