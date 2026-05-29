"""
First-run setup wizard — /api/settings/complete-setup.

Regression: if the database file is deleted while the server is running, a new
empty file is created and the wizard's status check auto-creates only the
`settings` table. Completing setup then used to hit a missing `users` table and
return a raw 500 ("Internal Server Error"), which the frontend surfaced as the
cryptic "Unexpected token 'I'… is not valid JSON". It must now return a clean,
JSON, actionable error instead.
"""
import pytest


def test_complete_setup_happy_path(make_client):
    anon = make_client()                       # public endpoint, no auth
    r = anon.post("/api/settings/complete-setup", json={
        "admin_password": "FreshPass123!", "company_name": "Acme"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    # Idempotency: a second call is rejected cleanly, not crashed.
    again = anon.post("/api/settings/complete-setup", json={"admin_password": "FreshPass123!"})
    assert again.status_code == 403


def test_complete_setup_on_uninitialised_db_is_clean_error(make_client, db):
    """Only the settings table exists (deleted-DB-mid-run) -> 503 JSON, never 500."""
    db.execute("PRAGMA foreign_keys=OFF")
    db.execute("DROP TABLE IF EXISTS users")
    db.commit()

    anon = make_client()
    r = anon.post("/api/settings/complete-setup", json={"admin_password": "FreshPass123!"})

    assert r.status_code == 503, r.text          # actionable, not a 500
    body = r.json()                              # must be valid JSON
    assert "restart" in body["detail"].lower()


def test_short_password_rejected(make_client):
    anon = make_client()
    r = anon.post("/api/settings/complete-setup", json={"admin_password": "short"})
    assert r.status_code == 400
