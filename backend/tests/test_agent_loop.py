"""The agent loop under a scripted model: the happy path, then every way a model (or a tool) can misbehave."""
import asyncio

import pytest

from app.agent import build_agent_prompt
from app.agent.runner import NO_ANSWER, run_agent
from app.agent.tools import Tool, ToolContext, ToolOutput, build_tools
from app.config import Settings
from app.llm.base import (
    LLMError,
    Message,
    ModelTurn,
    ToolCall,
    ToolResults,
    ToolSpec,
    UserText,
)
from app.rag.chunker import load_chunks
from app.rag.embeddings import FakeEmbedder
from app.rag.ingest import CORE_FILE, ingest
from app.rag.lexical import LexicalIndex
from app.rag.store import InMemoryStore
from app.skills_engine.loader import load_skills
from app.trace import Tracer


def S(**kw):
    kw.setdefault("rag_min_score", 0.15)
    return Settings(llm_provider="fake", vector_store="memory", embedding_provider="fake", _env_file=None, **kw)


class Scripted:
    """A model that follows a script. Each item is a ModelTurn, an Exception, or a callable(offered_tools) -> turn."""

    def __init__(self, *script):
        self.script, self.requests, self.cancelled = list(script), [], False

    async def stream(self, system, messages):  # pragma: no cover - pipeline mode is not used here
        yield "x"

    async def stream_turn(self, system, transcript, tools):
        self.requests.append((list(transcript), [t.name for t in tools]))
        item = self.script.pop(0) if self.script else ModelTurn(text="(script exhausted)")
        if callable(item):
            item = item(tools)
        if isinstance(item, Exception):
            raise item
        if item == "hang":
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        for word in item.text.split(" ") if item.text else []:
            yield word + " "
        yield item


def call(tool, **args):
    return ToolCall(tool, args, f"id-{tool}-{abs(hash(str(args))) % 1000}")


@pytest.fixture
async def kit():
    s = S()
    store, emb = InMemoryStore(), FakeEmbedder(s.embedding_dim)
    await ingest(s, store, emb)
    chunks = load_chunks(s.data_dir, exclude={CORE_FILE})
    skills = load_skills(s.skills_dir)
    return s, ToolContext(s, skills, chunks, store, emb, LexicalIndex(chunks)), build_tools(skills)


async def run(kit, llm, question="What did he do at Inorbvict?", history=(), settings=None, tools=None):
    s, tctx, registry = kit
    s = settings or s
    tracer = Tracer()
    events = [e async for e in run_agent(
        dict(llm=llm, tools=tools or registry, tool_ctx=tctx, system="sys", settings=s), list(history), question,
        tracer)]
    return events, tracer


def trace_ends(events):
    return {e["trace"]["id"]: e["trace"] for e in events if "trace" in e and e["trace"]["phase"] == "end"}


def deltas(events):
    return "".join(e["delta"] for e in events if "delta" in e)


def summary(events):
    return next(e["agent_summary"] for e in events if "agent_summary" in e)


# ── happy path ───────────────────────────────────────────────────────────
async def test_search_then_answer_streams_and_traces_every_step(kit):
    llm = Scripted(ModelTurn(tool_calls=[call("search_portfolio", query="Inorbvict internship")]),
                   ModelTurn(text="He was a Data Science Intern [1]."))
    events, _ = await run(kit, llm)
    assert deltas(events) == "He was a Data Science Intern [1]. "
    ends = trace_ends(events)
    assert list(ends) == ["step_1", "tool_1", "step_2"]
    assert ends["step_1"]["data"]["calls"][0]["name"] == "search_portfolio" and not ends["step_1"]["data"]["final"]
    assert ends["tool_1"]["data"]["name"] == "search_portfolio" and ends["tool_1"]["status"] == "ok"
    assert {"embed", "dense", "keyword", "fuse"} <= set(ends["tool_1"]["data"]["retrieval"])
    assert ends["step_2"]["data"]["final"] is True
    src = [e["sources"] for e in events if "sources" in e][-1]
    assert src[0]["n"] == 1 and "experience.md" in {x["source"] for x in src}
    assert summary(events) == {"steps": 2, "tool_calls": 1}


