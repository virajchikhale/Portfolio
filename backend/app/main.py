import json
import logging
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.agent import build_agent_prompt, build_system_prompt, load_core
from app.agent.runner import run_agent
from app.agent.tools import SourceBook, ToolContext, build_tools
from app.bootstrap import start_rag
from app.config import Settings, get_settings
from app.llm.base import LLMError, Message
from app.llm.factory import build_llm
from app.mcp_server import build_mcp_server, http_app
from app.rag.chunker import load_chunks
from app.rag.embeddings import RAG_HINTS
from app.rag.ingest import CORE_FILE
from app.rag.retriever import format_context, retrieve
from app.security.guardrails import GuardrailViolation, check_input, looks_like_injection, sanitize
from app.security.rate_limit import RateLimiter, client_ip
from app.skills_engine.loader import load_skills
from app.trace import Tracer

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


class Turn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(max_length=4000)  # hard cap before our own (smaller) guardrail
    history: list[Turn] = Field(default_factory=list, max_length=50)
    mode: Literal["pipeline", "agent"] = "pipeline"  # pipeline = fixed retrieve->answer chain; agent = tool loop


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    mcp = None
    mcp_asgi = None
    if settings.mcp_http_enabled:
        # Built up front: a mounted sub-app's own lifespan never runs, so OUR lifespan must enter the session manager
        # (https://py.sdk.modelcontextprotocol.io/run/asgi/).
        mcp = build_mcp_server(lambda: make_tool_ctx(), lambda: app.state.tools)
        mcp_asgi = http_app(mcp, settings)

    def make_tool_ctx() -> ToolContext:
        st = app.state
        return ToolContext(settings, st.skills, st.chunks, st.rag, st.embedder, st.lexical, SourceBook())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.limiter = RateLimiter(settings)
        app.state.skills = load_skills(settings.skills_dir)
        app.state.system_prompt = build_system_prompt(load_core(settings.data_dir), app.state.skills)
        app.state.llm = build_llm(settings)  # fails fast if the key is missing
        core = load_core(settings.data_dir)
        app.state.chunks = load_chunks(settings.data_dir, exclude={CORE_FILE})
        app.state.tools = build_tools(app.state.skills)
        app.state.agent_prompt = build_agent_prompt(core, app.state.skills, settings.agent_max_tool_calls)
        rag = await start_rag(settings)
        app.state.rag, app.state.embedder, app.state.lexical = rag.store, rag.embedder, rag.lexical
        app.state.rag_reason = rag.reason  # None = healthy; else a RAG_HINTS key shown in /api/health and the monitor
        async with AsyncExitStack() as stack:
            if mcp is not None:
                await stack.enter_async_context(mcp.session_manager.run())
            try:
                yield
            finally:
                await rag.close()

    app = FastAPI(
        title="VC·AI backend",
        lifespan=lifespan,
        docs_url=None if settings.environment == "prod" else "/docs",
        redoc_url=None,
        openapi_url=None if settings.environment == "prod" else "/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        allow_credentials=False,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.exception_handler(GuardrailViolation)
    async def _guard(_: Request, exc: GuardrailViolation):
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.get("/api/health")
    async def health(request: Request):
        # deliberately reveals no secrets / config values
        rag = request.app.state.rag
        try:
            chunks = await rag.count() if rag else 0
        except Exception:
            chunks = 0
        return {
            "status": "ok",
            "skills": sorted(request.app.state.skills),
            "provider": settings.llm_provider,
            "rag": {"enabled": rag is not None, "chunks": chunks, "reason": request.app.state.rag_reason},
        }

    @app.post("/api/chat")
    async def chat(body: ChatRequest, request: Request):
        tracer = Tracer()

        def blocked(stage: str, detail: str, payload: dict, status: int, headers: dict | None = None):
            # The trace goes back with the error so the UI can show WHERE the request was stopped.
            tracer.end(stage, "blocked", detail)
            return JSONResponse({**payload, "trace": tracer.drain()}, status_code=status, headers=headers)

        tracer.start("rate_limit", "Rate limit")
        try:
            request.app.state.limiter.check(client_ip(request, settings))
        except HTTPException as exc:
            return blocked("rate_limit", "limit reached", {"detail": exc.detail}, exc.status_code, exc.headers)
        tracer.end("rate_limit", detail="within limits")

        tracer.start("guardrails", "Input guardrails")
        try:
            text = check_input(body.message, settings)
            history: list[Message] = []
            for t in body.history[-settings.max_history_turns :]:
                if t.role == "user":
                    history.append(Message("user", check_input(t.content, settings)))
                    continue
                # Clients can forge "assistant" turns, so screen them too; drop (don't fail) if suspicious.
                if not looks_like_injection(t.content):
                    history.append(Message("assistant", sanitize(t.content)[: settings.max_input_chars * 3]))
        except GuardrailViolation as exc:
            # Deliberately generic: never reveal which pattern matched.
            return blocked("guardrails", "blocked by input guardrail", {"error": exc.message}, exc.status)
        tracer.end("guardrails", detail=f"{len(text)} chars checked", data={"chars": len(text)})
        messages = [*history, Message("user", text)]

        # Retrieval. A follow-up like "tell me more" has no keywords, so include the previous user turn.
        prior_user = next((m.content for m in reversed(history) if m.role == "user"), "")
        query = f"{prior_user} {text}".strip()[: settings.max_input_chars * 2]

        def sse(obj) -> str:
            return f"data: {json.dumps(obj)}\n\n"

        # Agent mode costs up to agent_max_steps model calls. If the daily budget cannot absorb that, quietly use
        # the cheap pipeline instead (and say so in the trace) rather than failing the visitor's question.
        wanted_agent = body.mode == "agent" and settings.agent_enabled
        use_agent = wanted_agent and request.app.state.limiter.can_afford(settings.agent_max_steps - 1)
        note = None
        if body.mode == "agent" and not use_agent:
            note = ("agent mode is disabled" if not settings.agent_enabled
                    else "daily budget low: using the fast pipeline")
        tracer.meta(mode="agent" if use_agent else "pipeline", requested=body.mode, note=note)

        async def agent_events():
            for e in tracer.drain():
                yield sse({"trace": e})
            tool_ctx = ToolContext(settings, request.app.state.skills, request.app.state.chunks,
                                   request.app.state.rag, request.app.state.embedder, request.app.state.lexical,
                                   SourceBook())
            kwargs = dict(llm=request.app.state.llm, tools=request.app.state.tools, tool_ctx=tool_ctx,
                          system=request.app.state.agent_prompt, settings=settings)
            async for item in run_agent(kwargs, history, text, tracer):
                if "agent_summary" in item:  # internal: charge the extra model calls to the daily budget
                    request.app.state.limiter.charge(item["agent_summary"]["steps"] - 1)
                    continue
                yield sse(item)
            yield "data: [DONE]\n\n"

        async def events():
            for e in tracer.drain():
                yield sse({"trace": e})

            hits = []
            if request.app.state.rag is not None:
                try:
                    hits = await retrieve(request.app.state.rag, request.app.state.embedder, query, settings,
                                          request.app.state.lexical, tracer)
                except Exception:
                    log.exception("retrieval failed; answering from core facts only")
                    tracer.abort_open("retrieval failed; continuing without sources")
            else:
                reason = request.app.state.rag_reason or "unknown"
                for stage, label in (("embed", "Embed query"), ("dense", "Vector search"),
                                     ("keyword", "Keyword (BM25)"), ("fuse", "Fuse + gate")):
                    tracer.skip(stage, label, f"retrieval unavailable: {reason}",
                                {"reason": reason, "hint": RAG_HINTS.get(reason, RAG_HINTS["unknown"])})
            for e in tracer.drain():
                yield sse({"trace": e})

            tracer.start("prompt", "Build prompt")
            system = f"{request.app.state.system_prompt}\n\n{format_context(hits)}"
            sources = [{"n": i, "label": h.chunk.label, "source": h.chunk.source} for i, h in enumerate(hits, 1)]
            # Size only: the prompt text itself is never exposed.
            tracer.end("prompt", detail=f"{len(hits)} source(s) in context",
                       data={"sources": len(hits), "approx_tokens": len(system) // 4})
            for e in tracer.drain():
                yield sse({"trace": e})
            if sources:
                yield sse({"sources": sources})

            tracer.start("llm", "LLM", settings.llm_model)
            yield sse({"trace": tracer.drain()[-1]})
            chunks, chars, first = 0, 0, None
            try:
                async for chunk in request.app.state.llm.stream(system, messages):
                    if first is None:
                        first = tracer.now()
                        tracer.progress("llm", "first token")
                        for e in tracer.drain():
                            yield sse({"trace": e})
                    chunks += 1
                    chars += len(chunk)
                    yield sse({"delta": chunk})
                tracer.end("llm", detail=f"{chunks} chunks, {chars} chars",
                           data={"model": settings.llm_model, "chunks": chunks, "chars": chars,
                                 "ttft_ms": first})
                for e in tracer.drain():
                    yield sse({"trace": e})
                yield "data: [DONE]\n\n"
            except LLMError as exc:
                tracer.end("llm", "error", "model call failed")
                for e in tracer.drain():
                    yield sse({"trace": e})
                yield sse({"error": str(exc)})

        return StreamingResponse(agent_events() if use_agent else events(), media_type="text/event-stream",
                                 headers={"X-Accel-Buffering": "no"})

    if mcp_asgi is not None:
        # Exactly ONE path, not a catch-all mount at "/": a root mount would swallow every route added after it
        # (e.g. static files in a single-container deployment). The guard is a plain ASGI app, so Route forwards it
        # untouched and the MCP app sees the original "/mcp" path it is configured for.
        app.add_route("/mcp", mcp_asgi, include_in_schema=False)
    return app


app = create_app() if __name__ != "__main__" else None
