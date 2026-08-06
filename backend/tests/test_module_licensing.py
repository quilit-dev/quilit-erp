"""
Module licensing — upgrade, downgrade, and the fail-open.

Runs ONLY in multi-tenant mode and ONLY on Postgres:

    TENANCY=schema DB_BACKEND=postgres \
      python -m pytest tests/test_module_licensing.py -q

These cover a bug that was invisible from the outside: update_tenant() popped
_MODULES_CACHE by SLUG while the cache is keyed by SCHEMA, so changing a
licence never invalidated anything. The operator saved, the catalog row
changed, and the running process kept enforcing the old licence — a customer
paid for an upgrade and did not receive it, or kept access after a downgrade.

Money depends on these, in both directions: a tenant seeing an unlicensed
module is revenue given away, and a tenant losing a licensed one is an outage.
"""
import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="module licensing tests require TENANCY=schema and DB_BACKEND=postgres",
)

from fastapi.testclient import TestClient   # noqa: E402

TEST_PW = "Licence1234!"


@pytest.fixture(autouse=True)
def fresh_db():
    yield


def _set_admin_password(schema, password):
    import psycopg
    from auth_utils import hash_password
    from database import _pg_dsn
    raw = psycopg.connect(_pg_dsn())
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{schema}", public')
            cur.execute("UPDATE users SET password_hash=%s, must_change_password=0 "
                        "WHERE username='admin'", (hash_password(password),))
        raw.commit()
    finally:
        raw.close()


@pytest.fixture(scope="module")
def lic(app):
    import tenancy
    t = tenancy.provision_tenant("licco", name="Licence Co")
    _set_admin_password(t["schema_name"], TEST_PW)
    return "licco"


def _login(app, slug):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "admin", "password": TEST_PW},
               headers={"X-Tenant": slug})
    assert r.status_code == 200, r.text
    return c


def test_no_licence_means_every_module(app, lic):
    """The fail-open, pinned deliberately.

    A tenant with no licence recorded sees everything. That is intentional for
    dev/demo, and it is why the Control Center now flags such a business in
    yellow — but it must stay a CHOICE, visible in a test, rather than an
    accident nobody remembers making.
    """
    import tenancy
    tenancy.update_tenant("licco", {"modules": []})
    c = _login(app, "licco")
    assert c.get("/api/hr/employees").status_code == 200


def test_upgrade_takes_effect_immediately(app, lic):
    """Assigning a licence must restrict the SAME running process at once.

    This is the regression: the cache was popped under the wrong key, so this
    request kept returning 200 long after the operator saved.
    """
    import tenancy
    c = _login(app, "licco")
    tenancy.update_tenant("licco", {"modules": ["clients", "invoices"]})

    assert c.get("/api/hr/employees").status_code == 403      # not licensed
    assert c.get("/api/clients/").status_code == 200          # licensed
    assert c.get("/api/invoices/").status_code == 200         # licensed


def test_downgrade_revokes_but_keeps_data(app, lic):
    """A downgrade hides a module; it must never destroy the records behind it,
    so re-enabling restores the same data. That promise is printed on the
    editor's confirm screen, so it is tested here."""
    import tenancy
    c = _login(app, "licco")

    # `hr` is chosen as the module to drop because nothing else here depends on
    # it. Dropping `clients` while keeping `invoices` would be undone by the
    # closure (invoices requires clients) — which is correct, and is why the
    # console locks such a checkbox rather than offering a downgrade that
    # silently does nothing.
    tenancy.update_tenant("licco", {"modules": ["clients", "hr"]})
    r = c.post("/api/clients/", json={"name": "Kept Through Downgrade"})
    assert r.status_code in (200, 201), r.text

    tenancy.update_tenant("licco", {"modules": ["hr"]})
    assert c.get("/api/clients/").status_code == 403          # revoked

    tenancy.update_tenant("licco", {"modules": ["clients", "hr"]})
    names = {x["name"] for x in c.get("/api/clients/").json()}
    assert "Kept Through Downgrade" in names                  # data survived


def test_a_dependency_cannot_be_downgraded_away(app, lic):
    """Dropping a module that something still licensed depends on must be a
    no-op, not a broken licence. The console locks the checkbox; the backend
    closure is what actually guarantees it."""
    import tenancy
    c = _login(app, "licco")
    tenancy.update_tenant("licco", {"modules": ["invoices"]})   # implies clients
    assert c.get("/api/clients/").status_code == 200
    assert "clients" in tenancy.tenant_modules("tenant_licco")


def test_dependencies_are_closed_on_save(app, lic):
    """Point of Sale cannot work without what it reads. Selecting it alone must
    license its dependencies too, or the customer buys a module that 500s."""
    import tenancy, capabilities
    tenancy.update_tenant("licco", {"modules": ["pos"]})
    effective = tenancy.tenant_modules("tenant_licco")
    assert effective is not None
    for dep in capabilities.resolve({"pos"}):
        assert dep in effective, f"{dep} missing — pos would break"


def test_selected_set_is_stored_not_the_closure(app, lic):
    """The catalog stores what the operator PICKED; the closure is recomputed on
    read. Storing the closure instead would make a later change to the
    dependency graph silently wrong for existing customers."""
    import tenancy
    tenancy.update_tenant("licco", {"modules": ["pos"]})
    row = [t for t in tenancy.list_tenants() if t["slug"] == "licco"][0]
    assert row["modules"] == "pos"
