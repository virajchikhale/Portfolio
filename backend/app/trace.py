"""Per-request trace of the pipeline, streamed to the browser so the UI can visualise it ("Flow Monitor").

Every stage emits a `start` and an `end` event with REAL timestamps (ms since the request began), so the UI can
replay the true timings at any speed. Events carry only what is safe and useful to show:

  shown:   stage names, durations, retrieved chunk labels/scores/text (public corpus), terms matched, model names
  NEVER:   the system prompt, guardrail patterns, API keys, per-IP rate-limit counters
"""
import time
from dataclasses import dataclass, field


@dataclass
class Tracer:
    enabled: bool = True
    _t0: float = field(default_factory=time.perf_counter)
    _starts: dict[str, float] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    _sent: int = 0

    def now(self) -> float:
        return round((time.perf_counter() - self._t0) * 1000, 1)

    def start(self, stage: str, label: str, detail: str = "") -> None:
        if not self.enabled:
            return
        t = self.now()
        self._starts[stage] = t
        self.events.append({"id": stage, "label": label, "phase": "start", "t": t, "detail": detail})

    def end(self, stage: str, status: str = "ok", detail: str = "", data: dict | None = None) -> None:
        """status: ok | blocked | empty | skipped | error"""
        if not self.enabled:
            return
        t = self.now()
        began = self._starts.pop(stage, t)
        self.events.append({"id": stage, "phase": "end", "t": t, "dur": round(t - began, 1),
                            "status": status, "detail": detail, "data": data or {}})

    def progress(self, stage: str, detail: str) -> None:
        if self.enabled:
            self.events.append({"id": stage, "phase": "progress", "t": self.now(), "detail": detail})

    def skip(self, stage: str, label: str, detail: str, data: dict | None = None) -> None:
        self.start(stage, label)
        self.end(stage, "skipped", detail, data)

    def abort_open(self, detail: str) -> None:
        """Close any stage still open (an exception interrupted it) so the UI never hangs on a spinner."""
        for stage in list(self._starts):
            self.end(stage, "error", detail)

    def drain(self) -> list[dict]:
        """Events produced since the last drain (for streaming them as they happen)."""
        new, self._sent = self.events[self._sent:], len(self.events)
        return new
