"""Run telemetry: one small summary per question, kept for the activity view and for debugging.

Privacy by default: a run is stored WITHOUT the visitor's question, the answer, or any network identifier. Only
shape and timing: mode, outcome, durations, how many tool calls, whether any source was found. (Opt in to keeping the
question text with TELEMETRY_STORE_QUESTIONS=true, e.g. to find gaps in the corpus.)
"""
import asyncio
import json
import logging
import math
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

from app.config import Settings

log = logging.getLogger(__name__)

OUTCOMES = ("ok", "empty", "blocked", "error", "cancelled")
STAGES = ("embed", "dense", "keyword", "fuse", "prompt", "llm")


@dataclass
class RunSummary:
    ts: float  # epoch seconds
    mode: str  # mode actually used: pipeline | agent
    requested: str  # mode the visitor asked for
    outcome: str  # ok | empty | blocked | error | cancelled
    total_ms: float = 0.0
    ttft_ms: float | None = None  # time to the first streamed character of the answer
    steps: int = 0  # model calls in agent mode
    tool_calls: int = 0
    sources: int = 0
    fallback: bool = False  # agent was requested but the fast pipeline was used instead
    stage_ms: dict[str, float] = field(default_factory=dict)
    model: str = ""
    question_len: int = 0
    question: str | None = None


def summarize(events: list[dict], *, outcome: str, mode: str, requested: str, model: str, question: str,
              sources: int, ttft_ms: float | None, store_question: bool) -> RunSummary:
    """Build the summary from the run's own trace (no extra instrumentation in the hot path)."""
    ends = [e for e in events if e.get("phase") == "end"]
    stage_ms = {e["id"]: e["dur"] for e in ends if e["id"] in STAGES}
    return RunSummary(
        ts=time.time(), mode=mode, requested=requested, outcome=outcome,
        total_ms=max((e["t"] for e in events), default=0.0), ttft_ms=ttft_ms,
        steps=sum(1 for e in events if e.get("phase") == "start" and str(e["id"]).startswith("step_")),
        tool_calls=sum(1 for e in events if e.get("phase") == "start" and str(e["id"]).startswith("tool_")),
        sources=sources, fallback=requested == "agent" and mode != "agent", stage_ms=stage_ms, model=model,
        question_len=len(question), question=question[:300] if store_question else None)


@dataclass
class Outcome:
    """What the stream turned out to contain; filled in as payloads go by."""

    deltas: int = 0
    error: str | None = None
    sources: int = 0
    first_delta_ms: float | None = None
    mode: str | None = None  # the mode that actually ran: a later meta event overrides it (agent -> pipeline fallback)

    def observe(self, item: dict, now_ms: float) -> None:
        trace = item.get("trace")
        if trace and trace.get("phase") == "meta" and trace.get("mode"):
            self.mode = trace["mode"]
        if "delta" in item:
            self.deltas += 1
            if self.first_delta_ms is None:
                self.first_delta_ms = round(now_ms, 1)
        elif "error" in item:
            self.error = item["error"]
        elif "sources" in item:
            self.sources = len(item["sources"])

    def classify(self, completed: bool) -> str:
        if not completed:
            return "cancelled"  # the visitor left before the answer finished
        return "error" if self.error else ("ok" if self.deltas else "empty")


class RunStore(Protocol):
    async def record(self, run: RunSummary) -> None: ...
    async def since(self, ts: float, limit: int = 20000) -> list[dict]: ...
    async def recent(self, limit: int) -> list[dict]: ...
    async def prune(self, older_than: float) -> int: ...


class MemoryRunStore:
    """Bounded in-process store: used with VECTOR_STORE=memory, and when Postgres is unavailable."""

    def __init__(self, maxlen: int = 5000):
        self._rows: deque[dict] = deque(maxlen=maxlen)

    async def record(self, run: RunSummary) -> None:
        self._rows.append(asdict(run))

    async def since(self, ts: float, limit: int = 20000) -> list[dict]:
        return [r for r in self._rows if r["ts"] >= ts][-limit:]

    async def recent(self, limit: int) -> list[dict]:
        return list(self._rows)[-limit:][::-1]

    async def prune(self, older_than: float) -> int:
        keep = [r for r in self._rows if r["ts"] >= older_than]
        gone = len(self._rows) - len(keep)
        self._rows.clear()
        self._rows.extend(keep)
        return gone


