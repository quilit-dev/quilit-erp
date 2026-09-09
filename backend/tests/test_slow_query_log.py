"""Finding out which query is slow, without paying for the privilege.

Nothing times SQL today. `metrics.py` records per-tenant p50/p95 but has no
endpoint dimension, so it can tell you a customer is slow and not what is slow;
`logging_setup.py` gives per-request duration and path, unaggregated.

`pg_stat_statements` is the better tool and needs no application code --- but
enabling it is a database change, not a deploy. This is the part that ships
with the app, works on both backends, and answers the same question well
enough to decide whether an optimisation was worth doing.

Two properties matter, and both are asserted here.

**Free when off.** This wrapper is on the path of every statement the
application runs. A disabled feature that still calls perf_counter twice per
query is not disabled.

**Never logs parameters.** The SQL shape identifies the query; the values are
customer data --- invoice totals, salaries, client names --- and logs are the
one place that data has no business being.
"""
import logging
import sqlite3

import pytest

import db_compat
from dialect import get_dialect


@pytest.fixture(autouse=True)
def fresh_db():
    yield                         # in-memory only; the shared harness is not needed


@pytest.fixture()
def conn():
    c = db_compat.CompatConn(sqlite3.connect(":memory:"), get_dialect("sqlite"))
    c.execute("CREATE TABLE t (a INTEGER, secret TEXT)")
    return c


def _records(caplog):
    return [r for r in caplog.records if r.name == "erp.slowquery"]


def test_nothing_is_logged_when_it_is_off(conn, caplog, monkeypatch):
    monkeypatch.setattr(db_compat, "SLOW_QUERY_MS", 0)
    with caplog.at_level(logging.WARNING):
        for _ in range(20):
            conn.execute("SELECT * FROM t WHERE a = ?", (1,))
    assert not _records(caplog)


def test_off_means_the_clock_is_never_even_read(conn, monkeypatch):
    """Free, not merely quiet.

    Every statement in the application passes through here, so a disabled
    feature that still times each one is a tax on the whole system.
    """
    monkeypatch.setattr(db_compat, "SLOW_QUERY_MS", 0)
    calls = {"n": 0}

    def counting_clock():
        calls["n"] += 1
        return 0.0

    monkeypatch.setattr(db_compat, "_perf_counter", counting_clock)
    for _ in range(10):
        conn.execute("SELECT * FROM t WHERE a = ?", (1,))
    assert calls["n"] == 0, (
        "perf_counter was called %d times with the feature off" % calls["n"])


def test_a_slow_query_is_reported(conn, caplog, monkeypatch):
    monkeypatch.setattr(db_compat, "SLOW_QUERY_MS", 0.0001)
    with caplog.at_level(logging.WARNING):
        conn.execute("SELECT * FROM t WHERE a = ?", (1,))
    found = _records(caplog)
    assert found, "nothing was reported above the threshold"
    assert found[0].duration_ms >= 0
    assert "SELECT" in found[0].sql


def test_parameters_are_never_logged(conn, caplog, monkeypatch):
    """The values are customer data. The shape is what identifies the query."""
    monkeypatch.setattr(db_compat, "SLOW_QUERY_MS", 0.0001)
    with caplog.at_level(logging.WARNING):
        conn.execute("SELECT * FROM t WHERE secret = ?", ("hunter2-salary-9000",))
    joined = " ".join(r.sql for r in _records(caplog))
    assert "hunter2" not in joined, "a bound parameter reached the log"
    assert "?" in joined or "%s" in joined, "the placeholder should survive"


def test_a_long_statement_is_truncated(conn, caplog, monkeypatch):
    monkeypatch.setattr(db_compat, "SLOW_QUERY_MS", 0.0001)
    long_sql = "SELECT " + ", ".join(["a"] * 400) + " FROM t"
    with caplog.at_level(logging.WARNING):
        conn.execute(long_sql)
    assert all(len(r.sql) <= 320 for r in _records(caplog)), \
        "a multi-kilobyte statement went into the log in full"


def test_a_fast_query_under_a_high_threshold_is_ignored(conn, caplog, monkeypatch):
    monkeypatch.setattr(db_compat, "SLOW_QUERY_MS", 10_000)
    with caplog.at_level(logging.WARNING):
        conn.execute("SELECT * FROM t")
    assert not _records(caplog)
