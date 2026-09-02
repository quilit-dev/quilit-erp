"""Being idle does not sign anybody out.

There were two timers, both half an hour, and between them a cashier who
stopped to serve somebody was signed out mid-sale and a long piece of data
entry could be lost to a phone call. Both are gone: the browser no longer
watches for mouse and key events, and the server no longer revokes a session
whose last request was a while ago.

What still ends a session is unchanged — the token expires, the user signs out,
or an admin revokes it — and that is what these pin, because removing a
security control by accident is exactly as easy as removing one on purpose.

`last_active` is the subtlety. It has to go on being written even though
nothing expires on it any more: the admin dashboard reads it to show who is
online, and the licence counts concurrent seats by it. Stopping the writes
would have looked like a tidy-up and quietly frozen both.
"""
import datetime

import pytest


def _session_row(db, username="admin"):
    return db.execute(
        "SELECT s.* FROM user_sessions s JOIN users u ON u.id = s.user_id "
        "WHERE u.username = ? ORDER BY s.id DESC LIMIT 1", (username,)).fetchone()


def _age_the_session(db, minutes, username="admin"):
    """Backdate last_active, which is what the old timeout measured."""
    stale = (datetime.datetime.utcnow() - datetime.timedelta(minutes=minutes)
             ).strftime("%Y-%m-%d %H:%M:%S")
    row = _session_row(db, username)
    db.execute("UPDATE user_sessions SET last_active=? WHERE id=?", (stale, row["id"]))
    db.commit()
    return row


def test_a_long_idle_session_still_works(make_client, db):
    """Two hours untouched — four times the old limit — and still signed in."""
    c = make_client("superadmin")
    assert c.get("/api/clients/").status_code == 200

    _age_the_session(db, 120)

    r = c.get("/api/clients/")
    assert r.status_code == 200, r.text
    assert "expired" not in r.text.lower()


def test_the_session_is_not_revoked_behind_the_user(make_client, db):
    """The old code revoked the row, so even a fresh request could not save it."""
    c = make_client("superadmin")
    c.get("/api/clients/")
    row = _age_the_session(db, 240)

    c.get("/api/clients/")
    after = db.execute("SELECT revoked FROM user_sessions WHERE id=?",
                       (row["id"],)).fetchone()
    assert after["revoked"] == 0, "an idle session was revoked"


def test_last_active_is_still_written(make_client, db):
    """Nothing expires on it now, but two other features read it."""
    c = make_client("superadmin")
    c.get("/api/clients/")
    row = _age_the_session(db, 90)
    before = _session_row(db)["last_active"]

    assert c.get("/api/clients/").status_code == 200
    after = _session_row(db)["last_active"]
    assert after > before, "last_active stopped moving; online/idle and the " \
                           "seat count both go blind"


# ── what still ends a session ───────────────────────────────────────────────
def test_signing_out_still_ends_it(make_client):
    c = make_client("superadmin")
    assert c.get("/api/clients/").status_code == 200
    assert c.post("/api/auth/logout").status_code in (200, 204)
    assert c.get("/api/clients/").status_code == 401


def test_a_revoked_session_is_still_refused(make_client, db):
    """An admin ending somebody's session must still take effect at once."""
    c = make_client("superadmin")
    c.get("/api/clients/")
    row = _session_row(db)
    db.execute("UPDATE user_sessions SET revoked=1 WHERE id=?", (row["id"],))
    db.commit()

    r = c.get("/api/clients/")
    assert r.status_code == 401, r.text


def test_no_timeout_constant_survives(make_client):
    """The guard is gone from the module, not merely widened."""
    import permissions
    assert not hasattr(permissions, "_SESSION_TIMEOUT")
