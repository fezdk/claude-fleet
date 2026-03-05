"""Fleet Orchestrator — an autonomous coordinator that monitors sessions,
answers routine questions, dispatches tasks, and escalates to the human.

Uses the Anthropic API as its reasoning engine and connects to the fleet
manager via REST API.

Run: fleet-orchestrator
  or: python -m fleet_manager.orchestrator

Env vars:
  ANTHROPIC_API_KEY  — required
  FLEET_URL          — fleet manager base URL (default: http://127.0.0.1:7700)
  FLEET_AUTH_TOKEN   — optional bearer token
  FLEET_ORCHESTRATOR_MODEL — model to use (default: claude-sonnet-4-6)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field

import anthropic

logger = logging.getLogger(__name__)

ORCHESTRATOR_SYSTEM_PROMPT = """\
You are a Fleet Orchestrator managing multiple Claude Code sessions. Each session \
is a Claude Code instance working on a software project inside a tmux terminal.

Your responsibilities:
1. **Answer routine questions** from sessions when the answer is clear from context \
   (e.g., "yes" to run tests, pick obvious defaults, confirm standard operations).
2. **Escalate complex questions** that require human judgment (architecture decisions, \
   ambiguous requirements, security-sensitive choices).
3. **Dispatch tasks** to idle sessions when there are pending tasks in the queue.
4. **Monitor health** — flag sessions that are stuck, erroring, or stale.

Guidelines:
- Be decisive on routine questions. Don't escalate everything.
- When answering a question, return a structured answer matching the question format.
- For escalation, explain WHY the human should decide.
- Keep summaries concise.

You will receive the current fleet state and must decide what actions to take. \
Return your decisions as a JSON object with these possible actions:

{
  "answers": [
    {"question_id": "...", "answer": {...}, "reasoning": "..."}
  ],
  "messages": [
    {"session_id": "...", "content": "...", "urgent": false, "reasoning": "..."}
  ],
  "escalations": [
    {"session_id": "...", "summary": "...", "details": "..."}
  ],
  "observations": "Brief summary of fleet health and any concerns"
}

