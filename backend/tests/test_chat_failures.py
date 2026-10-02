"""Every failure inside a chat turn must become a clean error event, never a dropped connection."""
import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def S(**kw):
    kw.setdefault("rag_min_score", 0.15)
    kw.setdefault("rate_limit_per_minute", 500)
    return Settings(llm_provider="fake", vector_store="memory", embedding_provider="fake", _env_file=None, **kw)


def events(r):
    return [json.loads(ln[6:]) for ln in r.text.splitlines() if ln.startswith("data: {")]


def ends(r):
    return {e["trace"]["id"]: e["trace"] for e in events(r) if "trace" in e and e["trace"]["phase"] == "end"}


class Stalls:
    async def stream(self, system, messages):
        await asyncio.sleep(30)
        yield "never"


class Explodes:
    async def stream(self, system, messages):
        yield "partial "
        raise RuntimeError("secret key AIza-123 and /etc/passwd leaked in this message")

    async def stream_turn(self, system, transcript, tools):
        raise RuntimeError("secret key AIza-123 and /etc/passwd leaked in this message")
        yield  # pragma: no cover


def test_a_stalled_model_times_out_instead_of_hanging():
    with TestClient(create_app(S(llm_timeout_s=0.3))) as c:
        c.app.state.llm = Stalls()
        r = c.post("/api/chat", json={"message": "hello"})
    assert r.status_code == 200
    assert events(r)[-1] == {"error": "The AI service took too long to answer. Please try again."}
    assert ends(r)["llm"]["status"] == "error" and ends(r)["llm"]["detail"] == "timed out"
    assert "[DONE]" not in r.text


@pytest.mark.parametrize("mode", ["pipeline", "agent"])
def test_unexpected_exceptions_become_a_generic_error_event(mode):
    with TestClient(create_app(S())) as c:
        c.app.state.llm = Explodes()
        r = c.post("/api/chat", json={"message": "hello there", "mode": mode})
    assert r.status_code == 200
    last = events(r)[-1]
    assert last == {"error": "Something went wrong while answering. Please try again."}
    assert "AIza" not in r.text and "/etc/passwd" not in r.text  # the real error stays in the logs
    assert "[DONE]" not in r.text


def test_a_failed_run_is_recorded_as_an_error():
    with TestClient(create_app(S())) as c:
        c.app.state.llm = Explodes()
        c.post("/api/chat", json={"message": "hello there"})
        c.portal.call(c.app.state.telemetry.drain)
        assert c.get("/api/stats").json()["runs"]["by_outcome"]["error"] == 1
