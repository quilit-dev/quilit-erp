"""
Phase 2 — the isolation boundary under attack.

test_multitenancy.py proves isolation works when everyone behaves. This module
covers the adversarial cases: what a customer, or someone who has stolen a
customer's session, can reach by lying about who they are.

Runs ONLY in multi-tenant mode and ONLY on Postgres:

    TENANCY=schema DB_BACKEND=postgres \
      python -m pytest tests/test_tenant_security.py -q

These are the tests that must never go red. Every one of them corresponds to a
way one paying customer could read or damage another's books.
"""
import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="tenant security tests require TENANCY=schema and DB_BACKEND=postgres",
)

from fastapi.testclient import TestClient   # noqa: E402

TEST_PW = "Tenant1234!"


@pytest.fixture(autouse=True)
def fresh_db():
    # These tests manage their own schemas; opt out of conftest's rebuild.
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
def pair(app):
    import tenancy
    for slug in ("victim", "attacker"):
        t = tenancy.provision_tenant(slug, name=slug.title())
        _set_admin_password(t["schema_name"], TEST_PW)
    return ("victim", "attacker")


def _login(app, slug):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "admin", "password": TEST_PW},
               headers={"X-Tenant": slug})
    assert r.status_code == 200, f"login to {slug} failed: {r.text}"
    return c


def _seed(client, name):
    r = client.post("/api/clients/", json={"name": name})
    assert r.status_code in (200, 201), r.text


# ── the boundary itself ──────────────────────────────────────────────────────

def test_forged_host_cannot_move_a_session(app, pair):
    """The Host header is attacker-controlled on any request.

    Tenant resolution falls back to the host subdomain for UNAUTHENTICATED
    requests, so the danger is an authenticated session carrying a Host that
    names someone else. The signed schema claim has to win — otherwise stealing
    data is a one-header curl.
    """
    victim = _login(app, "victim")
    _seed(victim, "VICTIM Secret Client")
    attacker = _login(app, "attacker")

    names = {c["name"] for c in
             attacker.get("/api/clients/", headers={"Host": "victim.quilit.dev"}).json()}
    assert "VICTIM Secret Client" not in names


def test_forged_host_and_header_together_cannot_move_a_session(app, pair):
    """Both lies at once — belt and braces are checked independently."""
    victim = _login(app, "victim")
    _seed(victim, "VICTIM Second Client")
    attacker = _login(app, "attacker")

    names = {c["name"] for c in attacker.get(
        "/api/clients/",
        headers={"Host": "victim.quilit.dev", "X-Tenant": "victim"}).json()}
    assert "VICTIM Second Client" not in names


def test_attacker_cannot_write_into_another_tenant(app, pair):
    """Reads are the obvious risk; writes are the expensive one. A write that
    lands in the wrong schema corrupts a ledger that has to reconcile."""
    attacker = _login(app, "attacker")
    r = attacker.post("/api/clients/", json={"name": "PLANTED BY ATTACKER"},
                      headers={"X-Tenant": "victim", "Host": "victim.quilit.dev"})
    assert r.status_code in (200, 201), r.text

    victim = _login(app, "victim")
    victim_names = {c["name"] for c in victim.get("/api/clients/").json()}
    assert "PLANTED BY ATTACKER" not in victim_names


# ── the platform boundary ────────────────────────────────────────────────────

def test_tenant_user_cannot_reach_platform_endpoints(app, pair):
    """A tenant admin is an admin of ONE business. The Control Center governs
    every business, so a tenant session must never authenticate against it."""
    attacker = _login(app, "attacker")
    for path in ("/api/platform/tenants", "/api/platform/reports",
                 "/api/platform/health"):
        r = attacker.get(path)
        assert r.status_code in (401, 403, 404), \
            f"{path} reachable with a tenant session: {r.status_code} {r.text[:200]}"


