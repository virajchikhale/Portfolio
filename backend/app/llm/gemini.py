import logging
from collections.abc import AsyncIterator

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


def explain_error(exc: Exception, settings: Settings) -> str:
    """Map a provider exception to a visitor-safe message.

    In dev we are specific (so you can fix config); in prod everything is generic and
    nothing about keys/quotas/models is revealed to visitors. The full error is always logged.
    """
    code = getattr(exc, "code", None)
    text = str(exc).lower()
    if settings.environment == "prod":
        return "The AI service is temporarily unavailable."
    if code in (400, 401, 403) and ("api key" in text or "api_key" in text or "permission" in text):
        return "Gemini rejected the API key (check GEMINI_API_KEY)."
    if code == 404 or "not found" in text:
        return f"Model '{settings.llm_model}' was not found (check LLM_MODEL; run scripts/check_llm.py to list models)."
    if code == 429 or "quota" in text or "resource_exhausted" in text:
        return "Gemini quota / rate limit reached for this key."
    if "thinking" in text:
        return "This model rejected the thinking setting (set LLM_THINKING_BUDGET=-1)."
    return "The AI service is temporarily unavailable (see backend logs)."


class GeminiClient:
    def __init__(self, settings: Settings):
        if settings.gemini_api_key is None or not settings.gemini_api_key.get_secret_value().strip():
            raise LLMError("GEMINI_API_KEY is not configured")
        # Imported lazily so the app/tests start without the SDK when using the fake provider.
        from google import genai

        self._genai = genai
        self._client = genai.Client(api_key=settings.gemini_api_key.get_secret_value().strip())
        self._s = settings

    def _config(self, system: str, with_thinking: bool, tools: list[ToolSpec] | None = None):
        types = self._genai.types
        kwargs = {
            "system_instruction": system,
            "max_output_tokens": self._s.llm_max_output_tokens,
            "temperature": self._s.llm_temperature,
        }
        # Thinking tokens count against max_output_tokens; leaving them on can yield EMPTY answers.
        if with_thinking:
            if self._s.llm_thinking_level:  # Gemini 3.x: the level replaces the budget (never send both)
                kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=self._s.llm_thinking_level.upper())
            elif self._s.llm_thinking_budget >= 0:
                kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=self._s.llm_thinking_budget)
        if tools:
            # Manual function calling (https://googleapis.github.io/python-genai/): declare the tools, let the model
            # decide (AUTO), and switch the SDK's automatic execution OFF: our loop runs the tools itself.
            kwargs["tools"] = [types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t.name, description=t.description, parameters_json_schema=t.parameters)
                for t in tools
            ])]
            kwargs["tool_config"] = types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(mode="AUTO"))
            kwargs["automatic_function_calling"] = types.AutomaticFunctionCallingConfig(disable=True)
        return types.GenerateContentConfig(**kwargs)

    async def _stream_once(self, system: str, messages: list[Message], with_thinking: bool) -> AsyncIterator[str]:
        types = self._genai.types
        contents = [
            types.Content(role="model" if m.role == "assistant" else "user", parts=[types.Part(text=m.content)])
            for m in messages
        ]
        stream = await self._client.aio.models.generate_content_stream(
            model=self._s.llm_model, contents=contents, config=self._config(system, with_thinking)
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text

    async def stream(self, system: str, messages: list[Message]) -> AsyncIterator[str]:
        emitted = False
        try:
            try:
                async for text in self._stream_once(system, messages, with_thinking=True):
                    emitted = True
                    yield text
            except Exception as exc:
                # Some models (e.g. Pro) reject thinking_budget=0: retry once without it.
                if emitted or "thinking" not in str(exc).lower():
                    raise
                log.warning("Model rejected thinking config, retrying without it: %s", exc)
                async for text in self._stream_once(system, messages, with_thinking=False):
                    emitted = True
                    yield text
        except Exception as exc:
            log.exception("Gemini call failed (model=%s)", self._s.llm_model)  # full detail to logs only
            raise LLMError(explain_error(exc, self._s)) from exc
        if not emitted:
            log.error("Gemini returned no text (blocked by safety filter or token budget exhausted)")
            raise LLMError("The model returned an empty answer. Try rephrasing your question.")

    # ── agent turns (tool calling) ──────────────────────────────────────────
    def _to_content(self, entry: TranscriptEntry):
        types = self._genai.types
        if isinstance(entry, Message):
            return types.Content(role="model" if entry.role == "assistant" else "user",
                                 parts=[types.Part(text=entry.content)])
        if isinstance(entry, UserText):
            return types.Content(role="user", parts=[types.Part(text=entry.text)])
        if isinstance(entry, ModelTurn):
            if entry.raw is not None:
                return entry.raw  # replay EXACTLY as received: thought signatures live inside these parts
            parts = [types.Part(text=entry.text)] if entry.text else []
            parts += [types.Part(function_call=types.FunctionCall(id=c.id, name=c.name, args=c.args))
                      for c in entry.tool_calls]
            return types.Content(role="model", parts=parts)
        if isinstance(entry, ToolResults):
            # All results of one model turn go back together in ONE content, in call order. The SDK's own
            # function-calling loop uses role="user" for this (the API only accepts "user" or "model").
            return types.Content(role="user", parts=[
                types.Part(function_response=types.FunctionResponse(
                    id=r.call.id, name=r.call.name, response=r.response))
                for r in entry.results
            ])
        raise TypeError(f"unknown transcript entry: {type(entry).__name__}")

    async def _turn_once(self, system, transcript, tools, with_thinking):
        types = self._genai.types
        contents = [self._to_content(e) for e in transcript]
        stream = await self._client.aio.models.generate_content_stream(
            model=self._s.llm_model, contents=contents, config=self._config(system, with_thinking, tools)
        )
        parts, calls, text = [], [], ""
        async for chunk in stream:
            cand = chunk.candidates[0] if chunk.candidates else None
            if not (cand and cand.content and cand.content.parts):
                continue
            for part in cand.content.parts:
                parts.append(part)  # keep every part (incl. thought_signature) for exact replay
                if part.function_call is not None:
                    fc = part.function_call
                    calls.append(ToolCall(name=fc.name, args=dict(fc.args or {}), id=fc.id))
                elif part.text and not part.thought:
                    text += part.text
                    yield part.text
        yield ModelTurn(text=text, tool_calls=calls, raw=types.Content(role="model", parts=parts))

    async def stream_turn(self, system: str, transcript: list[TranscriptEntry], tools: list[ToolSpec]):
        """Yield text deltas, then one ModelTurn. Retries once without the thinking config if the model rejects it."""
        emitted = False
        turn: ModelTurn | None = None
        try:
            try:
                async for item in self._turn_once(system, transcript, tools, with_thinking=True):
                    emitted = emitted or isinstance(item, str)
                    if isinstance(item, ModelTurn):
                        turn = item
                    else:
                        yield item
            except Exception as exc:
                if emitted or turn is not None or "thinking" not in str(exc).lower():
                    raise
                log.warning("Model rejected thinking config, retrying without it: %s", exc)
                async for item in self._turn_once(system, transcript, tools, with_thinking=False):
                    if isinstance(item, ModelTurn):
                        turn = item
                    else:
                        yield item
        except Exception as exc:
            log.exception("Gemini agent turn failed (model=%s)", self._s.llm_model)
            raise LLMError(explain_error(exc, self._s)) from exc
        if turn is None or (not turn.text.strip() and not turn.tool_calls):
            log.error("Gemini returned neither text nor a tool call (safety filter or token budget exhausted)")
            raise LLMError("The model returned an empty answer. Try rephrasing your question.")
        yield turn
