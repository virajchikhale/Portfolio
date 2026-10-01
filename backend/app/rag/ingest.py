"""Index data/*.md into the vector store. Idempotent: only new/changed chunks are embedded.

    python -m app.rag.ingest            # sync (what the server also does at startup)
    python -m app.rag.ingest --reset    # wipe and rebuild (needed after changing EMBEDDING_DIM)
"""
import argparse
import asyncio
import logging
from dataclasses import dataclass

from app.config import Settings, get_settings
from app.rag.chunker import load_chunks
from app.rag.embeddings import Embedder, build_embedder
from app.rag.store import VectorStore, build_store

log = logging.getLogger(__name__)
CORE_FILE = "core.md"  # always in the system prompt, so it is not retrieved


@dataclass(frozen=True)
class IngestReport:
    added: int
    removed: int
    unchanged: int


async def ingest(settings: Settings, store: VectorStore, embedder: Embedder, reset: bool = False) -> IngestReport:
    chunks = load_chunks(settings.data_dir, exclude={CORE_FILE})
    keyed = {c.key(settings.embedding_model, settings.embedding_dim): c for c in chunks}
    if reset:
        await store.reset()
    have = await store.existing_keys()
    new_keys = [k for k in keyed if k not in have]
    if new_keys:
        vectors = await embedder.embed_documents([keyed[k].embed_text for k in new_keys])
        await store.upsert([(k, keyed[k], v) for k, v in zip(new_keys, vectors, strict=True)])
    removed = await store.delete_except(set(keyed))
    report = IngestReport(added=len(new_keys), removed=removed, unchanged=len(keyed) - len(new_keys))
    log.info("ingest: %s", report)
    return report


async def _main(reset: bool) -> int:
    logging.basicConfig(level=logging.INFO)
    s = get_settings()
    store = build_store(s)
    await store.init(recreate=reset)
    try:
        r = await ingest(s, store, build_embedder(s), reset=reset)
        print(f"added={r.added} removed={r.removed} unchanged={r.unchanged} total_in_db={await store.count()}")
    finally:
        await store.close()
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true")
    raise SystemExit(asyncio.run(_main(ap.parse_args().reset)))
