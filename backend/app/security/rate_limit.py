"""In-memory sliding-window limiter + global daily budget.

Fine for a single-instance portfolio. Swap the storage for Redis/Postgres if you ever run >1 replica.
"""
import time
from collections import defaultdict, deque
from datetime import date

from fastapi import HTTPException, Request

from app.config import Settings


class RateLimiter:
    def __init__(self, settings: Settings):
        self._s = settings
        self._minute: dict[str, deque[float]] = defaultdict(deque)
        self._day: dict[str, int] = defaultdict(int)
        self._day_key = date.today()
        self._global = 0

    def _roll_day(self) -> None:
        today = date.today()
        if today != self._day_key:
            self._day_key, self._day, self._global = today, defaultdict(int), 0

    def check(self, client: str) -> None:
        self._roll_day()
        if self._global >= self._s.daily_global_request_budget:
            raise HTTPException(503, "Daily AI budget reached. Please try again tomorrow.")
        if self._day[client] >= self._s.rate_limit_per_day:
            raise HTTPException(429, "Daily limit reached for your connection.")
        now = time.monotonic()
        window = self._minute[client]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= self._s.rate_limit_per_minute:
            raise HTTPException(429, "Too many requests. Slow down.", headers={"Retry-After": "30"})
        window.append(now)
        self._day[client] += 1
        self._global += 1


    def can_afford(self, units: int) -> bool:
        """True if the global daily budget can absorb `units` MORE model calls (used to gate agent mode)."""
        self._roll_day()
        return self._global + units <= self._s.daily_global_request_budget

    def charge(self, units: int) -> None:
        """Count extra model calls (an agent run makes several; check() already counted the first)."""
        self._roll_day()
        self._global += max(0, units)


def client_ip(request: Request, settings: Settings) -> str:
    if settings.trust_proxy_headers:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
