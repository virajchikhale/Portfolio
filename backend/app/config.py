"""Runtime configuration. Everything comes from environment variables (or a local .env).

Secrets are SecretStr so they are masked in repr()/logs/tracebacks.
"""
import logging
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)

_DEFAULT_MODEL = {
    "local": "sentence-transformers/all-MiniLM-L6-v2",
    "gemini": "gemini-embedding-001",
    "fake": "fake-hash",
}
# Cosine scores are NOT comparable across models, so the "I have no source for this" cutoff is per model.
# Midpoints of the clean gap measured with scripts/eval_retrieval.py on evals/retrieval_set.json (re-run after
# changing the corpus or model). Models not listed fall back to 0.35: calibrate them before trusting it.
_DEFAULT_MIN_SCORE = {
    "sentence-transformers/all-minilm-l6-v2": 0.22,
    "nomic-ai/nomic-embed-text-v1.5-q": 0.52,
    "thenlper/gte-base": 0.77,
}
_FALLBACK_MIN_SCORE = 0.35
_DEFAULT_DIM = {"local": 384, "gemini": 768, "fake": 768}  # MiniLM = 384; Gemini is truncated to 768


def _local_model_dim(model: str) -> int:
    """Vector size of a fastembed model, so EMBEDDING_MODEL alone is enough to switch models."""
    try:
        from fastembed import TextEmbedding

        for m in TextEmbedding.list_supported_models():
            if m["model"].lower() == model.lower():
                return int(m["dim"])
    except ImportError:
        log.warning("fastembed is not installed; assuming %d dims for local model %s", _DEFAULT_DIM["local"], model)
    return _DEFAULT_DIM["local"]


