"""
Periodic task scheduler (Feature #1).

Run as its own process alongside the app + worker:

    SCHEDULER_TICK=3600 python backend/scheduler.py

Every ``SCHEDULER_TICK`` seconds it runs all registered periodic tasks
(scheduled_tasks.PERIODIC) for every ACTIVE tenant (schema mode) or for the
single install. Tasks are idempotent, so the tick interval only affects latency,
never correctness. Email/SMTP being off makes the tasks no-ops, so this is safe to
run with the default configuration.
"""
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _run_for_current_tenant():
    """Run every periodic task once for the active connection. Returns
    {task_name: count} for the work it did (0-counts omitted)."""
    import database
    import scheduled_tasks
    results = {}
    with database.session() as db:
        for name, fn in scheduled_tasks.PERIODIC:
            try:
                n = fn(db)
                if n:
                    print(f"scheduler: {name} → {n}", flush=True)
                    results[name] = results.get(name, 0) + int(n)
            except Exception:
                print(f"scheduler: {name} FAILED\n{traceback.format_exc()}", flush=True)
    return results


def run_once():
    """One sweep across all tenants (or the single install). Returns an
    aggregated {task_name: count} summary."""
    from tenant_context import IS_SCHEMA_TENANCY, set_current_schema, reset_current_schema
    totals = {}

    def _merge(r):
        for k, v in r.items():
            totals[k] = totals.get(k, 0) + v

    if IS_SCHEMA_TENANCY:
        import tenancy
        for t in tenancy.list_tenants():
            if t.get("status") != "active":
                continue
            token = set_current_schema(t["schema_name"])
            try:
                _merge(_run_for_current_tenant())
            finally:
                reset_current_schema(token)
    else:
        _merge(_run_for_current_tenant())
    return totals


def main():
    tick = int(os.environ.get("SCHEDULER_TICK", "3600"))
    print(f"scheduler: started (tick={tick}s)", flush=True)
    while True:
        try:
            run_once()
        except Exception:
            print(f"scheduler: sweep FAILED\n{traceback.format_exc()}", flush=True)
        time.sleep(tick)


if __name__ == "__main__":
    main()
