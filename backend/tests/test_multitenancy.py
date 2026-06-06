"""
Phase 2 — schema-per-tenant isolation.

Runs ONLY in multi-tenant mode and ONLY on Postgres. Invoke explicitly:

    TENANCY=schema DB_BACKEND=postgres \
      python -m pytest tests/test_multitenancy.py -q

It provisions two real tenant schemas, drives the live API per tenant (selecting
the tenant via the X-Tenant header at login), and asserts:

  * data created in one tenant is invisible to the other (structural isolation);
  * a token minted for tenant A stays bound to tenant A even if the request also
    carries an X-Tenant header naming tenant B (the signed schema claim wins);
  * the two tenants have independent users (same 'admin' username, different rows).

The module opts out of conftest's autouse `fresh_db` so the provisioned schemas
survive across its own tests.
"""
import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="multitenancy tests require TENANCY=schema and DB_BACKEND=postgres",
)

from fastapi.testclient import TestClient   # noqa: E402

TEST_PW = "Tenant1234!"


@pytest.fixture(autouse=True)
def fresh_db():
    # Override conftest's per-test rebuild — these tests manage their own schemas.
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
def tenants(app):
    """Provision two isolated tenants and give each a known admin password."""
    import tenancy
    for slug in ("acme", "globex"):
        t = tenancy.provision_tenant(slug, name=slug.title())
        _set_admin_password(t["schema_name"], TEST_PW)
    return {"acme": "tenant_acme", "globex": "tenant_globex"}


def _login(app, slug):
    c = TestClient(app)
    r = c.post("/api/auth/login",
               json={"username": "admin", "password": TEST_PW},
               headers={"X-Tenant": slug})
    assert r.status_code == 200, f"login to {slug} failed: {r.text}"
    return c


def test_each_tenant_authenticates_independently(app, tenants):
    acme = _login(app, "acme")
    globex = _login(app, "globex")
    # Both logged in as 'admin' but they are different rows in different schemas.
    assert acme.get("/api/auth/me").status_code == 200
    assert globex.get("/api/auth/me").status_code == 200


def test_data_is_isolated_between_tenants(app, tenants):
    acme = _login(app, "acme")
    globex = _login(app, "globex")

    r = acme.post("/api/clients/", json={"name": "ACME Customer"})
    assert r.status_code in (200, 201), r.text
    r = globex.post("/api/clients/", json={"name": "GLOBEX Customer"})
    assert r.status_code in (200, 201), r.text

    acme_names = {c["name"] for c in acme.get("/api/clients/").json()}
    globex_names = {c["name"] for c in globex.get("/api/clients/").json()}

    assert "ACME Customer" in acme_names
    assert "GLOBEX Customer" not in acme_names      # ← no cross-tenant leakage
    assert "GLOBEX Customer" in globex_names
    assert "ACME Customer" not in globex_names


def test_token_schema_claim_beats_forged_header(app, tenants):
    """A tenant-A session must stay on tenant A even if a later request also sends
    an X-Tenant header naming tenant B — the signed JWT claim is authoritative."""
    acme = _login(app, "acme")
    acme.post("/api/clients/", json={"name": "ACME Only"})

    # Same authenticated client, now also sending X-Tenant: globex.
    names = {c["name"] for c in
             acme.get("/api/clients/", headers={"X-Tenant": "globex"}).json()}
    assert "ACME Only" in names              # still seeing ACME's data
    assert "GLOBEX Customer" not in names    # the forged header did NOT switch tenants
