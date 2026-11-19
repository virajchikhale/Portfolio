"""Measure retrieval quality for the CONFIGURED embedding model, and recommend RAG_MIN_SCORE.

    python scripts/eval_retrieval.py                              # EMBEDDING_PROVIDER / EMBEDDING_MODEL from env/.env
    EMBEDDING_MODEL=thenlper/gte-base python scripts/eval_retrieval.py   # compare models on the same questions

Runs the real hybrid retriever (dense cosine gate + rare-term keyword channel) over data/*.md with an in-memory
store, against evals/retrieval_set.json:
  * in-scope questions must surface an expected source (recall / MRR),
  * off-topic questions ("expect": []) must retrieve NOTHING (leakage),
  * "kind": "entity" questions name rare proper nouns that small dense models miss; they show the keyword
    channel's contribution and are excluded from the dense-threshold recommendation.
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.rag.chunker import load_chunks  # noqa: E402
from app.rag.embeddings import build_embedder  # noqa: E402
from app.rag.ingest import CORE_FILE, ingest  # noqa: E402
from app.rag.lexical import LexicalIndex  # noqa: E402
from app.rag.retriever import retrieve  # noqa: E402
from app.rag.store import InMemoryStore  # noqa: E402


def first_rank(expect: list[str], hits) -> int | None:
    return next((r for r, h in enumerate(hits, 1) if h.chunk.source in expect), None)


async def main() -> int:
    s = get_settings()
    emb = build_embedder(s)
    store = InMemoryStore()
    await ingest(s, store, emb)
    lex = LexicalIndex(load_chunks(s.data_dir, exclude={CORE_FILE}))
    qs = json.loads((Path(__file__).resolve().parents[1] / "evals" / "retrieval_set.json").read_text())

    print(f"model={s.embedding_model} dim={s.embedding_dim} top_k={s.rag_top_k} RAG_MIN_SCORE={s.rag_min_score}\n")
    in_rows, off_rows = [], []
    for item in qs:
        raw = await store.search(await emb.embed_query(item["q"]), s.rag_top_k)
        final = await retrieve(store, emb, item["q"], s, lex)
        (in_rows if item["expect"] else off_rows).append((item, raw, final))

    print("IN-SCOPE (want an expected source in the final results)")
    ranks, dense_only_found = [], 0
    for item, raw, final in in_rows:
        r = first_rank(item["expect"], final)
        ranks.append(r)
        d = first_rank(item["expect"], [h for h in raw if h.score >= s.rag_min_score])
        dense_only_found += bool(d)
        tag = " [entity]" if item.get("kind") == "entity" else ""
        via = final[0].via if final else "-"
        label = final[0].chunk.label if final else "(nothing retrieved)"
        print(f"  {'✓' if r else '✗'} rank={r or '-'} via={via:7}{tag:10} {item['q']}  -> {label}")

    print("\nOFF-TOPIC (want nothing retrieved)")
    leaked = 0
    for item, raw, final in off_rows:
        leaked += bool(final)
        top = raw[0].score if raw else 0
        label = ", ".join(h.chunk.label[:30] for h in final) or "nothing"
        print(f"  {'✗ LEAK' if final else '✓'}  dense_top={top:.3f}  {item['q']}  -> {label}")

    n = len(in_rows)
    found = sum(1 for r in ranks if r)
    mrr = sum(1 / r for r in ranks if r) / max(n, 1)
    print(f"\nHYBRID      recall@{s.rag_top_k} = {found}/{n}   MRR = {mrr:.2f}   "
          f"off-topic leakage = {leaked}/{len(off_rows)}")
    print(f"DENSE ONLY  recall@{s.rag_top_k} = {dense_only_found}/{n}   (without the keyword channel)")

    # Dense-threshold recommendation from the non-entity questions only.
    best = []
    for item, raw, _ in in_rows:
        if item.get("kind") != "entity":
            best.append(next((h.score for h in raw if h.chunk.source in item["expect"]), 0.0))
    worst = [(raw[0].score if raw else 0.0) for _, raw, _ in off_rows]
    lo, hi = max(worst, default=0.0), min(best, default=0.0)
    if hi > lo:
        print(f"recommended RAG_MIN_SCORE = {(lo + hi) / 2:.2f}  (midpoint of clean gap {lo:.3f} .. {hi:.3f}; "
              f"current {s.rag_min_score})")
    else:
        print(f"no clean dense threshold for this model (gap {lo:.3f} .. {hi:.3f} overlaps); "
              f"current {s.rag_min_score}")
    return 0 if leaked == 0 and found == n else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