def test_tenant_user_cannot_provision_or_destroy(app, pair):
    """The destructive half of the Control Center, checked explicitly: these
    create and erase whole businesses."""
    attacker = _login(app, "attacker")
    r = attacker.post("/api/platform/tenants",
                      json={"slug": "pwned", "name": "Pwned"})
    assert r.status_code in (401, 403, 404), r.text
    r = attacker.post("/api/platform/tenants/victim/factory-reset?confirm=victim")
    assert r.status_code in (401, 403, 404), r.text
    r = attacker.delete("/api/platform/tenants/victim?confirm=victim")
    assert r.status_code in (401, 403, 404), r.text

    # And the victim is still there, intact.
    victim = _login(app, "victim")
    assert victim.get("/api/clients/").status_code == 200


# ── schema-name injection ────────────────────────────────────────────────────

@pytest.mark.parametrize("evil", [
    'victim" ; DROP SCHEMA "tenant_victim" CASCADE; --',
    "victim'; DROP TABLE users; --",
    "../../etc/passwd",
    "tenant_victim",          # the schema name itself, not the slug
    "victim\x00",             # null byte
    "victim%22",              # encoded quote
])
def test_malicious_tenant_header_is_refused_not_executed(app, pair, evil):
    """The slug reaches `SET search_path TO "<schema>"` by interpolation, so a
    slug that escapes its quotes would be arbitrary SQL. valid_slug is the only
    thing standing between a login form and DROP SCHEMA."""
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "admin", "password": TEST_PW},
               headers={"X-Tenant": evil})
    assert r.status_code != 500, f"server error on {evil!r}: {r.text[:200]}"
    assert r.status_code != 200, f"logged in via {evil!r}"

    # The victim schema must still exist and still hold its data.
    victim = _login(app, "victim")
    assert victim.get("/api/clients/").status_code == 200


@pytest.mark.parametrize("variant", ["VICTIM", "victim ", " Victim"])
def test_cosmetic_slug_variants_normalise_to_the_same_tenant(app, pair, variant):
    """Case and surrounding whitespace are normalised before validation, so a
    user who types "Victim" reaches their own workspace instead of a confusing
    failure. This is deliberate: it grants no access that the password did not
    already grant, and it must NOT be mistaken for a bypass — the point of
    pinning it here is that a future "stricter" change would break real logins.
    """
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "admin", "password": TEST_PW},
               headers={"X-Tenant": variant})
    assert r.status_code == 200, r.text
    # Wrong password must still fail through the same normalised path.
    c2 = TestClient(app)
    bad = c2.post("/api/auth/login", json={"username": "admin", "password": "nope"},
                  headers={"X-Tenant": variant})
    assert bad.status_code in (401, 429), bad.text


# ── schema upgrades reach EXISTING customers ────────────────────────────────

def test_existing_tenant_schemas_get_new_columns(app, pair):
    """A column added to the post-baseline must reach schemas that already
    exist, not just `public` and newly provisioned tenants.

    This is the shape of a real outage: invoice creation returned 500 for a live
    customer because `public.invoice_items` had `discount_pct` and
    `tenant_<slug>.invoice_items` did not. Every test passed, because the tests
    provision fresh schemas that pick the column up on creation.
    """
    import psycopg
    import tenancy
    from database import _pg_dsn

    schema = "tenant_victim"
    raw = psycopg.connect(_pg_dsn())
    try:
        # Put the schema back into the state it would have been in before the
        # column was introduced.
        with raw.cursor() as cur:
            cur.execute(f'ALTER TABLE "{schema}".invoice_items '
                        f'DROP COLUMN IF EXISTS discount_pct')
        raw.commit()

        def has_col():
            with raw.cursor() as cur:
                cur.execute("SELECT 1 FROM information_schema.columns WHERE "
                            "table_schema=%s AND table_name='invoice_items' "
                            "AND column_name='discount_pct'", (schema,))
                return cur.fetchone() is not None

        assert not has_col(), "precondition: the column should be gone"

        result = tenancy.upgrade_all_tenant_schemas()
        assert "victim" in result.get("upgraded", []), result

        assert has_col(), (
            "upgrade_all_tenant_schemas did not reach an existing tenant — "
            "a hosted customer would 500 on the next invoice")
    finally:
        raw.close()


# ── the first-run wizard must not be a takeover ─────────────────────────────

