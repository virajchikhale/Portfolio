"""Debug / calibration tool: show what retrieval returns, with scores (use it to tune RAG_MIN_SCORE).

    python -m app.rag.search "what did he do at Inorbvict?"
"""
import asyncio
import sys

from app.config import get_settings
from app.rag.embeddings import build_embedder
from app.rag.store import build_store


async def _main(q: str) -> None:
    s = get_settings()
    store = build_store(s)
    await store.init()
    try:
        hits = await store.search(await build_embedder(s).embed_query(q), s.rag_top_k * 2)
        for h in hits:
            mark = "✓" if h.score >= s.rag_min_score else "✗"
            print(f"{mark} {h.score:.3f}  {h.chunk.label}")
        print(f"(threshold RAG_MIN_SCORE={s.rag_min_score}; ✓ = would be used)")
    finally:
        await store.close()


if __name__ == "__main__":
    asyncio.run(_main(" ".join(sys.argv[1:]) or "who is Viraj?"))
