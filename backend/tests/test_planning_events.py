"""
Tests for the Planning > Calendar events feature.

Standalone events live in `planning_events`. They are independent of
projects/tasks — the calendar view shows only events, not Gantt content.
This module covers CRUD + the date-range filter + permission checks.
"""

import pytest


# ── Helpers ────────────────────────────────────────────────────────────────

def _create(c, **overrides):
    """Create an event and return the resulting row from the GET list."""
    body = {
        "title":      "Team standup",
        "start_date": "2026-06-10",
        "all_day":    1,
        "color":      "#10b981",
        **overrides,
    }
    r = c.post("/api/planning/events", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── Lifecycle ──────────────────────────────────────────────────────────────

def test_create_event_minimal(as_role):
    c = as_role("Project Manager")
    res = _create(c, title="Quick reminder")
    assert "id" in res

    r = c.get("/api/planning/events")
    rows = r.json()
    assert any(e["title"] == "Quick reminder" for e in rows)


def test_event_round_trip(as_role):
    c = as_role("Project Manager")
    res = _create(c, title="Client review",
                  start_date="2026-07-15", end_date="2026-07-15",
                  all_day=0, start_time="10:30", end_time="11:30")
    eid = res["id"]

    r = c.get("/api/planning/events")
    ev = next(e for e in r.json() if e["id"] == eid)
    assert ev["title"]      == "Client review"
    assert ev["start_date"] == "2026-07-15"
    assert ev["all_day"]    == 0
    assert ev["start_time"] == "10:30"
    assert ev["end_time"]   == "11:30"


def test_owner_is_recorded(as_role):
    c = as_role("Project Manager")
    res = _create(c, title="Mine")
    r = c.get("/api/planning/events")
    ev = next(e for e in r.json() if e["id"] == res["id"])
    # owner_id is whoever was logged in; owner_name is denormalised display
    assert ev["owner_id"] is not None
    assert ev["owner_name"]  # non-empty


def test_update_event(as_role):
    c = as_role("Project Manager")
    eid = _create(c, title="Original")["id"]

    r = c.put(f"/api/planning/events/{eid}",
              json={"title": "Renamed", "color": "#ef4444"})
    assert r.status_code == 200

    rows = c.get("/api/planning/events").json()
    ev = next(e for e in rows if e["id"] == eid)
    assert ev["title"] == "Renamed"
    assert ev["color"] == "#ef4444"


def test_switching_to_all_day_clears_times(as_role):
    """When all_day is set, stored times must be wiped so the UI never shows
       stale times that the form intentionally hid."""
    c = as_role("Project Manager")
    eid = _create(c, all_day=0, start_time="09:00", end_time="10:00",
                  title="Has times")["id"]

    r = c.put(f"/api/planning/events/{eid}", json={"all_day": 1})
    assert r.status_code == 200

    ev = next(e for e in c.get("/api/planning/events").json() if e["id"] == eid)
    assert ev["all_day"]    == 1
    assert ev["start_time"] is None
    assert ev["end_time"]   is None


def test_delete_event_is_soft(as_role, db):
    c = as_role("Project Manager")
    eid = _create(c, title="To delete")["id"]

    r = c.delete(f"/api/planning/events/{eid}")
    assert r.status_code == 200

    # Gone from API responses
    assert all(e["id"] != eid for e in c.get("/api/planning/events").json())

    # Still in the DB with archived_at set — confirms soft delete semantics
    row = db.execute(
        "SELECT archived_at FROM planning_events WHERE id=?", (eid,)
    ).fetchone()
    assert row is not None
    assert row["archived_at"] is not None


# ── Validation ─────────────────────────────────────────────────────────────

def test_empty_title_rejected(as_role):
    c = as_role("Project Manager")
    r = c.post("/api/planning/events",
               json={"title": "   ", "start_date": "2026-06-01"})
    assert r.status_code == 400


def test_end_before_start_rejected(as_role):
    c = as_role("Project Manager")
    r = c.post("/api/planning/events",
               json={"title": "Bad", "start_date": "2026-06-10",
                     "end_date": "2026-06-05"})
    assert r.status_code == 400


def test_update_end_before_start_rejected(as_role):
    c = as_role("Project Manager")
    eid = _create(c, start_date="2026-06-10")["id"]
    r = c.put(f"/api/planning/events/{eid}", json={"end_date": "2026-06-05"})
    assert r.status_code == 400


# ── Date-range filter ──────────────────────────────────────────────────────

def test_range_filter_includes_overlap(as_role):
    """
    A multi-day event whose middle falls inside the window should be
    returned even when its start_date is *before* the window.
    """
    c = as_role("Project Manager")
    _create(c, title="In window",     start_date="2026-06-15", end_date="2026-06-15")
    _create(c, title="Out of window", start_date="2026-08-01", end_date="2026-08-02")
    # Spans into the window from earlier
    _create(c, title="Overlap left",  start_date="2026-05-28", end_date="2026-06-05")

    rows = c.get("/api/planning/events",
                 params={"start": "2026-06-01", "end": "2026-06-30"}).json()
    titles = {e["title"] for e in rows}
    assert "In window"     in titles
    assert "Overlap left"  in titles
    assert "Out of window" not in titles


# ── Permission gates ──────────────────────────────────────────────────────

def test_viewer_can_read_but_cannot_create(as_role):
    """Read is gated by planning.view; create by planning.create."""
    # Auditor has view but not edit/create in the seeded roles
    c = as_role("Auditor")
    assert c.get("/api/planning/events").status_code == 200

    r = c.post("/api/planning/events",
               json={"title": "Nope", "start_date": "2026-06-01"})
    assert r.status_code == 403


def test_anonymous_cannot_list_events(client):
    r = client.get("/api/planning/events")
    assert r.status_code == 401


# ── Attendees + notifications ─────────────────────────────────────────────
#
# When an event is created with attendees, each non-self user receives a
# `planning_event` notification. Updates only ping the *newly* added users
# (no spam on every edit). Existing/personal events with no attendees fire
# nothing.

def _user_id(db, username):
    row = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    assert row, f"user {username!r} missing"
    return row["id"]


def _notifs_for(db, uid):
    rows = db.execute(
        "SELECT * FROM notifications WHERE user_id=? AND type='planning_event'",
        (uid,),
    ).fetchall()
    return [dict(r) for r in rows]


def test_event_without_attendees_fires_no_notifications(as_role, db):
    c = as_role("Project Manager")
    _create(c, title="Personal todo")
    # No notifications for anyone since attendees was empty
    rows = db.execute(
        "SELECT COUNT(*) FROM notifications WHERE type='planning_event'"
    ).fetchone()[0]
    assert rows == 0


def test_create_with_attendees_notifies_each(as_role, db):
    pm    = as_role("Project Manager")
    sales = _user_id(db, "u_sales")
    crm   = _user_id(db, "u_crm")
    pm_id = _user_id(db, "u_project_mgr")

    res = pm.post("/api/planning/events", json={
        "title": "Kick-off meeting", "start_date": "2026-09-10",
        "attendees": [sales, crm, pm_id],   # pm_id is self → must be stripped
    })
    assert res.status_code == 200
    body = res.json()
    assert body["attendees_notified"] == 2     # not 3 — self filtered out

    assert len(_notifs_for(db, sales)) == 1
    assert len(_notifs_for(db, crm))   == 1
    assert len(_notifs_for(db, pm_id)) == 0    # self never notified


def test_attendees_round_trip_on_event_row(as_role, db):
    c = as_role("Project Manager")
    sales = _user_id(db, "u_sales")
    res = c.post("/api/planning/events", json={
        "title": "Round trip", "start_date": "2026-09-11",
        "attendees": [sales],
    }).json()
    eid = res["id"]

    ev = next(e for e in c.get("/api/planning/events").json() if e["id"] == eid)
    assert ev["attendees"] == [sales]


def test_invalid_attendee_id_rejected(as_role, db):
    c = as_role("Project Manager")
    r = c.post("/api/planning/events", json={
        "title": "Bad invite", "start_date": "2026-09-12",
        "attendees": [999999],
    })
    assert r.status_code == 400


def test_update_attendees_notifies_only_new_additions(as_role, db):
    c = as_role("Project Manager")
    sales = _user_id(db, "u_sales")
    crm   = _user_id(db, "u_crm")

    # Initial invite — only sales is added
    res = c.post("/api/planning/events", json={
        "title": "Standup", "start_date": "2026-09-13",
        "attendees": [sales],
    }).json()
    eid = res["id"]
    assert len(_notifs_for(db, sales)) == 1
    assert len(_notifs_for(db, crm))   == 0

    # Update — sales stays, crm is added. Only crm should be notified.
    r = c.put(f"/api/planning/events/{eid}", json={
        "attendees": [sales, crm],
    })
    assert r.status_code == 200
    assert r.json()["attendees_notified"] == 1

    assert len(_notifs_for(db, sales)) == 1  # no re-notification
    assert len(_notifs_for(db, crm))   == 1


def test_clearing_attendees_does_not_renotify(as_role, db):
    c = as_role("Project Manager")
    sales = _user_id(db, "u_sales")
    eid = c.post("/api/planning/events", json={
        "title": "Brief", "start_date": "2026-09-14",
        "attendees": [sales],
    }).json()["id"]

    # Remove all attendees
    c.put(f"/api/planning/events/{eid}", json={"attendees": []})

    ev = next(e for e in c.get("/api/planning/events").json() if e["id"] == eid)
    assert ev["attendees"] == []
    # Original notification still exists (we don't delete), but no new ones
    assert len(_notifs_for(db, sales)) == 1


def test_invited_user_sees_the_notification_link(as_role, db):
    pm   = as_role("Project Manager")
    sales_id = _user_id(db, "u_sales")
    pm.post("/api/planning/events", json={
        "title": "Demo", "start_date": "2026-09-15",
        "attendees": [sales_id],
    })

    # The invited user can read their notifications via the standard
    # notifications endpoint and see the planning_event entry.
    sales = as_role("Sales")
    payload = sales.get("/api/notifications/").json()
    pe = [n for n in payload.get("notifications", []) if n["type"] == "planning_event"]
    assert len(pe) == 1
    assert pe[0]["link"] == "/planning"


# ── Visibility scoping ────────────────────────────────────────────────────
#
# Events are personal-by-default: a user sees only events they own or were
# explicitly invited to. This keeps HR's applicant calls, managers' 1:1s
# and other private meetings from leaking to every teammate that happens
# to have planning-view permission.

def test_event_visible_to_owner(as_role):
    """The creator always sees their own event."""
    pm = as_role("Project Manager")
    eid = _create(pm, title="Mine alone")["id"]
    rows = pm.get("/api/planning/events").json()
    assert any(e["id"] == eid for e in rows)


def test_event_visible_to_invited_attendee(as_role, db):
    """An attendee sees the event in their own list — that's how invites work.

    Uses Operations Manager as the attendee since `planning.view` is required
    to read the calendar at all; Sales has no planning permission by default.
    """
    pm     = as_role("Project Manager")
    ops_id = _user_id(db, "u_ops_mgr")
    eid = pm.post("/api/planning/events", json={
        "title": "1:1 with Ops", "start_date": "2026-10-01",
        "attendees": [ops_id],
    }).json()["id"]

    ops = as_role("Operations Manager")
    rows = ops.get("/api/planning/events").json()
    assert any(e["id"] == eid for e in rows), \
        "invited attendee should see the event in their calendar"


def test_event_hidden_from_uninvolved_user(as_role, db):
    """A third party with planning-view permission must NOT see the event."""
    pm  = as_role("Project Manager")
    ops_id = _user_id(db, "u_ops_mgr")
    pm.post("/api/planning/events", json={
        "title": "PM + Ops only", "start_date": "2026-10-02",
        "attendees": [ops_id],
    })

    # Manager has planning view permission via the seeded role matrix but was
    # not invited — must not see the private event.
    mgr = as_role("Manager")
    titles = {e["title"] for e in mgr.get("/api/planning/events").json()}
    assert "PM + Ops only" not in titles, \
        "uninvited user must not see another team's private event"


def test_event_with_no_attendees_is_hidden_from_others(as_role):
    """
    An event with no attendees is fully private — only the owner sees it.
    Also serves as a boundary check for the comma-wrapped LIKE pattern:
    when `attendees` is NULL, the wrapped value is just ",," and must never
    accidentally match a viewer's id.
    """
    pm = as_role("Project Manager")
    pm.post("/api/planning/events", json={
        "title": "Solo with no invites", "start_date": "2026-10-03",
    })
    mgr = as_role("Manager")
    titles = {e["title"] for e in mgr.get("/api/planning/events").json()}
    assert "Solo with no invites" not in titles


def test_non_owner_cannot_update_event(as_role, db):
    """Even an invited attendee must not be able to edit someone else's event."""
    pm     = as_role("Project Manager")
    ops_id = _user_id(db, "u_ops_mgr")
    eid = pm.post("/api/planning/events", json={
        "title": "Owner-only edit", "start_date": "2026-10-04",
        "attendees": [ops_id],
    }).json()["id"]

    ops = as_role("Operations Manager")
    r = ops.put(f"/api/planning/events/{eid}", json={"title": "hijacked"})
    assert r.status_code == 403


def test_non_owner_cannot_delete_event(as_role, db):
    pm     = as_role("Project Manager")
    ops_id = _user_id(db, "u_ops_mgr")
    eid = pm.post("/api/planning/events", json={
        "title": "Owner-only delete", "start_date": "2026-10-05",
        "attendees": [ops_id],
    }).json()["id"]

    ops = as_role("Operations Manager")
    r = ops.delete(f"/api/planning/events/{eid}")
    assert r.status_code == 403


def test_owner_can_still_edit_and_delete_own_event(as_role):
    """Sanity check — the ownership rule must not lock out the owner."""
    pm = as_role("Project Manager")
    eid = _create(pm, title="Owner's own")["id"]

    r = pm.put(f"/api/planning/events/{eid}", json={"title": "Renamed by owner"})
    assert r.status_code == 200

    r = pm.delete(f"/api/planning/events/{eid}")
    assert r.status_code == 200
