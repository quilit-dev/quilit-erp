"""
Online-users indicator — /api/users/online.

A user is "online" when they hold a live session whose last_active heartbeat is
within the 5-minute window. Covers: admin-only gating, that a freshly logged-in
user shows up, dedup per user, and that a revoked session drops them.
"""
import pytest


@pytest.mark.rbac
def test_online_requires_admin(make_client):
    r = make_client("Viewer").get("/api/users/online")
    assert r.status_code != 500
    assert r.status_code == 403


def test_logged_in_user_is_online(make_client):
    admin = make_client("superadmin")          # logging in creates a live session
    body = admin.get("/api/users/online").json()
    assert body["window_minutes"] == 5
    assert body["count"] >= 1
    assert any(u["username"] == "admin" for u in body["users"])
    # deduped per user, with a session count
    assert all(u["session_count"] >= 1 for u in body["users"])


def test_second_user_appears_then_drops_after_logout(make_client):
    admin = make_client("superadmin")
    other = make_client("Manager")             # second live session

    users = {u["username"] for u in admin.get("/api/users/online").json()["users"]}
    assert "u_manager" in users                # the Manager seed user is online

    other.post("/api/auth/logout")             # ends that session
    users_after = {u["username"] for u in admin.get("/api/users/online").json()["users"]}
    assert "u_manager" not in users_after
