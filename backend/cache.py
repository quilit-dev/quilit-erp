"""
Caching abstraction (Phase 4 — docs/SAAS_ARCHITECTURE.md §9).

``CACHE`` selects the backend:
  * ``none``  (default) — no caching. ``get_or_set`` just calls the producer and
                          returns its value; ``delete``/``delete_prefix`` are
                          no-ops. Behavior is byte-identical to no cache at all,
                          so the default test-suite and desktop builds are
                          unaffected.
  * ``redis``           — values are cached in Redis (``REDIS_URL``) with a TTL.

Keys are TENANT-SCOPED (prefixed with the active request's schema) so tenants
never read each other's cached values. Values are JSON-serialised (no pickle —
avoids deserialisation-RCE surface), which fits the cached data here (settings
strings / small dicts). redis is imported lazily, so it is never required for the
default ``none`` backend.
"""
import json
import os

CACHE = os.environ.get("CACHE", "none").lower()


def enabled() -> bool:
    return CACHE in ("redis",)


_client = None


def reset():
    """Drop the cached client (used by tests to inject a fake Redis)."""
    global _client
    _client = None


def _redis():
    global _client
    if _client is None:
        import redis
        _client = redis.Redis.from_url(
            os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    return _client


def _key(key: str) -> str:
    from tenant_context import current_schema
    return f"erp:{current_schema()}:{key}"


def get_or_set(key: str, ttl: int, producer):
    """Return the cached value for ``key``, or compute it via ``producer()``,
    cache it for ``ttl`` seconds, and return it. With CACHE=none this is exactly
    ``producer()`` — no caching, no Redis."""
    if not enabled():
        return producer()
    rk = _key(key)
    try:
        hit = _redis().get(rk)
        if hit is not None:
            return json.loads(hit)
    except Exception:
        return producer()        # Redis hiccup must never break the request
    value = producer()
    try:
        _redis().set(rk, json.dumps(value), ex=ttl)
    except Exception:
        pass
    return value


def delete(key: str) -> None:
    if not enabled():
        return
    try:
        _redis().delete(_key(key))
    except Exception:
        pass


def delete_prefix(prefix: str) -> None:
    """Invalidate every key under ``prefix`` for the current tenant."""
    if not enabled():
        return
    try:
        r = _redis()
        for k in r.scan_iter(_key(prefix) + "*"):
            r.delete(k)
    except Exception:
        pass