Only include non-empty arrays. If no action is needed, return {"observations": "..."}.
"""


@dataclass
class OrchestratorConfig:
    fleet_url: str = "http://127.0.0.1:7700"
    auth_token: str = ""
    model: str = "claude-sonnet-4-6"
    poll_interval: int = 10  # seconds
    max_auto_answers: int = 5  # max questions to auto-answer per cycle


@dataclass
class FleetState:
    sessions: list[dict] = field(default_factory=list)
    pending_questions: list[dict] = field(default_factory=list)
    timestamp: str = ""


class FleetAPI:
    """REST API client for the fleet manager."""

    def __init__(self, base_url: str, auth_token: str = ""):
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token

    def _request(self, method: str, path: str, body: dict | None = None) -> dict | list:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.auth_token:
            req.add_header("Authorization", f"Bearer {self.auth_token}")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            logger.error("API error %s %s: %s %s", method, path, e.code, e.read().decode())
            raise

    def get_sessions(self) -> list[dict]:
        return self._request("GET", "/api/sessions")

    def get_session(self, session_id: str) -> dict:
        return self._request("GET", f"/api/sessions/{session_id}")

    def get_pending_questions(self) -> list[dict]:
        return self._request("GET", "/api/questions?pending=true")

    def answer_question(self, question_id: str, answer: dict | list | str) -> dict:
        return self._request("POST", f"/api/questions/{question_id}/answer", {"answer": answer})

    def send_message(self, session_id: str, content: str, urgent: bool = False) -> dict:
        return self._request("POST", f"/api/sessions/{session_id}/message", {
            "content": content,
            "from_client": "orchestrator",
            "urgent": urgent,
        })

    def get_output(self, session_id: str) -> str:
        try:
            result = self._request("GET", f"/api/sessions/{session_id}/output")
            return result.get("output", "")
        except Exception:
            return "(output unavailable)"


class Orchestrator:
    """Main orchestrator loop."""

    def __init__(self, config: OrchestratorConfig):
        self.config = config
        self.api = FleetAPI(config.fleet_url, config.auth_token)
        self.client = anthropic.Anthropic()
        self._escalation_log: list[dict] = []

    def get_fleet_state(self) -> FleetState:
        sessions = self.api.get_sessions()
        questions = self.api.get_pending_questions()
        return FleetState(sessions=sessions, pending_questions=questions)

    def build_prompt(self, state: FleetState) -> str:
        """Build a prompt describing current fleet state for the AI."""
        parts = ["# Current Fleet State\n"]

        if not state.sessions:
            parts.append("No sessions registered.\n")
        else:
            parts.append(f"## Sessions ({len(state.sessions)})\n")
            for s in state.sessions:
                parts.append(
                    f"- **{s['session_id']}** [{s['state']}] — {s.get('summary', 'no summary')}\n"
                    f"  Project: {s.get('project_root', '?')} | Last seen: {s.get('last_seen', '?')}\n"
                )
                if s.get('detail'):
                    parts.append(f"  Detail: {s['detail']}\n")

        if state.pending_questions:
            parts.append(f"\n## Pending Questions ({len(state.pending_questions)})\n")
            for q in state.pending_questions:
                items = json.loads(q["items"]) if isinstance(q["items"], str) else q["items"]
                parts.append(
                    f"- **Question {q['question_id']}** (session: {q['session_id']})\n"
                    f"  Context: {q.get('context', 'none')}\n"
                )
                for item in items:
                    opts = f" Options: {item.get('options', [])}" if item.get("options") else ""
                    default = f" Default: {item.get('default')}" if item.get("default") else ""
                    parts.append(f"  - [{item['type']}] {item['text']}{opts}{default}\n")

        if self._escalation_log:
            parts.append(f"\n## Recent Escalations ({len(self._escalation_log)})\n")
            for e in self._escalation_log[-5:]:
                parts.append(f"- {e['summary']}\n")

        parts.append("\nWhat actions should be taken?")
        return "".join(parts)

    def decide(self, state: FleetState) -> dict:
        """Ask Claude to decide what actions to take."""
        if not state.sessions and not state.pending_questions:
            return {"observations": "Fleet is empty, nothing to do."}

        prompt = self.build_prompt(state)

        response = self.client.messages.create(
            model=self.config.model,
            max_tokens=2048,
            system=ORCHESTRATOR_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )

        text = response.content[0].text.strip()

        # Extract JSON from response (handle markdown code blocks)
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            text = text.split("```")[1].split("```")[0].strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            logger.warning("Failed to parse orchestrator response as JSON: %s", text[:200])
            return {"observations": f"(parse error) {text[:200]}"}

    def execute(self, decisions: dict) -> None:
        """Execute the orchestrator's decisions."""
        # Answer questions
        for answer_action in decisions.get("answers", []):
            qid = answer_action["question_id"]
            answer = answer_action["answer"]
            reasoning = answer_action.get("reasoning", "")
            try:
                self.api.answer_question(qid, answer)
                logger.info("Answered question %s: %s (reason: %s)", qid, answer, reasoning)
            except Exception as e:
                logger.error("Failed to answer question %s: %s", qid, e)

        # Send messages to sessions
        for msg_action in decisions.get("messages", []):
            sid = msg_action["session_id"]
            content = msg_action["content"]
            urgent = msg_action.get("urgent", False)
            reasoning = msg_action.get("reasoning", "")
            try:
                self.api.send_message(sid, content, urgent)
                logger.info("Sent message to %s: %s (reason: %s)", sid, content[:80], reasoning)
            except Exception as e:
                logger.error("Failed to send message to %s: %s", sid, e)

        # Log escalations
        for escalation in decisions.get("escalations", []):
            self._escalation_log.append(escalation)
            logger.warning(
                "ESCALATION [%s]: %s — %s",
                escalation.get("session_id", "?"),
                escalation.get("summary", "?"),
                escalation.get("details", ""),
            )
            print(f"\n{'='*60}")
            print(f"ESCALATION: {escalation.get('summary', '?')}")
            print(f"Session: {escalation.get('session_id', '?')}")
            print(f"Details: {escalation.get('details', '')}")
            print(f"{'='*60}\n")

        # Print observations
        if obs := decisions.get("observations"):
            logger.info("Observations: %s", obs)

    async def run_loop(self) -> None:
        """Main orchestrator loop."""
        logger.info(
            "Orchestrator started (model=%s, poll=%ds, fleet=%s)",
            self.config.model, self.config.poll_interval, self.config.fleet_url,
        )

        while True:
            try:
                state = self.get_fleet_state()

                # Only invoke AI when there's something to decide
                has_work = (
                    state.pending_questions
                    or any(s["state"] == "ERROR" for s in state.sessions)
                    or any(s["state"] == "IDLE" for s in state.sessions)
                )

                if has_work:
                    logger.info(
                        "Cycle: %d sessions, %d pending questions",
                        len(state.sessions), len(state.pending_questions),
                    )
                    decisions = self.decide(state)
                    self.execute(decisions)
                else:
                    logger.debug("All sessions working, no pending questions — skipping AI call")

            except KeyboardInterrupt:
                raise
            except Exception:
                logger.exception("Error in orchestrator cycle")

            await asyncio.sleep(self.config.poll_interval)


def main() -> None:
    parser = argparse.ArgumentParser(prog="fleet-orchestrator", description="Fleet Orchestrator")
    parser.add_argument("--url", default=os.environ.get("FLEET_URL", "http://127.0.0.1:7700"))
    parser.add_argument("--token", default=os.environ.get("FLEET_AUTH_TOKEN", ""))
    parser.add_argument("--model", default=os.environ.get("FLEET_ORCHESTRATOR_MODEL", "claude-sonnet-4-6"))
    parser.add_argument("--interval", type=int, default=10, help="Poll interval in seconds")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [orchestrator] %(levelname)s: %(message)s",
    )

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY environment variable is required")
        sys.exit(1)

    config = OrchestratorConfig(
        fleet_url=args.url,
        auth_token=args.token,
        model=args.model,
        poll_interval=args.interval,
    )

    orchestrator = Orchestrator(config)

    try:
        asyncio.run(orchestrator.run_loop())
    except KeyboardInterrupt:
        print("\nOrchestrator stopped.")


if __name__ == "__main__":
    main()
