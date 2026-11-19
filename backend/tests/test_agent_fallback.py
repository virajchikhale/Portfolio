"""If the agent cannot answer (e.g. the model rejects tool calling), the visitor still gets an answer."""
import json

from fastapi.testclient import TestClient

from app.config import Settings
from app.llm.base import LLMError, ModelTurn
from app.main import create_app


def S(**kw):
    kw.setdefault("rag_min_score", 0.15)
    kw.setdefault("rate_limit_per_minute", 500)
    return Settings(llm_provider="fake", vector_store="memory", embedding_provider="fake", _env_file=None, **kw)


def events(r):
    return [json.loads(ln[6:]) for ln in r.text.splitlines() if ln.startswith("data: {")]


def trace(r):
    return [e["trace"] for e in events(r) if "trace" in e]


def text(r):
    return "".join(e["delta"] for e in events(r) if "delta" in e)


class NoToolCalling:
    """Answers fine in plain mode but rejects the tool-calling request, like a model without function calling."""

    async def stream(self, system, messages):
        yield "Plain pipeline answer "

    async def stream_turn(self, system, transcript, tools):
        raise LLMError("The AI service is temporarily unavailable.")
        yield  # pragma: no cover


class FailsAfterAnswering:
    async def stream(self, system, messages):
        yield "pipeline "

    async def stream_turn(self, system, transcript, tools):
        yield "Started answering "
        yield ModelTurn(text="Started answering ")
        raise LLMError("late failure")  # pragma: no cover


def test_agent_failure_before_any_answer_falls_back_to_the_pipeline():
    with TestClient(create_app(S())) as c:
        c.app.state.llm = NoToolCalling()
        r = c.post("/api/chat", json={"message": "What did he do at Inorbvict?", "mode": "agent"})
        c.portal.call(c.app.state.telemetry.drain)
        stats = c.get("/api/stats").json()
    assert r.status_code == 200 and "Plain pipeline answer" in text(r) and r.text.rstrip().endswith("[DONE]")
    assert not any("error" in e for e in events(r))  # the visitor never sees the failure
    metas = [t for t in trace(r) if t["phase"] == "meta"]
    assert [m["mode"] for m in metas] == ["agent", "pipeline"] and "fast pipeline" in metas[-1]["note"]
    ends = {t["id"]: t for t in trace(r) if t["phase"] == "end"}
    assert ends["step_1"]["status"] == "error"  # the failed agent step is shown honestly, not hidden
    assert {"embed", "dense", "keyword", "fuse", "prompt", "llm"} <= set(ends)  # then the full pipeline ran
    assert stats["runs"]["by_mode"]["pipeline"] == 1 and stats["agent"]["fallbacks"] == 1


def test_fallback_can_be_switched_off_to_see_the_real_error():
    with TestClient(create_app(S(agent_fallback=False))) as c:
        c.app.state.llm = NoToolCalling()
        r = c.post("/api/chat", json={"message": "hello there", "mode": "agent"})
    assert events(r)[-1] == {"error": "The AI service is temporarily unavailable."} and "Plain pipeline" not in r.text


def test_no_fallback_once_the_visitor_has_already_seen_text():
    with TestClient(create_app(S())) as c:
        c.app.state.llm = FailsAfterAnswering()
        r = c.post("/api/chat", json={"message": "hello there", "mode": "agent"})
    # an answer was already streaming: switching to a second answer would be worse than ending cleanly
    assert "pipeline " not in text(r)
