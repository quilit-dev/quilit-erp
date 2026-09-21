"""A role added after a tenant installed the Lebanese chart must reach that
tenant pointing at the Lebanese account, not the default one.

install() re-points the roles that exist on the day. A role a later release
adds arrives through _ensure_pg_post_baseline pointing at a DEFAULT-chart code
-- which the tenant retired when it switched. `revenue_exempt` reached hajosign
as 4000, inactive there, and the first untaxed till sale after the deploy was
refused by the postability guard as a 500. `public` had always been tidied by
chart_lebanon.ensure_current at boot; the tenant schemas were not.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="tenant schemas exist only on the Postgres path",
)


@pytest.fixture(autouse=True)
def fresh_db():
    yield


def _tenant_conn(slug):
    import psycopg
    import tenancy
    from database import _pg_dsn
    from db_compat import CompatConn
    from dialect import get_dialect
    raw = psycopg.connect(_pg_dsn(), row_factory=psycopg.rows.dict_row)
    with raw.cursor() as cur:
        cur.execute(f'SET search_path TO "{tenancy.schema_for_slug(slug)}", public')
    return raw, CompatConn(raw, get_dialect("postgres"))


def test_the_boot_pass_re_points_a_later_role_on_a_lebanese_tenant(app):
    import tenancy
    import chart_lebanon as LB
    import accounting

    tenancy.provision_tenant("lebco", name="Leb Co")
    raw, db = _tenant_conn("lebco")
    try:
        LB.install(db)
        # The state a deploy leaves behind: the new role arrived from the
        # post-baseline as the default chart's code, retired on this tenant.
        db.execute("UPDATE account_roles SET code='4000' WHERE role='revenue_exempt'")
        db.execute("UPDATE account_roles SET code='4100' WHERE role='service_revenue_exempt'")
        db.commit()
        assert accounting.code(db, "revenue_exempt") == "4000"
    finally:
        raw.close()

    result = tenancy.upgrade_all_tenant_schemas()
    assert "lebco" in result["upgraded"], result

    raw, db = _tenant_conn("lebco")
    try:
        assert accounting.code(db, "revenue_exempt") == "7012"
        assert accounting.code(db, "service_revenue_exempt") == "7132"
        # And the default-chart stranger the post-baseline inserted is retired.
        row = db.execute("SELECT is_active FROM chart_of_accounts WHERE code='4000'").fetchone()
        assert row is not None and int(row["is_active"]) == 0
    finally:
        raw.close()


def test_a_default_chart_tenant_is_left_exactly_as_it_was(app):
    import tenancy
    import accounting

    tenancy.provision_tenant("defco", name="Default Co")
    tenancy.upgrade_all_tenant_schemas()
    raw, db = _tenant_conn("defco")
    try:
        assert accounting.code(db, "revenue") == "4000"
        assert accounting.code(db, "revenue_exempt") == "4000"
        row = db.execute("SELECT is_active FROM chart_of_accounts WHERE code='4000'").fetchone()
        assert int(row["is_active"]) == 1
    finally:
        raw.close()
