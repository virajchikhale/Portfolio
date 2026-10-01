"""Tests with the REAL local model (fastembed/ONNX). Opt-in because they need the model files:

    RUN_LOCAL_EMBEDDING_TESTS=1 EMBEDDING_CACHE_DIR=/path/to/models pytest tests/test_local_embedder.py
(CI sets this and caches the model directory.)
"""
import json
import math
import os
from pathlib import Path

import pytest

from app.config import Settings
from app.rag.chunker import load_chunks
from app.rag.embeddings import LocalEmbedder, RAGError, build_embedder
from app.rag.ingest import ingest
from app.rag.lexical import LexicalIndex
from app.rag.retriever import retrieve
from app.rag.store import InMemoryStore

pytestmark = pytest.mark.skipif(not os.environ.get("RUN_LOCAL_EMBEDDING_TESTS"),
                                reason="RUN_LOCAL_EMBEDDING_TESTS not set")
CACHE = os.environ.get("EMBEDDING_CACHE_DIR", "models")


def S(**kw):
    kw.setdefault("embedding_cache_dir", CACHE)
    return Settings(llm_provider="fake", vector_store="memory", embedding_provider="local", _env_file=None, **kw)


@pytest.fixture(scope="module")
def embedder():
    return build_embedder(S())


async def test_vectors_are_normalized_and_right_size(embedder):
    vs = await embedder.embed_documents(["hello world", "another sentence"])
    assert len(vs) == 2 and all(len(v) == 384 for v in vs)
    assert all(abs(math.sqrt(sum(x * x for x in v)) - 1) < 1e-4 for v in vs)


async def test_semantic_not_just_keyword_matching(embedder):
    docs = await embedder.embed_documents(["He studied Artificial Intelligence at university.", "He likes trekking."])
    q = await embedder.embed_query("Where did he go to college?")  # no shared words with the doc
    sims = [sum(a * b for a, b in zip(q, d, strict=True)) for d in docs]
    assert sims[0] > sims[1]


def test_stale_embedding_dim_in_env_is_ignored_for_local_models():
    """A leftover EMBEDDING_DIM=768 (from a Gemini setup) used to silently switch retrieval off."""
    s = S(embedding_dim=768)
    assert s.embedding_dim == 384
    assert LocalEmbedder(s)  # loads fine


def test_embedder_still_rejects_a_dimension_that_disagrees_with_the_model():
    s = S()
    s.embedding_dim = 768  # bypass the validator to prove the safety net inside the embedder itself
    with pytest.raises(RAGError, match="EMBEDDING_DIM"):
        LocalEmbedder(s)


def test_missing_model_is_a_clean_ragerror(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    with pytest.raises(RAGError, match="could not be loaded"):
        LocalEmbedder(S(embedding_model="BAAI/bge-small-en-v1.5", embedding_cache_dir=str(tmp_path)))


def test_defaults_follow_model():
    s = S()
    assert (s.embedding_model, s.embedding_dim, s.rag_min_score) == ("sentence-transformers/all-MiniLM-L6-v2", 384, 0.22)
    assert S(embedding_model="BAAI/bge-base-en-v1.5").embedding_dim == 768  # derived from the model, no manual dim


async def test_retrieval_quality_gate_on_real_corpus(embedder):
    """Regression guard on the full hybrid retriever: in-scope questions (incl. rare proper nouns like
    "Inorbvict") find their source; off-topic ones retrieve nothing."""
    s = S()
    store = InMemoryStore()
    await ingest(s, store, embedder)
    lex = LexicalIndex(load_chunks(s.data_dir, exclude={"core.md"}))
    cases = json.loads((Path(__file__).parents[1] / "evals" / "retrieval_set.json").read_text())
    missed, leaked = [], []
    for c in cases:
        hits = await retrieve(store, embedder, c["q"], s, lex)
        if c["expect"] and not any(h.chunk.source in c["expect"] for h in hits):
            missed.append(c["q"])
        if not c["expect"] and hits:
            leaked.append(c["q"])
    in_scope = sum(1 for c in cases if c["expect"])
    assert len(missed) / in_scope <= 0.1, f"recall dropped, missed: {missed}"
    assert not leaked, f"off-topic questions retrieved sources: {leaked}"
