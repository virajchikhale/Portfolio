"""Run the agent graph and expose it as an async stream of SSE payloads.

The graph runs in its own task and pushes events into a queue; this generator drains the queue. That keeps the
LangGraph part thin and lets us (a) enforce a wall-clock timeout, (b) turn every failure into a clean `error` event,
and (c) CANCEL the whole run when the browser disconnects, so an abandoned request stops spending model calls.
"""
import asyncio
import logging
import time
from collections.abc import AsyncIterator

from langgraph.errors import GraphRecursionError

from app.agent.graph import GRAPH, AgentContext
from app.llm.base import LLMError, UserText
from app.llm.base import Message as HistoryMessage
from app.trace import Tracer

log = logging.getLogger(__name__)
_DONE = object()
NO_ANSWER = "I couldn't put together an answer. Please try rephrasing your question."


async def run_agent(
    ctx_kwargs: dict, history: list[HistoryMessage], question: str, tracer: Tracer
) -> AsyncIterator[dict]:
    """Yield SSE payload dicts: {"trace":..}, {"delta":..}, {"sources":..}, {"error":..}. Never raises."""
    settings = ctx_kwargs["settings"]
    queue: asyncio.Queue = asyncio.Queue()
    ctx = AgentContext(**ctx_kwargs, tracer=tracer, emit=queue.put_nowait,
                       deadline=time.monotonic() + settings.agent_timeout_s * 0.8)
    transcript = [*history, UserText(question)]
    init = {"transcript": transcript, "steps": 0, "tool_calls": 0, "seen": [], "answer": "", "done": False,
            "stop": None}
    config = {"recursion_limit": 2 * settings.agent_max_steps + 4}  # decide+act per step, plus slack

    async def go():
        try:
            return await asyncio.wait_for(GRAPH.ainvoke(init, context=ctx, config=config), settings.agent_timeout_s)
        finally:
            queue.put_nowait(_DONE)

    def closing_events(why: str) -> list[dict]:
        """Close any stage still open and return those trace events. They must be yielded directly: the queue has
        already been fully consumed at this point."""
        tracer.abort_open(why)
        return [{"trace": e} for e in tracer.drain()]

    task = asyncio.create_task(go())
    try:
        while (item := await queue.get()) is not _DONE:
            yield item
        try:
            final = task.result()
        except LLMError as exc:
            for ev in closing_events("model call failed"):
                yield ev
            yield {"error": str(exc)}
        except TimeoutError:
            for ev in closing_events("timed out"):
                yield ev
            yield {"error": "The agent took too long to answer. Please try again."}
        except GraphRecursionError:
            for ev in closing_events("too many steps"):
                yield ev
            yield {"error": "The agent took too many steps. Please try again."}
        except Exception:
            log.exception("agent run failed")
            for ev in closing_events("unexpected error"):
                yield ev
            yield {"error": "Something went wrong while answering. Please try again."}
        else:
            if final.get("stop") == "no_answer" or not final.get("answer", "").strip():
                yield {"delta": NO_ANSWER}
            yield {"agent_summary": {"steps": final["steps"], "tool_calls": final["tool_calls"]}}
    finally:
        if not task.done():  # client went away mid-run: stop spending model calls
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
