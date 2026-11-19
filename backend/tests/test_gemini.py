import pytest

from app.config import Settings
from app.llm.base import LLMError, Message
from app.llm.gemini import GeminiClient, explain_error


class FakeAPIError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def _s(**kw):
    return Settings(llm_provider="gemini", gemini_api_key="AIza-test", _env_file=None, **kw)


def test_explain_error_dev_is_specific():
    s = _s()
    assert "API key" in explain_error(FakeAPIError(400, "API key not valid"), s)
    assert "gemini-2.5-flash" in explain_error(FakeAPIError(404, "model not found"), s)
    assert "quota" in explain_error(FakeAPIError(429, "RESOURCE_EXHAUSTED"), s).lower()


def test_explain_error_prod_leaks_nothing():
    s = _s(environment="prod")
    for e in (FakeAPIError(400, "API key not valid"), FakeAPIError(404, "model not found")):
        msg = explain_error(e, s)
        assert msg == "The AI service is temporarily unavailable."


def test_blank_key_rejected():
    with pytest.raises(LLMError):
        GeminiClient(Settings(llm_provider="gemini", gemini_api_key="   ", _env_file=None))


async def _collect(client):
    return "".join([t async for t in client.stream("sys", [Message("user", "hi")])])


async def test_retries_without_thinking_when_model_rejects_it(monkeypatch):
    client = GeminiClient(_s())
    calls = []

    async def fake_once(self, system, messages, with_thinking):
        calls.append(with_thinking)
        if with_thinking:
            raise FakeAPIError(400, "Budget 0 is invalid. This model only works in thinking mode.")
        yield "ok"

    monkeypatch.setattr(GeminiClient, "_stream_once", fake_once)
    assert await _collect(client) == "ok"
    assert calls == [True, False]


async def test_empty_answer_is_an_error(monkeypatch):
    client = GeminiClient(_s())

    async def empty(self, system, messages, with_thinking):
        return
        yield  # pragma: no cover

    monkeypatch.setattr(GeminiClient, "_stream_once", empty)
    with pytest.raises(LLMError, match="empty"):
        await _collect(client)


async def test_provider_error_becomes_safe_llmerror(monkeypatch):
    client = GeminiClient(_s(environment="prod"))

    async def boom(self, system, messages, with_thinking):
        raise FakeAPIError(403, "key AIza-test leaked in provider text")
        yield  # pragma: no cover

    monkeypatch.setattr(GeminiClient, "_stream_once", boom)
    with pytest.raises(LLMError) as e:
        await _collect(client)
    assert "AIza" not in str(e.value)


def test_thinking_budget_config():
    c = GeminiClient(_s(llm_thinking_budget=0))
    assert c._config("s", True).thinking_config.thinking_budget == 0
    assert c._config("s", False).thinking_config is None
    assert GeminiClient(_s(llm_thinking_budget=-1))._config("s", True).thinking_config is None
