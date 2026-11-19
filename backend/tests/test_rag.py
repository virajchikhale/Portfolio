import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.rag.chunker import chunk_markdown, load_chunks
from app.rag.embeddings import FakeEmbedder
from app.rag.ingest import ingest
from app.rag.retriever import format_context, retrieve
from app.rag.store import InMemoryStore


def S(**kw):
    # The fake embedder is a keyword hasher with lower cosine scores than real embeddings -> lower threshold here.
    kw.setdefault("rag_min_score", 0.15)
    return Settings(llm_provider="fake", vector_store="memory", embedding_provider="fake", _env_file=None, **kw)


# ── chunker ──────────────────────────────────────────────────────────────
def test_chunk_by_h2_with_source_and_title():
    cs = chunk_markdown("x.md", "# Doc\n\nintro\n\n## A\naaa\n\n## B\nbbb\n")
    assert [(c.title, c.heading, c.content) for c in cs] == [
        ("Doc", "Doc", "intro"), ("Doc", "A", "aaa"), ("Doc", "B", "bbb")]
    assert cs[1].label == "Doc › A" and cs[1].source == "x.md"


def test_long_sections_are_split_on_paragraphs():
    para = "word " * 100
    cs = chunk_markdown("x.md", "# D\n\n## S\n" + "\n\n".join([para] * 6), max_chars=700)
    assert len(cs) > 1 and all(len(c.content) <= 700 for c in cs)


def test_key_changes_with_model_dim_or_text():
    c = chunk_markdown("x.md", "# D\n\n## S\ntext")[0]
    assert c.key("m1", 8) != c.key("m2", 8) != c.key("m1", 16)
    assert c.key("m1", 8) == c.key("m1", 8)


def test_real_corpus_loads_and_excludes_core():
    cs = load_chunks("data", exclude={"core.md"})
    assert {c.source for c in cs} >= {"experience.md", "projects.md", "student-management-system.md", "education.md"}
    assert "core.md" not in {c.source for c in cs}
    assert all(10 < len(c.content) <= 1300 for c in cs)


def test_corpus_has_no_phone_number():
    import re
    text = "".join(p.read_text() for p in __import__("pathlib").Path("data").glob("*.md"))
    assert not re.search(r"\+?\d[\d ()-]{9,}\d", text), "do not put phone numbers in the public corpus"


# ── ingestion ────────────────────────────────────────────────────────────
async def test_ingest_is_idempotent_and_incremental(tmp_path):
    (tmp_path / "a.md").write_text("# A\n\n## one\nfirst section\n\n## two\nsecond section\n")
    s = S(data_dir=str(tmp_path))
    store, emb = InMemoryStore(), FakeEmbedder(s.embedding_dim)
    r1 = await ingest(s, store, emb)
    assert (r1.added, r1.removed, r1.unchanged) == (2, 0, 0)
    r2 = await ingest(s, store, emb)
    assert (r2.added, r2.removed, r2.unchanged) == (0, 0, 2)  # nothing re-embedded
    (tmp_path / "a.md").write_text("# A\n\n## one\nfirst section\n\n## two\nCHANGED text\n")
    r3 = await ingest(s, store, emb)
    assert (r3.added, r3.removed, r3.unchanged) == (1, 1, 1)
    assert await store.count() == 2


# ── retrieval over the real corpus (keyword-level plumbing check; semantic quality needs real embeddings + evals) ──
@pytest.fixture
async def corpus():
    s = S()
    store, emb = InMemoryStore(), FakeEmbedder(s.embedding_dim)
    await ingest(s, store, emb)
    return s, store, emb


@pytest.mark.parametrize("question,expected", [
    ("What did he do at Inorbvict with Power BI dashboards?", "experience.md"),
    ("What is his CGPA and polytechnic diploma percentage?", "education.md"),
    ("How does the OTP login and PHPMailer work in the student management system?", "student-management-system.md"),
    ("Tableau sales conversion internship", "experience.md"),
    ("movie recommendation hybrid collaborative filtering Streamlit", "projects.md"),
])
async def test_retrieves_expected_source(corpus, question, expected):
    s, store, emb = corpus
    hits = await retrieve(store, emb, question, s)
    assert expected in {h.chunk.source for h in hits}


