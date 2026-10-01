"""The agent loop as a LangGraph StateGraph (https://docs.langchain.com/oss/python/langgraph/graph-api).

        START ──► decide ──(model asked for tools)──► act ──┐
                    ▲  │                                    │
                    │  └──(model answered / limits hit)──► END
                    └───────────────────────────────────────┘

* decide: one model call. Text streams to the user as it arrives. If tools are requested we go to `act`.
* act:    runs the requested tools (read-only, validated, time-limited) and appends their results.
Hard limits (steps, tool calls, wall clock, repeated calls) make an endless or expensive loop impossible: on the last
step the model is offered NO tools, so it has to answer.

Non-state objects (LLM client, tools, emitter) travel in `context`, as LangGraph v1 recommends, not in the state.
"""
import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

from app.agent.tools import Tool, ToolContext, ToolOutput, run_tool
from app.config import Settings
from app.llm.base import LLMClient, LLMError, ModelTurn, ToolResult, ToolResults, TranscriptEntry
from app.trace import Tracer

MAX_CALLS_PER_TURN = 3  # parallel calls beyond this are answered with an error instead of executed
PREVIEW_CHARS = 300


class AgentState(TypedDict):
    transcript: list[TranscriptEntry]
    steps: int  # model calls made
    tool_calls: int  # tool executions made
    seen: list[str]  # signatures of calls already made (loop detection)
    answer: str
    done: bool
    stop: str | None  # why the loop ended early: None | "limit" | "no_answer"


@dataclass
class AgentContext:
    llm: LLMClient
    tools: dict[str, Tool]
    tool_ctx: ToolContext
    system: str
    settings: Settings
    tracer: Tracer
    emit: Callable[[dict], None]  # pushes SSE payloads ({"trace":..}, {"delta":..}, {"sources":..}) to the runner
    deadline: float  # time.monotonic() value after which the next model call must be the last

    def flush_trace(self) -> None:
        for e in self.tracer.drain():
            self.emit({"trace": e})


def _signature(name: str, args: Any) -> str:
    return f"{name}:{json.dumps(args, sort_keys=True, default=str)}"


async def decide(state: AgentState, runtime: Runtime[AgentContext]) -> dict:
    ctx = runtime.context
    s = ctx.settings
    n = state["steps"] + 1
    budget_left = state["tool_calls"] < s.agent_max_tool_calls
    last = n >= s.agent_max_steps or not budget_left or time.monotonic() > ctx.deadline
    offered = [] if last else [t.spec for t in ctx.tools.values()]

    sid = f"step_{n}"
    ctx.tracer.start(sid, f"Agent step {n}", "final answer (no tools offered)" if last else "model decides")
    ctx.flush_trace()

    text, turn = "", None
    async for item in ctx.llm.stream_turn(ctx.system, state["transcript"], offered):
        if isinstance(item, str):
            text += item
            ctx.emit({"delta": item})  # the answer streams live, exactly like pipeline mode
        else:
            turn = item
    if not isinstance(turn, ModelTurn):  # a well-behaved client always ends with one ModelTurn
        raise LLMError("The model returned no turn.")

    calls = turn.tool_calls if not last else []  # when no tools were offered, ignore any call the model makes anyway
    if not calls:
        verdict = "answer" if turn.text.strip() else "no_answer"
        ctx.tracer.end(sid, "ok" if turn.text.strip() else "empty",
                       "answered" if turn.text.strip() else "the model produced no text",
                       {"final": True, "text_chars": len(turn.text), "calls": []})
        ctx.flush_trace()
        return {"transcript": [*state["transcript"], turn], "steps": n, "done": True, "answer": turn.text,
                "stop": None if verdict == "answer" else "no_answer"}
    ctx.tracer.end(sid, "ok", "requested " + ", ".join(c.name for c in calls),
                   {"final": False, "text_chars": len(turn.text),
                    "calls": [{"name": c.name, "args": c.args} for c in calls]})
    ctx.flush_trace()
    return {"transcript": [*state["transcript"], turn], "steps": n, "done": False, "answer": turn.text}


async def act(state: AgentState, runtime: Runtime[AgentContext]) -> dict:
    ctx = runtime.context
    s = ctx.settings
    turn = state["transcript"][-1]
    if not isinstance(turn, ModelTurn):
        raise RuntimeError("act() must follow a model turn")
    seen, n_calls, results = list(state["seen"]), state["tool_calls"], []

    # Every function call must get exactly one response, in order (Gemini rejects a turn with missing responses).
    for i, call in enumerate(turn.tool_calls):
        n_calls += 1
        tid = f"tool_{n_calls}"
        ctx.tracer.start(tid, f"Tool: {call.name}", json.dumps(call.args, default=str)[:120])
        ctx.flush_trace()
        sig = _signature(call.name, call.args)
        tool = ctx.tools.get(call.name)
        if tool is None:
            out = ToolOutput(f"Error: unknown tool '{call.name}'", is_error=True)
        elif i >= MAX_CALLS_PER_TURN:
            out = ToolOutput("Error: too many tool calls in one step; call fewer tools at a time.", is_error=True)
        elif n_calls > s.agent_max_tool_calls:
            out = ToolOutput("Error: tool-call budget used up. Answer now with what you already know.", is_error=True)
        elif sig in seen:
            out = ToolOutput("Error: you already made this exact call; use its earlier result and answer.",
                             is_error=True)
        else:
            seen.append(sig)
            try:
                out = await asyncio.wait_for(run_tool(tool, ctx.tool_ctx, call.args), s.agent_tool_timeout_s)
            except TimeoutError:
                out = ToolOutput("Error: the tool timed out.", is_error=True)
        results.append(ToolResult(call, {"error": out.text} if out.is_error else {"result": out.text}))
        ctx.tracer.end(tid, "error" if out.is_error else "ok",
                       out.text[:90].replace("\n", " ") if out.is_error else f"{len(out.text)} chars returned",
                       {"name": call.name, "args": call.args, "result": out.text[:PREVIEW_CHARS], **out.data})
        ctx.flush_trace()
    if ctx.tool_ctx.book.chunks:
        ctx.emit({"sources": ctx.tool_ctx.book.as_events()})  # the UI keeps the latest list
    return {"transcript": [*state["transcript"], ToolResults(results)], "tool_calls": n_calls, "seen": seen}


def _route(state: AgentState) -> str:
    return END if state["done"] else "act"


def build_graph():
    g = StateGraph(AgentState, context_schema=AgentContext)
    g.add_node("decide", decide)
    g.add_node("act", act)
    g.add_edge(START, "decide")
    g.add_conditional_edges("decide", _route, {"act": "act", END: END})
    g.add_edge("act", "decide")
    return g.compile()


GRAPH = build_graph()  # stateless and reusable across requests
