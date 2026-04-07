"""REST API routes for questions."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fleet_manager import db
from fleet_manager.tmux_bridge import inject_input
from fleet_manager.ws_manager import ws_manager

router = APIRouter(prefix="/api/questions", tags=["questions"])


class AnswerPayload(BaseModel):
    answer: dict | list | str


@router.get("")
async def list_pending_questions(pending: bool = True):
    if pending:
        return db.get_pending_questions()
    # If not filtering by pending, return all (could add pagination later)
    return db.get_pending_questions()


@router.get("/{session_id}")
async def get_session_questions(session_id: str):
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(404, f"Session '{session_id}' not found")
    return db.get_pending_questions(session_id)


@router.post("/{question_id}/answer")
async def answer_question(question_id: str, payload: AnswerPayload):
    question = db.get_question(question_id)
    if not question:
        raise HTTPException(404, f"Question '{question_id}' not found")
    if question["answered"]:
        raise HTTPException(409, "Question already answered")

    session = db.get_session(question["session_id"])
    if not session:
        raise HTTPException(404, "Session for this question no longer exists")

    # Persist the answer
    answered = db.answer_question(question_id, json.dumps(payload.answer))
    await ws_manager.broadcast("question:answered", answered)

    # Inject the answer as a single JSON block so Claude Code can parse it
    answer_json = json.dumps(payload.answer)
    await inject_input(session["tmux_session"], session["tmux_pane"], answer_json)

    return answered


@router.delete("/{question_id}")
async def dismiss_question(question_id: str):
    """Dismiss a question without sending an answer to the session.
    
    Use this when the user will answer directly in the terminal via plaintext.
    """
    question = db.get_question(question_id)
    if not question:
        raise HTTPException(404, f"Question '{question_id}' not found")
    if question["answered"]:
        raise HTTPException(409, "Question already answered")

    # Mark as answered with a special marker to indicate dismissal
    dismissed = db.answer_question(question_id, json.dumps({"__dismissed__": True}))
    await ws_manager.broadcast("question:answered", dismissed)
    
    return dismissed
