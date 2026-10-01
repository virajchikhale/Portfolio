import pytest

from app.config import Settings
from app.rag.chunker import Chunk, load_chunks
from app.rag.lexical import LexicalIndex
from app.rag.retriever import retrieve
from app.rag.store import InMemoryStore


@pytest.fixture(scope="module")
def ix():
    return LexicalIndex(load_chunks("data", exclude={"core.md"}))


@pytest.mark.parametrize("q,source", [
    ("What did he do at Inorbvict?", "experience.md"),
    ("Tell me about Reva Tech", "experience.md"),
    ("What is ZCOER?", "experience.md"),
    ("What is PHPMailer used for?", "attendance-system.md"),
    ("Where is Nalanda school?", "education.md"),
    ("What programming languages does he know?", "skills.md"),
])
def test_rare_terms_are_found(ix, q, source):
    # BM25 favours short chunks, so the best-matching chunk may be a neighbour; the right source must be in the top 3
    assert source in {c.source for c, _ in ix.search(q, 3)}


@pytest.mark.parametrize("q", [
    "What is the weather in Paris today?",   # "weather" occurs in the farming project but covers 1/3 of the question
    "capital of France weather forecast",
    "Who won the football world cup?",
    "Explain quantum computing",
    "Give me a good pizza recipe",
])
def test_unrelated_or_common_word_questions_match_nothing(ix, q):
    assert ix.search(q, 3) == []


def test_empty_corpus_and_empty_query():
    assert LexicalIndex([]).search("anything", 3) == []
    assert LexicalIndex(load_chunks("data")).search("the of and", 3) == []


class OrthogonalEmbedder:
    """Dense channel that finds nothing: proves the keyword channel alone can rescue a rare-name question."""
    dim = 4

    async def embed_documents(self, texts):
        return [[1.0, 0, 0, 0] for _ in texts]

    async def embed_query(self, text):
        return [0, 1.0, 0, 0]


async def test_hybrid_rescues_what_dense_misses_and_labels_provenance(ix):
    s = Settings(vector_store="memory", embedding_provider="fake", rag_min_score=0.5, _env_file=None)
    store = InMemoryStore()
    for i, c in enumerate(load_chunks("data", exclude={"core.md"})):
        await store.upsert([(str(i), c, [1.0, 0, 0, 0])])
    hits = await retrieve(store, OrthogonalEmbedder(), "What did he do at Inorbvict?", s, ix)
    assert hits and all(h.via == "lexical" for h in hits)
    assert hits[0].chunk.source in {"experience.md", "skills.md"}
    # and without the lexical index the same question retrieves nothing (the bug this channel fixes)
    assert await retrieve(store, OrthogonalEmbedder(), "What did he do at Inorbvict?", s, None) == []
    # off-topic stays empty even with the keyword channel on
    assert await retrieve(store, OrthogonalEmbedder(), "What is the weather in Paris today?", s, ix) == []


def test_chunk_hashability_used_for_fusion():
    a, b = Chunk("a.md", "T", "H", "x"), Chunk("a.md", "T", "H", "x")
    assert a == b and hash(a) == hash(b)
