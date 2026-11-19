import hmac
import json
import logging
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.agent import build_agent_prompt, build_system_prompt, load_core
from app.agent.tools import SourceBook, ToolContext, build_tools
from app.bootstrap import start_rag
from app.chat import stream_turn
from app.config import Settings, get_settings
from app.llm.base import Message
from app.llm.factory import build_llm
from app.mcp_server import build_mcp_server, http_app
from app.rag.chunker import load_chunks
from app.rag.ingest import CORE_FILE
from app.rag.store import PgVectorStore
from app.security.guardrails import GuardrailViolation, check_input, looks_like_injection, sanitize
from app.security.rate_limit import RateLimiter, client_ip
from app.skills_engine.loader import load_skills
from app.telemetry import MemoryRunStore, Outcome, PgRunStore, Telemetry, summarize
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


async def _start_telemetry(settings: Settings, rag) -> Telemetry | None:
    """Postgres when the vector store is Postgres (survives restarts); otherwise a bounded in-memory store."""
    if not settings.telemetry_enabled:
        return None
    store = MemoryRunStore()
    if isinstance(rag.store, PgVectorStore) and rag.store.pool is not None:
        try:
            pg = PgRunStore(rag.store.pool)
            await pg.init()
            store = pg
        except Exception:
            log.exception("could not set up the Postgres run store; keeping run statistics in memory")
    telemetry = Telemetry(store, settings)
    await telemetry.prune()
    return telemetry


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
        app.state.telemetry = await _start_telemetry(settings, rag)
        async with AsyncExitStack() as stack:
            if mcp is not None:
                await stack.enter_async_context(mcp.session_manager.run())
            try:
                yield
            finally:
                if app.state.telemetry is not None:
                    await app.state.telemetry.drain()
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
        st = request.app.state

        def record(outcome: str, mode: str, out: Outcome | None = None) -> None:
            if st.telemetry is None:
                return
            out = out or Outcome()
            st.telemetry.record_nowait(summarize(
                tracer.events, outcome=outcome, mode=mode, requested=body.mode, model=settings.llm_model,
                question=body.message, sources=out.sources, ttft_ms=out.first_delta_ms,
                store_question=settings.telemetry_store_questions))

        def blocked(stage: str, detail: str, payload: dict, status: int, headers: dict | None = None):
            # The trace goes back with the error so the UI can show WHERE the request was stopped.
            tracer.end(stage, "blocked", detail)
            record("blocked", "pipeline")
            return JSONResponse({**payload, "trace": tracer.drain()}, status_code=status, headers=headers)

        tracer.start("rate_limit", "Rate limit")
        try:
            st.limiter.check(client_ip(request, settings))
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

        # Retrieval. A follow-up like "tell me more" has no keywords, so include the previous user turn.
        prior_user = next((m.content for m in reversed(history) if m.role == "user"), "")
        query = f"{prior_user} {text}".strip()[: settings.max_input_chars * 2]

        # Agent mode costs up to agent_max_steps model calls. If the daily budget cannot absorb that, quietly use
        # the cheap pipeline instead (and say so in the trace) rather than failing the visitor's question.
        use_agent = body.mode == "agent" and settings.agent_enabled and st.limiter.can_afford(
            settings.agent_max_steps - 1)
        note = None
        if body.mode == "agent" and not use_agent:
            note = ("agent mode is disabled" if not settings.agent_enabled
                    else "daily budget low: using the fast pipeline")
        mode = "agent" if use_agent else "pipeline"
        tracer.meta(mode=mode, requested=body.mode, note=note)

        def sse(obj) -> str:
            return f"data: {json.dumps(obj)}\n\n"

        async def stream():
            out, completed = Outcome(), False
            try:
                for e in tracer.drain():
                    yield sse({"trace": e})
                async for item in stream_turn(st, settings, use_agent=use_agent, history=history, text=text,
                                              query=query, tracer=tracer):
                    out.observe(item, tracer.now())
                    yield sse(item)
                completed = True
                if out.error is None:
                    yield "data: [DONE]\n\n"
            finally:
                # Runs on normal completion AND when the visitor leaves mid-answer (generator closed/cancelled).
                final_mode = out.mode or mode
                record(out.classify(completed), final_mode, out)
                if use_agent:  # the extra model calls were really made, even if the visitor never saw the answer
                    steps = sum(1 for e in tracer.events if e["phase"] == "start" and e["id"].startswith("step_"))
                    st.limiter.charge(steps - 1)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    # ── read-only statistics (aggregates only: no questions, no answers, nothing per visitor) ───────────
    read_limiter = RateLimiter(settings.model_copy(update={
        "rate_limit_per_minute": settings.read_rate_limit_per_minute, "rate_limit_per_day": 10**9,
        "daily_global_request_budget": 10**9}))

    @app.get("/api/stats")
    async def stats(request: Request, window: str = "24h"):
        read_limiter.check(client_ip(request, settings))
        if request.app.state.telemetry is None:
            return {"enabled": False}
        return {"enabled": True, **await request.app.state.telemetry.stats(window)}

    if settings.admin_token is not None:
        admin_token = settings.admin_token.get_secret_value().strip()

        @app.get("/api/admin/runs")
        async def admin_runs(request: Request, limit: int = 50):
            read_limiter.check(client_ip(request, settings))
            supplied = request.headers.get("authorization", "")
            if not admin_token or not hmac.compare_digest(supplied.encode(), f"Bearer {admin_token}".encode()):
                raise HTTPException(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})
            if request.app.state.telemetry is None:
                return {"runs": []}
            return {"runs": await request.app.state.telemetry.recent(limit)}

    if mcp_asgi is not None:
        # Exactly ONE path, not a catch-all mount at "/": a root mount would swallow every route added after it
        # (e.g. static files in a single-container deployment). The guard is a plain ASGI app, so Route forwards it
        # untouched and the MCP app sees the original "/mcp" path it is configured for.
        app.add_route("/mcp", mcp_asgi, include_in_schema=False)
    return app


app = create_app() if __name__ != "__main__" else None
