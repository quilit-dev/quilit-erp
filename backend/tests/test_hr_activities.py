"""
Tests for the HR Activities module — a personal queue of calls / meetings /
interviews / emails / notes with built-in time-deferred reminders.

The reminder mechanism leans on `notifications.deliver_at` rather than a
background scheduler, so most tests revolve around three invariants:
  1. The activity row + its reminder notification are written atomically.
  2. The reminder is hidden in the bell until `deliver_at` is reached.
  3. Edits/completes/archives keep the notification state in lockstep.
"""
from datetime import datetime, timedelta

import pytest


# ── Helpers ────────────────────────────────────────────────────────────────
def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _user_id(db, username):
    row = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    assert row, f"user {username!r} missing"
    return row["id"]


def _create(c, **overrides):
    body = {
        "activity_type": "Meeting",
        "subject":       "Catch-up with team",
        "scheduled_at":  _iso(datetime.utcnow() + timedelta(days=1)),
        "duration_min":  30,
        "reminder_minutes_before": 15,
        **overrides,
    }
    r = c.post("/api/hr-activities", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── CRUD lifecycle ─────────────────────────────────────────────────────────
def test_create_minimal(as_role):
    c = as_role("HR Manager")
    res = _create(c, subject="First call with applicant")
    assert "id" in res
    assert res["reminder_scheduled"] is True


def test_round_trip_list(as_role):
    c = as_role("HR Manager")
    aid = _create(c, subject="Coffee chat",
                  scheduled_at=_iso(datetime.utcnow() + timedelta(hours=2)))["id"]
    rows = c.get("/api/hr-activities").json()
    assert any(a["id"] == aid and a["subject"] == "Coffee chat" for a in rows)


def test_update_changes_fields(as_role):
    c = as_role("HR Manager")
    aid = _create(c, subject="Initial")["id"]

    r = c.put(f"/api/hr-activities/{aid}",
              json={"subject": "Renamed", "location": "Room 12"})
    assert r.status_code == 200

    row = c.get(f"/api/hr-activities/{aid}").json()
    assert row["subject"]  == "Renamed"
    assert row["location"] == "Room 12"


def test_complete_marks_done(as_role):
    c = as_role("HR Manager")
    aid = _create(c)["id"]
    r = c.patch(f"/api/hr-activities/{aid}/complete",
                json={"completed_notes": "Went great"})
    assert r.status_code == 200
    row = c.get(f"/api/hr-activities/{aid}").json()
    assert row["status"] == "Done"
    assert row["completed_at"]
    assert row["completed_notes"] == "Went great"


def test_archive_hides_from_list(as_role, db):
    c = as_role("HR Manager")
    aid = _create(c, subject="To archive")["id"]
    assert c.patch(f"/api/hr-activities/{aid}/archive").status_code == 200
    rows = c.get("/api/hr-activities", params={"scope": "all"}).json()
    assert all(a["id"] != aid for a in rows)
    # Still in DB with archived_at set (soft-delete semantics)
    row = db.execute(
        "SELECT archived_at FROM hr_activities WHERE id=?", (aid,)
    ).fetchone()
    assert row["archived_at"] is not None


# ── Visibility (personal queue) ────────────────────────────────────────────
def test_owner_only_visibility(as_role):
    """Activities belong to the user who created them — another HR-role user
    must not see them via the list endpoint."""
    hr_mgr = as_role("HR Manager")
    aid = _create(hr_mgr, subject="HR Manager's private call")["id"]

    other = as_role("Auditor")  # has hr_activities view, but isn't the owner
    rows = other.get("/api/hr-activities", params={"scope": "all"}).json()
    assert all(a["id"] != aid for a in rows), \
        "Auditor should not see HR Manager's personal activities"


def test_owner_only_get(as_role):
    """Direct GET by id returns 404 to non-owners — does not leak existence."""
    hr_mgr = as_role("HR Manager")
    aid = _create(hr_mgr)["id"]
    other = as_role("Auditor")  # has hr_activities view, but isn't the owner
    r = other.get(f"/api/hr-activities/{aid}")
    assert r.status_code == 404


# ── Permission gates ──────────────────────────────────────────────────────
def test_anonymous_blocked(client):
    r = client.get("/api/hr-activities")
    assert r.status_code == 401


def test_role_without_hr_activities_blocked(as_role):
    """A Sales user (no hr_activities permission) gets 403."""
    c = as_role("Sales")
    r = c.get("/api/hr-activities")
    assert r.status_code == 403


# ── Validation ────────────────────────────────────────────────────────────
def test_subject_required(as_role):
    c = as_role("HR Manager")
    r = c.post("/api/hr-activities", json={
        "subject": "   ",
        "scheduled_at": _iso(datetime.utcnow() + timedelta(days=1)),
    })
    assert r.status_code == 400


def test_invalid_type_rejected(as_role):
    c = as_role("HR Manager")
    r = c.post("/api/hr-activities", json={
        "activity_type": "Disco",
        "subject": "Bad type",
        "scheduled_at": _iso(datetime.utcnow() + timedelta(days=1)),
    })
    assert r.status_code == 400


def test_invalid_reminder_rejected(as_role):
    c = as_role("HR Manager")
    r = c.post("/api/hr-activities", json={
        "subject": "Bad reminder",
        "scheduled_at": _iso(datetime.utcnow() + timedelta(days=1)),
        "reminder_minutes_before": 7,    # not in ALLOWED_REMINDERS
    })
    assert r.status_code == 400


def test_malformed_date_rejected(as_role):
    c = as_role("HR Manager")
    r = c.post("/api/hr-activities", json={
        "subject": "Bad date",
        "scheduled_at": "tomorrow at noon",
    })
    assert r.status_code == 400


def test_unknown_applicant_rejected(as_role):
    c = as_role("HR Manager")
    r = c.post("/api/hr-activities", json={
        "subject": "Bad applicant",
        "scheduled_at": _iso(datetime.utcnow() + timedelta(days=1)),
        "applicant_id": 999999,
    })
    assert r.status_code == 400


# ── Reminder mechanics ────────────────────────────────────────────────────
def test_reminder_inserted_with_deliver_at(as_role, db):
    """
    Creating an activity with a 15-minute reminder should write a
    notification row whose deliver_at = scheduled_at - 15 min.
    """
    c = as_role("HR Manager")
    sched = datetime.utcnow() + timedelta(hours=4)
    res = _create(c, scheduled_at=_iso(sched), reminder_minutes_before=15)
    aid = res["id"]

    # Look up the linked notification through the activity row.
    notif_id = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (aid,)
    ).fetchone()["reminder_notif_id"]
    assert notif_id, "reminder notification should be linked"

    notif = db.execute(
        "SELECT type, deliver_at, entity_type, entity_id, is_read "
        "FROM notifications WHERE id=?", (notif_id,)
    ).fetchone()
    assert notif["type"]        == "hr_activity_reminder"
    assert notif["entity_type"] == "hr_activity"
    assert notif["entity_id"]   == aid
    assert notif["is_read"]     == 0

    expected = (sched - timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S")
    assert notif["deliver_at"] == expected


def test_reminder_hidden_until_deliver_at(as_role, db):
    """A future reminder must not appear in the notifications bell yet."""
    c = as_role("HR Manager")
    _create(c, subject="Way later", reminder_minutes_before=60,
            scheduled_at=_iso(datetime.utcnow() + timedelta(days=2)))

    payload = c.get("/api/notifications/").json()
    titles = [n["title"] for n in payload["notifications"]]
    assert not any("Way later" in t for t in titles), \
        "Reminder should be deferred until deliver_at"
    # Same story for the unread count
    cnt = c.get("/api/notifications/count").json()["unread_count"]
    # The deferred reminder must not contribute to the badge.
    assert all(n["title"] for n in payload["notifications"])  # sanity


def test_past_reminder_is_skipped(as_role, db):
    """Scheduling something with a reminder already in the past should NOT
       spam the bell with an immediately-due ping — the row goes through
       without a notification."""
    c = as_role("HR Manager")
    # Activity in 5 minutes, 15-minute reminder = -10 min ago. Skipped.
    res = _create(c, subject="Imminent",
                  scheduled_at=_iso(datetime.utcnow() + timedelta(minutes=5)),
                  reminder_minutes_before=15)
    assert res["reminder_scheduled"] is False

    row = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (res["id"],)
    ).fetchone()
    assert row["reminder_notif_id"] is None


