"""Notification system — configurable alerts via Telegram and browser push.

Telegram setup:
  1. Create a bot with @BotFather, get the token
  2. Send /start to your bot, then get your chat_id via
     https://api.telegram.org/bot<TOKEN>/getUpdates
  3. Set env vars: FLEET_TELEGRAM_TOKEN, FLEET_TELEGRAM_CHAT_ID

Notification rules are configured via config/default.json:
  "notifications": {
    "on_awaiting_input": true,
    "on_error": true,
    "on_task_complete": true,
    "on_stale": true,
    "telegram_token": "",
    "telegram_chat_id": ""
  }
"""

from __future__ import annotations

import asyncio
import logging
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class NotificationConfig:
    on_awaiting_input: bool = True
    on_error: bool = True
    on_task_complete: bool = True
    on_stale: bool = True
    telegram_token: str = ""
    telegram_chat_id: str = ""


_config: NotificationConfig | None = None


def init_notifications(cfg_dict: dict | None = None) -> NotificationConfig:
    """Initialize notification config from dict or env vars."""
    global _config

    if cfg_dict:
        _config = NotificationConfig(**{
            k: v for k, v in cfg_dict.items()
            if k in NotificationConfig.__dataclass_fields__
        })
    else:
        _config = NotificationConfig()

    # Env var overrides
    if v := os.environ.get("FLEET_TELEGRAM_TOKEN"):
        _config.telegram_token = v
    if v := os.environ.get("FLEET_TELEGRAM_CHAT_ID"):
        _config.telegram_chat_id = v

    if _config.telegram_token and _config.telegram_chat_id:
        logger.info("Telegram notifications enabled")
    else:
        logger.info("Telegram notifications disabled (no token/chat_id)")

    return _config


def get_notification_config() -> NotificationConfig:
    if _config is None:
        return init_notifications()
    return _config


async def send_telegram(message: str) -> bool:
    """Send a message via Telegram bot API."""
    cfg = get_notification_config()
    if not cfg.telegram_token or not cfg.telegram_chat_id:
        return False

    url = f"https://api.telegram.org/bot{cfg.telegram_token}/sendMessage"
    params = urllib.parse.urlencode({
        "chat_id": cfg.telegram_chat_id,
        "text": message,
        "parse_mode": "Markdown",
    }).encode()

    try:
        loop = asyncio.get_event_loop()
        req = urllib.request.Request(url, data=params, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        await loop.run_in_executor(None, lambda: urllib.request.urlopen(req, timeout=10))
        logger.debug("Telegram message sent")
        return True
    except Exception as e:
        logger.warning("Telegram send failed: %s", e)
        return False


async def notify_state_change(session_id: str, state: str, summary: str) -> None:
    """Send notification based on state change and notification rules."""
    cfg = get_notification_config()

    should_notify = False
    emoji = ""

    if state == "AWAITING_INPUT" and cfg.on_awaiting_input:
        should_notify = True
        emoji = "❓"
    elif state == "ERROR" and cfg.on_error:
        should_notify = True
        emoji = "🔴"
    elif state == "IDLE" and cfg.on_task_complete:
        should_notify = True
        emoji = "✅"

    if should_notify:
        message = f"{emoji} *Fleet: {session_id}*\nState: `{state}`\n{summary}"
        await send_telegram(message)


async def notify_stale(session_id: str, minutes: int) -> None:
    """Notify about a stale session."""
    cfg = get_notification_config()
    if not cfg.on_stale:
        return
    message = f"⚠️ *Fleet: {session_id}*\nStale — no update for {minutes}m"
    await send_telegram(message)


async def notify_question(session_id: str, context: str, items: list[dict]) -> None:
    """Notify about a new question from a session."""
    cfg = get_notification_config()
    if not cfg.on_awaiting_input:
        return

    questions_text = "\n".join(f"  • {item.get('text', '?')}" for item in items[:3])
    message = (
        f"❓ *Fleet: {session_id}*\n"
        f"Question: {context or 'needs input'}\n"
        f"{questions_text}"
    )
    await send_telegram(message)
