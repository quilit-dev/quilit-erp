"""
Every user can change their own password.

The endpoint always accepted any authenticated user, but nothing in the UI
called it — the only password screen was the FORCED one-time change at first
login. So a member of staff who thought their password had been seen had to ask
an admin to reset it, which meant the admin choosing, and knowing, their
password. These pin the endpoint's side of the contract for every role, not just
for an admin.

Requiring the current password is what makes this safe to expose to everyone: it
grants nothing an account holder does not already have.
"""
import pytest
from fastapi.testclient import TestClient
from helpers.seeding import ROLE_USERS, RBAC_ROLES, TEST_PASSWORD

NEW_PW = "Rotated_9182!"


def _change(client, old, new):
    return client.post("/api/auth/change-password",
                       json={"old_password": old, "new_password": new})


@pytest.mark.parametrize("role", RBAC_ROLES)
def test_every_role_can_change_its_own_password(app, make_client, role):
    """The whole point of the feature: not an admin-only privilege."""
    c = make_client(role)
    assert _change(c, TEST_PASSWORD, NEW_PW).status_code == 200

    # The new password is what actually works now.
    fresh = TestClient(app)
    r = fresh.post("/api/auth/login",
                   json={"username": ROLE_USERS[role], "password": NEW_PW})
    assert r.status_code == 200, r.text

    stale = TestClient(app)
    r = stale.post("/api/auth/login",
                   json={"username": ROLE_USERS[role], "password": TEST_PASSWORD})
    assert r.status_code in (401, 429), "the old password still works"


def test_wrong_current_password_is_refused(make_client):
    """Without this the endpoint would let anyone holding a borrowed session
    lock the real owner out of their account."""
    c = make_client("Sales")
    r = _change(c, "not-my-password", NEW_PW)
    assert r.status_code == 400
    assert "current password" in r.json()["detail"].lower()


def test_a_refused_change_leaves_the_old_password_working(app, make_client):
    c = make_client("Sales")
    _change(c, "not-my-password", NEW_PW)

    fresh = TestClient(app)
    r = fresh.post("/api/auth/login",
                   json={"username": ROLE_USERS["Sales"], "password": TEST_PASSWORD})
    assert r.status_code == 200, "a failed change must not have altered anything"


def test_short_password_is_refused(make_client):
    c = make_client("Sales")
    r = _change(c, TEST_PASSWORD, "short7!")
    assert r.status_code == 400


def test_anonymous_cannot_change_a_password(client):
    assert _change(client, TEST_PASSWORD, NEW_PW).status_code in (401, 403)


def test_changing_a_password_is_audited(make_client, db):
    """A password change is a security event; it has to be attributable."""
    c = make_client("Sales")
    assert _change(c, TEST_PASSWORD, NEW_PW).status_code == 200

    row = db.execute(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'change_password'"
    ).fetchone()
    assert row["n"] >= 1


def test_change_does_not_clear_another_users_password(app, make_client, db):
    """One user rotating their own password must not touch anyone else's — the
    UPDATE is keyed by id, and this is the guard on that staying true."""
    sales = make_client("Sales")
    assert _change(sales, TEST_PASSWORD, NEW_PW).status_code == 200

    other = TestClient(app)
    r = other.post("/api/auth/login",
                   json={"username": ROLE_USERS["Accountant"],
                         "password": TEST_PASSWORD})
    assert r.status_code == 200, "an unrelated user's password was affected"
