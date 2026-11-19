"""One chat turn as a stream of payload dicts: {"trace":..}, {"sources":..}, {"delta":..}, {"error":..}.

main.py turns these into server-sent events; keeping this separate from HTTP makes both modes easy to test and
guarantees the same failure behaviour: every failure becomes a clean `error` event, never a dropped connection.
(asyncio.CancelledError is deliberately NOT caught: when the visitor leaves, the cancellation must propagate so the
model call stops.)
"""
import asyncio
import logging
from collections.abc import AsyncIterator
from types import SimpleNamespace

from app.agent.runner import run_agent
from app.agent.tools import SourceBook, ToolContext
from app.config import Settings
from app.llm.base import LLMError, Message
from app.rag.embeddings import RAG_HINTS
from app.rag.retriever import format_context, retrieve
from app.trace import Tracer

log = logging.getLogger(__name__)
GENERIC_ERROR = "Something went wrong while answering. Please try again."


async def stream_turn(state: SimpleNamespace, settings: Settings, *, use_agent: bool, history: list[Message],
                      text: str, query: str, tracer: Tracer) -> AsyncIterator[dict]:
    try:
        stream = (_agent if use_agent else _pipeline)(state, settings, history, text, query, tracer)
        async for item in stream:
            yield item
    except Exception:
        log.exception("chat turn failed")
        tracer.abort_open("unexpected error")
        for e in tracer.drain():
            yield {"trace": e}
        yield {"error": GENERIC_ERROR}


def _drain(tracer: Tracer) -> list[dict]:
    return [{"trace": e} for e in tracer.drain()]


async def _agent(state, settings, history, text, query, tracer) -> AsyncIterator[dict]:
    for item in _drain(tracer):
        yield item
    tool_ctx = ToolContext(settings, state.skills, state.chunks, state.rag, state.embedder, state.lexical, SourceBook())
    kwargs = dict(llm=state.llm, tools=state.tools, tool_ctx=tool_ctx, system=state.agent_prompt, settings=settings)
    produced, failure = False, None
    async for item in run_agent(kwargs, history, text, tracer):
        if "agent_summary" in item:  # internal bookkeeping, never sent to the browser
            continue
        if "delta" in item:
            produced = True
        if "error" in item and not produced and settings.agent_fallback:
            failure = item["error"]  # swallow it: the visitor gets an answer from the pipeline instead
            break
        yield item
    if failure is None:
        return
    # The agent could not answer (e.g. the model rejected tool calling). Nothing was shown yet, so answer with the
    # fast pipeline rather than an error. The trace says so and the Flow Monitor switches graphs.
    log.warning("agent failed before answering (%s); falling back to the pipeline", failure)
    tracer.meta(mode="pipeline", requested="agent", note="the agent could not answer, so the fast pipeline was used")
    async for item in _pipeline(state, settings, history, text, query, tracer):
        yield item


async def _pipeline(state, settings, history, text, query, tracer) -> AsyncIterator[dict]:
    for item in _drain(tracer):
        yield item

    hits = []
    if state.rag is not None:
        try:
            hits = await retrieve(state.rag, state.embedder, query, settings, state.lexical, tracer)
        except Exception:
            log.exception("retrieval failed; answering from core facts only")
            tracer.abort_open("retrieval failed; continuing without sources")
    else:
        reason = state.rag_reason or "unknown"
        for stage, label in (("embed", "Embed query"), ("dense", "Vector search"),
                             ("keyword", "Keyword (BM25)"), ("fuse", "Fuse + gate")):
            tracer.skip(stage, label, f"retrieval unavailable: {reason}",
                        {"reason": reason, "hint": RAG_HINTS.get(reason, RAG_HINTS["unknown"])})
    for item in _drain(tracer):
        yield item

    tracer.start("prompt", "Build prompt")
    system = f"{state.system_prompt}\n\n{format_context(hits)}"
    sources = [{"n": i, "label": h.chunk.label, "source": h.chunk.source} for i, h in enumerate(hits, 1)]
    # Size only: the prompt text itself is never exposed.
    tracer.end("prompt", detail=f"{len(hits)} source(s) in context",
               data={"sources": len(hits), "approx_tokens": len(system) // 4})
    for item in _drain(tracer):
        yield item
    if sources:
        yield {"sources": sources}

    tracer.start("llm", "LLM", settings.llm_model)
    for item in _drain(tracer):
        yield item
    chunks, chars, first = 0, 0, None
    try:
        async with asyncio.timeout(settings.llm_timeout_s):  # a stalled model call must not hold the connection open
            async for chunk in state.llm.stream(system, [*history, Message("user", text)]):
                if first is None:
                    first = tracer.now()
                    tracer.progress("llm", "first token")
                    for item in _drain(tracer):
                        yield item
                chunks += 1
                chars += len(chunk)
                yield {"delta": chunk}
        tracer.end("llm", detail=f"{chunks} chunks, {chars} chars",
                   data={"model": settings.llm_model, "chunks": chunks, "chars": chars, "ttft_ms": first})
        for item in _drain(tracer):
            yield item
    except TimeoutError:
        tracer.end("llm", "error", "timed out")
        for item in _drain(tracer):
            yield item
        yield {"error": "The AI service took too long to answer. Please try again."}
    except LLMError as exc:
        tracer.end("llm", "error", "model call failed")
        for item in _drain(tracer):
            yield item
        yield {"error": str(exc)}
