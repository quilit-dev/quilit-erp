"""
HR Activities — a unified log of HR touchpoints (calls, meetings, interviews,
emails, notes) with built-in reminders.

Design notes
------------
* **Personal by default.** Each row has an `owner_id` and is visible only to
  that user (and superadmins). This matches how every CRM/ATS handles activity
  logs — you see your own queue, not the whole company's.

* **Reminders without a scheduler.** Creating or updating an activity inserts
  one notification row whose `deliver_at = scheduled_at - reminder_minutes`.
  The notifications list endpoint already filters by `deliver_at <= now()`, so
  the reminder simply *appears* in the bell when its time comes — no
  background process required.

* **Distinct from `recruitment_interviews`.** Recruitment interviews are
  applicant-centric (one applicant, multi-interviewer, score + decision).
  HR Activities are owner-centric (one HR user's queue) and cover activities
  that aren't tied to any applicant at all. The two coexist on purpose.
"""
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
import sqlite3

from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, notify

router = APIRouter()


# ── Reference enums ─────────────────────────────────────────────────────────
ACTIVITY_TYPES = ("Call", "Meeting", "Interview", "Email", "Note", "Task")
ACTIVITY_STATUSES = ("Planned", "Done", "Cancelled")
# Allowed reminder offsets in minutes. 0 means "no reminder". Anything else
# would be silently accepted by the DB but unwieldy in the UI, so we gate it.
ALLOWED_REMINDERS = {0, 5, 15, 30, 60, 120, 1440}


# ── Pydantic models ─────────────────────────────────────────────────────────
class ActivityCreate(BaseModel):
    activity_type:           str = "Meeting"
    subject:                 str
    description:             Optional[str] = None
    scheduled_at:            str               # 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DD HH:MM:SS'
    duration_min:            int = 30
    location:                Optional[str] = None
    applicant_id:            Optional[int] = None
    employee_id:             Optional[int] = None
    reminder_minutes_before: int = 15


class ActivityUpdate(BaseModel):
    activity_type:           Optional[str] = None
    subject:                 Optional[str] = None
    description:             Optional[str] = None
    scheduled_at:            Optional[str] = None
    duration_min:            Optional[int] = None
    location:                Optional[str] = None
    applicant_id:            Optional[int] = None
    employee_id:             Optional[int] = None
    reminder_minutes_before: Optional[int] = None
    status:                  Optional[str] = None


class ActivityComplete(BaseModel):
    completed_notes: Optional[str] = None


# ── Helpers ─────────────────────────────────────────────────────────────────
def _normalise_scheduled_at(raw: str) -> str:
    """
    Accept either 'YYYY-MM-DD HH:MM' or full 'YYYY-MM-DD HH:MM:SS'. Reject the
    raw string up front so a malformed input becomes a 400 instead of a
    silent NULL down the line. Returns a canonical 'YYYY-MM-DD HH:MM:SS'.
    """
    if not raw or not isinstance(raw, str):
        raise HTTPException(400, "scheduled_at is required")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M",
                "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    raise HTTPException(400, f"scheduled_at must be YYYY-MM-DD HH:MM[:SS], got {raw!r}")


def _validate_type(t: str):
    if t not in ACTIVITY_TYPES:
        raise HTTPException(400, f"activity_type must be one of {ACTIVITY_TYPES}")


def _validate_reminder(m: int):
    if m not in ALLOWED_REMINDERS:
        raise HTTPException(400, f"reminder_minutes_before must be one of {sorted(ALLOWED_REMINDERS)}")


def _validate_links(db: sqlite3.Connection, applicant_id, employee_id):
    """Both are optional, but a non-NULL id must point at a real row."""
    if applicant_id is not None:
        ok = db.execute(
            "SELECT 1 FROM recruitment_applicants WHERE id=? AND archived_at IS NULL",
            (applicant_id,),
        ).fetchone()
        if not ok:
            raise HTTPException(400, "applicant_id does not match a current applicant")
    if employee_id is not None:
        ok = db.execute(
            "SELECT 1 FROM hr_employees WHERE id=? AND archived_at IS NULL",
            (employee_id,),
        ).fetchone()
        if not ok:
            raise HTTPException(400, "employee_id does not match a current employee")