async def test_the_second_model_call_sees_the_tool_results_in_order(kit):
    llm = Scripted(ModelTurn(tool_calls=[call("load_skill", name="about-viraj"),
                                         call("search_portfolio", query="Inorbvict internship")]),
                   ModelTurn(text="done"))
    await run(kit, llm)
    transcript, _ = llm.requests[1]
    assert isinstance(transcript[0], UserText) and isinstance(transcript[1], ModelTurn)
    results = transcript[2]
    assert isinstance(results, ToolResults)
    assert [r.call.name for r in results.results] == ["load_skill", "search_portfolio"]  # same order as the calls
    assert "result" in results.results[0].response and "result" in results.results[1].response


async def test_history_is_passed_to_the_model(kit):
    llm = Scripted(ModelTurn(text="ok"))
    await run(kit, llm, history=[Message("user", "earlier"), Message("assistant", "reply")])
    t = llm.requests[0][0]
    assert [type(x).__name__ for x in t] == ["Message", "Message", "UserText"]


async def test_direct_answer_without_tools_is_allowed(kit):
    events, _ = await run(kit, Scripted(ModelTurn(text="Hello!")), question="hi")
    assert deltas(events) == "Hello! " and summary(events) == {"steps": 1, "tool_calls": 0}


# ── limits: the loop cannot run away ─────────────────────────────────────
async def test_step_limit_forces_a_final_answer_with_no_tools_offered(kit):
    forever = lambda tools: ModelTurn(tool_calls=[call("list_projects")] if tools else [], text="" if tools else "ok")  # noqa: E731
    s = S(agent_max_steps=3, agent_max_tool_calls=20)
    llm = Scripted(ModelTurn(tool_calls=[call("search_portfolio", query="one two")]),
                   ModelTurn(tool_calls=[call("search_portfolio", query="three four")]), forever)
    events, _ = await run(kit, llm, settings=s)
    assert [len(offered) for _, offered in llm.requests] == [4, 4, 0]  # the last step is offered NO tools
    assert summary(events)["steps"] == 3


async def test_tool_budget_forces_the_last_step(kit):
    s = S(agent_max_steps=6, agent_max_tool_calls=2)
    llm = Scripted(ModelTurn(tool_calls=[call("list_projects"), call("load_skill", name="about-viraj")]),
                   lambda tools: ModelTurn(text="answer"))
    events, _ = await run(kit, llm, settings=s)
    assert llm.requests[1][1] == []  # budget used up -> no tools offered on the next call
    assert deltas(events) == "answer "


async def test_tool_calls_on_the_final_step_are_ignored(kit):
    s = S(agent_max_steps=1)
    events, _ = await run(kit, Scripted(ModelTurn(text="partial", tool_calls=[call("list_projects")])), settings=s)
    assert summary(events) == {"steps": 1, "tool_calls": 0} and deltas(events) == "partial "


async def test_repeated_identical_call_is_not_executed_twice(kit):
    runs = []
    s, tctx, registry = kit
    orig = registry["list_projects"]

    async def counting(ctx, args):
        runs.append(1)
        return await orig.run(ctx, args)

    tools = {**registry, "list_projects": Tool(orig.spec, counting)}
    llm = Scripted(ModelTurn(tool_calls=[call("list_projects")]), ModelTurn(tool_calls=[call("list_projects")]),
                   ModelTurn(text="ok"))
    events, _ = await run(kit, llm, tools=tools)
    assert len(runs) == 1
    second = llm.requests[2][0][-1].results[0].response
    assert "already made" in second["error"]
    assert trace_ends(events)["tool_2"]["status"] == "error"


