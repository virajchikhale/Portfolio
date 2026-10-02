"""Vector stores behind one interface: PgVectorStore (production) and InMemoryStore (tests / keyless dev)."""
import asyncio
import logging
import math
from dataclasses import dataclass
from typing import Protocol

from app.config import Settings
from app.rag.chunker import Chunk
from app.rag.embeddings import RAGError

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Hit:
    chunk: Chunk
    score: float  # dense cosine similarity (0.0 if the chunk was found by the keyword channel only)
    via: str = "dense"  # dense | lexical | both


class VectorStore(Protocol):
    async def init(self, recreate: bool = False) -> None: ...
    async def existing_keys(self) -> set[str]: ...
    async def upsert(self, items: list[tuple[str, Chunk, list[float]]]) -> None: ...
    async def delete_except(self, keep: set[str]) -> int: ...
    async def search(self, embedding: list[float], k: int) -> list[Hit]: ...
    async def count(self) -> int: ...
    async def reset(self) -> None: ...
    async def close(self) -> None: ...


class InMemoryStore:
    def __init__(self) -> None:
        self._rows: dict[str, tuple[Chunk, list[float]]] = {}

    async def init(self, recreate: bool = False) -> None:
        if recreate:
            self._rows.clear()

    async def existing_keys(self) -> set[str]:
        return set(self._rows)

    async def upsert(self, items):
        for key, chunk, emb in items:
            self._rows[key] = (chunk, emb)

    async def delete_except(self, keep: set[str]) -> int:
        gone = [k for k in self._rows if k not in keep]
        for k in gone:
            del self._rows[k]
        return len(gone)

    async def search(self, embedding, k):
        def cos(a, b):
            na, nb = math.sqrt(sum(x * x for x in a)) or 1, math.sqrt(sum(x * x for x in b)) or 1
            return sum(x * y for x, y in zip(a, b, strict=True)) / (na * nb)

        scored = [Hit(c, cos(embedding, e)) for c, e in self._rows.values()]
        return sorted(scored, key=lambda h: h.score, reverse=True)[:k]

    async def count(self) -> int:
        return len(self._rows)

    async def reset(self) -> None:
        self._rows.clear()

    async def close(self) -> None: ...


class PgVectorStore:
    """Postgres + pgvector. All SQL is parameterised; the only interpolated value is the validated int dim."""

    def __init__(self, settings: Settings):
        if settings.database_url is None:
            raise RAGError("DATABASE_URL is required when VECTOR_STORE=pgvector", "database_url_missing")
        self._url = settings.database_url.get_secret_value()
        self._dim = int(settings.embedding_dim)
        self._pool = None

    async def init(self, recreate: bool = False, retries: int = 5, delay: float = 2.0) -> None:
        import psycopg
        from pgvector.psycopg import register_vector_async
        from psycopg_pool import AsyncConnectionPool

        last: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                # Bootstrap with a plain connection: the extension must exist before types can be registered.
                async with await psycopg.AsyncConnection.connect(self._url, autocommit=True, connect_timeout=5) as c:
                    await c.execute("CREATE EXTENSION IF NOT EXISTS vector")
                    if recreate:  # `ingest --reset`: the only way out of a dimension mismatch
                        await c.execute("DROP TABLE IF EXISTS chunks")
                    await c.execute(
                        f"""CREATE TABLE IF NOT EXISTS chunks (
                              key        text PRIMARY KEY,
                              source     text NOT NULL,
                              title      text NOT NULL,
                              heading    text NOT NULL,
                              content    text NOT NULL,
                              embedding  vector({self._dim}) NOT NULL,
                              created_at timestamptz NOT NULL DEFAULT now())"""
                    )
                    cur = await c.execute(
                        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
                        "WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'"
                    )
                    have = (await cur.fetchone())[0]
                    if have != f"vector({self._dim})":
                        raise RAGError(f"chunks.embedding is {have} but EMBEDDING_DIM={self._dim}; "
                                       "run `python -m app.rag.ingest --reset`", "dimension_mismatch")
                    await c.execute(
                        "CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw "
                        "ON chunks USING hnsw (embedding vector_cosine_ops)"
                    )
                self._pool = AsyncConnectionPool(self._url, min_size=1, max_size=5, open=False,
                                                 configure=register_vector_async)
                await self._pool.open(wait=True, timeout=10)
                return
            except RAGError:
                raise
            except Exception as exc:  # DB still starting, wrong creds, ...
                last = exc
                log.warning("pgvector init attempt %d/%d failed: %s", attempt, retries, type(exc).__name__)
                await asyncio.sleep(delay)
        raise RAGError("Could not connect to the vector database", "database_unreachable") from last

    @property
    def pool(self):
        return self._pool

    def _p(self):
        if self._pool is None:
            raise RAGError("vector store not initialised")
        return self._pool

    async def existing_keys(self) -> set[str]:
        async with self._p().connection() as c:
            cur = await c.execute("SELECT key FROM chunks")
            return {r[0] for r in await cur.fetchall()}

    async def upsert(self, items):
        if not items:
            return
        async with self._p().connection() as c:
            async with c.cursor() as cur:
                await cur.executemany(
                    "INSERT INTO chunks (key, source, title, heading, content, embedding) VALUES (%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (key) DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content",
                    [(k, ch.source, ch.title, ch.heading, ch.content, emb) for k, ch, emb in items],
                )

    async def delete_except(self, keep: set[str]) -> int:
        async with self._p().connection() as c:
            cur = await c.execute("DELETE FROM chunks WHERE NOT (key = ANY(%s))", (list(keep),))
            return cur.rowcount

    async def search(self, embedding, k):
        async with self._p().connection() as c:
            cur = await c.execute(
                "SELECT source, title, heading, content, 1 - (embedding <=> %s::vector) AS score "
                "FROM chunks ORDER BY embedding <=> %s::vector LIMIT %s",
                (embedding, embedding, k),
            )
            return [Hit(Chunk(s, t, h, body), float(score)) for s, t, h, body, score in await cur.fetchall()]

    async def count(self) -> int:
        async with self._p().connection() as c:
            cur = await c.execute("SELECT count(*) FROM chunks")
            return (await cur.fetchone())[0]

    async def reset(self) -> None:
        async with self._p().connection() as c:
            await c.execute("TRUNCATE chunks")

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()


def build_store(settings: Settings) -> VectorStore:
    return InMemoryStore() if settings.vector_store == "memory" else PgVectorStore(settings)
