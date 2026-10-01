import logging
from collections.abc import AsyncIterator

from app.config import Settings
from app.llm.base import LLMError, Message

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

    def _config(self, system: str, with_thinking: bool):
        types = self._genai.types
        kwargs = {
            "system_instruction": system,
            "max_output_tokens": self._s.llm_max_output_tokens,
            "temperature": self._s.llm_temperature,
        }
        # Thinking tokens count against max_output_tokens; leaving them on can yield EMPTY answers.
        if with_thinking and self._s.llm_thinking_budget >= 0:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=self._s.llm_thinking_budget)
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
