import asyncio
import hashlib
import logging
import math
import re
from typing import Protocol

from app.config import Settings

log = logging.getLogger(__name__)


class RAGError(Exception):
    """Retrieval-layer failure. Callers degrade gracefully (answer without sources)."""


class Embedder(Protocol):
    async def embed_documents(self, texts: list[str]) -> list[list[float]]: ...
    async def embed_query(self, text: str) -> list[float]: ...


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class GeminiEmbedder:
    BATCH = 50  # API limit is 100 inputs per request

    def __init__(self, settings: Settings):
        if settings.gemini_api_key is None or not settings.gemini_api_key.get_secret_value().strip():
            raise RAGError("GEMINI_API_KEY is not configured (needed for embeddings)")
        from google import genai

        self._types = genai.types
        self._client = genai.Client(api_key=settings.gemini_api_key.get_secret_value().strip())
        self._s = settings

    async def _embed(self, texts: list[str], task: str) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), self.BATCH):
            batch = texts[i : i + self.BATCH]
            try:
                res = await self._client.aio.models.embed_content(
                    model=self._s.embedding_model,
                    contents=batch,
                    config=self._types.EmbedContentConfig(task_type=task, output_dimensionality=self._s.embedding_dim),
                )
            except Exception as exc:
                log.exception("Gemini embedding call failed (model=%s)", self._s.embedding_model)
                raise RAGError("Embedding service unavailable") from exc
            vecs = [list(e.values) for e in res.embeddings]
            if len(vecs) != len(batch) or any(len(v) != self._s.embedding_dim for v in vecs):
                raise RAGError(f"Embedding size mismatch (expected dim {self._s.embedding_dim})")
            # Gemini only returns unit-length vectors at the full 3072 dims; normalise truncated ones.
            out += [_normalize(v) for v in vecs]
        return out

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return await self._embed(texts, "RETRIEVAL_DOCUMENT")

    async def embed_query(self, text: str) -> list[float]:
        return (await self._embed([text], "RETRIEVAL_QUERY"))[0]


class LocalEmbedder:
    """fastembed (ONNX Runtime, CPU). No network at runtime once the model is cached; no API key or quota."""

    def __init__(self, settings: Settings):
        from fastembed import TextEmbedding

        try:
            self._model = TextEmbedding(model_name=settings.embedding_model, cache_dir=settings.embedding_cache_dir)
        except Exception as exc:
            log.exception("Could not load local embedding model %s", settings.embedding_model)
            raise RAGError(f"Local embedding model '{settings.embedding_model}' could not be loaded "
                           f"(not cached and no network?)") from exc
        probe = next(iter(self._model.embed(["probe"])))
        if len(probe) != settings.embedding_dim:
            raise RAGError(f"{settings.embedding_model} produces {len(probe)}-dim vectors but "
                           f"EMBEDDING_DIM={settings.embedding_dim}; unset EMBEDDING_DIM or fix it, then "
                           "run `python -m app.rag.ingest --reset`")

    def _run(self, fn, texts: list[str]) -> list[list[float]]:
        return [_normalize([float(x) for x in v]) for v in fn(texts)]

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        # ONNX inference is blocking CPU work: keep it off the event loop so streaming chats stay responsive.
        return await asyncio.to_thread(self._run, self._model.passage_embed, texts)

    async def embed_query(self, text: str) -> list[float]:
        return (await asyncio.to_thread(self._run, self._model.query_embed, [text]))[0]


_STOP = {"the", "a", "an", "of", "and", "to", "in", "for", "is", "was", "what", "did", "does", "do", "his", "he",
         "about", "with", "on", "at", "as", "by", "it", "tell", "me", "how", "has", "have", "who", "which"}


class FakeEmbedder:
    """Deterministic bag-of-words hashing embedder: offline, free, similar texts -> similar vectors.

    Only for tests / keyless dev. It matches on shared words, not meaning.
    """

    def __init__(self, dim: int):
        self.dim = dim

    def _vec(self, text: str) -> list[float]:
        v = [0.0] * self.dim
        for w in re.findall(r"[a-z0-9]+", text.lower()):
            if w in _STOP or len(w) < 2:
                continue
            h = int.from_bytes(hashlib.sha256(w.encode()).digest()[:4], "big")
            v[h % self.dim] += 1.0
        return _normalize(v)

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    async def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


def build_embedder(settings: Settings) -> Embedder:
    if settings.embedding_provider == "fake":
        return FakeEmbedder(settings.embedding_dim)
    if settings.embedding_provider == "local":
        return LocalEmbedder(settings)
    return GeminiEmbedder(settings)
