"""`last_active` is a heartbeat, not an audit trail.

It used to be written --- and committed --- on every authenticated request.
Nothing signs anybody out on it: it feeds the admin dashboard's online
indicator (ONLINE_WINDOW_MINUTES = 5) and the licence seat count
(_SEAT_IDLE_MINUTES), and both work in minutes.

So the old behaviour paid a write and an fsync per request to keep a
five-minute window accurate to the second. That is a poor trade at three
tenants and a bad one at twenty: the notification bell polls every 30s and the
sidebar every 60s, so 200 idle users generate roughly 200 writes a minute for a
number nobody reads at that resolution.

The dangerous way to implement this is to skip the whole session lookup when
the heartbeat is fresh --- which would also skip the REVOCATION check, so an
admin revoking a session would find it still working for up to a minute. The
lookup still happens on every request; only the write is conditional. The last
two tests here are the ones that keep that true.
"""
import time

import pytest

pytestmark = pytest.mark.critical


def _last_active(db, username="admin"):
    row = db.execute(
        "SELECT s.last_active FROM user_sessions s "
        "  JOIN users u ON u.id = s.user_id "
        " WHERE u.username = ? AND s.revoked = 0 "
        " ORDER BY s.id DESC LIMIT 1", (username,)).fetchone()
    return row["last_active"] if row else None


def test_a_later_request_inside_the_window_does_not_rewrite_it(make_client, db):
    """The polling case: this is where the saving actually is.

    The sleep is load-bearing. `last_active` has one-second resolution, so a
    burst of requests inside the same second writes the SAME string every time
    --- an unthrottled build looks identical to a throttled one. Crossing a
    second boundary while staying inside the 60s window is what tells them
    apart, and without it this test passes against the behaviour it exists to
    prevent.
    """
    c = make_client("superadmin")
    c.get("/api/dashboard/")
    first = _last_active(db)
    assert first, "setup: a session heartbeat exists"

    time.sleep(1.05)
    for _ in range(5):
        assert c.get("/api/dashboard/").status_code == 200

    assert _last_active(db) == first, (
        "the heartbeat was rewritten a second later, still well inside the "
        "window. Each rewrite is an UPDATE plus a commit on a request that "
        "read nothing new.")


def test_the_heartbeat_is_written_when_it_has_gone_stale(monkeypatch,
                                                         make_client, db):
    """Throttling must not mean never."""
    import permissions
    monkeypatch.setattr(permissions, "SESSION_TOUCH_SECONDS", 0)

    c = make_client("superadmin")
    c.get("/api/dashboard/")
    first = _last_active(db)

    time.sleep(1.05)                      # the column is second-resolution
    c.get("/api/dashboard/")
    assert _last_active(db) != first, "the heartbeat stopped being maintained"


def test_zero_restores_the_old_behaviour(monkeypatch, make_client, db):
    """The kill switch: SESSION_TOUCH_SECONDS=0 needs no deploy."""
    import permissions
    monkeypatch.setattr(permissions, "SESSION_TOUCH_SECONDS", 0)
    assert permissions._touch_is_due("2026-09-09 12:00:00",
                                     "2026-09-09 12:00:00") is True


def test_a_missing_or_malformed_heartbeat_is_always_due(monkeypatch):
    """A session with no heartbeat should get one; a corrupt value should be
    corrected rather than frozen forever."""
    import permissions
    monkeypatch.setattr(permissions, "SESSION_TOUCH_SECONDS", 60)
    now = "2026-09-09 12:00:00"
    assert permissions._touch_is_due(None, now) is True
    assert permissions._touch_is_due("", now) is True
    assert permissions._touch_is_due("not a timestamp", now) is True


def test_the_window_boundary(monkeypatch):
    import permissions
    monkeypatch.setattr(permissions, "SESSION_TOUCH_SECONDS", 60)
    now = "2026-09-09 12:01:00"
    assert permissions._touch_is_due("2026-09-09 12:00:00", now) is True   # 60s
    assert permissions._touch_is_due("2026-09-09 12:00:01", now) is False  # 59s


# ── the part that must not be optimised away ─────────────────────────────────
def test_revocation_still_bites_on_the_very_next_request(make_client, db):
    """The dangerous shortcut this change must not become.

    Skipping the session lookup while the heartbeat is fresh would also skip
    the revoked check --- so an admin revoking a session would watch it keep
    working for up to a minute. Only the WRITE is conditional.
    """
    c = make_client("superadmin")
    assert c.get("/api/dashboard/").status_code == 200

    db.execute("UPDATE user_sessions SET revoked = 1 "
               " WHERE id = (SELECT MAX(id) FROM user_sessions)")
    db.commit()

    # No sleep: the heartbeat is deliberately still fresh, which is exactly the
    # window in which a naive throttle would keep the session alive.
    assert c.get("/api/dashboard/").status_code == 401, (
        "a revoked session was still accepted. The heartbeat throttle must "
        "skip the write, never the revocation check.")


def test_a_disabled_account_is_still_refused_immediately(make_client, db):
    """Same shape: `is_active` is re-read on every request, not cached."""
    c = make_client("superadmin")
    assert c.get("/api/dashboard/").status_code == 200

    db.execute("UPDATE users SET is_active = 0 WHERE username = 'admin'")
    db.commit()
    assert c.get("/api/dashboard/").status_code == 401
