import json

import httpx
import pytest

from app.config import Settings
from app.llm.base import LLMError, Message, ModelTurn, ToolCall, ToolResult, ToolResults, ToolSpec, UserText
from app.llm.openai_compat import OpenAICompatClient


def _s(**kw):
    kw.setdefault("llm_api_key", "gsk-test")
    return Settings(llm_provider="openai", llm_model="m", _env_file=None, **kw)


def _sse(*events):
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"


def _client(handler, **kw):
    return OpenAICompatClient(_s(**kw), transport=httpx.MockTransport(handler))


def _text(t):
    return {"choices": [{"delta": {"content": t}}]}


async def test_streams_text_and_sends_expected_request():
    seen = {}

    def handler(req: httpx.Request):
        seen["auth"] = req.headers.get("authorization")
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, text=_sse(_text("Hel"), _text("lo")), headers={"content-type": "text/event-stream"})

    out = "".join([t async for t in _client(handler).stream("sys", [Message("user", "hi")])])
    assert out == "Hello"
    assert seen["auth"] == "Bearer gsk-test"
    assert seen["body"]["messages"][0] == {"role": "system", "content": "sys"}
    assert seen["body"]["messages"][1] == {"role": "user", "content": "hi"}
    assert seen["body"]["stream"] is True and "tools" not in seen["body"]


async def test_tool_call_roundtrip():
    bodies = []

    def handler(req):
        bodies.append(json.loads(req.content))
        if len(bodies) == 1:  # arguments arrive split across chunks, as real providers stream them
            return httpx.Response(200, text=_sse(
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "search", "arguments": '{"query"'}}]}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ': "rag"}'}}]}}]}))
        return httpx.Response(200, text=_sse(_text("done")))

    tools = [ToolSpec("search", "find", {"type": "object", "properties": {"query": {"type": "string"}}})]
    c = _client(handler)
    items = [i async for i in c.stream_turn("sys", [UserText("q")], tools)]
    turn = items[-1]
    assert isinstance(turn, ModelTurn) and turn.tool_calls == [ToolCall("search", {"query": "rag"}, "c1")]
    assert bodies[0]["tools"][0]["function"]["name"] == "search"

    transcript = [UserText("q"), turn, ToolResults([ToolResult(turn.tool_calls[0], {"result": "ok"})])]
    items = [i async for i in c.stream_turn("sys", transcript, tools)]
    assert items[0] == "done" and isinstance(items[-1], ModelTurn)
    msgs = bodies[1]["messages"]
    assert msgs[2]["tool_calls"][0]["function"]["arguments"] == '{"query": "rag"}'
    assert msgs[3] == {"role": "tool", "tool_call_id": "c1", "content": '{"result": "ok"}'}


@pytest.mark.parametrize("status,needle", [(401, "LLM_API_KEY"), (404, "'m'"), (429, "rate limit")])
async def test_dev_errors_are_specific(status, needle):
    c = _client(lambda r: httpx.Response(status, json={"error": "x"}))
    with pytest.raises(LLMError, match=needle):
        [t async for t in c.stream("s", [Message("user", "hi")])]


async def test_prod_errors_leak_nothing():
    c = _client(lambda r: httpx.Response(401, json={"error": "bad key gsk-test"}), environment="prod")
    with pytest.raises(LLMError) as e:
        [t async for t in c.stream("s", [Message("user", "hi")])]
    assert str(e.value) == "The AI service is temporarily unavailable."


async def test_empty_answer_is_an_error():
    c = _client(lambda r: httpx.Response(200, text=_sse({"choices": [{"delta": {}}]})))
    with pytest.raises(LLMError, match="empty"):
        [t async for t in c.stream("s", [Message("user", "hi")])]


def test_key_required_for_remote_but_not_local():
    with pytest.raises(LLMError):
        OpenAICompatClient(_s(llm_api_key=None))
    OpenAICompatClient(_s(llm_api_key=None, llm_base_url="http://host.docker.internal:11434/v1"))