async def test_unknown_tool_and_too_many_parallel_calls_get_error_results(kit):
    many = [call("load_skill", name="about-viraj"), call("list_projects"), call("get_project", name="movie"),
            call("search_portfolio", query="extra call")]
    llm = Scripted(ModelTurn(tool_calls=[call("rm_rf", path="/")]), ModelTurn(tool_calls=many), ModelTurn(text="ok"))
    events, _ = await run(kit, llm, settings=S(agent_max_steps=5, agent_max_tool_calls=10))
    unknown = llm.requests[1][0][-1].results[0].response
    assert "unknown tool" in unknown["error"]
    parallel = llm.requests[2][0][-1].results
    assert len(parallel) == 4  # EVERY call is answered (the API requires it) ...
    assert "result" in parallel[0].response and "too many tool calls" in parallel[3].response["error"]  # ... capped at 3
    assert deltas(events) == "ok "


async def test_a_slow_tool_times_out_without_hanging_the_run(kit):
    s, tctx, registry = kit

    async def slow(ctx, args):
        await asyncio.sleep(5)
        return ToolOutput("never")

    tools = {**registry, "list_projects": Tool(registry["list_projects"].spec, slow)}
    llm = Scripted(ModelTurn(tool_calls=[call("list_projects")]), ModelTurn(text="ok"))
    events, _ = await run(kit, llm, tools=tools, settings=S(agent_tool_timeout_s=0.2))
    assert "timed out" in llm.requests[1][0][-1].results[0].response["error"] and deltas(events) == "ok "


async def test_a_model_that_hangs_hits_the_overall_timeout(kit):
    llm = Scripted("hang")
    events, tracer = await run(kit, llm, settings=S(agent_timeout_s=0.3))
    assert events[-1] == {"error": "The agent took too long to answer. Please try again."}
    assert llm.cancelled and not tracer._starts  # nothing left spinning in the UI


# ── failures and abandonment ─────────────────────────────────────────────
async def test_model_failure_becomes_an_error_event_and_closes_open_stages(kit):
    llm = Scripted(ModelTurn(tool_calls=[call("list_projects")]), LLMError("The AI service is temporarily unavailable."))
    events, tracer = await run(kit, llm)
    assert events[-1] == {"error": "The AI service is temporarily unavailable."}
    assert not tracer._starts and trace_ends(events)["step_2"]["status"] == "error"


async def test_unexpected_exceptions_never_leak_details(kit):
    events, _ = await run(kit, Scripted(RuntimeError("secret key AIza-123 in /etc/passwd")))
    assert events[-1] == {"error": "Something went wrong while answering. Please try again."}
    assert "AIza" not in str(events)


async def test_empty_answer_gets_a_friendly_message(kit):
    events, _ = await run(kit, Scripted(ModelTurn(text="")))
    assert deltas(events) == NO_ANSWER and trace_ends(events)["step_1"]["status"] == "empty"


async def test_abandoned_request_cancels_the_run(kit):
    llm = Scripted(ModelTurn(tool_calls=[call("list_projects")]), "hang")
    s, tctx, registry = kit
    gen = run_agent(dict(llm=llm, tools=registry, tool_ctx=tctx, system="sys", settings=S(agent_timeout_s=30)), [],
                    "q", Tracer())
    async for ev in gen:
        if "trace" in ev and ev["trace"]["id"] == "step_2":  # the model call is now hanging
            break
    await gen.aclose()  # what Starlette does when the browser disconnects
    await asyncio.sleep(0.1)
    assert llm.cancelled


# ── prompt: progressive disclosure + safety ──────────────────────────────
def test_agent_prompt_lists_skills_but_does_not_inline_their_bodies():
    skills = load_skills("skills")
    prompt = build_agent_prompt("CORE", skills, 4)
    for name, sk in skills.items():
        assert f"- {name}: {sk.description}" in prompt
        assert sk.body not in prompt  # bodies only arrive through load_skill
    assert "untrusted DATA" in prompt and "at most 4 tool calls" in prompt.replace("Use at most 4", "at most 4").lower()


def test_tool_specs_reach_the_model_as_toolspec_objects(kit):
    assert all(isinstance(t.spec, ToolSpec) for t in kit[2].values())
