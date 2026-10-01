import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.agent import build_system_prompt, load_profile
from app.config import Settings, get_settings
from app.llm.base import LLMError, Message
from app.llm.factory import build_llm
from app.security.guardrails import GuardrailViolation, check_input, looks_like_injection, sanitize
from app.security.rate_limit import RateLimiter, client_ip
from app.skills_engine.loader import load_skills

logging.basicConfig(level=logging.INFO)


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
        app.state.system_prompt = build_system_prompt(load_profile(), app.state.skills)
        app.state.llm = build_llm(settings)  # fails fast if the key is missing
        yield

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
        return {"status": "ok", "skills": sorted(request.app.state.skills), "provider": settings.llm_provider}

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

        async def events():
            try:
                async for chunk in request.app.state.llm.stream(request.app.state.system_prompt, messages):
                    yield f"data: {json.dumps({'delta': chunk})}\n\n"
                yield "data: [DONE]\n\n"
            except LLMError as exc:
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    return app


app = create_app() if __name__ != "__main__" else None
