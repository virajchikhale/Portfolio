"""Integration tests against a REAL Postgres+pgvector. Skipped unless TEST_DATABASE_URL is set, e.g.
   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/test pytest tests/test_pgvector.py
(CI provides a pgvector service container.)"""
import os

import pytest

from app.config import Settings
from app.rag.chunker import Chunk
from app.rag.embeddings import FakeEmbedder, RAGError
from app.rag.ingest import ingest
from app.rag.retriever import retrieve
from app.rag.store import PgVectorStore

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")

DIM = 16


def S(**kw):
    kw.setdefault("embedding_dim", DIM)
    return Settings(llm_provider="fake", vector_store="pgvector", embedding_provider="fake", database_url=URL,
                    _env_file=None, **kw)


@pytest.fixture
async def store():
    import psycopg

    async with await psycopg.AsyncConnection.connect(URL, autocommit=True) as c:
        await c.execute("DROP TABLE IF EXISTS chunks")
    st = PgVectorStore(S())
    await st.init(retries=1)
    yield st
    await st.close()


def vec(i):
    v = [0.0] * DIM
    v[i] = 1.0
    return v


async def test_upsert_search_orders_by_cosine(store):
    items = [(f"k{i}", Chunk("a.md", "T", f"H{i}", f"content {i}"), vec(i)) for i in range(4)]
    await store.upsert(items)
    hits = await store.search([0.9, 0.1] + [0.0] * (DIM - 2), 3)
    assert [h.chunk.heading for h in hits][:2] == ["H0", "H1"]
    assert hits[0].score > 0.99 and hits[0].score > hits[1].score
    assert await store.count() == 4


async def test_upsert_is_idempotent_and_delete_except(store):
    c = Chunk("a.md", "T", "H", "x")
    await store.upsert([("k1", c, vec(0))])
    await store.upsert([("k1", c, vec(0))])
    assert await store.count() == 1
    await store.upsert([("k2", c, vec(1))])
    assert await store.delete_except({"k2"}) == 1
    assert await store.existing_keys() == {"k2"}


async def test_dimension_mismatch_is_detected(store):
    other = PgVectorStore(S(embedding_dim=32))
    with pytest.raises(RAGError, match="EMBEDDING_DIM"):
        await other.init(retries=1)


async def test_bad_connection_raises_ragerror():
    bad = PgVectorStore(Settings(vector_store="pgvector", database_url="postgresql://x:y@127.0.0.1:1/z",
                                 embedding_dim=DIM, _env_file=None))
    with pytest.raises(RAGError):
        await bad.init(retries=1, delay=0)


async def test_sql_injection_in_content_is_inert(store):
    evil = Chunk("a.md", "T", "H'); DROP TABLE chunks;--", "x'; DROP TABLE chunks;--")
    await store.upsert([("k", evil, vec(0))])
    assert await store.count() == 1
    assert (await store.search(vec(0), 1))[0].chunk.heading.startswith("H'")


async def test_full_ingest_and_retrieval_on_real_corpus(store):
    s = S()
    emb = FakeEmbedder(DIM)
    r1 = await ingest(s, store, emb)
    assert r1.added > 5
    assert (await ingest(s, store, emb)).added == 0
    hits = await retrieve(store, emb, "Inorbvict Power BI dashboards internship", Settings(rag_min_score=0.1, _env_file=None))
    assert "experience.md" in {h.chunk.source for h in hits}


async def test_reset_recreates_table_after_dimension_change(store):
    await store.upsert([("k", Chunk("a.md", "T", "H", "x"), vec(0))])
    other = PgVectorStore(S(embedding_dim=32))
    with pytest.raises(RAGError):
        await other.init(retries=1)
    await other.init(recreate=True, retries=1)  # what `python -m app.rag.ingest --reset` does
    try:
        assert await other.count() == 0
    finally:
        await other.close()


def test_stale_index_with_wrong_dimension_rebuilds_itself_at_startup():
    """The classic footgun: the table was built for another embedding size (e.g. you switched provider).
    Startup must rebuild it from data/*.md instead of leaving retrieval switched off."""
    import psycopg
    from fastapi.testclient import TestClient

    from app.main import create_app

    with psycopg.connect(URL, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS chunks")
        c.execute("CREATE EXTENSION IF NOT EXISTS vector")
        c.execute("CREATE TABLE chunks (key text PRIMARY KEY, source text, title text, heading text, "
                  "content text, embedding vector(16), created_at timestamptz DEFAULT now())")
    s = Settings(llm_provider="fake", vector_store="pgvector", embedding_provider="fake", database_url=URL,
                 embedding_dim=64, _env_file=None)
    with TestClient(create_app(s)) as c:
        rag = c.get("/api/health").json()["rag"]
        assert rag["enabled"] is True and rag["reason"] is None and rag["chunks"] > 5
    with psycopg.connect(URL) as c:
        assert c.execute("SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
                         "WHERE attrelid='chunks'::regclass AND attname='embedding'").fetchone()[0] == "vector(64)"


def test_stale_index_is_not_rebuilt_when_ingest_on_startup_is_off():
    import psycopg
    from fastapi.testclient import TestClient

    from app.main import create_app

    with psycopg.connect(URL, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS chunks")
        c.execute("CREATE EXTENSION IF NOT EXISTS vector")
        c.execute("CREATE TABLE chunks (key text PRIMARY KEY, source text, title text, heading text, "
                  "content text, embedding vector(16), created_at timestamptz DEFAULT now())")
    s = Settings(llm_provider="fake", vector_store="pgvector", embedding_provider="fake", database_url=URL,
                 embedding_dim=64, ingest_on_startup=False, _env_file=None)
    with TestClient(create_app(s)) as c:
        rag = c.get("/api/health").json()["rag"]
        assert rag["enabled"] is False and rag["reason"] == "dimension_mismatch"  # explicit opt-out: stay loud
