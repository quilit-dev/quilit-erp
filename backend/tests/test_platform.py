"""
Phase 2 lifecycle — platform-operator API + tenant suspend/activate.

Runs only in multi-tenant mode on Postgres:

    TENANCY=schema DB_BACKEND=postgres \
      python -m pytest tests/test_platform.py -q

Proves: operator auth is required and separate from tenant auth; provisioning via
the API returns first-login credentials that actually work; suspending a tenant
blocks all its requests with 402; re-activating restores access.
"""
import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="platform tests require TENANCY=schema and DB_BACKEND=postgres",
)

from fastapi.testclient import TestClient   # noqa: E402

OP_USER = "operator"
OP_PW = "Operator1234!"


@pytest.fixture(autouse=True)
def fresh_db():
    yield                                    # these tests manage their own state


@pytest.fixture(scope="module")
def platform(app):
    import tenancy
    tenancy.create_platform_admin(OP_USER, OP_PW, full_name="Vendor Ops")
    return True


def _operator(app):
    c = TestClient(app)
    r = c.post("/api/platform/login", json={"username": OP_USER, "password": OP_PW})
    assert r.status_code == 200, r.text
    return c


def test_platform_endpoints_require_auth(app, platform):
    c = TestClient(app)
    assert c.get("/api/platform/tenants").status_code == 401
    assert c.post("/api/platform/tenants", json={"slug": "x"}).status_code == 401


def test_bad_operator_credentials_rejected(app, platform):
    c = TestClient(app)
    assert c.post("/api/platform/login",
                  json={"username": OP_USER, "password": "wrong"}).status_code == 401


def test_provision_returns_working_first_credentials(app, platform):
    op = _operator(app)
    r = op.post("/api/platform/tenants", json={"slug": "initech", "name": "Initech"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["slug"] == "initech"
    assert body["admin_username"] == "admin"
    pw = body["admin_password"]
    assert pw

    # The returned credentials log in to the new tenant.
    r = TestClient(app).post("/api/auth/login",
                             json={"username": "admin", "password": pw},
                             headers={"X-Tenant": "initech"})
    assert r.status_code == 200, r.text

    # It now shows up in the catalog listing.
    slugs = {t["slug"] for t in op.get("/api/platform/tenants").json()}
    assert "initech" in slugs


def test_suspend_blocks_then_activate_restores(app, platform):
    op = _operator(app)
    pw = op.post("/api/platform/tenants",
                 json={"slug": "umbrella", "name": "Umbrella"}).json()["admin_password"]

    def login():
        return TestClient(app).post("/api/auth/login",
                                    json={"username": "admin", "password": pw},
                                    headers={"X-Tenant": "umbrella"})

    assert login().status_code == 200                      # active → works
    assert op.post("/api/platform/tenants/umbrella/suspend").status_code == 200
    assert login().status_code == 402                      # suspended → blocked
    assert op.post("/api/platform/tenants/umbrella/activate").status_code == 200
    assert login().status_code == 200                      # restored
