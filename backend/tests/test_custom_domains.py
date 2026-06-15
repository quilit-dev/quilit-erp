"""
Custom domains per tenant (each client on its own hostname).

Runs ONLY in multi-tenant mode and ONLY on Postgres:

    TENANCY=schema DB_BACKEND=postgres \
      python -m pytest tests/test_custom_domains.py -q

Proves:
  * a domain starts unverified and does NOT route or pass the TLS gate;
  * DNS-TXT verification (mocked) flips it to verified;
  * a verified Host header resolves to the right tenant schema;
  * the on-demand TLS gate (/api/platform/tls-check) only approves verified hosts;
  * a domain can't be hijacked by a second tenant.

DNS is mocked via tenancy._resolve_txt so the suite never touches the network.
"""
import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="custom-domain tests require TENANCY=schema and DB_BACKEND=postgres",
)

from fastapi.testclient import TestClient   # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    # These tests manage their own schema/catalog; opt out of the per-test rebuild.
    yield


@pytest.fixture(scope="module")
def tenant():
    import tenancy
    t = tenancy.provision_tenant("domco", name="Dom Co")
    return t


def _scope(host=None, cookie=None, xtenant=None):
    headers = []
    if host:    headers.append((b"host", host.encode()))
    if cookie:  headers.append((b"cookie", cookie.encode()))
    if xtenant: headers.append((b"x-tenant", xtenant.encode()))
    return {"type": "http", "headers": headers}


def test_unverified_domain_does_not_route_or_pass_tls_gate(app, tenant, monkeypatch):
    import tenancy
    info = tenancy.add_tenant_domain("domco", "erp.domco.example")
    assert info["verified"] == 0
    assert info["txt_name"] == "_erp-verify.erp.domco.example"
    assert info["txt_value"]

    # Resolution must NOT pick up an unverified domain.
    assert tenancy.resolve_tenant_from_scope(_scope(host="erp.domco.example")) is None
    assert tenancy.is_verified_domain("erp.domco.example") is False

    # TLS gate refuses an unverified host.
    c = TestClient(app)
    assert c.get("/api/platform/tls-check", params={"domain": "erp.domco.example"}).status_code == 404


def test_verify_then_route_and_tls_gate(app, tenant, monkeypatch):
    import tenancy
    info = tenancy.add_tenant_domain("domco", "shop.domco.example")
    token = info["txt_value"]

    # Wrong TXT → stays unverified.
    monkeypatch.setattr(tenancy, "_resolve_txt", lambda name: ["some-other-value"])
    assert tenancy.verify_tenant_domain("shop.domco.example")["verified"] is False
    assert tenancy.resolve_tenant_from_scope(_scope(host="shop.domco.example")) is None

    # Correct TXT → verified.
    monkeypatch.setattr(tenancy, "_resolve_txt", lambda name: ["other", token])
    assert tenancy.verify_tenant_domain("shop.domco.example")["verified"] is True

    # Now the Host header resolves to the tenant's schema.
    resolved = tenancy.resolve_tenant_from_scope(_scope(host="shop.domco.example"))
    assert resolved == (tenant["schema_name"], "active")

    # And the TLS gate approves it.
    c = TestClient(app)
    assert c.get("/api/platform/tls-check", params={"domain": "shop.domco.example"}).status_code == 200


def test_tls_check_unknown_domain_is_404(app, tenant):
    c = TestClient(app)
    assert c.get("/api/platform/tls-check", params={"domain": "not-a-tenant.example"}).status_code == 404
    assert c.get("/api/platform/tls-check").status_code == 404   # missing param


def test_domain_cannot_be_stolen_by_another_tenant(app, tenant, monkeypatch):
    import tenancy
    tenancy.provision_tenant("domco2", name="Dom Co 2")
    tenancy.add_tenant_domain("domco", "shared.domco.example")
    with pytest.raises(ValueError):
        tenancy.add_tenant_domain("domco2", "shared.domco.example")


def test_login_routes_by_verified_host(app, tenant, monkeypatch):
    """End-to-end: with no X-Tenant header, a verified Host routes login to the
    correct tenant schema."""
    import tenancy
    from auth_utils import hash_password
    from database import _pg_dsn
    import psycopg

    # Give this tenant's admin a known password.
    raw = psycopg.connect(_pg_dsn())
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{tenant["schema_name"]}", public')
            cur.execute("UPDATE users SET password_hash=%s, must_change_password=0 "
                        "WHERE username='admin'", (hash_password("DomCo1234!"),))
        raw.commit()
    finally:
        raw.close()

    tenancy.add_tenant_domain("domco", "login.domco.example")
    # Mock DNS to return exactly this domain's token, so verification passes.
    monkeypatch.setattr(tenancy, "_resolve_txt",
                        lambda name: _token_for("login.domco.example"))
    tenancy.verify_tenant_domain("login.domco.example")

    c = TestClient(app)
    r = c.post("/api/auth/login",
               json={"username": "admin", "password": "DomCo1234!"},
               headers={"Host": "login.domco.example"})
    assert r.status_code == 200, r.text


def _token_for(domain):
    import tenancy
    for d in tenancy.list_tenant_domains():
        if d["domain"] == domain:
            return [d["verify_token"]]
    return []
