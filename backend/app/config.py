"""Runtime configuration. Everything comes from environment variables (or a local .env).

Secrets are SecretStr so they are masked in repr()/logs/tracebacks.
"""
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── LLM (provider is swappable via env; Gemini is the default) ──────────
    llm_provider: Literal["gemini", "fake"] = "gemini"
    llm_model: str = "gemini-2.5-flash"  # override with LLM_MODEL; check current names in Google AI docs
    gemini_api_key: SecretStr | None = None
    llm_max_output_tokens: int = Field(512, ge=16, le=4096)
    llm_temperature: float = Field(0.3, ge=0, le=2)
    llm_timeout_s: float = Field(30, gt=0)

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