class PgRunStore:
    """Postgres-backed store (reuses the vector store's connection pool)."""

    def __init__(self, pool):
        self._pool = pool

    async def init(self) -> None:
        async with self._pool.connection() as c:
            await c.execute("""CREATE TABLE IF NOT EXISTS runs (
                id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
                mode text NOT NULL, requested text NOT NULL, outcome text NOT NULL,
                total_ms real, ttft_ms real, steps int, tool_calls int, sources int, fallback boolean,
                stage_ms jsonb, model text, question_len int, question text)""")
            await c.execute("CREATE INDEX IF NOT EXISTS runs_ts_idx ON runs (ts DESC)")

    async def record(self, run: RunSummary) -> None:
        async with self._pool.connection() as c:
            await c.execute(
                "INSERT INTO runs (ts, mode, requested, outcome, total_ms, ttft_ms, steps, tool_calls, sources, "
                "fallback, stage_ms, model, question_len, question) VALUES (to_timestamp(%s),%s,%s,%s,%s,%s,%s,%s,%s,"
                "%s,%s,%s,%s,%s)",
                (run.ts, run.mode, run.requested, run.outcome, run.total_ms, run.ttft_ms, run.steps, run.tool_calls,
                 run.sources, run.fallback, json.dumps(run.stage_ms), run.model, run.question_len, run.question))

    _COLS = ("extract(epoch from ts) AS ts, mode, requested, outcome, total_ms, ttft_ms, steps, tool_calls, sources, "
             "fallback, stage_ms, model, question_len, question")

    async def _rows(self, sql: str, params: tuple) -> list[dict]:
        async with self._pool.connection() as c:
            cur = await c.execute(sql, params)
            names = [d.name for d in cur.description]
            out = []
            for row in await cur.fetchall():
                d = dict(zip(names, row, strict=True))
                d["ts"] = float(d["ts"])
                d["stage_ms"] = d["stage_ms"] if isinstance(d["stage_ms"], dict) else json.loads(d["stage_ms"] or "{}")
                out.append(d)
            return out

    async def since(self, ts: float, limit: int = 20000) -> list[dict]:
        # _COLS is a constant column list, not input; every value below is a bound parameter.
        rows = await self._rows(f"SELECT {self._COLS} FROM runs WHERE ts >= to_timestamp(%s) "  # noqa: S608
                                "ORDER BY ts DESC LIMIT %s", (ts, limit))
        return rows[::-1]

    async def recent(self, limit: int) -> list[dict]:
        return await self._rows(f"SELECT {self._COLS} FROM runs ORDER BY ts DESC LIMIT %s", (limit,))  # noqa: S608

    async def prune(self, older_than: float) -> int:
        async with self._pool.connection() as c:
            cur = await c.execute("DELETE FROM runs WHERE ts < to_timestamp(%s)", (older_than,))
            return cur.rowcount


def _pct(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile (no interpolation: with few runs, an honest observed value beats a made-up one)."""
    if not values:
        return None
    v = sorted(values)
    return round(v[max(0, math.ceil(p / 100 * len(v)) - 1)], 1)


def aggregate(rows: list[dict], *, window: str, started_at: float, now: float | None = None) -> dict[str, Any]:
    """Public statistics: counts and latency percentiles only. Nothing here identifies a visitor or a question."""
    now = now or time.time()
    answered = [r for r in rows if r["outcome"] in ("ok", "empty")]
    ok = [r for r in rows if r["outcome"] == "ok"]
    agent = [r for r in answered if r["mode"] == "agent"]
    stage = {s: [r["stage_ms"][s] for r in answered if s in (r.get("stage_ms") or {})] for s in STAGES}
    with_sources = sum(1 for r in ok if r["sources"] > 0)
    return {
        "window": window,
        "uptime_s": round(now - started_at),
        "runs": {
            "total": len(rows),
            "by_mode": {m: sum(1 for r in rows if r["mode"] == m) for m in ("pipeline", "agent")},
            "by_outcome": {o: sum(1 for r in rows if r["outcome"] == o) for o in OUTCOMES},
        },
        "latency_ms": {"p50": _pct([r["total_ms"] for r in ok], 50), "p95": _pct([r["total_ms"] for r in ok], 95)},
        "ttft_ms": {"p50": _pct([r["ttft_ms"] for r in ok if r["ttft_ms"] is not None], 50)},
        "answers": {
            "with_sources": with_sources,
            "without_sources": len(ok) - with_sources,
            "with_sources_pct": round(100 * with_sources / len(ok), 1) if ok else None,
        },
        "agent": {
            "runs": len(agent),
            "avg_steps": round(sum(r["steps"] for r in agent) / len(agent), 2) if agent else None,
            "avg_tool_calls": round(sum(r["tool_calls"] for r in agent) / len(agent), 2) if agent else None,
            "fallbacks": sum(1 for r in rows if r["fallback"]),
        },
        "stages_p50_ms": {s: _pct(v, 50) for s, v in stage.items()},
    }


WINDOWS = {"24h": 24 * 3600, "7d": 7 * 24 * 3600, "all": None}


class Telemetry:
    """Records runs without ever blocking or failing a visitor's request."""

    def __init__(self, store: RunStore, settings: Settings):
        self.store = store
        self.settings = settings
        self.started_at = time.time()
        self._tasks: set[asyncio.Task] = set()
        self._cache: dict[str, tuple[float, dict]] = {}
        self._writes = 0

    def record_nowait(self, run: RunSummary) -> None:
        """Fire and forget: a slow or broken database must not slow down or break a chat answer."""
        task = asyncio.get_running_loop().create_task(self._record(run))
        self._tasks.add(task)  # hold a reference so the task is not garbage-collected mid-flight
        task.add_done_callback(self._tasks.discard)

    async def _record(self, run: RunSummary) -> None:
        try:
            await self.store.record(run)
            self._cache.clear()
            self._writes += 1
            if self._writes % 500 == 0:
                await self.prune()
        except Exception:
            log.exception("could not record run telemetry")

    async def prune(self) -> int:
        try:
            return await self.store.prune(time.time() - self.settings.run_retention_days * 86400)
        except Exception:
            log.exception("could not prune old runs")
            return 0

    async def stats(self, window: str = "24h") -> dict:
        window = window if window in WINDOWS else "24h"
        hit = self._cache.get(window)
        if hit and time.time() - hit[0] < 10:
            return hit[1]
        span = WINDOWS[window]
        rows = await self.store.since(time.time() - span if span else 0.0)
        out = aggregate(rows, window=window, started_at=self.started_at)
        self._cache[window] = (time.time(), out)
        return out

    async def recent(self, limit: int = 50) -> list[dict]:
        return await self.store.recent(max(1, min(limit, 200)))

    async def drain(self) -> None:
        """Let in-flight writes finish (shutdown, tests)."""
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
