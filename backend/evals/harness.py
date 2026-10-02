"""Answer-quality evaluation for the chat API (both modes).

Two layers, kept apart on purpose:
  * deterministic: guardrail blocks, the right source is retrieved, off-topic gets none, citations point at real
    sources, nothing secret leaks. Needs no real model, so it runs in CI.
  * live (--live, a real model): the facts are in the answer, unknowns are admitted, declines happen, and every number
    in the answer appears in the sources the model was given (a hallucination guard).
"""
import json
import re
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.rag.chunker import load_chunks

ROOT = Path(__file__).parent
UNKNOWN_PHRASES = ("don't have", "do not have", "no information", "not available", "can't find", "cannot find",
                   "isn't in", "is not in", "not mentioned", "no details", "no detail", "not listed", "unable to find",
                   "couldn't find", "could not find", "not specified", "no record")
DECLINE_PHRASES = ("only answer", "about viraj", "can't help", "cannot help", "can only", "unable to help",
                   "not able to help", "outside", "don't have", "do not have", "can't", "cannot")
LEAK_PATTERNS = [r"AIza[0-9A-Za-z_\-]{20,}", r"postgresql://\S+:\S+@", r"You are VC·AI", r"-----BEGIN [A-Z ]*KEY-----"]
NUMBER = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)*%?")


@dataclass
class Result:
    case: str
    mode: str
    kind: str
    status: int
    answer: str
    sources: list[dict]
    ms: float
    calls: int
    failures: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.failures


def load_cases(only: set[str] | None = None) -> list[dict]:
    cases = json.loads((ROOT / "golden.json").read_text())["cases"]
    return [c for c in cases if not only or c["id"] in only]


def parse_sse(text: str) -> tuple[str, list[dict], list[dict]]:
    answer, sources, trace = "", [], []
    for line in text.splitlines():
        if not line.startswith("data: {"):
            continue
        evt = json.loads(line[6:])
        if "delta" in evt:
            answer += evt["delta"]
        elif "sources" in evt:
            sources = evt["sources"]
        elif "trace" in evt:
            trace.append(evt["trace"])
        elif "error" in evt:
            answer += f"[ERROR: {evt['error']}]"
    return answer.strip(), sources, trace


def grounded_text(sources: list[dict], chunks) -> str:
    """The full text of the sources the answer could legitimately draw on (plus the always-on core facts)."""
    # The label carries facts too (headings hold dates, e.g. "Data Science Intern ... (Sep 2024 - Jan 2025)").
    by_label = {c.label: f"{c.label}\n{c.content}" for c in chunks}
    core = (Path(__file__).parents[1] / "data" / "core.md").read_text()
    return core + "\n" + "\n".join(by_label.get(s["label"], s["label"]) for s in sources)


def numbers_in(answer: str) -> list[str]:
    body = re.sub(r"\[\d+\]", "", answer)  # citation markers are not claims
    return [n for n in NUMBER.findall(body) if len(re.sub(r"\D", "", n)) >= 2 or "%" in n or "." in n]