def _compute_deliver_at(scheduled_at: str, reminder_min: int) -> Optional[str]:
    """Return the deliver_at timestamp for the reminder notification, or None
    when the reminder is disabled (offset 0). The notification will appear in
    the bell exactly when this timestamp passes."""
    if not reminder_min:
        return None
    dt = datetime.strptime(scheduled_at, "%Y-%m-%d %H:%M:%S") - timedelta(minutes=reminder_min)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _link_label(db: sqlite3.Connection, applicant_id, employee_id) -> str:
    """Build the short subtitle stored in the reminder notification body."""
    if applicant_id:
        r = db.execute(
            "SELECT full_name FROM recruitment_applicants WHERE id=?", (applicant_id,)
        ).fetchone()
        if r:
            return f"Applicant: {r['full_name']}"
    if employee_id:
        r = db.execute(
            "SELECT full_name FROM hr_employees WHERE id=?", (employee_id,)
        ).fetchone()
        if r:
            return f"Employee: {r['full_name']}"
    return ""


def _schedule_reminder(
    db: sqlite3.Connection,
    *,
    activity_id: int,
    owner_id: int,
    subject: str,
    activity_type: str,
    scheduled_at: str,
    reminder_min: int,
    link_label: str,
) -> Optional[int]:
    """
    Insert (or skip) the reminder notification for an activity. Returns the
    new notification id, or None when no reminder is required.

    Skipped when:
      * reminder_min == 0 (user disabled it)
      * computed deliver_at is already in the past — there's nothing to wait
        for, so spamming the bell would just be noise.
    """
    deliver_at = _compute_deliver_at(scheduled_at, reminder_min)
    if not deliver_at:
        return None
    if deliver_at <= _now():
        return None
    pretty_when = scheduled_at[:16].replace(" ", " at ")
    body = f"{activity_type} '{subject}' starts at {pretty_when}."
    if link_label:
        body += f"  ({link_label})"
    return notify(
        db,
        user_id=owner_id,
        type="hr_activity_reminder",
        title=f"⏰ Reminder: {subject}",
        body=body,
        link="/hr-activities",
        entity_type="hr_activity",
        entity_id=activity_id,
        deliver_at=deliver_at,
    )


def _clear_reminder(db: sqlite3.Connection, activity_id: int) -> None:
    """Wipe any existing (future) reminder for this activity so updates don't
    leave duplicates lying around. Already-delivered reminders stay in the
    bell — the user might want to see that history."""
    row = db.execute(
        "SELECT reminder_notif_id FROM hr_activities WHERE id=?", (activity_id,)
    ).fetchone()
    if row and row["reminder_notif_id"]:
        db.execute(
            "DELETE FROM notifications WHERE id=? AND deliver_at IS NOT NULL "
            "AND deliver_at > datetime('now')",
            (row["reminder_notif_id"],),
        )


def _can_see(row: sqlite3.Row, user: dict) -> bool:
    return row["owner_id"] == user["id"] or user.get("is_superadmin")


def _require_owned(db: sqlite3.Connection, aid: int, user: dict) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM hr_activities WHERE id=? AND archived_at IS NULL", (aid,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Activity not found")
    if not _can_see(row, user):
        # Don't reveal existence to non-owners.
        raise HTTPException(404, "Activity not found")
    return row


