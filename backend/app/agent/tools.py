"""The portfolio's tools: small, READ-ONLY, deterministic. One registry feeds both the agent and the MCP server.

Security model (the model's arguments are untrusted input, exactly like a user's message):
  * every tool is read-only: nothing here can write, send, delete or fetch a URL;
  * arguments are validated strictly (type, length, allowed keys, enum for skill names);
  * results are size-capped and treated as DATA by the caller (never as instructions);
  * no tool can read a secret, a file path or the system prompt.
"""
import json
from dataclasses import dataclass, field
from typing import Any

from app.config import Settings
from app.llm.base import ToolSpec
from app.rag.chunker import Chunk
from app.rag.lexical import LexicalIndex
from app.rag.retriever import retrieve
from app.rag.store import VectorStore
from app.security.guardrails import looks_like_injection, sanitize
from app.skills_engine.loader import Skill
from app.trace import Tracer

MAX_RESULT_CHARS = 3000
MAX_ARGS_JSON = 1000
PROJECTS_SOURCE = "projects.md"


@dataclass
class SourceBook:
    """Numbers every chunk cited during ONE run ([1], [2]...) so citations stay consistent across several searches."""

    chunks: list[Chunk] = field(default_factory=list)

    def number(self, chunk: Chunk) -> int:
        if chunk not in self.chunks:
            self.chunks.append(chunk)
        return self.chunks.index(chunk) + 1

    def as_events(self) -> list[dict]:
        return [{"n": i, "label": c.label, "source": c.source} for i, c in enumerate(self.chunks, 1)]


@dataclass
class ToolContext:
    settings: Settings
    skills: dict[str, Skill]
    chunks: list[Chunk]  # the whole corpus (for list_projects / get_project)
    store: VectorStore | None = None
    embedder: Any = None
    lexical: LexicalIndex | None = None
    book: SourceBook = field(default_factory=SourceBook)


@dataclass
class ToolOutput:
    text: str  # what the model (or the MCP client) receives
    data: dict = field(default_factory=dict)  # extra details for the Flow Monitor
    is_error: bool = False


class ToolError(Exception):
    """Bad arguments / unavailable tool. The message is returned to the model so it can correct itself."""


