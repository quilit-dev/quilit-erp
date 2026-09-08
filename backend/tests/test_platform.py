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


# ── fingerprint terminals in the fleet view ──────────────────────────────────
# The vendor's blind spot with agents in the field: a terminal that stops
# reporting takes the customer's attendance with it, silently, and the first
# anyone notices is a payroll run built on a gap. The CUSTOMER can see it on
# their own HR screen -- these tests are about the operator seeing it without
# waiting for the phone call.

def _tenant_with_a_terminal(app, slug, name="Clocks Ltd"):
    op = _operator(app)
    r = op.post("/api/platform/tenants", json={"slug": slug, "name": name})
    assert r.status_code == 200, r.text
    pw = r.json()["admin_password"]

    c = TestClient(app)
    assert c.post("/api/auth/login",
                  json={"username": "admin", "password": pw},
                  headers={"X-Tenant": slug}).status_code == 200
    d = c.post("/api/hr/timeclock/devices", json={"name": "Front door"})
    assert d.status_code in (200, 201), d.text
    return op, c, d.json()


def _health_row(op, slug):
    body = op.get("/api/platform/health").json()
    return body, next(r for r in body["tenants"] if r["slug"] == slug)


def test_a_registered_terminal_shows_in_the_fleet_view(app, platform):
    op, _, _ = _tenant_with_a_terminal(app, "clockco")
    _, row = _health_row(op, "clockco")
    assert row["clock_devices"] == 1


def test_a_terminal_that_has_never_reported_counts_as_silent(app, platform):
    # The install-went-wrong case. "Never heard from" must not read as fine.
    op, _, _ = _tenant_with_a_terminal(app, "neverclock")
    body, row = _health_row(op, "neverclock")
    assert row["clock_stale"] == 1
    assert any("silent" in i for i in row["issues"]), row["issues"]
    assert row["health_score"] < 100
    assert body["platform"]["clock_stale"] >= 1,         "the operator should see it without opening a row"


def test_a_terminal_heard_from_just_now_is_not_flagged(app, platform):
    op, c, dev = _tenant_with_a_terminal(app, "liveclock")
    anon = TestClient(app)
    r = anon.post("/api/time/punches",
                  json={"punches": [{"device_user_id": "1",
                                     "punched_at": "2026-09-07 08:00:00"}]},
                  headers={"Authorization": "Bearer " + dev["token"],
                           "X-Tenant": "liveclock"})
    assert r.status_code == 200, r.text

    _, row = _health_row(op, "liveclock")
    assert row["clock_stale"] == 0
    assert row["clock_last_seen"]
    assert not any("silent" in i for i in row["issues"]), row["issues"]


def test_fingers_nobody_has_linked_are_surfaced(app, platform):
    # Punches piling up against nobody: cheap to fix, invisible until payroll.
    op, c, dev = _tenant_with_a_terminal(app, "unlinkedclock")
    anon = TestClient(app)
    anon.post("/api/time/punches",
              json={"punches": [{"device_user_id": "7",
                                 "punched_at": "2026-09-07 08:00:00"}]},
              headers={"Authorization": "Bearer " + dev["token"],
                       "X-Tenant": "unlinkedclock"})
    _, row = _health_row(op, "unlinkedclock")
    assert row["clock_unclaimed"] == 1
    assert any("not linked" in i for i in row["issues"]), row["issues"]


def test_a_customer_without_a_terminal_is_not_marked_unhealthy(app, platform):
    # Most tenants will never use this. Not using a feature is not a fault.
    op = _operator(app)
    op.post("/api/platform/tenants", json={"slug": "noclock", "name": "No Clock"})
    _, row = _health_row(op, "noclock")
    assert row["clock_devices"] == 0
    assert not any("terminal" in i for i in row["issues"]), row["issues"]


def test_one_customers_terminal_is_not_counted_against_another(app, platform):
    # Creates BOTH tenants itself rather than leaning on one an earlier test
    # happened to leave behind -- otherwise running this alone with -k fails
    # for a reason that has nothing to do with what it is testing.
    op, _, _ = _tenant_with_a_terminal(app, "mineclock")
    op.post("/api/platform/tenants", json={"slug": "theirsclock",
                                           "name": "Theirs"})
    _, mine = _health_row(op, "mineclock")
    _, theirs = _health_row(op, "theirsclock")
    assert mine["clock_devices"] == 1
    assert theirs["clock_devices"] == 0
