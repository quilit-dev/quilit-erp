"""
Authentication, session lifecycle and login-rate-limiting.
"""
import pytest
from helpers.seeding import ROLE_USERS, TEST_PASSWORD


@pytest.mark.smoke
def test_login_success(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": TEST_PASSWORD})
    assert r.status_code == 200, r.text
    assert r.json()["is_superadmin"] is True


def test_login_wrong_password_is_401(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "incorrect"})
    assert r.status_code == 401


def test_login_unknown_user_is_401(client):
    r = client.post("/api/auth/login", json={"username": "no_such_user", "password": "x"})
    assert r.status_code == 401


def test_disabled_account_cannot_log_in(client):
    r = client.post("/api/auth/login",
                     json={"username": ROLE_USERS["__disabled__"], "password": TEST_PASSWORD})
    assert r.status_code == 403, f"disabled account login -> {r.status_code} (expected 403)"


def test_login_is_rate_limited(client):
    """5 failed attempts inside the window -> the 6th must be 429, not another 401."""
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "admin", "password": "bad"})
    r = client.post("/api/auth/login", json={"username": "admin", "password": "bad"})
    assert r.status_code == 429, f"rate-limit not enforced: got {r.status_code}"


def test_me_requires_authentication(client):
    assert client.get("/api/auth/me").status_code == 401


def test_me_reports_correct_role(make_client):
    c = make_client("Manager")
    r = c.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["role_name"] == "Manager"


def test_logout_revokes_the_session(make_client):
    c = make_client("Viewer")
    assert c.get("/api/auth/me").status_code == 200
    assert c.post("/api/auth/logout").status_code == 200
    # session revoked + cookie cleared -> subsequent calls rejected
    assert c.get("/api/auth/me").status_code == 401


def test_second_login_revokes_the_first_session(make_client):
    """The backend keeps a single active session per user — verify the older one dies."""
    first  = make_client("Sales")
    assert first.get("/api/auth/me").status_code == 200
    second = make_client("Sales")            # logs in again as the same user
    assert second.get("/api/auth/me").status_code == 200
    # the first session's jti was revoked by the second login
    assert first.get("/api/auth/me").status_code == 401
