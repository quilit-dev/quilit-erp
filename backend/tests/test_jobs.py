"""
Phase 4 — background-jobs abstraction (jobs.py).

JOBS=inline (default) runs a job synchronously and returns its result — identical
to a plain call. JOBS=rq enqueues it for a worker (no worker is run here; we only
assert it was queued, capturing the tenant). The rq path uses fakeredis.
"""
import pytest

import jobs

fakeredis = pytest.importorskip("fakeredis")

_runs = []


@jobs.job("test.echo")
def _echo(x):
    _runs.append(x)
    return x * 2


@pytest.fixture(autouse=True)
def fresh_db():
    yield


# ── default (inline) backend ─────────────────────────────────────────────────

def test_inline_runs_synchronously():
    _runs.clear()
    result = jobs.enqueue("test.echo", 21)
    assert result == 42            # returns the job's result directly
    assert _runs == [21]           # ran now, in-process
    assert jobs.async_enabled() is False


def test_unknown_job_raises():
    with pytest.raises(KeyError):
        jobs.enqueue("does.not.exist")


# ── rq backend (fakeredis) ───────────────────────────────────────────────────

@pytest.fixture
def rq_mode(monkeypatch):
    monkeypatch.setattr(jobs, "JOBS", "rq")
    jobs.reset()
    from rq import Queue
    q = Queue("erp", connection=fakeredis.FakeStrictRedis())
    monkeypatch.setattr(jobs, "_queue", q)
    yield q
    jobs.reset()


def test_rq_enqueues_without_running_inline(rq_mode):
    _runs.clear()
    from tenant_context import set_current_schema, reset_current_schema
    tok = set_current_schema("tenant_x")
    try:
        job_id = jobs.enqueue("test.echo", 7)
    finally:
        reset_current_schema(tok)

    assert isinstance(job_id, str)
    assert _runs == []                       # NOT executed inline
    assert len(rq_mode) == 1                 # exactly one job queued

    queued = rq_mode.jobs[0]
    # The worker entry is run_with_tenant(name, schema, args, kwargs).
    assert queued.args[0] == "test.echo"
    assert queued.args[1] == "tenant_x"      # tenant captured for the worker
    assert queued.args[2] == (7,)