def test_zero_reminder_means_no_notification(as_role, db):
    c = as_role("HR Manager")
    res = _create(c, reminder_minutes_before=0)
    assert res["reminder_scheduled"] is False
    row = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (res["id"],)
    ).fetchone()
    assert row["reminder_notif_id"] is None


def test_editing_reschedules_reminder(as_role, db):
    """When the scheduled_at changes, the linked notification's deliver_at
    must follow. We do this by deleting the old (future) reminder and
    inserting a new one, so the bell never carries a stale ping."""
    c = as_role("HR Manager")
    res = _create(c,
                  scheduled_at=_iso(datetime.utcnow() + timedelta(hours=6)),
                  reminder_minutes_before=15)
    aid = res["id"]
    old_notif_id = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (aid,)
    ).fetchone()["reminder_notif_id"]

    new_sched = datetime.utcnow() + timedelta(days=3)
    r = c.put(f"/api/hr-activities/{aid}",
              json={"scheduled_at": _iso(new_sched)})
    assert r.status_code == 200

    new_notif_id = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (aid,)
    ).fetchone()["reminder_notif_id"]
    # Old reminder gone, new one in place.
    assert new_notif_id and new_notif_id != old_notif_id
    expected = (new_sched - timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M:%S")
    new_deliver = db.execute(
        "SELECT deliver_at FROM notifications WHERE id=?", (new_notif_id,)
    ).fetchone()["deliver_at"]
    assert new_deliver == expected
    # Original notification was deleted (it was still in the future).
    assert db.execute(
        "SELECT 1 FROM notifications WHERE id=?", (old_notif_id,)
    ).fetchone() is None


def test_completing_cancels_reminder(as_role, db):
    """A completed activity should drop its pending reminder."""
    c = as_role("HR Manager")
    res = _create(c, scheduled_at=_iso(datetime.utcnow() + timedelta(days=1)),
                  reminder_minutes_before=15)
    aid = res["id"]
    notif_id = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (aid,)
    ).fetchone()["reminder_notif_id"]
    assert notif_id

    c.patch(f"/api/hr-activities/{aid}/complete", json={})
    # Reminder notification gone, link cleared.
    assert db.execute(
        "SELECT 1 FROM notifications WHERE id=?", (notif_id,)
    ).fetchone() is None
    assert db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (aid,)
    ).fetchone()["reminder_notif_id"] is None


