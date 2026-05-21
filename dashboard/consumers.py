"""
WebSocket consumer that bridges the chat UI to Gemini.

Protocol (client ↔ server):
  → { "type": "select_cell", "stats": {...} }
  → { "type": "user_message", "text": "..." }
  → { "type": "clear_context" }

  ← { "type": "system", "text": "Context updated to UZB_..." }
  ← { "type": "ai_chunk", "text": "..." }
  ← { "type": "ai_done" }
  ← { "type": "error", "message": "..." }
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .gemini_client import get_client

log = logging.getLogger(__name__)

MAX_USER_MSG = 2000
MAX_HISTORY = 16


class ChatConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.cell_stats: Optional[dict] = None
        self.history: list[dict] = []
        self.streaming = False
        await self.accept()
        await self.send_json({
            "type": "system",
            "text": "connected",
            "gemini_configured": get_client().configured,
        })

    async def disconnect(self, code):
        log.info("WS disconnect %s", code)

    async def receive_json(self, content, **kwargs):
        msg_type = content.get("type")

        if msg_type == "select_cell":
            stats = content.get("stats") or {}
            if not isinstance(stats, dict):
                return await self._error("invalid stats payload")
            self.cell_stats = stats
            label = stats.get("id", "unknown")
            await self.send_json({
                "type": "system",
                "text": f"Context: {label} ({stats.get('district', '')})",
                "cell_id": label,
            })

        elif msg_type == "clear_context":
            self.cell_stats = None
            await self.send_json({"type": "system", "text": "Context cleared"})

        elif msg_type == "user_message":
            text = (content.get("text") or "").strip()
            if not text:
                return
            if len(text) > MAX_USER_MSG:
                return await self._error(f"message too long ({len(text)} > {MAX_USER_MSG})")
            if self.streaming:
                return await self._error("already streaming; wait for current reply")

            await self._stream_reply(text)

        else:
            await self._error(f"unknown type: {msg_type!r}")

    async def _stream_reply(self, user_text: str):
        self.streaming = True
        self.history.append({"role": "user", "text": user_text})

        client = get_client()
        collected = []
        try:
            async for chunk in client.stream(user_text, self.cell_stats, self.history[:-1]):
                collected.append(chunk)
                await self.send_json({"type": "ai_chunk", "text": chunk})
        except Exception as e:
            log.exception("stream error")
            await self._error(f"server error: {type(e).__name__}")
        finally:
            full = "".join(collected).strip()
            if full:
                self.history.append({"role": "model", "text": full})
            # Trim history
            if len(self.history) > MAX_HISTORY:
                self.history = self.history[-MAX_HISTORY:]
            self.streaming = False
            await self.send_json({"type": "ai_done"})

    async def _error(self, message: str):
        await self.send_json({"type": "error", "message": message})
