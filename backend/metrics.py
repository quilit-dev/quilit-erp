"""
Per-tenant API usage, latency and storage growth.

Design constraint: instrumentation must not become the bottleneck it measures.
Writing a row per request would put a database write in front of every call —
at which point the metrics are the slowest thing in the system. So the hot path
only increments an in-memory counter, and a flush folds those counters into the
shared catalog at most once a minute.

    request  ->  dict increment (microseconds, no I/O)
    ~60s     ->  one UPSERT per active tenant

Multiple workers are fine: WEB_CONCURRENCY>1 means several processes each hold
their own counters, and the flush is an additive UPSERT
(requests = requests + excluded.requests), so the day's row ends up as the true
sum rather than whichever worker wrote last.

What is stored, and why only this:
  * requests / client_errors / server_errors — usage and failure rate.
  * total_ms + max_ms — average is total/requests, so two numbers give both the
    typical and the worst case. Percentiles would need histograms per tenant
    per day; that is a lot of machinery for a ten-customer fleet, and average
    plus max already answers "is this customer's ERP slow?".
  * storage snapshots — one row per tenant per day, so growth is derivable.
    Nothing recorded history before, which is why analytics could only ever
    report the current size.

Everything degrades to a no-op rather than raising: telemetry must never take
the ERP down.
"""
import threading
import time
from datetime import datetime

_FLUSH_SECONDS = 60

_lock = threading.Lock()
_pending = {}          # (tenant_slug, day) -> counters
_last_flush = time.monotonic()
_last_snapshot_day = None


def _today():
    return datetime.utcnow().strftime("%Y-%m-%d")


