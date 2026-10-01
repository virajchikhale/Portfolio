from collections.abc import AsyncIterator

from app.config import Settings
from app.llm.base import (
    LLMClient,
    Message,
    ModelTurn,
    ToolCall,
    ToolResults,
    ToolSpec,
    TranscriptEntry,
    UserText,
)


class FakeClient:
    """Deterministic offline provider for tests and keyless local dev."""

    async def stream(self, system: str, messages: list[Message]) -> AsyncIterator[str]:
        for word in f"[fake-llm] You said: {messages[-1].content}".split(" "):
            yield word + " "


    async def stream_turn(self, system: str, transcript: list[TranscriptEntry], tools: list[ToolSpec]):
        """Deterministic stand-in for a tool-calling model (keyless demos and tests):
        load a matching skill, search the corpus, then answer from what the search returned."""
        question = next((e.text for e in reversed(transcript) if isinstance(e, UserText)), "")
        done = [r for e in transcript if isinstance(e, ToolResults) for r in e.results]
        names = {t.name for t in tools}
        q = question.lower()
        turn: ModelTurn
        if tools and not any(r.call.name == "load_skill" for r in done) and "load_skill" in names:
            skill = ("contact-handoff" if any(w in q for w in ("contact", "hire", "reach", "email"))
                     else "project-explainer" if any(w in q for w in ("project", "built", "build"))
                     else "about-viraj")
            turn = ModelTurn(tool_calls=[ToolCall("load_skill", {"name": skill}, "fake-1")])
        elif tools and not any(r.call.name == "search_portfolio" for r in done) and "search_portfolio" in names:
            turn = ModelTurn(tool_calls=[ToolCall("search_portfolio", {"query": question}, "fake-2")])
        else:
            found = next((r.response.get("result", "") for r in done if r.call.name == "search_portfolio"), "")
            first = next((ln for ln in str(found).splitlines() if ln.startswith("[1]")), "")
            text = (f"[fake-agent] Based on {first or 'the available sources'}" if first
                    else "[fake-agent] I don't have that detail in my sources.")
            for word in text.split(" "):
                yield word + " "
            turn = ModelTurn(text=text + " ")
        yield turn


def build_llm(settings: Settings) -> LLMClient:
    if settings.llm_provider == "fake":
        return FakeClient()
    if settings.llm_provider == "gemini":
        from app.llm.gemini import GeminiClient

        return GeminiClient(settings)
    raise ValueError(f"unknown LLM_PROVIDER {settings.llm_provider!r}")