# ── List / get ──────────────────────────────────────────────────────────────
@router.get("")
def list_activities(
    scope:        str  = Query("upcoming", description="upcoming | today | overdue | done | all"),
    activity_type: Optional[str] = Query(None),
    applicant_id: Optional[int]  = Query(None),
    employee_id:  Optional[int]  = Query(None),
    limit:        int  = Query(200, ge=1, le=500),
    user=Depends(require_perm("hr_activities", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Return the calling user's activity queue (superadmin sees all). Default
    `scope=upcoming` is what the HR Activities page lands on — the next 14
    days of planned items.
    """
    sql = [
        "SELECT a.*,",
        "       ap.full_name AS applicant_name,",
        "       e.full_name  AS employee_name,",
        "       u.full_name  AS owner_name",
        "FROM hr_activities a",
        "LEFT JOIN recruitment_applicants ap ON ap.id = a.applicant_id",
        "LEFT JOIN hr_employees           e  ON e.id  = a.employee_id",
        "LEFT JOIN users                  u  ON u.id  = a.owner_id",
        "WHERE a.archived_at IS NULL",
    ]
    args: list = []
    if not user.get("is_superadmin"):
        sql.append("AND a.owner_id = ?")
        args.append(user["id"])
    if activity_type:
        _validate_type(activity_type)
        sql.append("AND a.activity_type = ?")
        args.append(activity_type)
    if applicant_id:
        sql.append("AND a.applicant_id = ?")
        args.append(applicant_id)
    if employee_id:
        sql.append("AND a.employee_id = ?")
        args.append(employee_id)

    if scope == "upcoming":
        # Planned activities from now through the next 14 days. Excludes
        # overdue so the screen doesn't fill with stale items the user
        # forgot to close — `scope=overdue` surfaces those separately.
        sql.append("AND a.status = 'Planned'")
        sql.append("AND a.scheduled_at >= datetime('now')")
        sql.append("AND a.scheduled_at <= datetime('now', '+14 days')")
        sql.append("ORDER BY a.scheduled_at ASC")
    elif scope == "today":
        sql.append("AND a.status = 'Planned'")
        sql.append("AND date(a.scheduled_at) = date('now')")
        sql.append("ORDER BY a.scheduled_at ASC")
    elif scope == "overdue":
        sql.append("AND a.status = 'Planned'")
        sql.append("AND a.scheduled_at < datetime('now')")
        sql.append("ORDER BY a.scheduled_at ASC")
    elif scope == "done":
        sql.append("AND a.status = 'Done'")
        sql.append("ORDER BY COALESCE(a.completed_at, a.scheduled_at) DESC")
    elif scope == "all":
        sql.append("ORDER BY a.scheduled_at DESC")
    else:
        raise HTTPException(400, f"unknown scope {scope!r}")

    sql.append("LIMIT ?")
    args.append(limit)

    rows = db.execute(" ".join(sql), args).fetchall()
    return [dict(r) for r in rows]


@router.get("/summary")
def summary(
    user=Depends(require_perm("hr_activities", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Counters for the page header — today / upcoming / overdue / done(7d)."""
    base_args = [] if user.get("is_superadmin") else [user["id"]]
    base_where = "WHERE archived_at IS NULL"
    if not user.get("is_superadmin"):
        base_where += " AND owner_id = ?"

    today_n = db.execute(
        f"SELECT COUNT(*) FROM hr_activities {base_where} "
        f"AND status='Planned' AND date(scheduled_at) = date('now')",
        base_args,
    ).fetchone()[0]
    upcoming_n = db.execute(
        f"SELECT COUNT(*) FROM hr_activities {base_where} "
        f"AND status='Planned' AND scheduled_at >= datetime('now') "
        f"AND scheduled_at <= datetime('now', '+14 days')",
        base_args,
    ).fetchone()[0]
    overdue_n = db.execute(
        f"SELECT COUNT(*) FROM hr_activities {base_where} "
        f"AND status='Planned' AND scheduled_at < datetime('now')",
        base_args,
    ).fetchone()[0]
    done_7d = db.execute(
        f"SELECT COUNT(*) FROM hr_activities {base_where} "
        f"AND status='Done' AND completed_at >= datetime('now', '-7 days')",
        base_args,
    ).fetchone()[0]

    return {
        "today":       today_n,
        "upcoming_14": upcoming_n,
        "overdue":     overdue_n,
        "done_7d":     done_7d,
    }


@router.get("/{aid}")
def get_activity(
    aid: int,
    user=Depends(require_perm("hr_activities", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Mirror the columns the list endpoint returns (joined applicant /
    employee / owner names) so the form modal can be opened with a single
    fetch."""
    _require_owned(db, aid, user)
    row = db.execute(
        """SELECT a.*,
                  ap.full_name AS applicant_name,
                  e.full_name  AS employee_name,
                  u.full_name  AS owner_name
           FROM hr_activities a
           LEFT JOIN recruitment_applicants ap ON ap.id = a.applicant_id
           LEFT JOIN hr_employees           e  ON e.id  = a.employee_id
           LEFT JOIN users                  u  ON u.id  = a.owner_id
           WHERE a.id=?""",
        (aid,),
    ).fetchone()
    return dict(row)


# ── Create ─────────────────────────────────────────────────────────────────
@router.post("")
def create_activity(
    body: ActivityCreate,
    user=Depends(require_perm("hr_activities", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not body.subject or not body.subject.strip():
        raise HTTPException(400, "Subject is required")
    _validate_type(body.activity_type)
    _validate_reminder(body.reminder_minutes_before)
    scheduled_at = _normalise_scheduled_at(body.scheduled_at)
    duration = max(0, int(body.duration_min or 0))
    _validate_links(db, body.applicant_id, body.employee_id)

    now = _now()
    cur = db.execute(
        """INSERT INTO hr_activities
              (owner_id, activity_type, subject, description, scheduled_at,
               duration_min, location, status, applicant_id, employee_id,
               reminder_minutes_before, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Planned', ?, ?, ?, ?)""",
        (user["id"], body.activity_type, body.subject.strip(), body.description,
         scheduled_at, duration, body.location,
         body.applicant_id, body.employee_id, body.reminder_minutes_before, now),
    )
    aid = cur.lastrowid

    # Schedule the reminder (may be a no-op if reminder=0 or already in the past).
    notif_id = _schedule_reminder(
        db,
        activity_id=aid,
        owner_id=user["id"],
        subject=body.subject.strip(),
        activity_type=body.activity_type,
        scheduled_at=scheduled_at,
        reminder_min=body.reminder_minutes_before,
        link_label=_link_label(db, body.applicant_id, body.employee_id),
    )
    if notif_id:
        db.execute(
            "UPDATE hr_activities SET reminder_notif_id=? WHERE id=?",
            (notif_id, aid),
        )

    db.commit()
    log_action(db, user, "create", "hr_activity", aid, body.subject.strip())
    return {"id": aid, "message": "Activity created", "reminder_scheduled": bool(notif_id)}


# ── Update ─────────────────────────────────────────────────────────────────
@router.put("/{aid}")
def update_activity(
    aid: int,
    body: ActivityUpdate,
    user=Depends(require_perm("hr_activities", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = _require_owned(db, aid, user)

    # Merge the patch with the current row so we always have a consistent
    # picture for reminder math and link validation.
    new_type     = body.activity_type or row["activity_type"]
    new_subject  = (body.subject if body.subject is not None else row["subject"]) or ""
    new_sched    = _normalise_scheduled_at(body.scheduled_at) if body.scheduled_at else row["scheduled_at"]
    new_remind   = body.reminder_minutes_before if body.reminder_minutes_before is not None \
                   else row["reminder_minutes_before"]
    new_app_id   = body.applicant_id if body.applicant_id is not None else row["applicant_id"]
    new_emp_id   = body.employee_id  if body.employee_id  is not None else row["employee_id"]
    new_status   = body.status or row["status"]
    new_duration = body.duration_min if body.duration_min is not None else row["duration_min"]

    if not new_subject.strip():
        raise HTTPException(400, "Subject cannot be empty")
    _validate_type(new_type)
    _validate_reminder(new_remind)
    if new_status not in ACTIVITY_STATUSES:
        raise HTTPException(400, f"status must be one of {ACTIVITY_STATUSES}")
    _validate_links(db, new_app_id, new_emp_id)

    db.execute(
        """UPDATE hr_activities SET
              activity_type=?, subject=?, description=COALESCE(?, description),
              scheduled_at=?, duration_min=?, location=COALESCE(?, location),
              applicant_id=?, employee_id=?, reminder_minutes_before=?,
              status=?, updated_at=?
           WHERE id=?""",
        (new_type, new_subject.strip(), body.description,
         new_sched, max(0, int(new_duration or 0)), body.location,
         new_app_id, new_emp_id, new_remind,
         new_status, _now(), aid),
    )

    # Rebuild the pending reminder so the bell stays in sync with the new
    # schedule. Already-fired reminders are left alone (they're history).
    _clear_reminder(db, aid)
    db.execute("UPDATE hr_activities SET reminder_notif_id=NULL WHERE id=?", (aid,))
    if new_status == "Planned":
        notif_id = _schedule_reminder(
            db,
            activity_id=aid,
            owner_id=row["owner_id"],
            subject=new_subject.strip(),
            activity_type=new_type,
            scheduled_at=new_sched,
            reminder_min=new_remind,
            link_label=_link_label(db, new_app_id, new_emp_id),
        )
        if notif_id:
            db.execute(
                "UPDATE hr_activities SET reminder_notif_id=? WHERE id=?",
                (notif_id, aid),
            )

    db.commit()
    log_action(db, user, "edit", "hr_activity", aid, new_subject.strip())
    return {"message": "Activity updated"}


# ── Complete ───────────────────────────────────────────────────────────────
@router.patch("/{aid}/complete")
def complete_activity(
    aid: int,
    body: ActivityComplete,
    user=Depends(require_perm("hr_activities", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Mark an activity Done in one click. Optional outcome notes."""
    row = _require_owned(db, aid, user)
    if row["status"] == "Done":
        return {"message": "Already completed"}

    db.execute(
        "UPDATE hr_activities SET status='Done', completed_at=?, "
        "completed_notes=COALESCE(?, completed_notes), updated_at=? WHERE id=?",
        (_now(), body.completed_notes, _now(), aid),
    )
    # No further reminders needed — wipe the pending one if any.
    _clear_reminder(db, aid)
    db.execute("UPDATE hr_activities SET reminder_notif_id=NULL WHERE id=?", (aid,))
    db.commit()
    log_action(db, user, "complete", "hr_activity", aid, row["subject"])
    return {"message": "Activity marked done"}


# ── Archive (soft-delete) ──────────────────────────────────────────────────
@router.patch("/{aid}/archive")
def archive_activity(
    aid: int,
    user=Depends(require_perm("hr_activities", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = _require_owned(db, aid, user)
    db.execute(
        "UPDATE hr_activities SET archived_at=?, updated_at=? WHERE id=?",
        (_now(), _now(), aid),
    )
    _clear_reminder(db, aid)
    db.execute("UPDATE hr_activities SET reminder_notif_id=NULL WHERE id=?", (aid,))
    db.commit()
    log_action(db, user, "archive", "hr_activity", aid, row["subject"])
    return {"message": "Activity archived"}


# ── Reference dropdowns — applicants + employees for the form ──────────────
@router.get("/dropdown/applicants")
def dropdown_applicants(
    user=Depends(require_perm("hr_activities", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, full_name FROM recruitment_applicants "
        "WHERE archived_at IS NULL ORDER BY full_name"
    ).fetchall()
    return [{"id": r["id"], "name": r["full_name"]} for r in rows]


@router.get("/dropdown/employees")
def dropdown_employees(
    user=Depends(require_perm("hr_activities", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        "SELECT id, full_name FROM hr_employees "
        "WHERE archived_at IS NULL ORDER BY full_name"
    ).fetchall()
    return [{"id": r["id"], "name": r["full_name"]} for r in rows]