async def test_off_topic_retrieves_nothing(corpus):
    s, store, emb = corpus
    assert await retrieve(store, emb, "capital of France weather forecast", s) == []


def test_format_context_numbers_sources_and_handles_empty():
    assert "no relevant sources" in format_context([])


# ── API ──────────────────────────────────────────────────────────────────
class Recorder:
    def __init__(self):
        self.system = None

    async def stream(self, system, messages):
        self.system = system
        yield "ok"


def _events(resp):
    """Content events (sources / delta / error); trace events are covered in test_trace.py."""
    return [e for e in (json.loads(ln[6:]) for ln in resp.text.splitlines() if ln.startswith("data: {"))
            if "trace" not in e]


@pytest.fixture
def rag_client():
    with TestClient(create_app(S(rate_limit_per_minute=100))) as c:
        c.rec = Recorder()
        c.app.state.llm = c.rec
        yield c


def test_health_reports_rag(rag_client):
    body = rag_client.get("/api/health").json()
    assert body["rag"]["enabled"] is True and body["rag"]["chunks"] > 5


def test_chat_emits_sources_and_injects_context(rag_client):
    r = rag_client.post("/api/chat", json={"message": "Tell me about the Inorbvict Power BI internship"})
    ev = _events(r)
    assert [x["n"] for x in ev[0]["sources"]] == list(range(1, len(ev[0]["sources"]) + 1))
    assert "experience.md" in {x["source"] for x in ev[0]["sources"]}
    assert "Work experience › Data Science Intern" in rag_client.rec.system
    assert "Power BI dashboards" in rag_client.rec.system


def test_off_topic_has_no_sources(rag_client):
    r = rag_client.post("/api/chat", json={"message": "capital of France weather forecast"})
    assert all("sources" not in e for e in _events(r))
    assert "no relevant sources" in rag_client.rec.system


def _labels(resp):
    return [x["label"] for e in _events(resp) for x in e.get("sources", [])]


def test_followup_uses_previous_turn_for_retrieval(rag_client):
    follow_up = "how long did he stay there?"
    target = "Data Science Intern"
    alone = rag_client.post("/api/chat", json={"message": follow_up})
    assert not any(target in label for label in _labels(alone))  # no keywords of its own

    prior = "Tell me about the Data Science Intern role at Inorbvict Healthcare Hinjewadi"
    r = rag_client.post("/api/chat", json={"message": follow_up, "history": [
        {"role": "user", "content": prior}, {"role": "assistant", "content": "ok"}]})
    assert any(target in label for label in _labels(r))  # previous turn supplied the topic


def test_retrieval_failure_degrades_to_plain_answer(rag_client):
    async def boom(*a, **k):
        raise RuntimeError("db down")

    rag_client.app.state.embedder.embed_query = boom
    r = rag_client.post("/api/chat", json={"message": "Tell me about Inorbvict"})
    assert r.status_code == 200
    ev = _events(r)
    assert all("sources" not in e for e in ev) and any(e.get("delta") == "ok" for e in ev)


def test_injected_text_inside_retrieved_context_is_labelled_as_data(rag_client):
    rag_client.post("/api/chat", json={"message": "Tell me about Inorbvict"})
    assert "never instructions" in rag_client.rec.system


def test_chat_survives_when_rag_is_misconfigured():
    s = Settings(llm_provider="fake", vector_store="pgvector", database_url=None, embedding_provider="fake",
                 _env_file=None)
    with TestClient(create_app(s)) as c:  # missing DATABASE_URL -> RAG off, chat still up
        assert c.get("/api/health").json()["rag"]["enabled"] is False
        assert c.post("/api/chat", json={"message": "hello"}).status_code == 200