def ensure_catalog(raw) -> None:
    with raw.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.api_metrics (
                tenant_slug   TEXT NOT NULL,
                day           TEXT NOT NULL,
                requests      BIGINT NOT NULL DEFAULT 0,
                client_errors BIGINT NOT NULL DEFAULT 0,
                server_errors BIGINT NOT NULL DEFAULT 0,
                total_ms      DOUBLE PRECISION NOT NULL DEFAULT 0,
                max_ms        DOUBLE PRECISION NOT NULL DEFAULT 0,
                PRIMARY KEY (tenant_slug, day)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.storage_snapshots (
                tenant_slug TEXT NOT NULL,
                day         TEXT NOT NULL,
                db_bytes    BIGINT,
                PRIMARY KEY (tenant_slug, day)
            )
        """)
    raw.commit()


def record(tenant_slug: str, status: int, elapsed_ms: float) -> None:
    """Hot path. A dict update under a short lock — no I/O."""
    if not tenant_slug:
        return
    key = (tenant_slug, _today())
    with _lock:
        c = _pending.get(key)
        if c is None:
            c = _pending[key] = {"requests": 0, "client_errors": 0,
                                 "server_errors": 0, "total_ms": 0.0, "max_ms": 0.0}
        c["requests"] += 1
        c["total_ms"] += elapsed_ms
        if elapsed_ms > c["max_ms"]:
            c["max_ms"] = elapsed_ms
        if 400 <= status < 500:
            c["client_errors"] += 1
        elif status >= 500:
            c["server_errors"] += 1


def due_for_flush() -> bool:
    return (time.monotonic() - _last_flush) >= _FLUSH_SECONDS and bool(_pending)


def flush() -> int:
    """Fold in-memory counters into the catalog. Returns rows written."""
    global _last_flush
    with _lock:
        if not _pending:
            _last_flush = time.monotonic()
            return 0
        batch, _pending_local = dict(_pending), None
        _pending.clear()
        _last_flush = time.monotonic()

    try:
        from tenancy import _connect
        raw = _connect()
    except Exception:
        return 0                       # telemetry must never break the request

    try:
        ensure_catalog(raw)
        with raw.cursor() as cur:
            for (slug, day), c in batch.items():
                cur.execute("""
                    INSERT INTO public.api_metrics
                        (tenant_slug, day, requests, client_errors, server_errors,
                         total_ms, max_ms)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (tenant_slug, day) DO UPDATE SET
                        requests      = public.api_metrics.requests      + EXCLUDED.requests,
                        client_errors = public.api_metrics.client_errors + EXCLUDED.client_errors,
                        server_errors = public.api_metrics.server_errors + EXCLUDED.server_errors,
                        total_ms      = public.api_metrics.total_ms      + EXCLUDED.total_ms,
                        max_ms        = GREATEST(public.api_metrics.max_ms, EXCLUDED.max_ms)
                """, (slug, day, c["requests"], c["client_errors"],
                      c["server_errors"], c["total_ms"], c["max_ms"]))
        raw.commit()
        return len(batch)
    except Exception:
        return 0
    finally:
        raw.close()


def snapshot_storage_if_due() -> bool:
    """One size row per tenant per day, so growth becomes derivable.

    Piggybacks on the flush cycle rather than needing a scheduler: the first
    request after midnight UTC takes the snapshot. ON CONFLICT DO NOTHING makes
    concurrent workers harmless.
    """
    global _last_snapshot_day
    day = _today()
    if _last_snapshot_day == day:
        return False
    _last_snapshot_day = day           # set first: a failure must not spin

    # Same once-a-day slot: expire trials that ran out. Piggybacking here
    # avoids standing up a scheduler for two cheap jobs.
    try:
        import tenancy
        for row in tenancy.expire_due_trials():
            print(f"trial expired -> suspended: {row['slug']} "
                  f"(ended {row['trial_ends_at']})", flush=True)
    except Exception:
        pass

    try:
        from tenancy import _connect
        import health
        raw = _connect()
    except Exception:
        return False
    try:
        ensure_catalog(raw)
        sizes = health._schema_sizes(raw)
        with raw.cursor() as cur:
            cur.execute("SELECT slug, schema_name FROM public.tenants")
            for row in cur.fetchall():
                cur.execute(
                    "INSERT INTO public.storage_snapshots (tenant_slug, day, db_bytes) "
                    "VALUES (%s,%s,%s) ON CONFLICT (tenant_slug, day) DO NOTHING",
                    (row["slug"], day, sizes.get(row["schema_name"])))
        raw.commit()
        return True
    except Exception:
        return False
    finally:
        raw.close()


# ── read side ────────────────────────────────────────────────────────────────

def usage_for(slug: str, days: int = 30) -> list:
    """Daily request volume, error rate and latency for one tenant."""
    try:
        from tenancy import _connect
        raw = _connect()
    except Exception:
        return []
    try:
        ensure_catalog(raw)
        with raw.cursor() as cur:
            cur.execute("""
                SELECT day, requests, client_errors, server_errors,
                       ROUND((total_ms / NULLIF(requests, 0))::numeric, 1) AS avg_ms,
                       ROUND(max_ms::numeric, 1) AS max_ms
                FROM public.api_metrics
                WHERE tenant_slug = %s
                  AND day >= to_char(now() - make_interval(days => %s), 'YYYY-MM-DD')
                ORDER BY day
            """, (slug, days))
            return [dict(r) for r in cur.fetchall()]
    except Exception:
        return []
    finally:
        raw.close()


def storage_for(slug: str, days: int = 90) -> list:
    try:
        from tenancy import _connect
        raw = _connect()
    except Exception:
        return []
    try:
        ensure_catalog(raw)
        with raw.cursor() as cur:
            cur.execute("""
                SELECT day, db_bytes FROM public.storage_snapshots
                WHERE tenant_slug = %s
                  AND day >= to_char(now() - make_interval(days => %s), 'YYYY-MM-DD')
                ORDER BY day
            """, (slug, days))
            return [dict(r) for r in cur.fetchall()]
    except Exception:
        return []
    finally:
        raw.close()
