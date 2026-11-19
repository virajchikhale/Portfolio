"""Diagnose retrieval (RAG) end to end, printing the REAL errors the API hides.

    docker compose exec backend python scripts/check_rag.py          # inside the running container
    docker compose run --rm backend python scripts/check_rag.py --fix   # also rebuild the index if it is stale
    cd backend && python scripts/check_rag.py                        # local

Checks, in order: settings -> embedding model -> vector store -> index contents -> sample questions.
Never prints secrets (the database password is masked).
"""
import argparse
import asyncio
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.rag.chunker import load_chunks  # noqa: E402
from app.rag.embeddings import RAG_HINTS, RAGError, build_embedder  # noqa: E402
from app.rag.ingest import CORE_FILE, ingest  # noqa: E402
from app.rag.lexical import LexicalIndex  # noqa: E402
from app.rag.retriever import retrieve  # noqa: E402
from app.rag.store import build_store  # noqa: E402

QUESTIONS = ["Where did he study?", "What did he do at Inorbvict?", "Which BI tools has he used?",
             "What is the capital of Australia?"]


def step(n: int, title: str) -> None:
    print(f"\n[{n}] {title}")


def fail(msg: str, err: Exception | None = None, code: str | None = None) -> int:
    print(f"    FAILED: {msg}")
    if err is not None:
        print(f"    underlying: {type(err).__name__}: {str(err)[:300]}")
    code = code or getattr(err, "code", None)
    if code:
        print(f"    reason: {code}\n    fix:    {RAG_HINTS.get(code, RAG_HINTS['unknown'])}")
    return 1


async def main(fix: bool) -> int:
    s = get_settings()
    step(1, "Settings")
    url = s.database_url.get_secret_value() if s.database_url else None
    masked = re.sub(r"//([^:/@]+):[^@]*@", r"//\1:***@", url) if url else None
    print(f"    vector_store={s.vector_store}  database_url={masked}")
    print(f"    embedding: provider={s.embedding_provider} model={s.embedding_model} dim={s.embedding_dim}")
    print(f"    rag_min_score={s.rag_min_score}  top_k={s.rag_top_k}  cache_dir={s.embedding_cache_dir}")
    files = sorted(Path(s.data_dir).glob("*.md"))
    chunks = load_chunks(s.data_dir, exclude={CORE_FILE})
    print(f"    data: {len(files)} markdown files in '{s.data_dir}' -> {len(chunks)} chunks")
    if not chunks:
        return fail(f"no chunks: is '{s.data_dir}' present in this container?")
    env_file = next((p for p in (Path("../.env"), Path(".env")) if p.exists()), None)
    for name in ("EMBEDDING_DIM", "RAG_MIN_SCORE", "EMBEDDING_MODEL", "EMBEDDING_PROVIDER"):
        raw = [ln for ln in env_file.read_text().splitlines() if ln.startswith(name + "=")] if env_file else []
        if raw:
            print(f"    note: {env_file} sets {raw[0].strip()}: it overrides the built-in default "
                  "(delete the line unless you chose it on purpose)")

    step(2, f"Embedding model ({s.embedding_provider}: {s.embedding_model})")
    try:
        t = time.perf_counter()
        emb = build_embedder(s)
        v = await emb.embed_query("hello")
        print(f"    OK: {len(v)}-dim vector in {(time.perf_counter() - t) * 1000:.0f} ms (incl. model load)")
    except RAGError as e:
        return fail(str(e), e)
    except Exception as e:
        return fail("could not load/call the embedder", e, "embedding_model_unavailable")

    step(3, f"Vector store ({s.vector_store})")
    store = build_store(s)
    try:
        try:
            await store.init()
        except RAGError as e:
            if e.code == "dimension_mismatch" and fix:
                print(f"    index has the wrong size ({e}); --fix: rebuilding")
                await store.init(recreate=True)
            else:
                return fail(str(e), e)
        print("    OK: connected, pgvector extension and table present" if s.vector_store == "pgvector" else "    OK")

        step(4, "Index contents")
        r = await ingest(s, store, emb) if fix or await store.count() == 0 else None
        if r:
            print(f"    ingested: added={r.added} removed={r.removed} unchanged={r.unchanged}")
        n = await store.count()
        print(f"    chunks in store: {n} (expected {len(chunks)})")
        if n != len(chunks):
            print("    !! the index is out of date: run with --fix, or `python -m app.rag.ingest`")

        step(5, "Sample questions through the real hybrid retriever")
        lex = LexicalIndex(chunks)
        bad = 0
        for q in QUESTIONS:
            hits = await retrieve(store, emb, q, s, lex)
            shown = ", ".join(f"{h.chunk.label[:34]} ({h.via} {h.score:.2f})" for h in hits) or "NOTHING"
            print(f"    {q!r:38} -> {shown}")
            if "capital" not in q and not hits:
                bad += 1
        if bad:
            print(f"    !! {bad} in-scope question(s) retrieved nothing: tune RAG_MIN_SCORE "
                  "(`python scripts/eval_retrieval.py`)")
            return 1
        print("\nAll good: retrieval works.")
        return 0
    except RAGError as e:
        return fail(str(e), e)
    except Exception as e:
        return fail("unexpected error", e, "startup_failed")
    finally:
        await store.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="rebuild a stale/mismatched index")
    sys.exit(asyncio.run(main(ap.parse_args().fix)))
