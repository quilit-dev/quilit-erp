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
    import database
    import scheduled_tasks
    with database.session() as db:
        for name, fn in scheduled_tasks.PERIODIC:
            try:
                n = fn(db)
                if n:
                    print(f"scheduler: {name} → {n}", flush=True)
            except Exception:
                print(f"scheduler: {name} FAILED\n{traceback.format_exc()}", flush=True)


def run_once():
    """One sweep across all tenants (or the single install)."""
    from tenant_context import IS_SCHEMA_TENANCY, set_current_schema, reset_current_schema
    if IS_SCHEMA_TENANCY:
        import tenancy
        for t in tenancy.list_tenants():
            if t.get("status") != "active":
                continue
            token = set_current_schema(t["schema_name"])
            try:
                _run_for_current_tenant()
            finally:
                reset_current_schema(token)
    else:
        _run_for_current_tenant()


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