def test_the_setup_wizard_cannot_claim_a_provisioned_workspace(app, pair):
    """The worst bug found in the pre-delivery audit.

    `/api/settings/complete-setup` is UNAUTHENTICATED by design: on a
    self-hosted first run somebody standing at the machine has to set the first
    password, and a `setup_complete` flag closes it afterwards.

    A provisioned tenant never runs that wizard — the platform generates the
    admin password and hands it to the owner — so the flag stayed "0" forever
    and the endpoint remained open on the customer's subdomain. Anyone who knew
    the subdomain could set the admin password, log in as superadmin and read
    the customer's books. Verified end to end before the fix.
    """
    anon = TestClient(app)
    H = {"X-Tenant": "victim"}

    r = anon.post("/api/settings/complete-setup", headers=H, json={
        "admin_password": "AttackerOwns1!", "company_name": "Pwned",
        "company_email": "a@b.c", "default_currency": "USD", "business_type": "x"})
    assert r.status_code == 403, (
        f"the wizard claimed a live workspace: {r.status_code} {r.text[:200]}")

    stolen = TestClient(app)
    l = stolen.post("/api/auth/login", headers=H,
                    json={"username": "admin", "password": "AttackerOwns1!"})
    assert l.status_code != 200, "an attacker set the admin password"

    # The real owner is unaffected.
    victim = _login(app, "victim")
    assert victim.get("/api/clients/").status_code == 200


def test_setup_status_does_not_advertise_claimable_workspaces(app, pair):
    """It answered `false`, which told an attacker exactly which subdomains
    were still open to the takeover above."""
    anon = TestClient(app)
    r = anon.get("/api/settings/setup-status", headers={"X-Tenant": "victim"})
    assert r.status_code == 200
    assert r.json()["setup_complete"] is True, r.text


# ── branding does not cross the boundary ────────────────────────────────────

def test_each_tenant_keeps_its_own_logo(app, pair):
    """The logo used to be ONE file, `static/logo.png`, resolved from the
    running process with no tenant in the path. On this deployment every
    customer shares one filesystem, so whoever uploaded last replaced everyone
    else's branding — and it then appeared on their invoices, their quotations
    and the documents their own customers opened from a share link.

    It lives in the database now, so each schema holds its own.
    """
    import io

    victim_png   = b"\x89PNG\r\n\x1a\n" + b"V" * 64
    attacker_png = b"\x89PNG\r\n\x1a\n" + b"A" * 64

    def upload(client, data):
        r = client.post("/api/settings/logo",
                        files={"file": ("logo.png", io.BytesIO(data), "image/png")})
        assert r.status_code == 200, r.text

    victim   = _login(app, "victim")
    attacker = _login(app, "attacker")

    upload(victim, victim_png)
    upload(attacker, attacker_png)          # LAST write wins under the old code

    assert victim.get("/api/settings/logo").content == victim_png, (
        "the victim is serving someone else's logo — a later upload by another "
        "tenant overwrote their branding")
    assert attacker.get("/api/settings/logo").content == attacker_png


def test_anonymous_reader_gets_the_logo_of_the_host_they_asked_for(app, pair):
    """The login screen and the customer-facing share link both render the logo
    with no session, so the tenant comes from the host. That path must not fall
    back to some other tenant's branding."""
    import io

    victim_png = b"\x89PNG\r\n\x1a\n" + b"V" * 64
    victim = _login(app, "victim")
    r = victim.post("/api/settings/logo",
                    files={"file": ("logo.png", io.BytesIO(victim_png), "image/png")})
    assert r.status_code == 200, r.text

    anon = TestClient(app)
    got = anon.get("/api/settings/logo", headers={"X-Tenant": "victim"})
    assert got.status_code == 200
    assert got.content == victim_png


def test_tenant_upgrade_is_idempotent(app, pair):
    """It runs on every boot, so a second pass must be a no-op rather than an
    error that blocks startup."""
    import tenancy
    first = tenancy.upgrade_all_tenant_schemas()
    second = tenancy.upgrade_all_tenant_schemas()
    assert not first.get("failed"), first
    assert not second.get("failed"), second
