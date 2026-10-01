import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.agent import build_system_prompt, load_core
from app.config import Settings, get_settings
from app.llm.base import LLMError, Message
from app.llm.factory import build_llm
from app.rag.chunker import load_chunks
from app.rag.embeddings import RAGError, build_embedder
from app.rag.ingest import CORE_FILE, ingest
from app.rag.lexical import LexicalIndex
from app.rag.retriever import format_context, retrieve
from app.rag.store import build_store
from app.security.guardrails import GuardrailViolation, check_input, looks_like_injection, sanitize
from app.security.rate_limit import RateLimiter, client_ip
from app.skills_engine.loader import load_skills

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


class Turn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(max_length=4000)  # hard cap before our own (smaller) guardrail
    history: list[Turn] = Field(default_factory=list, max_length=50)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.limiter = RateLimiter(settings)
        app.state.skills = load_skills(settings.skills_dir)
        app.state.system_prompt = build_system_prompt(load_core(settings.data_dir), app.state.skills)
        app.state.llm = build_llm(settings)  # fails fast if the key is missing
        app.state.rag = None
        app.state.embedder = None
        app.state.lexical = None
        store = None
        try:
            store = build_store(settings)
            embedder = build_embedder(settings)
            await store.init()
            if settings.ingest_on_startup:
                await ingest(settings, store, embedder)
            app.state.rag, app.state.embedder = store, embedder
            app.state.lexical = LexicalIndex(load_chunks(settings.data_dir, exclude={CORE_FILE}))
        except RAGError:
            # Misconfiguration (missing DATABASE_URL, dim mismatch...) must be loud, not silent.
            log.exception("RAG disabled: configuration error")
        except Exception:
            # Chat stays up (answers from core facts only) even if the DB / embeddings are down at boot.
            log.exception("RAG disabled: vector store or embeddings unavailable at startup")
        try:
            yield
        finally:
            if store is not None:
                await store.close()

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
            "rag": {"enabled": rag is not None, "chunks": chunks},
        }

    @app.post("/api/chat")
    async def chat(body: ChatRequest, request: Request):
        request.app.state.limiter.check(client_ip(request, settings))
        text = check_input(body.message, settings)
        history: list[Message] = []
        for t in body.history[-settings.max_history_turns :]:
            if t.role == "user":
                history.append(Message("user", check_input(t.content, settings)))
                continue
            # Clients can forge "assistant" turns, so screen them too; drop (don't fail) if suspicious.
            if not looks_like_injection(t.content):
                history.append(Message("assistant", sanitize(t.content)[: settings.max_input_chars * 3]))
        messages = [*history, Message("user", text)]

        # Retrieval. A follow-up like "tell me more" has no keywords, so include the previous user turn.
        prior_user = next((m.content for m in reversed(history) if m.role == "user"), "")
        query = f"{prior_user} {text}".strip()[: settings.max_input_chars * 2]
        hits = []
        if request.app.state.rag is not None:
            try:
                hits = await retrieve(
                    request.app.state.rag, request.app.state.embedder, query, settings, request.app.state.lexical
                )
            except Exception:
                log.exception("retrieval failed; answering from core facts only")
        system = f"{request.app.state.system_prompt}\n\n{format_context(hits)}"
        sources = [{"n": i, "label": h.chunk.label, "source": h.chunk.source} for i, h in enumerate(hits, 1)]

        async def events():
            try:
                if sources:
                    yield f"data: {json.dumps({'sources': sources})}\n\n"
                async for chunk in request.app.state.llm.stream(system, messages):
                    yield f"data: {json.dumps({'delta': chunk})}\n\n"
                yield "data: [DONE]\n\n"
            except LLMError as exc:
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    return app


app = create_app() if __name__ != "__main__" else None
