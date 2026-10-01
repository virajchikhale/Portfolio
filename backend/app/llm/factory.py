from collections.abc import AsyncIterator

from app.config import Settings
from app.llm.base import LLMClient, Message


class FakeClient:
    """Deterministic offline provider for tests and keyless local dev."""

    async def stream(self, system: str, messages: list[Message]) -> AsyncIterator[str]:
        for word in f"[fake-llm] You said: {messages[-1].content}".split(" "):
            yield word + " "


def build_llm(settings: Settings) -> LLMClient:
    if settings.llm_provider == "fake":
        return FakeClient()
    if settings.llm_provider == "gemini":
        from app.llm.gemini import GeminiClient

        return GeminiClient(settings)
    raise ValueError(f"unknown LLM_PROVIDER {settings.llm_provider!r}")