def _clip(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _check_args(args: Any, allowed: set[str], required: set[str]) -> dict:
    if not isinstance(args, dict):
        raise ToolError("arguments must be an object")
    if len(json.dumps(args, default=str)) > MAX_ARGS_JSON:
        raise ToolError("arguments too large")
    extra = set(args) - allowed
    if extra:
        raise ToolError(f"unexpected argument(s): {', '.join(sorted(extra))}")
    missing = required - set(args)
    if missing:
        raise ToolError(f"missing argument(s): {', '.join(sorted(missing))}")
    return args


def _str_arg(args: dict, key: str, lo: int, hi: int) -> str:
    v = args.get(key)
    if not isinstance(v, str):
        raise ToolError(f"'{key}' must be a string")
    v = sanitize(v)
    if not lo <= len(v) <= hi:
        raise ToolError(f"'{key}' must be {lo}-{hi} characters")
    return v


# ── the tools ───────────────────────────────────────────────────────────────
async def search_portfolio(ctx: ToolContext, args: dict) -> ToolOutput:
    args = _check_args(args, {"query"}, {"query"})
    query = _str_arg(args, "query", 2, 200)
    if looks_like_injection(query):
        raise ToolError("query rejected")
    if ctx.store is None or ctx.embedder is None:
        return ToolOutput("Search is unavailable right now (retrieval is switched off). "
                          "Answer from CORE FACTS only, or say you don't have that detail.",
                          {"query": query}, is_error=True)
    sub = Tracer()  # records the retrieval stages so the Flow Monitor can show them inside this tool call
    hits = await retrieve(ctx.store, ctx.embedder, query, ctx.settings, ctx.lexical, sub)
    stages = {e["id"]: {"dur": e["dur"], **e["data"], "status": e["status"]} for e in sub.events if e["phase"] == "end"}
    if not hits:
        return ToolOutput("No relevant sources found for this query. Try different keywords, or tell the user you "
                          "don't have that detail.", {"query": query, "retrieval": stages, "sources": []})
    numbered = [(ctx.book.number(h.chunk), h) for h in hits]
    text = "\n\n".join(f"[{n}] {h.chunk.label}\n{h.chunk.content}" for n, h in numbered)
    return ToolOutput(_clip(text), {"query": query, "retrieval": stages,
                                    "sources": [{"n": n, "label": h.chunk.label} for n, h in numbered]})


async def load_skill(ctx: ToolContext, args: dict) -> ToolOutput:
    args = _check_args(args, {"name"}, {"name"})
    name = _str_arg(args, "name", 1, 64)
    skill = ctx.skills.get(name)
    if skill is None:
        raise ToolError(f"unknown skill '{name}'. Available: {', '.join(sorted(ctx.skills))}")
    return ToolOutput(_clip(skill.body), {"skill": name, "chars": len(skill.body)})


def _projects(ctx: ToolContext) -> list[Chunk]:
    return [c for c in ctx.chunks if c.source == PROJECTS_SOURCE]


def _first_sentence(text: str, limit: int = 140) -> str:
    first = text.strip().split(". ")[0].strip()
    return first if len(first) <= limit else first[: limit - 1].rstrip() + "…"


async def list_projects(ctx: ToolContext, args: dict) -> ToolOutput:
    _check_args(args, set(), set())
    items = _projects(ctx)
    if not items:
        return ToolOutput("No projects are listed.", is_error=True)
    lines = [f"- {c.heading}: {_first_sentence(c.content)}" for c in items]
    return ToolOutput(_clip("\n".join(lines)), {"count": len(items), "names": [c.heading for c in items]})


async def get_project(ctx: ToolContext, args: dict) -> ToolOutput:
    args = _check_args(args, {"name"}, {"name"})
    name = _str_arg(args, "name", 2, 100).lower()
    items = _projects(ctx)
    words = [w for w in name.replace("(", " ").replace(")", " ").split() if len(w) > 2]
    scored = sorted(((sum(w in c.heading.lower() for w in words) + (3 if name in c.heading.lower() else 0), c)
                     for c in items), key=lambda x: x[0], reverse=True)
    if not scored or scored[0][0] == 0:
        raise ToolError("no such project. Available: " + "; ".join(c.heading for c in items))
    chunk = scored[0][1]
    n = ctx.book.number(chunk)
    return ToolOutput(_clip(f"[{n}] {chunk.label}\n{chunk.content}"), {"project": chunk.heading, "sources": [
        {"n": n, "label": chunk.label}]})


# ── registry ────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Tool:
    spec: ToolSpec
    run: Any  # async (ctx, args) -> ToolOutput


def build_tools(skills: dict[str, Skill]) -> dict[str, Tool]:
    tools = [
        Tool(ToolSpec(
            "search_portfolio",
            "Search Viraj's portfolio (resume, experience, education, skills, projects) and return the most relevant "
            "numbered sources. Call this before answering any factual question about Viraj.",
            {"type": "object", "properties": {"query": {
                "type": "string", "description": "What to look for, in plain words (e.g. 'internship at Inorbvict')."}},
             "required": ["query"]}), search_portfolio),
        Tool(ToolSpec(
            "load_skill",
            "Load the full instructions of one skill. Only call it when a skill in the catalog clearly matches the "
            "question, and before you answer.",
            {"type": "object", "properties": {"name": {
                "type": "string", "enum": sorted(skills), "description": "Skill name from the catalog."}},
             "required": ["name"]}), load_skill),
        Tool(ToolSpec(
            "list_projects", "List all of Viraj's projects with a one-line summary each.",
            {"type": "object", "properties": {}}), list_projects),
        Tool(ToolSpec(
            "get_project", "Get the full description of one project by (part of) its name.",
            {"type": "object", "properties": {"name": {"type": "string", "description": "Project name, e.g. 'Movie "
                                                                                       "Recommendation'."}},
             "required": ["name"]}), get_project),
    ]
    return {t.spec.name: t for t in tools}


async def run_tool(tool: Tool, ctx: ToolContext, args: Any) -> ToolOutput:
    """Run one tool; argument errors become an error result the model can read and fix (never an exception)."""
    try:
        return await tool.run(ctx, args)
    except ToolError as exc:
        return ToolOutput(f"Error: {exc}", is_error=True)
