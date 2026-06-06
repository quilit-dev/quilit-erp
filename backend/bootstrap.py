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
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


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
    else:
        import database
        database.init_db()
        print("bootstrap: single-tenant schema ready.", flush=True)


if __name__ == "__main__":
    main()
