"""
Container startup bootstrap (Phase 5 — docs/SAAS_ARCHITECTURE.md §10).

Run once before the web server starts:
  * single-tenant (TENANCY=single, the default) → create/upgrade the schema via
    database.init_db().
  * schema-per-tenant (TENANCY=schema) → ensure the shared `public` catalog
    tables exist (tenants + platform_admins). Business schemas are provisioned
    per-tenant through the platform API, not here.

Idempotent — safe to run on every deploy/restart.
"""
import os
import time
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _check_storage():
    """Validate document storage before serving traffic (see storage.py)."""
    import storage
    info = storage.validate_config()
    if not info.get("checked"):
        print(f"bootstrap: storage={info['backend']} - {info['detail']}", flush=True)
    elif info.get("reachable"):
        print(f"bootstrap: storage=s3 bucket={info['bucket']} reachable.", flush=True)
    else:
        # Config is valid but the bucket did not answer. Warn loudly and carry
        # on: a blip must not keep the whole ERP down.
        print(f"bootstrap: WARNING storage=s3 bucket={info['bucket']} "
              f"unreachable - {info.get('warning')}", flush=True)


def main():
    from tenant_context import IS_SCHEMA_TENANCY
    if IS_SCHEMA_TENANCY:
        import tenancy
        raw = tenancy._connect()
        try:
            tenancy.ensure_tenants_catalog(raw)
            tenancy.ensure_platform_admins_catalog(raw)
        finally:
            raw.close()
        print("bootstrap: schema-per-tenant catalog ready "
              "(provision tenants via /api/platform).", flush=True)

        # The schema pass for `public` and every tenant. This is the release
        # phase -- it runs ONCE, before any container starts, instead of once
        # per gunicorn worker at import time.
        #
        # A failure here fails the deploy, deliberately. It used to be swallowed
        # so one broken tenant could not stop the service booting; in a release
        # phase that would mean shipping code which expects a column one tenant
        # does not have, which is the outage the upgrade exists to prevent.
        # ALLOW_PARTIAL_MIGRATION=1 restores the old behaviour when an operator
        # decides a stuck tenant should not hold the others back.
        import database
        started = time.perf_counter()
        database._init_db_postgres()
        print("bootstrap: schema pass finished in %.1fs"
              % (time.perf_counter() - started), flush=True)

        failed = getattr(database, "LAST_TENANT_UPGRADE_FAILURES", {}) or {}
        if failed and os.environ.get("ALLOW_PARTIAL_MIGRATION", "0") != "1":
            for slug, err in failed.items():
                print(f"bootstrap: FAILED {slug}: {err}", flush=True)
            raise SystemExit(
                "bootstrap: %d tenant(s) did not reach the current schema. "
                "Deploying now would serve code that expects columns they do "
                "not have. Fix them, or set ALLOW_PARTIAL_MIGRATION=1 to "
                "proceed knowingly." % len(failed))

        # Optional first-operator seeding. Without this the vendor console is
        # unreachable on a fresh cloud deploy: nothing creates a platform admin,
        # and the container is the only place that can talk to the private
        # database, so there is no way in from outside.
        #
        # Set PLATFORM_ADMIN_USERNAME (and optionally PLATFORM_ADMIN_PASSWORD)
        # to seed one. Idempotent: create_platform_admin upserts, so redeploys
        # simply reset the password to whatever the variable holds. Leave the
        # password unset and a strong one is generated and printed ONCE below —
        # capture it from the deploy log, then remove the variables.
        admin_user = (os.environ.get("PLATFORM_ADMIN_USERNAME") or "").strip()
        if admin_user:
            admin_pass = (os.environ.get("PLATFORM_ADMIN_PASSWORD") or "").strip()
            result = tenancy.create_platform_admin(admin_user, admin_pass or None)
            if admin_pass:
                print(f"bootstrap: platform operator '{result['username']}' ready "
                      "(password taken from PLATFORM_ADMIN_PASSWORD).", flush=True)
            else:
                # Printed once, to the deploy log only.
                print("bootstrap: platform operator created — "
                      f"username={result['username']} "
                      f"password={result['password']}", flush=True)
                print("bootstrap: capture that password now, then unset "
                      "PLATFORM_ADMIN_USERNAME to stop reseeding.", flush=True)
    else:
        import database
        database.init_db()
        print("bootstrap: single-tenant schema ready.", flush=True)
    _check_storage()


if __name__ == "__main__":
    main()
