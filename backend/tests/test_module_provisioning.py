"""
Tests for the module-provisioning lockdown.

`enabled_modules` is the vendor's per-customer "which modules ship in this
build" lever. It lives in `backend/vendor_config.py` as an immutable
build-time constant — NOT in the database — so a customer with filesystem
access (delete erp.db, edit the settings table, run a fresh superadmin)
cannot grant themselves access to modules they did not pay for.

This suite covers the immutability contract end-to-end.
"""
import vendor_config


# ── GET surface — the constant is the only thing reported ──────────────────

def test_fresh_install_reports_empty_modules(as_role):
    """Default constant is empty (== all modules visible in dev/demo)."""
    c = as_role("superadmin")
    r = c.get("/api/settings/")
    assert r.status_code == 200
    assert r.json().get("enabled_modules", None) == ""


def test_get_surfaces_overridden_constant(as_role, monkeypatch):
    """When the build constant is set, the API reports that exact value."""
    monkeypatch.setattr(vendor_config, "ENABLED_MODULES", "sales,inventory,pos")
    c = as_role("superadmin")
    r = c.get("/api/settings/")
    assert r.status_code == 200
    assert r.json()["enabled_modules"] == "sales,inventory,pos"


def test_authenticated_non_admin_can_read_modules(as_role):
    """
    GET /api/settings/ is auth-required but not admin-required, because the
    Sidebar — running under any logged-in user — needs to read
    enabled_modules to decide which nav links to render.
    """
    c = as_role("Viewer")
    r = c.get("/api/settings/")
    assert r.status_code == 200
    assert "enabled_modules" in r.json()


def test_anonymous_cannot_read_settings(client):
    """Unauthenticated callers get 401, not the settings payload."""
    r = client.get("/api/settings/")
    assert r.status_code == 401


# ── Write surface — enabled_modules is rejected at the schema layer ────────

def test_superadmin_put_with_enabled_modules_rejected(as_role):
    """
    The lockdown: even the vendor superadmin can't change enabled_modules at
    runtime. The whole point is that the value is baked into the build.
    A PUT body containing `enabled_modules` is a schema error (422), not a
    permission error — there is no path to set this field from a request.
    """
    c = as_role("superadmin")
    r = c.put("/api/settings/", json={"enabled_modules": "everything"})
    assert r.status_code == 422


def test_piggybacked_enabled_modules_rejects_whole_request(as_role):
    """
    Defence-in-depth: if a caller tries to slip enabled_modules in alongside
    a legitimate update, the whole request is rejected — the legitimate field
    is NOT silently committed.
    """
    c = as_role("superadmin")
    r = c.put("/api/settings/", json={
        "company_name": "Hacker Co",
        "enabled_modules": "sales",
    })
    assert r.status_code == 422
    # And the legitimate field was NOT applied
    r2 = c.get("/api/settings/")
    assert r2.json()["company_name"] != "Hacker Co"


def test_direct_db_write_does_not_affect_api(as_role, db):
    """
    The vector this whole change is built to close: a customer dumps a value
    into the settings table directly via sqlite3. The API still reports the
    build constant, untouched.
    """
    db.execute(
        "INSERT INTO settings (key, value) VALUES ('enabled_modules', 'all,the,modules') "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    db.commit()
    c = as_role("superadmin")
    r = c.get("/api/settings/")
    assert r.json()["enabled_modules"] == vendor_config.ENABLED_MODULES


# ── Standard auth on /api/settings/ still applies for other fields ─────────

def test_non_admin_cannot_write_other_settings(as_role):
    """Sales role has no admin access — cannot write any settings field."""
    c = as_role("Sales")
    r = c.put("/api/settings/", json={"company_name": "Sales Co"})
    assert r.status_code == 403


def test_anonymous_cannot_write_settings(client):
    r = client.put("/api/settings/", json={"company_name": "Anon Co"})
    assert r.status_code == 401


def test_admin_can_still_write_legitimate_fields(as_role):
    """The lockdown is field-targeted — legitimate settings still flow."""
    c = as_role("superadmin")
    r = c.put("/api/settings/", json={"company_name": "New Name"})
    assert r.status_code == 200
    r2 = c.get("/api/settings/")
    assert r2.json()["company_name"] == "New Name"
