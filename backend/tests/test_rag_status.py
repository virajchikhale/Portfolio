"""When retrieval cannot start, the app must (a) keep chatting, (b) say WHY in /api/health and the trace, with a fix."""
import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.rag.embeddings import RAG_HINTS


def S(**kw):
    base = dict(llm_provider="fake", _env_file=None, rate_limit_per_minute=100)
    return Settings(**{**base, **kw})


def health(c):
    return c.get("/api/health").json()["rag"]


def skipped_trace(c):
    r = c.post("/api/chat", json={"message": "Where did he study?"})
    assert r.status_code == 200 and '"delta"' in r.text  # chat still answers
    tr = [json.loads(ln[6:])["trace"] for ln in r.text.splitlines() if ln.startswith('data: {"trace"')]
    return {e["id"]: e for e in tr if e["phase"] == "end"}


def test_healthy_has_no_reason():
    with TestClient(create_app(S(vector_store="memory", embedding_provider="fake"))) as c:
        assert health(c) == {"enabled": True, "chunks": health(c)["chunks"], "reason": None}


@pytest.mark.parametrize("settings,reason", [
    (dict(vector_store="pgvector", database_url=None, embedding_provider="fake"), "database_url_missing"),
    (dict(vector_store="memory", embedding_provider="gemini", gemini_api_key=None), "embedding_key_missing"),
])
def test_failure_reason_in_health_and_trace_with_actionable_hint(settings, reason):
    with TestClient(create_app(S(**settings))) as c:
        h = health(c)
        assert h["enabled"] is False and h["reason"] == reason
        end = skipped_trace(c)
        for stage in ("embed", "dense", "keyword", "fuse"):
            assert end[stage]["status"] == "skipped"
            assert end[stage]["data"]["reason"] == reason
            assert end[stage]["data"]["hint"] == RAG_HINTS[reason]


def test_unreachable_database_reports_database_unreachable(monkeypatch):
    async def instant(*a, **k):
        return None

    monkeypatch.setattr("app.rag.store.asyncio.sleep", instant)  # do not wait 10 s for the retries
    s = S(vector_store="pgvector", embedding_provider="fake", database_url="postgresql://u:p@127.0.0.1:1/db")
    with TestClient(create_app(s)) as c:
        assert health(c)["reason"] == "database_unreachable"
        assert skipped_trace(c)["fuse"]["data"]["hint"] == RAG_HINTS["database_unreachable"]


def test_every_reason_code_has_a_hint():
    for code in ("database_url_missing", "database_unreachable", "dimension_mismatch", "embedding_model_unavailable",
                 "embedding_dim_mismatch", "embedding_key_missing", "embedding_failed", "startup_failed", "unknown"):
        assert RAG_HINTS[code] and "password" not in RAG_HINTS[code].lower().replace("postgres_password", "")


def test_reason_and_hint_never_leak_secrets():
    s = S(vector_store="pgvector", embedding_provider="fake", database_url="postgresql://user:SuperSecret9@127.0.0.1:1/db")
    import app.rag.store as store_mod

    async def instant(*a, **k):
        return None

    store_mod.asyncio.sleep, orig = instant, store_mod.asyncio.sleep
    try:
        with TestClient(create_app(s)) as c:
            dump = json.dumps(c.get("/api/health").json()) + json.dumps(skipped_trace(c))
    finally:
        store_mod.asyncio.sleep = orig
    assert "SuperSecret9" not in dump and "postgresql://" not in dump


def test_local_provider_ignores_a_stale_embedding_dim(caplog):
    import logging

    with caplog.at_level(logging.WARNING):
        s = Settings(embedding_provider="local", embedding_dim=768, _env_file=None)
    assert s.embedding_dim == 384 and "Ignoring EMBEDDING_DIM=768" in caplog.text


def test_gemini_provider_keeps_an_explicit_dimension():
    assert Settings(embedding_provider="gemini", embedding_dim=1536, _env_file=None).embedding_dim == 1536


def test_overriding_min_score_far_above_the_calibrated_value_is_flagged(caplog):
    import logging

    with caplog.at_level(logging.WARNING):
        s = Settings(embedding_provider="local", rag_min_score=0.35, _env_file=None)
    assert s.rag_min_score == 0.35 and "RAG_MIN_SCORE=0.35" in caplog.text
    with caplog.at_level(logging.WARNING):
        caplog.clear()
        Settings(embedding_provider="local", rag_min_score=0.23, _env_file=None)
    assert "RAG_MIN_SCORE" not in caplog.text  # a small, deliberate tweak is fine
