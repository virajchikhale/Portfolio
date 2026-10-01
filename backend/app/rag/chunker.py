"""Split markdown documents into retrievable chunks.

One chunk per `##` section (so a chunk is a coherent topic), long sections are split on paragraph
boundaries. Each chunk remembers its source file + heading so answers can cite it.
"""
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Chunk:
    source: str  # file name, e.g. experience.md
    title: str  # document title (# heading)
    heading: str  # section title (## heading)
    content: str

    @property
    def label(self) -> str:
        return f"{self.title} › {self.heading}"

    @property
    def embed_text(self) -> str:
        # title + heading give the embedding the context a bare paragraph lacks
        return f"{self.title} — {self.heading}\n{self.content}"

    def key(self, model: str, dim: int) -> str:
        """Stable id: changes if the text, embedding model or dimension changes -> re-embedded automatically."""
        return hashlib.sha256(f"{model}|{dim}|{self.source}|{self.embed_text}".encode()).hexdigest()


_H1 = re.compile(r"^#\s+(.+)$", re.M)
_H2 = re.compile(r"^##\s+(.+)$", re.M)


def _split_long(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    parts, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        if cur and len(cur) + len(para) + 2 > max_chars:
            parts.append(cur.strip())
            cur = ""
        cur += para + "\n\n"
    if cur.strip():
        parts.append(cur.strip())
    return parts


def chunk_markdown(source: str, text: str, max_chars: int = 1200) -> list[Chunk]:
    m = _H1.search(text)
    title = m.group(1).strip() if m else Path(source).stem
    body = text[m.end():] if m else text
    sections = _H2.split(body)  # [preamble, h2, body, h2, body, ...]
    chunks: list[Chunk] = []
    preamble = sections[0].strip()
    if preamble:
        chunks += [Chunk(source, title, title, p) for p in _split_long(preamble, max_chars)]
    for heading, content in zip(sections[1::2], sections[2::2], strict=True):
        content = content.strip()
        if content:
            chunks += [Chunk(source, title, heading.strip(), p) for p in _split_long(content, max_chars)]
    return chunks


def load_chunks(data_dir: str | Path, exclude: set[str] = frozenset()) -> list[Chunk]:
    chunks: list[Chunk] = []
    for path in sorted(Path(data_dir).glob("*.md")):
        if path.name in exclude:
            continue
        chunks += chunk_markdown(path.name, path.read_text(encoding="utf-8"))
    return chunks