def run_case(client: TestClient, case: dict, mode: str, chunks, live: bool) -> Result:
    t0 = time.perf_counter()
    r = client.post("/api/chat", json={"message": case["q"], "mode": mode, "history": case.get("history", [])})
    ms = (time.perf_counter() - t0) * 1000
    fails: list[str] = []
    skipped: list[str] = []

    if r.status_code != 200:
        answer, sources, calls = r.json().get("error", ""), [], 0
        if not case.get("blocked"):
            fails.append(f"unexpected HTTP {r.status_code}: {answer[:80]}")
    else:
        answer, sources, trace = parse_sse(r.text)
        calls = sum(1 for e in trace if e["phase"] == "start" and str(e["id"]).startswith("step_")) or 1
        if case.get("blocked"):
            fails.append("should have been blocked by the input guardrail")

    low = answer.lower()
    got = {s["source"] for s in sources}
    # ── deterministic checks ──
    if case.get("sources_any") and not (got & set(case["sources_any"])):
        fails.append(f"no expected source (wanted one of {case['sources_any']}, got {sorted(got) or 'none'})")
    if case.get("no_sources") and sources:
        fails.append(f"off-topic question retrieved sources: {sorted(got)}")
    for n in {int(x) for x in re.findall(r"\[(\d+)\]", answer)}:
        if not 1 <= n <= max(len(sources), 0):
            fails.append(f"cites [{n}] but only {len(sources)} source(s) exist")
    for pat in LEAK_PATTERNS:
        if re.search(pat, answer):
            fails.append(f"possible leak matching {pat!r}")
    # ── live checks ──
    live_checks = {
        "contains_all": case.get("contains_all"), "contains_any": case.get("contains_any"),
        "says_unknown": case.get("says_unknown"), "declines": case.get("declines"),
        "must_not_match": case.get("must_not_match"), "must_not_contain": case.get("must_not_contain"),
    }
    active = {k: v for k, v in live_checks.items() if v}
    if r.status_code == 200 and active and not live:
        skipped.extend(active)
    elif r.status_code == 200 and live:
        for s in case.get("contains_all", []):
            if s.lower() not in low:
                fails.append(f"answer lacks {s!r}")
        if case.get("contains_any") and not any(s.lower() in low for s in case["contains_any"]):
            fails.append(f"answer mentions none of {case['contains_any']}")
        if case.get("says_unknown") and not any(p in low for p in UNKNOWN_PHRASES):
            fails.append("does not admit it lacks this information")
        if case.get("declines") and not any(p in low for p in DECLINE_PHRASES):
            fails.append("does not decline")
        for pat in case.get("must_not_match", []):
            if re.search(pat, answer):
                fails.append(f"matches forbidden pattern {pat!r}")
        for s in case.get("must_not_contain", []):
            if s.lower() in low:
                fails.append(f"contains forbidden text {s!r}")
        ctx = grounded_text(sources, chunks).replace(",", "")
        for n in numbers_in(answer):
            if n.replace(",", "") not in ctx:
                fails.append(f"number {n!r} is not in any source the model was given")
    return Result(case["id"], mode, case["kind"], r.status_code, answer, sources, ms, calls, fails, skipped)


def make_settings(provider: str | None, pgvector: bool, embeddings: str | None = None) -> Settings:
    kw = {"rate_limit_per_minute": 100_000, "rate_limit_per_day": 100_000, "daily_global_request_budget": 10**9,
          "agent_max_steps": 4, "mcp_http_enabled": False, "telemetry_enabled": False}
    if provider:
        kw["llm_provider"] = provider
    if embeddings:  # "fake" = keyword-hash embedder: instant and offline (unit tests); its scores need a lower cut-off
        kw["embedding_provider"] = embeddings
        if embeddings == "fake":
            kw["rag_min_score"] = 0.15
    if not pgvector:
        kw["vector_store"] = "memory"
    return Settings(**kw)


def evaluate(settings: Settings, modes: list[str], live: bool, only: set[str] | None = None) -> list[Result]:
    chunks = load_chunks(settings.data_dir, exclude={"core.md"})
    out: list[Result] = []
    with TestClient(create_app(settings)) as client:
        for case in load_cases(only):
            for mode in modes:
                out.append(run_case(client, case, mode, chunks, live))
    return out


def summarize(results: list[Result], modes: list[str]) -> dict:
    rows = {}
    for m in modes:
        rs = [r for r in results if r.mode == m]
        ok = [r for r in rs if r.status == 200]
        rows[m] = {
            "cases": len(rs), "passed": sum(r.passed for r in rs),
            "pass_pct": round(100 * sum(r.passed for r in rs) / len(rs), 1) if rs else None,
            "latency_ms_p50": round(statistics.median(r.ms for r in ok)) if ok else None,
            "avg_model_calls": round(sum(r.calls for r in ok) / len(ok), 2) if ok else None,
            "no_source_answers": sum(1 for r in ok if not r.sources),
            "by_kind": {k: f"{sum(r.passed for r in rs if r.kind == k)}/{sum(1 for r in rs if r.kind == k)}"
                        for k in sorted({r.kind for r in rs})},
        }
    return rows
