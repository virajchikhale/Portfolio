"""Any OpenAI-compatible chat-completions endpoint: Groq, OpenRouter, Together, Ollama, vLLM, LM Studio...

Select with LLM_PROVIDER=openai plus LLM_BASE_URL / LLM_API_KEY / LLM_MODEL. Streams over SSE and supports tool calling
for agent mode. The API key is only ever sent to LLM_BASE_URL.
"""
import json
import logging
import uuid
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import httpx

from app.config import Settings
from app.llm.base import (
    LLMError,
    Message,
    ModelTurn,
    ToolCall,
    ToolResults,
    ToolSpec,
    TranscriptEntry,
    UserText,
)

log = logging.getLogger(__name__)

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "host.docker.internal", "ollama"}


def explain_error(status: int | None, settings: Settings) -> str:
    """Visitor-safe message. Specific in dev (so you can fix config), generic in prod. Full detail goes to the logs."""
    if settings.environment == "prod":
        return "The AI service is temporarily unavailable."
    if status in (401, 403):
        return "The LLM provider rejected the API key (check LLM_API_KEY)."
    if status == 404:
        return f"Model '{settings.llm_model}' was not found at LLM_BASE_URL (check LLM_MODEL)."
    if status == 429:
        return "The LLM provider's rate limit / quota was reached."
    return "The AI service is temporarily unavailable (see backend logs)."


class OpenAICompatClient:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self._s = settings
        self._url = settings.llm_base_url.rstrip("/") + "/chat/completions"
        key = settings.llm_api_key.get_secret_value().strip() if settings.llm_api_key else ""
        host = urlparse(settings.llm_base_url).hostname or ""
        if not key and host not in _LOCAL_HOSTS:
            raise LLMError("LLM_API_KEY is not configured")
        self._headers = {"Authorization": f"Bearer {key}"} if key else {}
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(settings.llm_timeout_s, connect=10), transport=transport)

    # ── wire format ─────────────────────────────────────────────────────────
    def _payload(self, system: str, messages: list[dict], tools: list[ToolSpec] | None) -> dict:
        body: dict = {
            "model": self._s.llm_model,
            "messages": [{"role": "system", "content": system}, *messages],
            "stream": True,
            "temperature": self._s.llm_temperature,
            "max_tokens": self._s.llm_max_output_tokens,
        }
        if tools:
            body["tools"] = [{"type": "function", "function": {
                "name": t.name, "description": t.description, "parameters": t.parameters}} for t in tools]
            body["tool_choice"] = "auto"
        return body

    @staticmethod
    def _to_messages(transcript: list[TranscriptEntry]) -> list[dict]:
        out: list[dict] = []
        for e in transcript:
            if isinstance(e, Message):
                out.append({"role": e.role, "content": e.content})
            elif isinstance(e, UserText):
                out.append({"role": "user", "content": e.text})
            elif isinstance(e, ModelTurn):
                msg: dict = {"role": "assistant", "content": e.text or None}
                if e.tool_calls:
                    msg["tool_calls"] = [{"id": c.id, "type": "function",
                                          "function": {"name": c.name, "arguments": json.dumps(c.args)}}
                                         for c in e.tool_calls]
                out.append(msg)
            elif isinstance(e, ToolResults):
                out += [{"role": "tool", "tool_call_id": r.call.id, "content": json.dumps(r.response)} for r in e.results]
            else:
                raise TypeError(f"unknown transcript entry: {type(e).__name__}")
        return out

    async def _events(self, body: dict) -> AsyncIterator[dict]:
        async with self._http.stream("POST", self._url, headers=self._headers, json=body) as resp:
            if resp.status_code >= 400:
                detail = (await resp.aread())[:500].decode("utf-8", "replace")
                log.error("LLM provider returned %s: %s", resp.status_code, detail)
                raise LLMError(explain_error(resp.status_code, self._s))
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    yield json.loads(data)
                except json.JSONDecodeError:
                    continue

    # ── public interface ────────────────────────────────────────────────────
    async def stream(self, system: str, messages: list[Message]) -> AsyncIterator[str]:
        emitted = False
        try:
            body = self._payload(system, self._to_messages(list(messages)), None)
            async for ev in self._events(body):
                for choice in ev.get("choices") or []:
                    text = (choice.get("delta") or {}).get("content")
                    if text:
                        emitted = True
                        yield text
        except LLMError:
            raise
        except Exception as exc:
            log.exception("LLM call failed (model=%s)", self._s.llm_model)
            raise LLMError(explain_error(None, self._s)) from exc
        if not emitted:
            raise LLMError("The model returned an empty answer. Try rephrasing your question.")

    async def stream_turn(self, system: str, transcript: list[TranscriptEntry], tools: list[ToolSpec]):
        text = ""
        calls: dict[int, dict] = {}
        try:
            body = self._payload(system, self._to_messages(transcript), tools)
            async for ev in self._events(body):
                for choice in ev.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        text += delta["content"]
                        yield delta["content"]
                    for tc in delta.get("tool_calls") or []:
                        slot = calls.setdefault(tc.get("index", 0), {"id": None, "name": "", "args": ""})
                        slot["id"] = tc.get("id") or slot["id"]
                        fn = tc.get("function") or {}
                        slot["name"] += fn.get("name") or ""
                        slot["args"] += fn.get("arguments") or ""
        except LLMError:
            raise
        except Exception as exc:
            log.exception("LLM agent turn failed (model=%s)", self._s.llm_model)
            raise LLMError(explain_error(None, self._s)) from exc
        tool_calls = []
        for _, c in sorted(calls.items()):
            try:
                args = json.loads(c["args"]) if c["args"].strip() else {}
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(ToolCall(name=c["name"], args=args if isinstance(args, dict) else {},
                                       id=c["id"] or f"call_{uuid.uuid4().hex[:12]}"))
        if not text.strip() and not tool_calls:
            raise LLMError("The model returned an empty answer. Try rephrasing your question.")
        yield ModelTurn(text=text, tool_calls=tool_calls)