def test_due_reminder_appears_in_bell(as_role, db):
    """Force a deliver_at into the past and verify it surfaces in the list."""
    c = as_role("HR Manager")
    res = _create(c, subject="Should ping now",
                  scheduled_at=_iso(datetime.utcnow() + timedelta(hours=1)),
                  reminder_minutes_before=15)
    notif_id = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (res["id"],)
    ).fetchone()["reminder_notif_id"]
    assert notif_id

    # Backdate deliver_at to simulate the wall-clock catching up.
    db.execute(
        "UPDATE notifications SET deliver_at = datetime('now', '-1 minutes') "
        "WHERE id=?", (notif_id,),
    )
    db.commit()

    payload = c.get("/api/notifications/").json()
    titles = [n["title"] for n in payload["notifications"]]
    assert any("Should ping now" in t for t in titles)


# ── Scope filters ─────────────────────────────────────────────────────────
def test_scope_upcoming_excludes_overdue(as_role):
    c = as_role("HR Manager")
    # One future, one past — upcoming scope should only return the future one.
    _create(c, subject="Future event",
            scheduled_at=_iso(datetime.utcnow() + timedelta(hours=3)),
            reminder_minutes_before=0)
    _create(c, subject="Past event",
            scheduled_at=_iso(datetime.utcnow() - timedelta(hours=3)),
            reminder_minutes_before=0)

    titles = {a["subject"] for a in c.get("/api/hr-activities").json()}
    assert "Future event" in titles
    assert "Past event"   not in titles


