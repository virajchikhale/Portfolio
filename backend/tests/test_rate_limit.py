import pytest
from fastapi import HTTPException

from app.config import Settings
from app.security import rate_limit
from app.security.rate_limit import RateLimiter, limiter_key


def S(**kw):
    return Settings(llm_provider="fake", vector_store="memory", embedding_provider="fake", _env_file=None, **kw)


def test_ipv6_clients_are_grouped_by_their_64_so_one_attacker_cannot_rotate_addresses():
    a = limiter_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
    b = limiter_key("2001:db8:1:2:1111:2222:3333:4444")
    other = limiter_key("2001:db8:1:3::1")
    assert a == b and a != other and a.endswith("/64")


def test_ipv4_and_mapped_addresses_normalise_and_garbage_passes_through():
    assert limiter_key("203.0.113.7") == "203.0.113.7"
    assert limiter_key("::ffff:203.0.113.7") == "203.0.113.7"
    assert limiter_key("not-an-ip") == "not-an-ip"


def test_the_limit_applies_across_one_ipv6_prefix():
    lim = RateLimiter(S(rate_limit_per_minute=2))
    lim.check("2001:db8::1")
    lim.check("2001:db8::2")
    with pytest.raises(HTTPException) as e:
        lim.check("2001:db8::ffff")
    assert e.value.status_code == 429


def test_idle_clients_are_garbage_collected(monkeypatch):
    lim = RateLimiter(S(rate_limit_per_minute=5))
    for i in range(300):
        lim.check(f"198.51.100.{i % 250}")
    assert len(lim._minute) > 100
    lim._gc(now=10**9)  # a long time later: every window is stale
    assert len(lim._minute) == 0


def test_memory_stays_bounded_under_a_flood_of_distinct_clients(monkeypatch):
    monkeypatch.setattr(rate_limit, "MAX_TRACKED_CLIENTS", 100)
    lim = RateLimiter(S(rate_limit_per_minute=5, rate_limit_per_day=1000, daily_global_request_budget=10**9))
    for i in range(5000):
        lim.check(f"10.{i // 250}.{i % 250}.1")
    assert len(lim._day) <= 100 + rate_limit._GC_EVERY and len(lim._minute) <= 100 + rate_limit._GC_EVERY
