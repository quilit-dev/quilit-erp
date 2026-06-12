"""The platform-operator API is absent outside cloud (schema-tenancy) mode.

These run in the default single-tenant test configuration, where the console
must present as 404 (not 500s against a SQLite DB that has no tenant catalog).
The positive-path coverage lives in test_platform.py (TENANCY=schema only).
"""
import pytest

from tenant_context import IS_SCHEMA_TENANCY

pytestmark = pytest.mark.skipif(
    IS_SCHEMA_TENANCY,
    reason="gate tests assert single-tenant behaviour; cloud mode is covered by test_platform.py",
)


def test_status_probe_reports_disabled(client):
    r = client.get("/api/platform/status")
    assert r.status_code == 200
    assert r.json() == {"enabled": False}


def test_login_is_404_in_single_tenant_mode(client):
    r = client.post("/api/platform/login",
                    json={"username": "x", "password": "y"})
    assert r.status_code == 404


def test_tenant_endpoints_are_404_in_single_tenant_mode(client):
    assert client.get("/api/platform/tenants").status_code == 404
    assert client.post("/api/platform/tenants",
                       json={"slug": "acme"}).status_code == 404
    assert client.get("/api/platform/me").status_code == 404
