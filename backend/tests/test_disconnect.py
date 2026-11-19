"""A visitor who closes the tab must stop costing us model calls. Tested through a REAL uvicorn server, because
middleware (BaseHTTPMiddleware) can swallow disconnects and an in-process test client cannot show that."""
import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from app.config import Settings
from app.llm.base import ModelTurn, ToolCall
from app.main import create_app


class Hanging:
    """A model that answers slowly forever and records whether it was cancelled."""

    def __init__(self):
        self.slow_turn_started = threading.Event()
        self.cancelled = threading.Event()

    async def stream(self, system, messages):
        self.slow_turn_started.set()
        try:
            for _ in range(600):
                await asyncio.sleep(0.05)
                yield "word "
        except asyncio.CancelledError:
            self.cancelled.set()
            raise

    async def stream_turn(self, system, transcript, tools):
        try:
            if len(transcript) < 3:  # first turn: ask for a tool, so the loop is mid-run when the client leaves
                yield ModelTurn(tool_calls=[ToolCall("list_projects", {}, "c1")])
            else:
                self.slow_turn_started.set()
                for _ in range(600):
                    await asyncio.sleep(0.05)
                    yield "word "
                yield ModelTurn(text="done")
        except asyncio.CancelledError:
            self.cancelled.set()
            raise


@pytest.fixture
def live_server():
    s = Settings(llm_provider="fake", vector_store="memory", embedding_provider="fake", rate_limit_per_minute=100,
                 _env_file=None)
    app = create_app(s)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, fd=sock.fileno(), log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.1)
    llm = Hanging()
    app.state.llm = llm  # swapped after startup: the lifespan has run by now
    yield f"http://127.0.0.1:{port}", llm, app
    server.should_exit = True
    t.join(timeout=10)


@pytest.mark.parametrize("mode,leave_when", [("pipeline", '"llm"'), ("agent", '"step_2"')])
def test_closing_the_connection_cancels_the_model_call(live_server, mode, leave_when):
    url, llm, _app = live_server
    body = {"message": "hello there", "mode": mode}
    with httpx.Client(timeout=15) as c, c.stream("POST", f"{url}/api/chat", json=body) as r:
        assert r.status_code == 200
        for line in r.iter_lines():  # walk away only once the slow model call is demonstrably in progress
            if line.startswith("data:") and leave_when in line and '"start"' in line:
                break
        assert llm.slow_turn_started.wait(5)
    assert llm.cancelled.wait(5), f"{mode}: the model call kept running after the client disconnected"


def test_an_abandoned_agent_run_is_recorded_as_cancelled_and_still_charged(live_server):
    url, llm, _app = live_server
    body = {"message": "hello there", "mode": "agent"}
    with httpx.Client(timeout=15) as c:
        before = c.get(f"{url}/api/stats?window=all").json()["runs"]["by_outcome"]["cancelled"]
        spent_before = _app.state.limiter._global
        with c.stream("POST", f"{url}/api/chat", json=body) as r:
            for line in r.iter_lines():
                if line.startswith("data:") and '"step_2"' in line and '"start"' in line:
                    break
        assert llm.cancelled.wait(5)
        deadline = time.time() + 5
        while time.time() < deadline:  # the recording is fire-and-forget: give it a moment
            stats = c.get(f"{url}/api/stats?window=all").json()
            if stats["runs"]["by_outcome"]["cancelled"] > before:
                break
            time.sleep(0.1)
    assert stats["runs"]["by_outcome"]["cancelled"] == before + 1
    # check() counted 1 call; two model calls were really started (step_1, step_2), so one more is charged
    assert _app.state.limiter._global - spent_before == 2