def test_scope_overdue_returns_only_past_planned(as_role):
    c = as_role("HR Manager")
    _create(c, subject="Future",
            scheduled_at=_iso(datetime.utcnow() + timedelta(hours=3)),
            reminder_minutes_before=0)
    _create(c, subject="Past",
            scheduled_at=_iso(datetime.utcnow() - timedelta(hours=3)),
            reminder_minutes_before=0)

    titles = {a["subject"]
              for a in c.get("/api/hr-activities", params={"scope": "overdue"}).json()}
    assert "Past"   in titles
    assert "Future" not in titles


def test_summary_counters(as_role):
    c = as_role("HR Manager")
    _create(c, subject="Today",
            scheduled_at=_iso(datetime.utcnow() + timedelta(minutes=30)),
            reminder_minutes_before=0)
    _create(c, subject="Tomorrow",
            scheduled_at=_iso(datetime.utcnow() + timedelta(days=1)),
            reminder_minutes_before=0)
    _create(c, subject="Yesterday",
            scheduled_at=_iso(datetime.utcnow() - timedelta(days=1)),
            reminder_minutes_before=0)

    s = c.get("/api/hr-activities/summary").json()
    # Today's count includes any activity scheduled later today (the 30-min one).
    assert s["today"]       >= 1
    assert s["upcoming_14"] >= 2     # 30-min-from-now + tomorrow
    assert s["overdue"]     >= 1     # yesterday's planned item


# ── Linking to applicants / employees ─────────────────────────────────────
def test_link_to_applicant(as_role, db):
    """Creating an activity with a real applicant_id stores the link and the
    dropdown surfaces the applicant's name in the join columns."""
    c = as_role("HR Manager")
    # Need an applicant in the DB. Insert one directly to avoid coupling this
    # suite to the recruitment API's payload shape.
    now = _iso(datetime.utcnow())
    db.execute(
        "INSERT INTO recruitment_applicants (full_name, status, applied_at, created_at) "
        "VALUES (?, 'Applied', ?, ?)", ("Alice Tester", now, now),
    )
    db.commit()
    app_id = db.execute(
        "SELECT id FROM recruitment_applicants WHERE full_name='Alice Tester'"
    ).fetchone()["id"]

    aid = _create(c, subject="Phone screen", applicant_id=app_id,
                  reminder_minutes_before=0)["id"]
    row = c.get(f"/api/hr-activities/{aid}").json()
    assert row["applicant_id"]   == app_id
    assert row["applicant_name"] == "Alice Tester"


def test_dropdowns_return_active_only(as_role, db):
    """Archived applicants and deleted employees must not appear in the
    activity-form dropdowns."""
    c = as_role("HR Manager")
    now = _iso(datetime.utcnow())
    db.execute(
        "INSERT INTO recruitment_applicants (full_name, status, applied_at, created_at, archived_at) "
        "VALUES (?, 'Withdrawn', ?, ?, ?)", ("Bob Archived", now, now, now),
    )
    db.commit()

    names = {a["name"] for a in c.get("/api/hr-activities/dropdown/applicants").json()}
    assert "Bob Archived" not in names
