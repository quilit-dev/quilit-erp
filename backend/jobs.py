"""
Background-job abstraction (Phase 4 — docs/SAAS_ARCHITECTURE.md §9).

``JOBS`` selects how registered jobs run:
  * ``inline`` (default) — run synchronously, in-process, right now, and return
                           the result. Identical to a plain function call, so the
                           default suite and desktop builds are unaffected.
  * ``rq``               — enqueue onto Redis (RQ) for a separate worker; returns
                           the job id. The CURRENT tenant schema is captured and
                           re-applied in the worker so the job runs in the right
                           tenant.

Jobs are registered by name with ``@job("name")`` and dispatched with
``enqueue("name", *args, **kwargs)``. redis/rq are imported lazily, so neither is
required for the default ``inline`` backend (they stay out of the desktop bundle).
"""
import os

JOBS = os.environ.get("JOBS", "inline").lower()


def async_enabled() -> bool:
    return JOBS in ("rq", "redis")


# name -> callable. Populated by @job at import time (worker imports the app, so
# every router's jobs register).
_REGISTRY = {}


def job(name):
    def deco(fn):
        _REGISTRY[name] = fn
        fn._job_name = name
        return fn
    return deco


def registered(name) -> bool:
    return name in _REGISTRY


def run_with_tenant(name, schema, args, kwargs):
    """Top-level entry the RQ worker executes: re-establish the tenant schema in
    this process, then run the registered job. Imported by reference, so it must
    stay module-level and picklable-friendly."""
    from tenant_context import set_current_schema, reset_current_schema
    token = set_current_schema(schema)
    try:
        return _REGISTRY[name](*args, **kwargs)
    finally:
        reset_current_schema(token)


_queue = None


def reset():
    """Drop the cached queue (used by tests to inject a fake Redis)."""
    global _queue
    _queue = None


def _get_queue():
    global _queue
    if _queue is None:
        import redis
        from rq import Queue
        conn = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
        _queue = Queue("erp", connection=conn)
    return _queue


def enqueue(name, *args, **kwargs):
    """Dispatch a registered job. JOBS=inline runs it now and returns its result;
    JOBS=rq enqueues it and returns the RQ job id."""
    if name not in _REGISTRY:
        raise KeyError(f"unknown job {name!r}")
    if not async_enabled():
        return _REGISTRY[name](*args, **kwargs)
    from tenant_context import current_schema
    rq_job = _get_queue().enqueue(run_with_tenant, name, current_schema(), args, kwargs)
    return rq_job.id
