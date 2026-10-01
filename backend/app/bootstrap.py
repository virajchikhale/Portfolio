"""Start retrieval (vector store + embedder + keyword index). Shared by the web app and the stdio MCP server so both
behave identically, including the loud-but-non-fatal failure handling."""
import logging
from dataclasses import dataclass

from app.config import Settings
from app.rag.chunker import load_chunks
from app.rag.embeddings import RAGError, build_embedder
from app.rag.ingest import CORE_FILE, ingest
from app.rag.lexical import LexicalIndex
from app.rag.store import build_store

log = logging.getLogger(__name__)


@dataclass
class Rag:
    store: object | None = None  # the vector store (kept open by the caller) or None when retrieval is off
    embedder: object | None = None
    lexical: LexicalIndex | None = None
    reason: str | None = None  # None = healthy; else a RAG_HINTS key
    opened: object | None = None  # the store to close on shutdown, even when retrieval ended up disabled

    @property
    def enabled(self) -> bool:
        return self.store is not None

    async def close(self) -> None:
        if self.opened is not None:
            await self.opened.close()


async def start_rag(settings: Settings) -> Rag:
    rag = Rag()
    try:
        store = build_store(settings)
        rag.opened = store
        embedder = build_embedder(settings)
        try:
            await store.init()
        except RAGError as exc:
            if exc.code != "dimension_mismatch" or not settings.ingest_on_startup:
                raise
            # The index is derived data (rebuilt from data/*.md), so a size change, e.g. after switching the
            # embedding model, is safe to fix automatically instead of leaving retrieval switched off.
            log.warning("Rebuilding the vector index (embedding size changed): %s", exc)
            await store.init(recreate=True)
        if settings.ingest_on_startup:
            await ingest(settings, store, embedder)
        rag.store, rag.embedder = store, embedder
        rag.lexical = LexicalIndex(load_chunks(settings.data_dir, exclude={CORE_FILE}))
    except RAGError as exc:
        # Misconfiguration (missing DATABASE_URL, model not loadable...) must be loud, not silent.
        log.exception("RAG disabled: %s", exc.code)
        rag.reason = exc.code
    except Exception:
        # Chat stays up (answers from core facts only) even if the DB / embeddings are down at boot.
        log.exception("RAG disabled: vector store or embeddings unavailable at startup")
        rag.reason = "startup_failed"
    return rag
