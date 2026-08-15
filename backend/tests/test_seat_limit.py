"""
Licensed seats, enforced at login.

`max_users` was recorded at provisioning and checked by nothing, so a business
licensed for three people could put thirty on it.

Seats are CONCURRENT users, not user accounts. Counting accounts and refusing at
the door would punish everyone for an admin adding one person too many, and
could never free itself — the company would simply be locked out until someone
with no way in fixed it. Concurrency self-heals: a seat returns when a session
signs out or goes idle.

The tests that matter most here are the ones asserting a login is ALLOWED. A
seat limit that locks a paying customer out of their own books is worse than no
limit at all, so every escape hatch is pinned.

Postgres-only: `max_users` lives in `public.tenants`.
"""
import os
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.skipif(
    os.environ.get("TENANCY", "single").lower() not in ("schema", "multi", "tenant")
    or os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="seat limits need TENANCY=schema and DB_BACKEND=postgres",
)

PW = "Seats1234!"
SLUG = "seat_probe"


@pytest.fixture(autouse=True)
def fresh_db():
    yield                       # manages its own schema


def _sql(schema, sql, params=()):
    import tenancy
    raw = tenancy._connect()
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{schema}", public')
            cur.execute(sql, params)
            rows = cur.fetchall() if cur.description else []
        raw.commit()
        return rows
    finally:
        raw.close()


def _set_seats(n):
    import tenancy
    raw = tenancy._connect()
    try:
        with raw.cursor() as cur:
            cur.execute("UPDATE public.tenants SET max_users=%s WHERE slug=%s", (n, SLUG))
        raw.commit()
    finally:
        raw.close()
    tenancy._LICENCE_CACHE.clear()


@pytest.fixture(scope="module")
def world(app):
    """One tenant, an admin, and four ordinary staff."""
    import tenancy
    from auth_utils import hash_password
    tenancy.provision_tenant(SLUG, name="Seat Probe")
    schema = tenancy.schema_for_slug(SLUG)

    _sql(schema, "UPDATE users SET password_hash=%s, must_change_password=0 "
                 "WHERE username='admin'", (hash_password(PW),))
    role = _sql(schema, "SELECT id FROM roles WHERE name='Sales'")[0]["id"]
    for i in range(1, 5):
        _sql(schema,
             "INSERT INTO users (username, password_hash, full_name, role, role_id,"
             " is_active, is_superadmin, must_change_password, created_at)"
             " VALUES (%s,%s,%s,'user',%s,1,0,0, now()::text)"
             " ON CONFLICT (username) DO NOTHING",
             (f"seat{i}", hash_password(PW), f"Staff {i}", role))
    return {"schema": schema}


def _login(app, username):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": username, "password": PW},
               headers={"X-Tenant": SLUG})
    return c, r


def _clear_sessions(schema):
    _sql(schema, "UPDATE user_sessions SET revoked=1 WHERE revoked=0")


@pytest.fixture(autouse=True)
def reset_sessions(world):
    _clear_sessions(world["schema"])
    yield
    _clear_sessions(world["schema"])


# ── the limit bites ─────────────────────────────────────────────────────────

def test_a_login_past_the_seat_count_is_refused(app, world):
    _set_seats(2)
    _, r1 = _login(app, "seat1")
    _, r2 = _login(app, "seat2")
    assert r1.status_code == 200 and r2.status_code == 200

    _, r3 = _login(app, "seat3")
    assert r3.status_code == 403, r3.text
    assert "seats" in r3.json()["detail"].lower()
    assert "2" in r3.json()["detail"], "the message should name the limit"


def test_signing_out_frees_the_seat(app, world):
    """Self-healing is the whole reason seats are concurrent."""
    _set_seats(1)
    c1, r1 = _login(app, "seat1")
    assert r1.status_code == 200
    _, blocked = _login(app, "seat2")
    assert blocked.status_code == 403

    c1.post("/api/auth/logout")

    _, r2 = _login(app, "seat2")
    assert r2.status_code == 200, "a released seat was not reusable"


def test_an_idle_session_stops_holding_a_seat(app, world):
    """Idle revocation is LAZY — it only fires when the stale token is next
    used. Someone who closes their browser would otherwise hold a seat for
    good, and nobody could take it."""
    _set_seats(1)
    _, r1 = _login(app, "seat1")
    assert r1.status_code == 200

    stale = (datetime.utcnow() - timedelta(hours=3)).strftime("%Y-%m-%d %H:%M:%S")
    _sql(world["schema"],
         "UPDATE user_sessions SET last_active=%s WHERE revoked=0", (stale,))

    _, r2 = _login(app, "seat2")
    assert r2.status_code == 200, "an abandoned session is still holding a seat"


# ── the limit must NOT bite (the dangerous half) ────────────────────────────

def test_an_admin_is_never_locked_out(app, world):
    """Whoever can deactivate a user or call the vendor must be able to get in.
    A seat limit that shuts the owner out of their own books is worse than no
    limit at all."""
    _set_seats(1)
    _, r1 = _login(app, "seat1")
    assert r1.status_code == 200

    _, admin = _login(app, "admin")
    assert admin.status_code == 200, admin.text


def test_signing_in_again_does_not_take_a_second_seat(app, world):
    """Login already replaces your previous session, so a second device is the
    same seat — not a reason to refuse the person who holds it."""
    _set_seats(1)
    _, first = _login(app, "seat1")
    assert first.status_code == 200

    _, again = _login(app, "seat1")
    assert again.status_code == 200, "a user was refused their own seat"


def test_no_limit_means_unlimited(app, world):
    _set_seats(None)
    for name in ("seat1", "seat2", "seat3", "seat4"):
        _, r = _login(app, name)
        assert r.status_code == 200, f"{name}: {r.text}"


def test_zero_is_treated_as_unlimited_not_as_nobody(app, world):
    """A 0 in the box is an operator leaving it blank, not a licence for no
    one. Reading it literally would lock out the entire company."""
    _set_seats(0)
    _, r = _login(app, "seat1")
    assert r.status_code == 200, r.text


def test_a_wrong_password_is_still_just_a_wrong_password(app, world):
    """The seat check runs after authentication, so a failed login never
    reveals how full the licence is."""
    _set_seats(1)
    _login(app, "seat1")

    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "seat2", "password": "nope"},
               headers={"X-Tenant": SLUG})
    assert r.status_code in (401, 429)
    assert "seat" not in r.text.lower()


def test_raising_the_limit_takes_effect_immediately(app, world):
    """The seat count is cached; an operator selling two more seats should not
    have to wait for a TTL while the customer sits locked out."""
    _set_seats(1)
    _login(app, "seat1")
    _, blocked = _login(app, "seat2")
    assert blocked.status_code == 403

    import tenancy
    tenancy.update_tenant(SLUG, {"max_users": 5})

    _, allowed = _login(app, "seat2")
    assert allowed.status_code == 200, "the new seats were not honoured"
