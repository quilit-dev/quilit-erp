"""Deleting a user, and getting the name back.

Deleting is a SOFT delete: the row stays, because every `created_by` pointer
and every audit entry has to keep resolving to a person. But `users.username`
is UNIQUE at the schema level, so the dead row went on holding the name and the
same person could never be recreated — the failure surfaced as the generic
"would duplicate an existing record", which says nothing about which record or
why.

Every application-level check already ignored deleted rows. The refusal came
from the constraint, not from a rule anyone meant to have.
"""
import pytest

from helpers.seeding import TEST_PASSWORD


def _users(c):
    return {u["username"]: u for u in c.get("/api/users/").json()}


def _create(c, username, **kw):
    body = {"username": username, "password": "password123",
            "full_name": kw.pop("full_name", username.title())}
    body.update(kw)
    return c.post("/api/users/", json=body)


@pytest.fixture
def admin(make_client):
    return make_client("superadmin")


def test_a_deleted_username_can_be_used_again(admin):
    """The reported bug: create ali, delete ali, cannot create ali."""
    assert _create(admin, "ali").status_code == 200
    first = _users(admin)["ali"]["id"]
    assert admin.delete(f"/api/users/{first}").status_code == 200

    again = _create(admin, "ali", full_name="Ali Again")

    assert again.status_code == 200, again.text
    assert _users(admin)["ali"]["id"] != first


def test_the_same_name_can_go_round_more_than_once(admin):
    """Suffixing with the row id, so two dead rows never collide with each
    other either — which a fixed suffix like '#deleted' would."""
    for _ in range(3):
        assert _create(admin, "ali_round").status_code == 200, "round trip failed"
        admin.delete(f"/api/users/{_users(admin)['ali_round']['id']}")

    assert _create(admin, "ali_round").status_code == 200


def test_a_name_in_live_use_is_still_refused(admin):
    """And says which name, rather than falling through to the constraint."""
    assert _create(admin, "ali_live").status_code == 200

    r = _create(admin, "ali_live")

    assert r.status_code == 400
    assert "ali_live" in r.json()["detail"]
    assert "already taken" in r.json()["detail"]


def test_the_recreated_account_is_a_new_person(admin, db):
    """Not a revival: the old row keeps its id, so anything pointing at it
    still points at who did the work, and the new account inherits none of it.
    """
    _create(admin, "ali_person")
    old_id = _users(admin)["ali_person"]["id"]
    admin.delete(f"/api/users/{old_id}")
    _create(admin, "ali_person", full_name="Someone Else")
    new_id = _users(admin)["ali_person"]["id"]

    assert new_id != old_id
    row = db.execute("SELECT username, deleted_at, is_active FROM users WHERE id=?",
                     (old_id,)).fetchone()
    assert row["deleted_at"] is not None
    assert row["is_active"] == 0
    # Still there, still identifiable, no longer holding the name.
    assert row["username"] == f"ali_person#deleted{old_id}"


def test_the_deleted_account_cannot_log_in_under_either_name(admin, make_client):
    _create(admin, "ali_login")
    uid = _users(admin)["ali_login"]["id"]
    admin.delete(f"/api/users/{uid}")

    anon = make_client()
    for name in ("ali_login", f"ali_login#deleted{uid}"):
        r = anon.post("/api/auth/login",
                      json={"username": name, "password": "password123"})
        assert r.status_code != 200, name


def test_a_live_user_keeps_their_name(admin, db):
    """The rename happens on delete and nowhere else."""
    _create(admin, "ali_keeps")

    row = db.execute("SELECT username FROM users WHERE username='ali_keeps'").fetchone()

    assert row is not None


# ── The rows that predate the fix ────────────────────────────────────────────

def test_the_migration_frees_a_name_a_deleted_row_was_holding(db):
    """Every account deleted before this shipped is still sitting on its name.

    Migration 169 reaches those, and has to be safe to run again: the Postgres
    half lives in the post-baseline, which executes on every boot.
    """
    db.execute(
        "INSERT INTO users (username, password_hash, full_name, role, is_active, "
        " deleted_at, created_at) VALUES (?,?,?,?,0,datetime('now'),datetime('now'))",
        ("legacy_ali", "x", "Legacy Ali", "user"))
    uid = db.execute("SELECT id FROM users WHERE username='legacy_ali'").fetchone()["id"]

    free = ("UPDATE users SET username = username || '#deleted' || id "
            " WHERE deleted_at IS NOT NULL AND username NOT LIKE ('%#deleted' || id)")
    db.execute(free)
    db.commit()

    after = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
    assert after["username"] == f"legacy_ali#deleted{uid}"

    # Idempotent: a second pass must not stack another suffix on.
    db.execute(free)
    db.commit()
    assert db.execute("SELECT username FROM users WHERE id=?",
                      (uid,)).fetchone()["username"] == f"legacy_ali#deleted{uid}"


def test_the_migration_is_written_into_both_backends(db):
    """SQLite replays a numbered chain; Postgres applies a baseline plus the
    post-baseline block. A statement in one and not the other fixes the problem
    on a developer's machine and leaves it in production."""
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] / "database.py").read_text(
        encoding="utf-8")

    assert src.count("SET username = username || '#deleted' || id") == 2
    assert "169_free_deleted_usernames" in src


def test_seeded_accounts_are_untouched(admin):
    """A guard on the migration's WHERE clause: it must match deleted rows and
    nothing else. Renaming a live login locks somebody out of the system."""
    names = set(_users(admin))

    assert "admin" in names
    assert not any("#deleted" in n for n in names)


def test_a_deleted_user_is_gone_from_the_list(admin):
    _create(admin, "ali_gone")
    admin.delete(f"/api/users/{_users(admin)['ali_gone']['id']}")

    assert "ali_gone" not in _users(admin)
    assert not any("#deleted" in n for n in _users(admin))


def test_login_still_works_for_everyone_else(make_client):
    """The blast radius check: this touches the table every session reads."""
    c = make_client()
    r = c.post("/api/auth/login",
               json={"username": "admin", "password": TEST_PASSWORD})

    assert r.status_code == 200, r.text
