"""Gemini tool-calling adapter, tested with REAL google-genai types fed through a fake client.

Facts these tests pin down (from the official docs / SDK source, see app/llm/gemini.py):
  * tools are declared with FunctionDeclaration(parameters_json_schema=...), mode AUTO, automatic calling DISABLED
  * the model's turn is replayed EXACTLY as received (thought signatures live inside the parts)
  * all function responses of one turn go back together in one role="user" content, in call order
  * thinking_level (Gemini 3.x) is sent INSTEAD of thinking_budget
"""
from types import SimpleNamespace as NS

import pytest
from google.genai import types

from app.config import Settings
from app.llm.base import LLMError, Message, ModelTurn, ToolCall, ToolResult, ToolResults, ToolSpec, UserText
from app.llm.gemini import GeminiClient

SEARCH = ToolSpec("search_portfolio", "Search.", {"type": "object", "properties": {"query": {"type": "string"}},
                                                  "required": ["query"]})


def S(**kw):
    return Settings(llm_provider="gemini", gemini_api_key="AIza-test", vector_store="memory",
                    embedding_provider="fake", _env_file=None, **kw)


def chunk(*parts):
    return NS(candidates=[NS(content=types.Content(role="model", parts=list(parts)))])


class FakeModels:
    def __init__(self, scripts):
        self.scripts, self.calls = list(scripts), []

    async def generate_content_stream(self, *, model, contents, config):
        self.calls.append(NS(model=model, contents=contents, config=config))
        script = self.scripts.pop(0)
        if isinstance(script, Exception):
            raise script

        async def gen():
            for c in script:
                yield c

        return gen()


def client_with(*scripts, **settings):
    c = GeminiClient(S(**settings))
    c._client = NS(aio=NS(models=FakeModels(scripts)))
    return c, c._client.aio.models


async def collect(c, transcript, tools=(SEARCH,)):
    items = [i async for i in c.stream_turn("sys", transcript, list(tools))]
    return [i for i in items if isinstance(i, str)], items[-1]


async def test_function_call_is_parsed_and_signature_preserved_for_replay():
    sig = types.Part(function_call=types.FunctionCall(id="c1", name="search_portfolio", args={"query": "x"}),
                     thought_signature=b"SIGNATURE-BYTES")
    c, models = client_with([chunk(sig)])
    deltas, turn = await collect(c, [UserText("hi")])
    assert deltas == [] and turn.tool_calls == [ToolCall("search_portfolio", {"query": "x"}, "c1")]
    assert turn.raw.parts[0].thought_signature == b"SIGNATURE-BYTES"  # kept for the next request

    # replay: the next request must carry that very content, unchanged
    c._client.aio.models.scripts.append([chunk(types.Part(text="done"))])
    transcript = [UserText("hi"), turn, ToolResults([ToolResult(turn.tool_calls[0], {"result": "[1] a"})])]
    await collect(c, transcript)
    sent = models.calls[-1].contents
    assert sent[1] is turn.raw and sent[1].parts[0].thought_signature == b"SIGNATURE-BYTES"


async def test_tool_results_go_back_in_one_user_content_in_call_order_with_ids():
    t1 = ToolCall("search_portfolio", {"query": "a"}, "id-a")
    t2 = ToolCall("search_portfolio", {"query": "b"}, "id-b")
    turn = ModelTurn(tool_calls=[t1, t2])  # no raw: adapter rebuilds the function_call parts
    c, models = client_with([chunk(types.Part(text="ok"))])
    await collect(c, [UserText("q"), turn, ToolResults([ToolResult(t1, {"result": "A"}), ToolResult(t2, {"error": "B"})])])
    contents = models.calls[0].contents
    assert [x.role for x in contents] == ["user", "model", "user"]
    assert [p.function_call.name for p in contents[1].parts] == ["search_portfolio"] * 2
    resp = contents[2].parts
    assert [p.function_response.id for p in resp] == ["id-a", "id-b"]
    assert resp[0].function_response.response == {"result": "A"} and resp[1].function_response.response == {"error": "B"}


async def test_request_declares_tools_auto_mode_and_disables_automatic_calling():
    c, models = client_with([chunk(types.Part(text="hello"))])
    await collect(c, [UserText("q")])
    cfg = models.calls[0].config
    decl = cfg.tools[0].function_declarations[0]
    assert decl.name == "search_portfolio" and decl.parameters_json_schema["required"] == ["query"]
    assert cfg.tool_config.function_calling_config.mode == types.FunctionCallingConfigMode.AUTO
    assert cfg.automatic_function_calling.disable is True  # WE run the tools, not the SDK
    assert cfg.system_instruction == "sys"


async def test_no_tools_means_a_plain_text_request():
    c, models = client_with([chunk(types.Part(text="final answer"))])
    deltas, turn = await collect(c, [UserText("q")], tools=())
    cfg = models.calls[0].config
    assert not cfg.tools and cfg.tool_config is None and deltas == ["final answer"] and turn.text == "final answer"


async def test_text_streams_live_and_thought_parts_are_never_shown():
    c, _ = client_with([chunk(types.Part(text="Hel")), chunk(types.Part(text="SECRET THOUGHT", thought=True)),
                        chunk(types.Part(text="lo"))])
    deltas, turn = await collect(c, [UserText("q")])
    assert deltas == ["Hel", "lo"] and turn.text == "Hello" and turn.tool_calls == []


async def test_thinking_level_replaces_budget():
    c, models = client_with([chunk(types.Part(text="x"))], llm_thinking_level="low", llm_thinking_budget=0)
    await collect(c, [UserText("q")])
    tc = models.calls[0].config.thinking_config
    assert tc.thinking_level == types.ThinkingLevel.LOW and tc.thinking_budget is None


async def test_thinking_budget_used_when_no_level():
    c, models = client_with([chunk(types.Part(text="x"))], llm_thinking_budget=0)
    await collect(c, [UserText("q")])
    assert models.calls[0].config.thinking_config.thinking_budget == 0


async def test_retries_once_without_thinking_when_rejected():
    c, models = client_with(Exception("thinking_level is not supported by this model"), [chunk(types.Part(text="ok"))],
                            llm_thinking_level="low")
    deltas, _ = await collect(c, [UserText("q")])
    assert deltas == ["ok"] and len(models.calls) == 2
    assert models.calls[0].config.thinking_config is not None and models.calls[1].config.thinking_config is None


async def test_empty_turn_is_an_error():
    c, _ = client_with([chunk()])
    with pytest.raises(LLMError, match="empty"):
        await collect(c, [UserText("q")])


async def test_provider_errors_become_safe_llmerrors():
    c, _ = client_with(RuntimeError("quota exceeded: key AIza-test"), environment="prod")
    with pytest.raises(LLMError) as e:
        await collect(c, [UserText("q")])
    assert "AIza" not in str(e.value)


async def test_plain_messages_in_the_transcript_are_converted():
    c, models = client_with([chunk(types.Part(text="x"))])
    await collect(c, [Message("user", "hi"), Message("assistant", "yo"), UserText("again")])
    assert [x.role for x in models.calls[0].contents] == ["user", "model", "user"]
