"""Tiny in-process BM25 over the corpus, to catch what dense embeddings miss: rare proper nouns.

A small embedding model has never seen "Inorbvict" or "ZCOER", so a question naming them scores low on cosine
similarity even though the right chunk contains the exact word. We only let *rare* corpus terms trigger a lexical
match (a term in <= max_df_ratio of the chunks), so common words ("tools", "work") can't pull in junk, and words
that are absent from the corpus ("Paris", "pizza") match nothing. A match must also *cover* the question: at least
min_coverage of its content words must be such rare terms. "What did he do at Inorbvict?" is 100% covered, whereas
"What's the weather in Paris today?" matches "weather" (it occurs in the farming project) but covers only 1 of 3
content words, so it is rejected instead of citing an unrelated project.
"""
import math
import re
from collections import Counter

from app.rag.chunker import Chunk
from app.rag.embeddings import _STOP

_TOKEN = re.compile(r"[a-z0-9]+")
# Function words and the subject's own name carry no signal for keyword matching: every question is about Viraj.
_LEX_STOP = _STOP | {
    "viraj", "chikhale", "during", "after", "before", "from", "into", "over", "under", "between", "through",
    "also", "than", "then", "there", "their", "they", "them", "were", "been", "being", "would", "could",
    "should", "will", "can", "any", "all", "some", "other", "more", "most", "very", "just", "get", "got",
    "does", "are", "was", "his", "her", "him", "she", "you", "your", "that", "this", "these", "those", "when",
    "where", "why", "whom", "whose", "work", "worked", "working", "know", "knows", "built", "made", "build",
}
_K1, _B = 1.5, 0.75


def _terms(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(text.lower()) if t not in _LEX_STOP and len(t) >= 3]


class LexicalIndex:
    def __init__(self, chunks: list[Chunk], max_df_ratio: float = 0.2, min_coverage: float = 0.5):
        self._chunks = chunks
        self._tf = [Counter(_terms(c.embed_text)) for c in chunks]
        self._len = [sum(tf.values()) for tf in self._tf]
        self._avg = (sum(self._len) / len(chunks)) if chunks else 1.0
        self._df: Counter[str] = Counter()
        for tf in self._tf:
            self._df.update(tf.keys())
        self._max_df = max_df_ratio * max(len(chunks), 1)
        self._min_coverage = min_coverage

    def rare_terms(self, query: str) -> list[str]:
        return [t for t in dict.fromkeys(_terms(query)) if 0 < self._df.get(t, 0) <= self._max_df]

    def search(self, query: str, k: int) -> list[tuple[Chunk, float]]:
        terms = self.rare_terms(query)
        content = set(_terms(query))
        if not terms or len(terms) / len(content) < self._min_coverage:
            return []
        n = len(self._chunks)
        scored = []
        for chunk, tf, dl in zip(self._chunks, self._tf, self._len, strict=True):
            s = 0.0
            for t in terms:
                f = tf.get(t, 0)
                if f:
                    idf = math.log(1 + (n - self._df[t] + 0.5) / (self._df[t] + 0.5))
                    s += idf * f * (_K1 + 1) / (f + _K1 * (1 - _B + _B * dl / self._avg))
            if s > 0:
                scored.append((chunk, s))
        return sorted(scored, key=lambda x: x[1], reverse=True)[:k]