class Settings(BaseSettings):
    # Later files win: backend/.env overrides the repo-root .env, so both `uvicorn` from backend/ and docker work.
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), env_file_encoding="utf-8", extra="ignore")

    # ── LLM (provider is swappable via env; Gemini is the default) ──────────
    llm_provider: Literal["gemini", "fake"] = "gemini"
    llm_model: str = "gemini-2.5-flash"  # override with LLM_MODEL; check current names in Google AI docs
    gemini_api_key: SecretStr | None = None
    llm_max_output_tokens: int = Field(1024, ge=16, le=8192)
    # Gemini 'thinking' budget. 0 = off (fast, cheap, no empty answers). -1 = don't send (model default;
    # required for models that cannot disable thinking, e.g. Pro).
    llm_thinking_budget: int = Field(0, ge=-1)
    # Gemini 3.x replaced the budget with a level (https://ai.google.dev/gemini-api/docs/thinking). When set it is
    # sent INSTEAD of the budget (the API rejects both together).
    llm_thinking_level: Literal["minimal", "low", "medium", "high"] | None = None
    llm_temperature: float = Field(0.3, ge=0, le=2)
    llm_timeout_s: float = Field(60, gt=0)  # pipeline mode: wall-clock limit for the whole model call

    # ── RAG (retrieval) ─────────────────────────────────────────────────────
    # local = fastembed (ONNX, CPU, no API/quota, content never leaves your machine); gemini = hosted; fake = tests
    embedding_provider: Literal["local", "gemini", "fake"] = "local"
    embedding_model: str | None = None  # default per provider: see _DEFAULT_MODEL / _DEFAULT_DIM below
    embedding_dim: int | None = Field(None, ge=8, le=2000)  # default per provider; HNSW supports up to 2000 dims
    embedding_cache_dir: str = "models"  # where the local model files live (baked into the Docker image)
    vector_store: Literal["pgvector", "memory"] = "pgvector"
    database_url: SecretStr | None = None  # postgresql://user:pass@host:5432/db (pass must be URL-safe)
    data_dir: str = "data"
    ingest_on_startup: bool = True  # embeds only new/changed chunks, so restarts are cheap
    rag_top_k: int = Field(4, ge=1, le=20)
    rag_min_score: float | None = Field(None, ge=0, le=1)  # default per model; tune with scripts/eval_retrieval.py

    # ── Agent mode (tool-calling loop, see app/agent) ────────────────────────
    agent_enabled: bool = True
    # If the agent fails before answering anything, answer with the fast pipeline instead of showing an error.
    agent_fallback: bool = True
    agent_max_steps: int = Field(4, ge=1, le=10)  # model calls per question (each may request tools)
    agent_max_tool_calls: int = Field(6, ge=1, le=20)  # tool executions per question
    agent_tool_timeout_s: float = Field(15, gt=0)
    agent_timeout_s: float = Field(60, gt=0)  # whole run

    # ── MCP server (see app/mcp_server.py): the same read-only tools for external MCP clients ──────────────
    mcp_http_enabled: bool = True  # mounts the streamable-HTTP endpoint at /mcp
    mcp_auth_token: SecretStr | None = None  # when set, /mcp requires "Authorization: Bearer <token>"
    mcp_rate_limit_per_minute: int = Field(60, ge=1)  # per client IP; a single MCP interaction is several HTTP calls
    mcp_rate_limit_per_day: int = Field(2000, ge=1)
    mcp_allowed_hosts: str = ""  # comma-separated Host headers accepted behind a real hostname, e.g. "api.example.com"

    # ── Telemetry: one small summary row per run, for the activity view and for debugging ───────────────────
    # Stored WITHOUT the visitor's question or the answer unless TELEMETRY_STORE_QUESTIONS=true (privacy by default).
    telemetry_enabled: bool = True
    telemetry_store_questions: bool = False
    run_retention_days: int = Field(30, ge=1, le=365)
    admin_token: SecretStr | None = None  # enables GET /api/admin/runs (Bearer); unset = the endpoint does not exist
    read_rate_limit_per_minute: int = Field(60, ge=1)  # per client IP, for the read-only stats endpoints

    # ── Guardrails / abuse protection ───────────────────────────────────────
    max_input_chars: int = Field(800, ge=1)
    max_history_turns: int = Field(6, ge=0)
    rate_limit_per_minute: int = Field(8, ge=1)  # per client IP
    rate_limit_per_day: int = Field(60, ge=1)  # per client IP
    daily_global_request_budget: int = Field(1500, ge=1)  # hard cap across all visitors
    # Only honour X-Forwarded-For when the app really sits behind your own proxy.
    trust_proxy_headers: bool = False

    # ── HTTP ────────────────────────────────────────────────────────────────
    # Comma-separated list of allowed browser origins, e.g. "https://you.github.io,http://localhost:8080"
    cors_origins: str = ""
    skills_dir: str = "skills"
    environment: Literal["dev", "prod"] = "dev"

    @model_validator(mode="after")
    def _embedding_defaults(self):
        # Changing provider/model changes the vector size: leave both unset to get a consistent pair.
        if self.embedding_model is None:
            self.embedding_model = _DEFAULT_MODEL[self.embedding_provider]
        if self.embedding_provider == "local":
            # A local model's vector size is a fact about the model, not a setting. A stale EMBEDDING_DIM left in
            # .env from an earlier provider (e.g. 768 for Gemini) would otherwise silently switch retrieval off.
            model_dim = _local_model_dim(self.embedding_model)
            if self.embedding_dim not in (None, model_dim):
                log.warning("Ignoring EMBEDDING_DIM=%s: %s produces %d-dim vectors. Remove EMBEDDING_DIM from .env.",
                            self.embedding_dim, self.embedding_model, model_dim)
            self.embedding_dim = model_dim
        elif self.embedding_dim is None:
            self.embedding_dim = _DEFAULT_DIM[self.embedding_provider]
        calibrated = _DEFAULT_MIN_SCORE.get(self.embedding_model.lower())
        if self.rag_min_score is None:
            self.rag_min_score = calibrated if calibrated is not None else _FALLBACK_MIN_SCORE
        elif calibrated is not None and self.rag_min_score > calibrated + 0.05:
            log.warning(
                "RAG_MIN_SCORE=%s is much higher than the calibrated %s for %s: relevant questions may retrieve "
                "nothing. Remove RAG_MIN_SCORE from .env unless you tuned it.",
                self.rag_min_score, calibrated, self.embedding_model)
        return self

    @field_validator("cors_origins")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip() and o.strip() != "*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
