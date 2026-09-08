"""An asset waiting for approval must still reach the ledger after a deploy.

This is the behavioural half of the fixed_assets bug; `test_backfill_guards.py`
is the structural half. It only reproduces on Postgres with schema tenancy,
because the SQLite chain has always had the guard --- which is exactly why the
bug survived a 2,826-test suite for months.

The sequence a real customer hit:

  1. Someone adds a fixed asset. `acquisition_entry_id` is NULL; it always is
     at insert (routers/assets.py).
  2. A capex approval policy holds it pending.
  3. A deploy happens --- any deploy --- and the boot pass runs
     `UPDATE fixed_assets SET is_opening_balance = 1
        WHERE acquisition_entry_id IS NULL` against every tenant schema.
  4. The asset is approved. approval_engine posts the acquisition only
     `if not acquisition_entry_id and not is_opening_balance`, so it skips.

The asset is now on the register, depreciating, and absent from the general
ledger. Nothing raised, nothing logged, and the balance sheet is short by its
cost until somebody reconciles by hand.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="the guard only exists on the Postgres path; SQLite has always been safe",
)

from fastapi.testclient import TestClient   # noqa: E402

TEST_PW = "Tenant1234!"


@pytest.fixture(autouse=True)
def fresh_db():
    yield


@pytest.fixture(scope="module")
def tenant(app):
    import tenancy
    from auth_utils import hash_password
    import psycopg
    from database import _pg_dsn

    slug = "assetco"
    t = tenancy.provision_tenant(slug, name="Asset Co")
    raw = psycopg.connect(_pg_dsn())
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{t["schema_name"]}", public')
            cur.execute("UPDATE users SET password_hash=%s, must_change_password=0 "
                        "WHERE username='admin'", (hash_password(TEST_PW),))
        raw.commit()
    finally:
        raw.close()
    return slug


def _client(app, slug):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "admin", "password": TEST_PW},
               headers={"X-Tenant": slug})
    assert r.status_code == 200, r.text
    return c


def _asset_row(app, slug, asset_id):
    import psycopg
    from database import _pg_dsn
    import tenancy
    raw = psycopg.connect(_pg_dsn(), row_factory=psycopg.rows.dict_row)
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{tenancy.schema_for_slug(slug)}", public')
            cur.execute("SELECT * FROM fixed_assets WHERE id=%s", (asset_id,))
            return cur.fetchone()
    finally:
        raw.close()


def _await_approval(slug, asset_id):
    """Put the asset into the state a capex policy leaves it in.

    Set explicitly rather than by standing up an approval policy, and NOT
    conditionally: an earlier version of this test only asserted
    `if acquisition_entry_id is None`, and on a fresh tenant with no policy
    the acquisition posts immediately --- so the assertion never ran and the
    test passed against the bug it was written to catch.
    """
    import psycopg
    import tenancy
    from database import _pg_dsn
    raw = psycopg.connect(_pg_dsn())
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{tenancy.schema_for_slug(slug)}", public')
            cur.execute("UPDATE fixed_assets SET acquisition_entry_id = NULL, "
                        " is_opening_balance = 0 WHERE id = %s", (asset_id,))
        raw.commit()
    finally:
        raw.close()


def test_a_deploy_does_not_relabel_an_asset_awaiting_its_entry(app, tenant):
    """The core regression: a boot must not touch an asset the app just made."""
    import tenancy
    c = _client(app, tenant)

    r = c.post("/api/assets/", json={
        "name": "Delivery van", "category": "Vehicles",
        "acquisition_cost": 24000, "acquisition_date": "2026-09-01",
        "depreciation_method": "straight_line", "useful_life_months": 60,
        "salvage_value": 0})
    assert r.status_code in (200, 201), r.text
    asset_id = r.json()["id"]

    _await_approval(tenant, asset_id)
    before = _asset_row(app, tenant, asset_id)
    assert before["acquisition_entry_id"] is None, "setup: it is awaiting approval"
    assert before["is_opening_balance"] == 0, "setup: it is a real purchase"

    # A deploy. This is the whole test.
    tenancy.upgrade_all_tenant_schemas()

    after = _asset_row(app, tenant, asset_id)
    assert after["is_opening_balance"] == 0, (
        "a boot pass relabelled an asset as an opening balance. Approved, "
        "approval_engine then skips posting the acquisition (it requires "
        "`not is_opening_balance`), so the asset joins the register and never "
        "reaches the general ledger.")


def test_the_backfill_marker_is_recorded_so_it_runs_once(app, tenant):
    """A guard that never writes its marker repeats on every boot anyway."""
    import psycopg
    import tenancy
    from database import _pg_dsn

    tenancy.upgrade_all_tenant_schemas()
    raw = psycopg.connect(_pg_dsn(), row_factory=psycopg.rows.dict_row)
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{tenancy.schema_for_slug(tenant)}", public')
            cur.execute("SELECT COUNT(*) n FROM schema_migrations "
                        "WHERE name='167j_existing_assets_are_openings'")
            assert cur.fetchone()["n"] >= 1, (
                "the marker was never recorded, so the backfill will run again "
                "on the next boot")
    finally:
        raw.close()


def test_repeated_deploys_leave_the_register_alone(app, tenant):
    """Three boots in a row must be indistinguishable from none."""
    import tenancy
    c = _client(app, tenant)
    r = c.post("/api/assets/", json={
        "name": "Forklift", "category": "Equipment",
        "acquisition_cost": 9000, "acquisition_date": "2026-09-02",
        "depreciation_method": "straight_line", "useful_life_months": 48,
        "salvage_value": 0})
    asset_id = r.json()["id"]

    _await_approval(tenant, asset_id)
    first = _asset_row(app, tenant, asset_id)
    assert first["acquisition_entry_id"] is None, "setup: awaiting approval"
    for _ in range(3):
        tenancy.upgrade_all_tenant_schemas()
    last = _asset_row(app, tenant, asset_id)

    assert last["is_opening_balance"] == first["is_opening_balance"]
    assert last["acquisition_entry_id"] == first["acquisition_entry_id"]
