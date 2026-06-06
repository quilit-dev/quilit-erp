"""
Phase 4 — caching abstraction (cache.py).

CACHE=none (default) is a pure passthrough; CACHE=redis caches with tenant-scoped
keys + TTL. The redis path is exercised in-process with fakeredis (no server).
"""
import pytest

import cache
from tenant_context import set_current_schema, reset_current_schema

fakeredis = pytest.importorskip("fakeredis")


@pytest.fixture(autouse=True)
def fresh_db():
    yield                      # these tests need neither the app nor a database


@pytest.fixture
def redis_mode(monkeypatch):
    monkeypatch.setattr(cache, "CACHE", "redis")
    cache.reset()
    monkeypatch.setattr(cache, "_client", fakeredis.FakeStrictRedis())
    yield
    cache.reset()


# ── default (none) backend ───────────────────────────────────────────────────

def test_none_backend_never_caches():
    calls = []
    def producer():
        calls.append(1)
        return "v"
    assert cache.get_or_set("k", 60, producer) == "v"
    assert cache.get_or_set("k", 60, producer) == "v"
    assert len(calls) == 2          # producer runs every time — no caching
    assert cache.enabled() is False


# ── redis backend (fakeredis) ────────────────────────────────────────────────

def test_redis_caches_then_invalidates(redis_mode):
    calls = []
    def producer():
        calls.append(1)
        return "v1"
    assert cache.get_or_set("k", 60, producer) == "v1"
    assert cache.get_or_set("k", 60, producer) == "v1"
    assert len(calls) == 1          # second read served from cache
    cache.delete("k")
    assert cache.get_or_set("k", 60, lambda: "v2") == "v2"   # recomputed after delete


def test_redis_caches_none_value(redis_mode):
    calls = []
    def producer():
        calls.append(1)
        return None
    assert cache.get_or_set("n", 60, producer) is None
    assert cache.get_or_set("n", 60, producer) is None
    assert len(calls) == 1          # a cached None is distinguished from a miss


def test_delete_prefix(redis_mode):
    cache.get_or_set("setting:a", 60, lambda: "1")
    cache.get_or_set("setting:b", 60, lambda: "2")
    cache.delete_prefix("setting:")
    calls = []
    cache.get_or_set("setting:a", 60, lambda: (calls.append(1), "1")[1])
    assert len(calls) == 1          # prefix wipe forced a recompute


def test_keys_are_tenant_scoped(redis_mode):
    tok = set_current_schema("tenant_a")
    try:
        cache.get_or_set("k", 60, lambda: "A")
    finally:
        reset_current_schema(tok)

    tok = set_current_schema("tenant_b")
    try:
        calls = []
        v = cache.get_or_set("k", 60, lambda: (calls.append(1), "B")[1])
        assert v == "B" and len(calls) == 1   # tenant_b cannot see tenant_a's entry
    finally:
        reset_current_schema(tok)
