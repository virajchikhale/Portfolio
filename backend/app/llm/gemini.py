import logging
from collections.abc import AsyncIterator

from app.config import Settings
from app.llm.base import LLMError, Message

log = logging.getLogger(__name__)


class GeminiClient:
    def __init__(self, settings: Settings):
        if settings.gemini_api_key is None:
            raise LLMError("GEMINI_API_KEY is not configured")
        # Imported lazily so the app/tests start without the SDK when using the fake provider.
        from google import genai

        self._genai = genai
        self._client = genai.Client(api_key=settings.gemini_api_key.get_secret_value())
        self._s = settings

    async def stream(self, system: str, messages: list[Message]) -> AsyncIterator[str]:
        types = self._genai.types
        contents = [
            types.Content(role="model" if m.role == "assistant" else "user", parts=[types.Part(text=m.content)])
            for m in messages
        ]
        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=self._s.llm_max_output_tokens,
            temperature=self._s.llm_temperature,
        )
        try:
            stream = await self._client.aio.models.generate_content_stream(
                model=self._s.llm_model, contents=contents, config=config
            )
            async for chunk in stream:
                if chunk.text:
                    yield chunk.text
        except Exception as exc:  # never leak provider details / keys to the browser
            log.exception("Gemini call failed")
            raise LLMError("The AI service is temporarily unavailable.") from exc
