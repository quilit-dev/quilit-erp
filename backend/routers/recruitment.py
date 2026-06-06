"""
Recruitment — full applicant pipeline + interview management + onboarding.

Pipeline:
  Applied → Screening → Interview → Technical Test → Accepted / Rejected / Withdrawn

Architecture mirrors the HR module: status_history is an immutable audit
trail (one row per transition), interviews are scheduled per applicant with
score + decision, and file attachments (CV / cover letter / certificates) are
stored as BLOBs alongside the applicant. An Accepted applicant becomes an
employee in HR via POST /api/recruitment/applicants/{id}/convert — the CV and
any other PDFs the applicant uploaded are copied over to hr_employee_files.
"""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, validator
from typing import Optional
from datetime import date, datetime
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from routers.hr_activities import (
    _normalise_scheduled_at as _hr_normalise_scheduled_at,
    _schedule_reminder as _hr_schedule_reminder,
    _clear_reminder as _hr_clear_reminder,
)
from utils import _now, notify
import sqlite3
import storage

router = APIRouter()

# ── Pipeline reference ────────────────────────────────────────────────────────
PIPELINE_STATUSES = [
    "Applied", "Screening", "Interview", "Technical Test",
    "Accepted", "Rejected", "Withdrawn",
]
# Forward-only transitions for the kanban board. Terminal states only flow
# into archived history. "Withdrawn" and "Rejected" are allowed from any
# non-terminal state. "Accepted" is the gateway to employee onboarding.
TERMINAL = {"Accepted", "Rejected", "Withdrawn"}

POSITION_STATUS = {"Open", "On Hold", "Filled", "Cancelled"}
EMPLOYMENT_TYPES = {"Full-time", "Part-time", "Contract", "Intern"}
INTERVIEW_TYPES  = {"Phone", "Video", "On-site", "Technical", "Final"}
INTERVIEW_STATUS = {"Scheduled", "Completed", "Cancelled", "No-show"}
INTERVIEW_DECISIONS = {"", "Hire", "No hire", "Maybe", "Strong hire", "Strong no hire"}
FILE_KINDS       = {"cv", "cover_letter", "portfolio", "certificate", "other"}
MAX_FILE_BYTES   = 8 * 1024 * 1024

# Accepted document types for applicant files: PDF + Word (.doc/.docx).
# Office files frequently arrive with an empty or 'application/octet-stream'
# content-type, so the type is resolved from the extension as a fallback. The
# canonical value from this allowlist is what gets stored — never the raw
# client-supplied content-type, which the download endpoint serves back inline
# (storing an arbitrary type would let a caller smuggle e.g. text/html).
_DOC_CONTENT_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
_DOC_EXT_TYPES = {
    ".pdf":  "application/pdf",
    ".doc":  "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def _resolve_doc_type(file) -> str:
    """Return the canonical content-type for an accepted upload, else raise 400."""
    ct = (file.content_type or "").split(";")[0].strip().lower()
    if ct in _DOC_CONTENT_TYPES:
        return ct
    name = (file.filename or "").lower()
    for ext, canonical in _DOC_EXT_TYPES.items():
        if name.endswith(ext):
            return canonical
    raise HTTPException(400, "Only PDF and Word (.doc, .docx) files are accepted.")


# ══════════════════════════════════════════════════════════════════════════════
# Pydantic models
# ══════════════════════════════════════════════════════════════════════════════

class PositionBody(BaseModel):
    title:           str
    department_id:   Optional[int] = None
    employment_type: str           = "Full-time"
    location:        Optional[str] = None
    salary_min:      Optional[float] = None
    salary_max:      Optional[float] = None
    headcount:       int           = 1
    status:          str           = "Open"
    description:     Optional[str] = None
    requirements:    Optional[str] = None
    posted_at:       Optional[str] = None
    closed_at:       Optional[str] = None

    @validator("title")
    def _title_not_blank(cls, v):
        if not (v or "").strip():
            raise ValueError("Position title is required")
        return v.strip()

    @validator("employment_type")
    def _valid_type(cls, v):
        if v not in EMPLOYMENT_TYPES:
            raise ValueError(f"Invalid employment type. Must be one of: {', '.join(sorted(EMPLOYMENT_TYPES))}")
        return v

    @validator("status")
    def _valid_status(cls, v):
        if v not in POSITION_STATUS:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(POSITION_STATUS))}")
        return v

    @validator("headcount")
    def _headcount_positive(cls, v):
        if v is None or v < 1:
            raise ValueError("Headcount must be at least 1")
        return v


class ApplicantBody(BaseModel):
    full_name:       str
    position_id:     Optional[int] = None
    email:           Optional[str] = None
    phone:           Optional[str] = None
    source:          Optional[str] = "Other"
    expected_salary: Optional[float] = None
    offered_salary:  Optional[float] = None
    rating:          Optional[int]   = None
    assigned_to:     Optional[int]   = None
    notes:           Optional[str]   = None

    @validator("full_name")
    def _name_not_blank(cls, v):
        if not (v or "").strip():
            raise ValueError("Applicant name is required")
        return v.strip()

    @validator("rating")
    def _rating_range(cls, v):
        if v is None:
            return v
        if v < 1 or v > 5:
            raise ValueError("Rating must be between 1 and 5")
        return v


class StatusChange(BaseModel):
    new_status: str
    note:       Optional[str] = None
    # Captured when the transition is Accept or Reject. Stored in the
    # matching dedicated column (accepted_reason / rejected_reason) plus
    # appended to the status_history note for the audit trail.
    reason:     Optional[str] = None

    @validator("new_status")
    def _valid(cls, v):
        if v not in PIPELINE_STATUSES:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(PIPELINE_STATUSES)}")
        return v


class InterviewBody(BaseModel):
    interview_type:   str           = "Phone"
    scheduled_at:     str
    duration_min:     int           = 60
    location:         Optional[str] = None
    interviewer_id:   Optional[int] = None
    interviewer_name: Optional[str] = None
    status:           str           = "Scheduled"
    score:            Optional[int] = None
    decision:         Optional[str] = None
    notes:            Optional[str] = None

    @validator("interview_type")
    def _valid_type(cls, v):
        if v not in INTERVIEW_TYPES:
            raise ValueError(f"Invalid type. Must be one of: {', '.join(sorted(INTERVIEW_TYPES))}")
        return v

    @validator("status")
    def _valid_status(cls, v):
        if v not in INTERVIEW_STATUS:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(INTERVIEW_STATUS))}")
        return v

    @validator("decision")
    def _valid_decision(cls, v):
        if v in (None, ""):
            return None
        if v not in INTERVIEW_DECISIONS:
            raise ValueError(f"Invalid decision. Must be one of: {', '.join(sorted(d for d in INTERVIEW_DECISIONS if d))}")
        return v

    @validator("score")
    def _score_range(cls, v):
        if v is None:
            return v
        if v < 1 or v > 10:
            raise ValueError("Score must be between 1 and 10")
        return v


class ConvertBody(BaseModel):
    # All optional — sensible defaults are pulled from the applicant + position.
    job_title:         Optional[str]   = None
    department_id:     Optional[int]   = None
    employment_type:   Optional[str]   = None
    salary:            Optional[float] = None
    hire_date:         Optional[str]   = None
    manager_id:        Optional[int]   = None
    # When set, the convert endpoint mints a matching Active hr_contracts row
    # using the offer's clauses (probation, work schedule, weekly hours,
    # benefits, additional terms). The offer must be Accepted and belong to
    # this applicant — see convert_to_employee for the validation.
    accepted_offer_id: Optional[int]   = None


# ══════════════════════════════════════════════════════════════════════════════
# POSITIONS
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/positions")
def list_positions(
    status: Optional[str] = None,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT p.*, d.name AS department_name,
                  (SELECT COUNT(*) FROM recruitment_applicants a
                   WHERE a.position_id = p.id AND a.archived_at IS NULL) AS applicants
           FROM recruitment_positions p
           LEFT JOIN hr_departments d ON p.department_id = d.id
           WHERE p.archived_at IS NULL"""
    params: list = []
    if status:
        q += " AND p.status = ?"; params.append(status)
    q += " ORDER BY p.created_at DESC"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@router.get("/positions/{pos_id}")
def get_position(
    pos_id: int,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT p.*, d.name AS department_name
           FROM recruitment_positions p
           LEFT JOIN hr_departments d ON p.department_id = d.id
           WHERE p.id=? AND p.archived_at IS NULL""", (pos_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Position not found")
    result = dict(row)
    result["applicants"] = [
        dict(r) for r in db.execute(
            "SELECT id, full_name, status, rating, expected_salary, applied_at "
            "FROM recruitment_applicants "
            "WHERE position_id=? AND archived_at IS NULL "
            "ORDER BY applied_at DESC", (pos_id,),
        ).fetchall()
    ]
    return result


@router.post("/positions")
def create_position(
    data: PositionBody,
    user=Depends(require_perm("recruitment", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if data.department_id and not db.execute(
        "SELECT 1 FROM hr_departments WHERE id=? AND archived_at IS NULL", (data.department_id,)
    ).fetchone():
        raise HTTPException(400, "Selected department does not exist.")
    now = _now()
    cur = db.execute(
        """INSERT INTO recruitment_positions
           (title, department_id, employment_type, location, salary_min, salary_max,
            headcount, status, description, requirements, posted_at, closed_at,
            created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.title, data.department_id, data.employment_type, data.location,
         data.salary_min, data.salary_max, data.headcount, data.status,
         data.description, data.requirements,
         data.posted_at or now[:10], data.closed_at,
         user["id"], now),
    )
    log_action(db, user, "create", "recruitment_position", cur.lastrowid, data.title)
    db.commit()
    return {"id": cur.lastrowid, "message": "Position created"}


@router.put("/positions/{pos_id}")
def update_position(
    pos_id: int,
    data: PositionBody,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute(
        "SELECT 1 FROM recruitment_positions WHERE id=? AND archived_at IS NULL", (pos_id,)
    ).fetchone():
        raise HTTPException(404, "Position not found")
    if data.department_id and not db.execute(
        "SELECT 1 FROM hr_departments WHERE id=? AND archived_at IS NULL", (data.department_id,)
    ).fetchone():
        raise HTTPException(400, "Selected department does not exist.")
    db.execute(
        """UPDATE recruitment_positions SET
           title=?, department_id=?, employment_type=?, location=?, salary_min=?,
           salary_max=?, headcount=?, status=?, description=?, requirements=?,
           posted_at=?, closed_at=?
           WHERE id=?""",
        (data.title, data.department_id, data.employment_type, data.location,
         data.salary_min, data.salary_max, data.headcount, data.status,
         data.description, data.requirements, data.posted_at, data.closed_at,
         pos_id),
    )
    log_action(db, user, "update", "recruitment_position", pos_id, data.title)
    db.commit()
    return {"message": "Position updated"}


@router.patch("/positions/{pos_id}/archive")
def archive_position(
    pos_id: int,
    user=Depends(require_perm("recruitment", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT title FROM recruitment_positions WHERE id=? AND archived_at IS NULL", (pos_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Position not found")
    db.execute("UPDATE recruitment_positions SET archived_at=? WHERE id=?", (_now(), pos_id))
    log_action(db, user, "archive", "recruitment_position", pos_id, row["title"])
    db.commit()
    return {"message": "Position archived"}


# ══════════════════════════════════════════════════════════════════════════════
# APPLICANTS
# ══════════════════════════════════════════════════════════════════════════════

def _record_status_change(db, applicant_id, old_status, new_status, note, user_id):
    """Append-only audit row for the pipeline transition."""
    db.execute(
        """INSERT INTO recruitment_status_history
           (applicant_id, old_status, new_status, note, changed_by, created_at)
           VALUES (?,?,?,?,?,?)""",
        (applicant_id, old_status, new_status, note, user_id, _now()),
    )


@router.get("/applicants")
def list_applicants(
    status:      Optional[str] = None,
    position_id: Optional[int] = None,
    search:      Optional[str] = None,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT a.*, p.title AS position_title,
                  u.full_name AS assigned_to_name,
                  (SELECT COUNT(*) FROM recruitment_interviews i
                   WHERE i.applicant_id = a.id) AS interview_count,
                  (SELECT COUNT(*) FROM recruitment_applicant_files f
                   WHERE f.applicant_id = a.id) AS file_count
           FROM recruitment_applicants a
           LEFT JOIN recruitment_positions p ON a.position_id = p.id
           LEFT JOIN users u ON a.assigned_to = u.id
           WHERE a.archived_at IS NULL"""
    params: list = []
    if status:
        q += " AND a.status = ?"; params.append(status)
    if position_id:
        q += " AND a.position_id = ?"; params.append(position_id)
    if search:
        q += " AND (a.full_name LIKE ? OR a.email LIKE ? OR a.phone LIKE ?)"
        s = f"%{search}%"; params.extend([s, s, s])
    q += " ORDER BY a.applied_at DESC"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@router.get("/applicants/{app_id}")
def get_applicant(
    app_id: int,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT a.*, p.title AS position_title, p.department_id AS position_department_id,
                  d.name AS department_name, u.full_name AS assigned_to_name,
                  e.full_name AS converted_employee_name, e.employee_code AS converted_employee_code
           FROM recruitment_applicants a
           LEFT JOIN recruitment_positions p ON a.position_id = p.id
           LEFT JOIN hr_departments d        ON p.department_id = d.id
           LEFT JOIN users u                 ON a.assigned_to = u.id
           LEFT JOIN hr_employees e          ON a.converted_employee_id = e.id
           WHERE a.id=?""",
        (app_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Applicant not found")
    result = dict(row)
    result["interviews"] = [
        dict(r) for r in db.execute(
            """SELECT i.*, u.full_name AS interviewer_user_name
               FROM recruitment_interviews i
               LEFT JOIN users u ON i.interviewer_id = u.id
               WHERE i.applicant_id=? ORDER BY i.scheduled_at DESC""",
            (app_id,),
        ).fetchall()
    ]
    result["status_history"] = [
        dict(r) for r in db.execute(
            """SELECT h.*, u.full_name AS changed_by_name
               FROM recruitment_status_history h
               LEFT JOIN users u ON h.changed_by = u.id
               WHERE h.applicant_id=? ORDER BY h.id DESC""",
            (app_id,),
        ).fetchall()
    ]
    result["files"] = [
        dict(r) for r in db.execute(
            "SELECT id, kind, filename, content_type, size_bytes, created_at "
            "FROM recruitment_applicant_files WHERE applicant_id=? ORDER BY created_at DESC",
            (app_id,),
        ).fetchall()
    ]
    return result


@router.post("/applicants")
def create_applicant(
    data: ApplicantBody,
    user=Depends(require_perm("recruitment", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if data.position_id and not db.execute(
        "SELECT 1 FROM recruitment_positions WHERE id=? AND archived_at IS NULL", (data.position_id,)
    ).fetchone():
        raise HTTPException(400, "Selected position does not exist.")
    if data.assigned_to and not db.execute(
        "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL", (data.assigned_to,)
    ).fetchone():
        raise HTTPException(400, "Selected recruiter does not exist.")
    now = _now()
    cur = db.execute(
        """INSERT INTO recruitment_applicants
           (position_id, full_name, email, phone, source, expected_salary, rating,
            assigned_to, notes, status, applied_at, last_status_change,
            created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,'Applied',?,?,?,?)""",
        (data.position_id, data.full_name, data.email, data.phone, data.source,
         data.expected_salary, data.rating, data.assigned_to, data.notes,
         now[:10], now, user["id"], now),
    )
    app_id = cur.lastrowid
    _record_status_change(db, app_id, None, "Applied", "Applicant registered", user["id"])
    log_action(db, user, "create", "recruitment_applicant", app_id, data.full_name)
    db.commit()
    return {"id": app_id, "message": "Applicant registered"}


@router.put("/applicants/{app_id}")
def update_applicant(
    app_id: int,
    data: ApplicantBody,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute(
        "SELECT 1 FROM recruitment_applicants WHERE id=? AND archived_at IS NULL", (app_id,)
    ).fetchone():
        raise HTTPException(404, "Applicant not found")
    if data.position_id and not db.execute(
        "SELECT 1 FROM recruitment_positions WHERE id=? AND archived_at IS NULL", (data.position_id,)
    ).fetchone():
        raise HTTPException(400, "Selected position does not exist.")
    db.execute(
        """UPDATE recruitment_applicants SET
           position_id=?, full_name=?, email=?, phone=?, source=?, expected_salary=?,
           offered_salary=?, rating=?, assigned_to=?, notes=?
           WHERE id=?""",
        (data.position_id, data.full_name, data.email, data.phone, data.source,
         data.expected_salary, data.offered_salary, data.rating, data.assigned_to,
         data.notes, app_id),
    )
    log_action(db, user, "update", "recruitment_applicant", app_id, data.full_name)
    db.commit()
    return {"message": "Applicant updated"}


@router.post("/applicants/{app_id}/status")
def change_applicant_status(
    app_id: int,
    data: StatusChange,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT status, full_name FROM recruitment_applicants WHERE id=? AND archived_at IS NULL",
        (app_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Applicant not found")
    old = row["status"]
    if old == data.new_status:
        return {"message": f"Already in {data.new_status}", "status": data.new_status}
    if old in TERMINAL and data.new_status not in TERMINAL:
        raise HTTPException(
            400,
            f"Applicant is already in a terminal state ({old}). "
            "Re-opening requires creating a new application.",
        )
    note = data.note or data.reason
    # `reason` lands in the matching column so the applicant detail can
    # surface "why was this person accepted/rejected" without parsing the
    # free-form note. Non-terminal transitions ignore it.
    db.execute(
        "UPDATE recruitment_applicants SET status=?, last_status_change=?, "
        " accepted_reason=CASE WHEN ?='Accepted' THEN ? ELSE accepted_reason END, "
        " rejected_reason=CASE WHEN ?='Rejected' THEN ? ELSE rejected_reason END "
        "WHERE id=?",
        (data.new_status, _now(),
         data.new_status, data.reason,
         data.new_status, data.reason,
         app_id),
    )
    _record_status_change(db, app_id, old, data.new_status, note, user["id"])
    # Friendly heads-up to whoever owns the candidate.
    notify(db, type="recruitment_status",
           title=f"Applicant moved: {row['full_name']}",
           body=f"{old} → {data.new_status}",
           link=f"/recruitment", entity_type="recruitment_applicant",
           entity_id=app_id, dedup_hours=1)
    log_action(db, user, "status_change", "recruitment_applicant", app_id,
               row["full_name"], {"from": old, "to": data.new_status})
    db.commit()
    return {"message": "Status updated", "status": data.new_status}


@router.patch("/applicants/{app_id}/archive")
def archive_applicant(
    app_id: int,
    user=Depends(require_perm("recruitment", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT full_name FROM recruitment_applicants WHERE id=? AND archived_at IS NULL", (app_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Applicant not found")
    db.execute("UPDATE recruitment_applicants SET archived_at=? WHERE id=?", (_now(), app_id))
    log_action(db, user, "archive", "recruitment_applicant", app_id, row["full_name"])
    db.commit()
    return {"message": "Applicant archived"}


# ══════════════════════════════════════════════════════════════════════════════
# INTERVIEWS
# ══════════════════════════════════════════════════════════════════════════════

# Each recruitment interview type maps to the corresponding HR Activities
# `activity_type` enum so the mirrored row shows up under the right filter on
# the HR Activities page. "Phone" → Call, everything else is an Interview.
_INTERVIEW_TO_ACTIVITY_TYPE = {
    "Phone":     "Call",
    "Video":     "Interview",
    "On-site":   "Interview",
    "Technical": "Interview",
    "Final":     "Interview",
}

# Reminder offset (minutes) for the auto-mirrored HR Activity. 15 min mirrors
# the hr_activities default and is one of the allowed values in
# hr_activities.ALLOWED_REMINDERS.
_DEFAULT_INTERVIEW_REMINDER_MIN = 15


def _interview_activity_owner(db: sqlite3.Connection, interviewer_id, fallback_user_id) -> int:
    """Pick the HR Activity owner for an interview. Prefer the interviewer when
    they're a real internal user (so the meeting lands in *their* queue); fall
    back to the person who scheduled it. External interviewers (no user id)
    can't own activities, so the scheduler always sees the reminder."""
    if interviewer_id:
        row = db.execute(
            "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL",
            (interviewer_id,),
        ).fetchone()
        if row:
            return int(interviewer_id)
    return int(fallback_user_id)


def _build_interview_subject(applicant_name: str, interview_type: str) -> str:
    return f"{interview_type} interview — {applicant_name}"


def _build_interview_description(data: "InterviewBody", applicant_name: str) -> str:
    """Compact, human-readable body for the mirrored HR Activity."""
    bits = [f"Auto-created from recruitment interview with {applicant_name}."]
    if data.interviewer_name:
        bits.append(f"Interviewer: {data.interviewer_name}.")
    if data.notes:
        bits.append(data.notes)
    return " ".join(bits)


def _mirror_interview_to_hr_activity(
    db: sqlite3.Connection,
    *,
    interview_id: int,
    applicant_id: int,
    applicant_name: str,
    owner_id: int,
    data: "InterviewBody",
    scheduled_at: str,
) -> int:
    """Insert one hr_activities row that mirrors the recruitment interview,
    schedule its reminder, and return the new activity id. The interview row
    is later stamped with the activity id so subsequent edits can find and
    update the same mirror instead of creating duplicates."""
    activity_type = _INTERVIEW_TO_ACTIVITY_TYPE.get(data.interview_type, "Interview")
    subject       = _build_interview_subject(applicant_name, data.interview_type)
    description   = _build_interview_description(data, applicant_name)
    # Translate the recruitment interview lifecycle into the HR Activity one.
    # "Cancelled" and "No-show" both end the activity; "Completed" closes it.
    activity_status = {
        "Scheduled": "Planned",
        "Completed": "Done",
        "Cancelled": "Cancelled",
        "No-show":   "Cancelled",
    }.get(data.status, "Planned")
    now = _now()

    cur = db.execute(
        """INSERT INTO hr_activities
              (owner_id, activity_type, subject, description, scheduled_at,
               duration_min, location, status, applicant_id, employee_id,
               reminder_minutes_before, completed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)""",
        (owner_id, activity_type, subject, description, scheduled_at,
         max(0, int(data.duration_min or 0)), data.location, activity_status,
         applicant_id, _DEFAULT_INTERVIEW_REMINDER_MIN,
         now if activity_status == "Done" else None, now),
    )
    activity_id = cur.lastrowid

    # Only schedule a reminder while the activity is still upcoming. Completed
    # / cancelled mirrors don't need a future ping.
    if activity_status == "Planned":
        notif_id = _hr_schedule_reminder(
            db,
            activity_id=activity_id,
            owner_id=owner_id,
            subject=subject,
            activity_type=activity_type,
            scheduled_at=scheduled_at,
            reminder_min=_DEFAULT_INTERVIEW_REMINDER_MIN,
            link_label=f"Applicant: {applicant_name}",
        )
        if notif_id:
            db.execute(
                "UPDATE hr_activities SET reminder_notif_id=? WHERE id=?",
                (notif_id, activity_id),
            )

    return activity_id


def _resync_interview_activity(
    db: sqlite3.Connection,
    *,
    interview_id: int,
    activity_id: int,
    applicant_id: int,
    applicant_name: str,
    owner_id: int,
    data: "InterviewBody",
    scheduled_at: str,
) -> None:
    """Update the mirrored hr_activities row so it stays in lock-step with the
    interview. Already-fired reminders are left alone (they're history); the
    pending one, if any, is rebuilt against the new schedule."""
    activity_type = _INTERVIEW_TO_ACTIVITY_TYPE.get(data.interview_type, "Interview")
    subject       = _build_interview_subject(applicant_name, data.interview_type)
    description   = _build_interview_description(data, applicant_name)
    activity_status = {
        "Scheduled": "Planned",
        "Completed": "Done",
        "Cancelled": "Cancelled",
        "No-show":   "Cancelled",
    }.get(data.status, "Planned")
    now = _now()

    # Preserve completed_at semantics: stamp once on first Done, clear on revert.
    existing_completed = db.execute(
        "SELECT completed_at FROM hr_activities WHERE id=?", (activity_id,)
    ).fetchone()
    new_completed = existing_completed["completed_at"] if existing_completed else None
    if activity_status == "Done" and not new_completed:
        new_completed = now
    if activity_status != "Done":
        new_completed = None

    db.execute(
        """UPDATE hr_activities SET
              activity_type=?, subject=?, description=?, scheduled_at=?,
              duration_min=?, location=?, status=?, applicant_id=?,
              completed_at=?, updated_at=?
           WHERE id=? AND archived_at IS NULL""",
        (activity_type, subject, description, scheduled_at,
         max(0, int(data.duration_min or 0)), data.location, activity_status,
         applicant_id, new_completed, now, activity_id),
    )

    # Rebuild the pending reminder if the activity is still planned. The
    # helper is a no-op when the schedule is already past, so we don't risk
    # spamming the bell on backdated edits.
    _hr_clear_reminder(db, activity_id)
    db.execute("UPDATE hr_activities SET reminder_notif_id=NULL WHERE id=?",
               (activity_id,))
    if activity_status == "Planned":
        notif_id = _hr_schedule_reminder(
            db,
            activity_id=activity_id,
            owner_id=owner_id,
            subject=subject,
            activity_type=activity_type,
            scheduled_at=scheduled_at,
            reminder_min=_DEFAULT_INTERVIEW_REMINDER_MIN,
            link_label=f"Applicant: {applicant_name}",
        )
        if notif_id:
            db.execute(
                "UPDATE hr_activities SET reminder_notif_id=? WHERE id=?",
                (notif_id, activity_id),
            )


@router.post("/applicants/{app_id}/interviews")
def schedule_interview(
    app_id: int,
    data: InterviewBody,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT id, full_name FROM recruitment_applicants WHERE id=? AND archived_at IS NULL", (app_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Applicant not found")
    if data.interviewer_id and not db.execute(
        "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL", (data.interviewer_id,)
    ).fetchone():
        raise HTTPException(400, "Selected interviewer does not exist.")
    # Canonicalise the timestamp once so the recruitment row, the mirrored
    # HR Activity and the reminder math all agree.
    scheduled_at = _hr_normalise_scheduled_at(data.scheduled_at)
    cur = db.execute(
        """INSERT INTO recruitment_interviews
           (applicant_id, interview_type, scheduled_at, duration_min, location,
            interviewer_id, interviewer_name, status, score, decision, notes,
            completed_at, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (app_id, data.interview_type, scheduled_at, data.duration_min, data.location,
         data.interviewer_id, data.interviewer_name, data.status, data.score,
         data.decision, data.notes,
         _now() if data.status == "Completed" else None,
         user["id"], _now()),
    )
    interview_id = cur.lastrowid

    # Mirror into HR Activities so the interviewer (or scheduler) gets the row
    # in their personal queue + a reminder ping when the time comes.
    activity_id = _mirror_interview_to_hr_activity(
        db,
        interview_id=interview_id,
        applicant_id=app_id,
        applicant_name=row["full_name"],
        owner_id=_interview_activity_owner(db, data.interviewer_id, user["id"]),
        data=data,
        scheduled_at=scheduled_at,
    )
    db.execute(
        "UPDATE recruitment_interviews SET hr_activity_id=? WHERE id=?",
        (activity_id, interview_id),
    )

    log_action(db, user, "schedule", "recruitment_interview", interview_id,
               f"{row['full_name']} — {data.interview_type}")
    db.commit()
    return {
        "id": interview_id,
        "hr_activity_id": activity_id,
        "message": "Interview scheduled",
    }


@router.put("/interviews/{interview_id}")
def update_interview(
    interview_id: int,
    data: InterviewBody,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM recruitment_interviews WHERE id=?", (interview_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Interview not found")
    if data.interviewer_id and not db.execute(
        "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL", (data.interviewer_id,)
    ).fetchone():
        raise HTTPException(400, "Selected interviewer does not exist.")

    scheduled_at = _hr_normalise_scheduled_at(data.scheduled_at)
    completed_at = row["completed_at"]
    if data.status == "Completed" and not completed_at:
        completed_at = _now()
    if data.status != "Completed":
        completed_at = None

    db.execute(
        """UPDATE recruitment_interviews SET
           interview_type=?, scheduled_at=?, duration_min=?, location=?,
           interviewer_id=?, interviewer_name=?, status=?, score=?, decision=?,
           notes=?, completed_at=?
           WHERE id=?""",
        (data.interview_type, scheduled_at, data.duration_min, data.location,
         data.interviewer_id, data.interviewer_name, data.status, data.score,
         data.decision, data.notes, completed_at, interview_id),
    )

    # Keep the mirrored HR Activity in sync. If the interview pre-dates
    # migration 101 (no mirror) or its mirror was archived, create a fresh
    # one so the calendar view doesn't lose the entry.
    applicant = db.execute(
        "SELECT id, full_name FROM recruitment_applicants WHERE id=?",
        (row["applicant_id"],),
    ).fetchone()
    if applicant:
        owner_id = _interview_activity_owner(db, data.interviewer_id, user["id"])
        existing_activity_id = row["hr_activity_id"] if "hr_activity_id" in row.keys() else None
        live_activity = None
        if existing_activity_id:
            live_activity = db.execute(
                "SELECT id FROM hr_activities WHERE id=? AND archived_at IS NULL",
                (existing_activity_id,),
            ).fetchone()
        if live_activity:
            _resync_interview_activity(
                db,
                interview_id=interview_id,
                activity_id=existing_activity_id,
                applicant_id=applicant["id"],
                applicant_name=applicant["full_name"],
                owner_id=owner_id,
                data=data,
                scheduled_at=scheduled_at,
            )
        else:
            new_activity_id = _mirror_interview_to_hr_activity(
                db,
                interview_id=interview_id,
                applicant_id=applicant["id"],
                applicant_name=applicant["full_name"],
                owner_id=owner_id,
                data=data,
                scheduled_at=scheduled_at,
            )
            db.execute(
                "UPDATE recruitment_interviews SET hr_activity_id=? WHERE id=?",
                (new_activity_id, interview_id),
            )

    log_action(db, user, "update", "recruitment_interview", interview_id, data.interview_type)
    db.commit()
    return {"message": "Interview updated"}


@router.delete("/interviews/{interview_id}")
def delete_interview(
    interview_id: int,
    user=Depends(require_perm("recruitment", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM recruitment_interviews WHERE id=?", (interview_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Interview not found")
    # Soft-archive the mirrored HR Activity so it disappears from the
    # owner's queue but stays in audit / archives. Pending reminder, if any,
    # is wiped so the bell doesn't fire for a cancelled meeting.
    activity_id = row["hr_activity_id"] if "hr_activity_id" in row.keys() else None
    if activity_id:
        _hr_clear_reminder(db, activity_id)
        db.execute(
            "UPDATE hr_activities SET archived_at=?, reminder_notif_id=NULL, updated_at=? "
            "WHERE id=? AND archived_at IS NULL",
            (_now(), _now(), activity_id),
        )
    db.execute("DELETE FROM recruitment_interviews WHERE id=?", (interview_id,))
    log_action(db, user, "delete", "recruitment_interview", interview_id, row["interview_type"])
    db.commit()
    return {"message": "Interview removed"}


# ══════════════════════════════════════════════════════════════════════════════
# APPLICANT FILES (CV, cover letter, certificates, ...)
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/applicants/{app_id}/files")
async def upload_applicant_file(
    app_id: int,
    kind: str = Form("cv"),
    file: UploadFile = File(...),
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    if kind not in FILE_KINDS:
        raise HTTPException(400, f"kind must be one of: {', '.join(sorted(FILE_KINDS))}")
    if not db.execute(
        "SELECT 1 FROM recruitment_applicants WHERE id=? AND archived_at IS NULL", (app_id,)
    ).fetchone():
        raise HTTPException(404, "Applicant not found")
    content_type = _resolve_doc_type(file)
    data = await file.read()
    if not data:
        raise HTTPException(400, "Uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(400,
            f"File too large ({len(data)//1024} KB). Max {MAX_FILE_BYTES//(1024*1024)} MB.")
    # CV is single-slot per applicant — replace the previous one (and its object).
    if kind == "cv":
        for old in db.execute(
            "SELECT storage_backend, storage_key FROM recruitment_applicant_files "
            "WHERE applicant_id=? AND kind='cv'", (app_id,)).fetchall():
            if old["storage_backend"] == "s3" and old["storage_key"]:
                storage.delete_object(old["storage_key"])
        db.execute("DELETE FROM recruitment_applicant_files WHERE applicant_id=? AND kind='cv'",
                   (app_id,))
    fname = file.filename or f"{kind}.pdf"
    if storage.is_s3():
        key = storage.make_key("recruitment_applicant", app_id, fname)
        storage.put_object(key, data, content_type)
        backend, blob = "s3", b""
    else:
        key, backend, blob = None, "db", data
    cur = db.execute(
        """INSERT INTO recruitment_applicant_files
           (applicant_id, kind, filename, content_type, size_bytes, data,
            storage_backend, storage_key, uploaded_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (app_id, kind, fname, content_type,
         len(data), blob, backend, key, user["id"], _now()),
    )
    log_action(db, user, "upload", "recruitment_applicant_file", cur.lastrowid,
               f"applicant #{app_id} — {kind}")
    db.commit()
    return {"id": cur.lastrowid, "kind": kind, "filename": file.filename, "message": "File uploaded"}


@router.get("/applicants/{app_id}/files")
def list_applicant_files(
    app_id: int,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    return [
        dict(r) for r in db.execute(
            "SELECT id, kind, filename, content_type, size_bytes, created_at "
            "FROM recruitment_applicant_files WHERE applicant_id=? ORDER BY created_at DESC",
            (app_id,),
        ).fetchall()
    ]


@router.get("/files/{file_id}/download")
def download_applicant_file(
    file_id: int,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT filename, content_type, data, storage_backend, storage_key "
        "FROM recruitment_applicant_files WHERE id=?",
        (file_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "File not found")
    content = (storage.get_object(row["storage_key"])
               if row["storage_backend"] == "s3" else row["data"])
    return Response(
        content=content,
        media_type=row["content_type"] or "application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{row["filename"]}"',
            "Cache-Control": "private, max-age=0, must-revalidate",
        },
    )


@router.delete("/files/{file_id}")
def delete_applicant_file(
    file_id: int,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT applicant_id, kind, storage_backend, storage_key "
        "FROM recruitment_applicant_files WHERE id=?", (file_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "File not found")
    if row["storage_backend"] == "s3" and row["storage_key"]:
        storage.delete_object(row["storage_key"])
    db.execute("DELETE FROM recruitment_applicant_files WHERE id=?", (file_id,))
    log_action(db, user, "delete", "recruitment_applicant_file", file_id,
               f"applicant #{row['applicant_id']} — {row['kind']}")
    db.commit()
    return {"message": "File deleted"}


# ══════════════════════════════════════════════════════════════════════════════
# CONVERT TO EMPLOYEE — the bridge between Recruitment and HR
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/applicants/{app_id}/convert")
def convert_to_employee(
    app_id: int,
    data: ConvertBody = ConvertBody(),
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Convert an Accepted applicant into an hr_employees row.

    Copies the applicant's CV (and any other PDFs) into hr_employee_files so
    the HR detail page has them on day one. Stamps the applicant with the new
    employee id and bumps the position to 'Filled' if its headcount is 1."""
    applicant = db.execute(
        """SELECT a.*, p.department_id AS position_department_id, p.title AS position_title,
                  p.employment_type AS position_employment_type, p.headcount AS position_headcount
           FROM recruitment_applicants a
           LEFT JOIN recruitment_positions p ON a.position_id = p.id
           WHERE a.id=? AND a.archived_at IS NULL""",
        (app_id,),
    ).fetchone()
    if not applicant:
        raise HTTPException(404, "Applicant not found")
    if applicant["status"] != "Accepted":
        raise HTTPException(400, "Only Accepted applicants can be converted.")
    if applicant["converted_employee_id"]:
        raise HTTPException(400, "Applicant has already been converted.")

    # Resolve the employee record from the applicant + position + override.
    job_title       = data.job_title       or applicant["position_title"]
    department_id   = data.department_id   or applicant["position_department_id"]
    employment_type = data.employment_type or applicant["position_employment_type"] or "Full-time"
    salary          = (data.salary if data.salary is not None
                       else (applicant["offered_salary"] or applicant["expected_salary"] or 0))
    hire_date       = (data.hire_date or _now())[:10]

    if department_id and not db.execute(
        "SELECT 1 FROM hr_departments WHERE id=? AND archived_at IS NULL", (department_id,)
    ).fetchone():
        raise HTTPException(400, "Selected department does not exist.")
    if data.manager_id and not db.execute(
        "SELECT 1 FROM hr_employees WHERE id=? AND archived_at IS NULL", (data.manager_id,)
    ).fetchone():
        raise HTTPException(400, "Selected manager does not exist.")
    if employment_type not in EMPLOYMENT_TYPES:
        raise HTTPException(400, f"Invalid employment_type. Must be one of: {', '.join(sorted(EMPLOYMENT_TYPES))}")

    now = _now()
    cur = db.execute(
        """INSERT INTO hr_employees
           (full_name, job_title, department_id, employment_type, status,
            hire_date, email, phone, salary, manager_id, notes, created_at)
           VALUES (?,?,?,?,'Active',?,?,?,?,?,?,?)""",
        (applicant["full_name"], job_title, department_id, employment_type,
         hire_date, applicant["email"], applicant["phone"], salary,
         data.manager_id,
         f"Converted from applicant #{app_id}" + (f" — {applicant['notes']}" if applicant["notes"] else ""),
         now),
    )
    emp_id = cur.lastrowid
    db.execute("UPDATE hr_employees SET employee_code=? WHERE id=?", (f"EMP-{emp_id:04d}", emp_id))

    # Seed the salary/role timeline with the hire row, matching the path taken
    # by /api/hr/employees.
    db.execute(
        """INSERT INTO hr_employment_changes
           (employee_id, effective_date, change_type,
            old_salary, new_salary, old_title, new_title,
            old_department_id, new_department_id,
            old_manager_id, new_manager_id,
            reason, created_by, created_at)
           VALUES (?, ?, 'hire', NULL, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?)""",
        (emp_id, hire_date, salary, job_title, department_id, data.manager_id,
         f"Hired from applicant #{app_id}", user["id"], now),
    )

    # Copy applicant PDFs over to hr_employee_files — CV becomes the employee
    # CV; everything else lands under 'other' so nothing is lost.
    file_rows = db.execute(
        "SELECT kind, filename, content_type, size_bytes, data "
        "FROM recruitment_applicant_files WHERE applicant_id=?",
        (app_id,),
    ).fetchall()
    for f in file_rows:
        target_kind = "cv" if f["kind"] == "cv" else "other"
        db.execute(
            """INSERT INTO hr_employee_files
               (employee_id, kind, filename, content_type, size_bytes, data,
                uploaded_by, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (emp_id, target_kind, f["filename"], f["content_type"],
             f["size_bytes"], f["data"], user["id"], now),
        )

    # Stamp the link both ways.
    db.execute(
        "UPDATE recruitment_applicants SET converted_employee_id=? WHERE id=?",
        (emp_id, app_id),
    )

    # If this position only needed one hire, mark it Filled. Otherwise we just
    # decrement implicitly (an HR person can edit headcount manually).
    if applicant["position_id"] and (applicant["position_headcount"] or 0) <= 1:
        db.execute(
            "UPDATE recruitment_positions SET status='Filled', closed_at=? WHERE id=?",
            (now[:10], applicant["position_id"]),
        )

    # If the caller passed an accepted_offer_id, mint a matching Active row in
    # hr_contracts so the offer's terms become the employee's first formal
    # contract. Validation: the offer must (a) exist, (b) belong to this
    # applicant, (c) be in Accepted state — otherwise we refuse so HR can't
    # accidentally bind the employee to an unsent draft or someone else's offer.
    contract_id = None
    contract_number = None
    if data.accepted_offer_id is not None:
        offer = db.execute(
            "SELECT * FROM recruitment_offers "
            "WHERE id=? AND applicant_id=? AND archived_at IS NULL",
            (data.accepted_offer_id, app_id),
        ).fetchone()
        if not offer:
            raise HTTPException(400, "accepted_offer_id does not match an offer for this applicant.")
        if offer["status"] != "Accepted":
            raise HTTPException(400, f"Offer {offer['offer_number']} is in {offer['status']} state — only Accepted offers can be activated as a contract.")

        # Build a contract_number from the year + the next available id.
        cnum_row = db.execute("SELECT value FROM settings WHERE key='contract_prefix'").fetchone()
        cprefix  = (cnum_row["value"] if cnum_row and cnum_row["value"] else "CTR-")
        cmax     = db.execute("SELECT COALESCE(MAX(id), 0) AS m FROM hr_contracts").fetchone()
        contract_number = f"{cprefix}{now[:4]}-{cmax['m'] + 1:04d}"

        # Compose a clauses payload that captures the Lebanon-aware toggles
        # from the offer in the contract's free-text `terms` column. Keeps the
        # contract self-contained even if the offer is later archived.
        terms_bits = []
        if offer["include_nssf"]:
            terms_bits.append("Employer to register the Employee with the National Social Security Fund (NSSF).")
        if offer["include_eos"]:
            terms_bits.append("End-of-service indemnity per Lebanese Labor Code Article 50 and the Social Security Law.")
        if offer["include_confidentiality"]:
            terms_bits.append("Confidentiality of business information during and after the term.")
        if offer["include_non_compete"]:
            terms_bits.append(f"Non-compete for {offer['non_compete_months']} months post-termination, subject to enforceability under Lebanese law.")
        terms_bits.append(f"Notice period: {offer['notice_period_days']} days after probation.")
        terms_bits.append(f"Annual leave: {offer['annual_leave_days']} days per year (Article 39 minimum).")
        if offer["additional_terms"]:
            terms_bits.append(offer["additional_terms"])
        composed_terms = "\n\n".join(terms_bits)

        cur2 = db.execute(
            """INSERT INTO hr_contracts
                  (employee_id, contract_number, contract_type, status,
                   start_date, end_date, probation_end_date, job_title,
                   work_schedule, weekly_hours, salary, salary_currency,
                   benefits, terms, signed_at, created_by, created_at)
               VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (emp_id, contract_number, offer["contract_type"],
             offer["start_date"], offer["end_date"], offer["probation_end_date"],
             offer["job_title"], offer["work_schedule"], offer["weekly_hours"],
             offer["salary"], offer["salary_currency"],
             offer["benefits"], composed_terms, now, user["id"], now),
        )
        contract_id = cur2.lastrowid
        log_action(db, user, "create-from-offer", "hr_contract", contract_id,
                   f"{contract_number} ({applicant['full_name']})",
                   {"offer_id": data.accepted_offer_id})

    log_action(db, user, "convert", "recruitment_applicant", app_id,
               applicant["full_name"], {"employee_id": emp_id})
    notify(db, type="recruitment_hired",
           title=f"New hire: {applicant['full_name']}",
           body=f"Welcome aboard! Onboarding starts on {hire_date}.",
           link=f"/hr", entity_type="hr_employee", entity_id=emp_id)
    db.commit()
    return {
        "employee_id":      emp_id,
        "employee_code":    f"EMP-{emp_id:04d}",
        "contract_id":      contract_id,
        "contract_number":  contract_number,
        "contract_created": contract_id is not None,
        "message":          "Applicant onboarded as employee",
    }


# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY — KPIs for the Recruitment dashboard
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/summary")
def recruitment_summary(
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    open_positions = db.execute(
        "SELECT COUNT(*) FROM recruitment_positions "
        "WHERE archived_at IS NULL AND status='Open'"
    ).fetchone()[0]
    by_status = {
        r["status"]: r["count"]
        for r in db.execute(
            """SELECT status, COUNT(*) AS count
               FROM recruitment_applicants WHERE archived_at IS NULL
               GROUP BY status"""
        ).fetchall()
    }
    upcoming = db.execute(
        "SELECT COUNT(*) FROM recruitment_interviews "
        "WHERE status='Scheduled' AND scheduled_at >= date('now')"
    ).fetchone()[0]
    hired_ytd = db.execute(
        "SELECT COUNT(*) FROM recruitment_applicants "
        "WHERE converted_employee_id IS NOT NULL "
        "  AND substr(applied_at,1,4) = strftime('%Y','now')"
    ).fetchone()[0]
    return {
        "open_positions":      open_positions,
        "by_status":           by_status,
        "applied":             by_status.get("Applied", 0),
        "screening":           by_status.get("Screening", 0),
        "interview":           by_status.get("Interview", 0),
        "technical_test":      by_status.get("Technical Test", 0),
        "accepted":            by_status.get("Accepted", 0),
        "rejected":            by_status.get("Rejected", 0),
        "upcoming_interviews": upcoming,
        "hired_ytd":           hired_ytd,
    }


# ══════════════════════════════════════════════════════════════════════════════
# OFFER LETTERS / PRE-EMPLOYMENT CONTRACTS
# ══════════════════════════════════════════════════════════════════════════════
#
# Distinct from `hr_contracts`:
#   * Attached to an applicant (no employee record exists yet).
#   * Holds the Lebanon-aware toggles the print template renders.
#   * Lifecycle: Draft → Sent → Accepted / Declined / Expired.
#
# Once the candidate accepts and the applicant is converted via /convert, a
# matching Active row is auto-minted in hr_contracts (see convert_to_employee).
#
# Disclaimer: This is a template-generation tool, NOT legal advice. The output
# is intended as a starting point for review by qualified Lebanese counsel.

OFFER_STATUSES   = {"Draft", "Sent", "Accepted", "Declined", "Expired"}
OFFER_CONTRACT_TYPES = {"Permanent", "Fixed-term", "Probation", "Internship", "Consultant"}
OFFER_CURRENCIES = {"USD", "EUR", "LBP", "AED", "SAR"}
OFFER_PAY_SCHEDULES = {"Monthly", "Bi-weekly", "Weekly"}
# Lebanese Labor Code Article 9 caps the probationary period at three months
# for ordinary employees. We treat this as a hard ceiling on the form input;
# anything longer needs to be drafted as a fixed-term contract instead.
LB_MAX_PROBATION_MONTHS = 3
# Article 31 caps the working week at 48 hours. Exceeding this is technically
# possible (with overtime + ministerial approval for some sectors), but is
# not what a standard offer letter should default to.
LB_MAX_WEEKLY_HOURS     = 48


class OfferCreate(BaseModel):
    contract_type:           str           = "Permanent"
    job_title:               Optional[str] = None
    department_id:           Optional[int] = None
    start_date:              str
    end_date:                Optional[str] = None
    probation_months:        int           = 3
    probation_end_date:      Optional[str] = None
    work_schedule:           Optional[str] = "Mon–Fri 9:00–18:00"
    weekly_hours:            Optional[float] = 48
    annual_leave_days:       int           = 15
    notice_period_days:      int           = 30
    salary:                  float
    salary_currency:         str           = "USD"
    payment_schedule:        str           = "Monthly"
    include_nssf:            bool          = True
    include_eos:             bool          = True
    include_confidentiality: bool          = True
    include_non_compete:     bool          = False
    non_compete_months:      int           = 6
    benefits:                Optional[str] = None
    additional_terms:        Optional[str] = None
    place_of_work:           Optional[str] = None
    expires_at:              Optional[str] = None    # offer expiry (Sent → Expired)

    @validator("contract_type")
    def _valid_type(cls, v):
        if v not in OFFER_CONTRACT_TYPES:
            raise ValueError(f"Invalid contract_type. Must be one of: {', '.join(sorted(OFFER_CONTRACT_TYPES))}")
        return v

    @validator("salary_currency")
    def _valid_currency(cls, v):
        if v not in OFFER_CURRENCIES:
            raise ValueError(f"Invalid currency. Must be one of: {', '.join(sorted(OFFER_CURRENCIES))}")
        return v

    @validator("payment_schedule")
    def _valid_schedule(cls, v):
        if v not in OFFER_PAY_SCHEDULES:
            raise ValueError(f"Invalid payment schedule. Must be one of: {', '.join(sorted(OFFER_PAY_SCHEDULES))}")
        return v

    @validator("salary")
    def _salary_non_negative(cls, v):
        if v is None or v < 0:
            raise ValueError("Salary cannot be negative")
        return v

    @validator("probation_months")
    def _probation_cap(cls, v):
        # Article 9 of the Lebanese Labor Code caps probation at 3 months.
        if v is None or v < 0:
            raise ValueError("Probation cannot be negative")
        if v > LB_MAX_PROBATION_MONTHS:
            raise ValueError(
                f"Probation exceeds the {LB_MAX_PROBATION_MONTHS}-month cap "
                f"under Lebanese Labor Code Article 9. Use a fixed-term "
                f"contract instead if a longer trial is needed."
            )
        return v

    @validator("weekly_hours")
    def _weekly_hours_cap(cls, v):
        if v is None:
            return v
        if v < 0:
            raise ValueError("Weekly hours cannot be negative")
        # Article 31 — soft warning via clamped value; we accept up to the cap
        # silently and reject above it so callers don't paper over overtime.
        if v > LB_MAX_WEEKLY_HOURS:
            raise ValueError(
                f"Weekly hours exceed the {LB_MAX_WEEKLY_HOURS}h cap under "
                f"Lebanese Labor Code Article 31. Overtime arrangements "
                f"should be documented separately."
            )
        return v


class OfferUpdate(OfferCreate):
    # Same shape as create — every field is overwritten on edit. A separate
    # class keeps the API contract clear (no partial PATCH) and lets us add
    # update-only fields later without breaking create callers.
    pass


class OfferStatusBody(BaseModel):
    status:          str
    declined_reason: Optional[str] = None

    @validator("status")
    def _valid(cls, v):
        if v not in OFFER_STATUSES:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(OFFER_STATUSES))}")
        return v


def _next_offer_number(db: sqlite3.Connection) -> str:
    """Generate a unique offer number — OFF-YYYY-####. Format chosen to sort
    naturally and stay readable in PDFs and emails."""
    year = _now()[:4]
    mx   = db.execute("SELECT COALESCE(MAX(id), 0) AS m FROM recruitment_offers").fetchone()
    return f"OFF-{year}-{mx['m'] + 1:04d}"


def _load_applicant_for_offer(db: sqlite3.Connection, app_id: int) -> sqlite3.Row:
    row = db.execute(
        """SELECT a.*, p.title AS position_title, p.department_id AS position_department_id,
                  p.employment_type AS position_employment_type
           FROM recruitment_applicants a
           LEFT JOIN recruitment_positions p ON a.position_id = p.id
           WHERE a.id=? AND a.archived_at IS NULL""",
        (app_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Applicant not found")
    return row


def _serialize_offer(row: sqlite3.Row) -> dict:
    d = dict(row)
    # Booleans come back as 0/1 from SQLite — normalise so JSON consumers see real bools.
    for k in ("include_nssf", "include_eos", "include_confidentiality", "include_non_compete"):
        d[k] = bool(d.get(k))
    return d


@router.get("/applicants/{app_id}/offers")
def list_offers(
    app_id: int,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """All active (non-archived) offers for an applicant, newest first."""
    _load_applicant_for_offer(db, app_id)
    rows = db.execute(
        """SELECT o.*, d.name AS department_name, u.full_name AS created_by_name
           FROM recruitment_offers o
           LEFT JOIN hr_departments d ON o.department_id = d.id
           LEFT JOIN users u          ON o.created_by    = u.id
           WHERE o.applicant_id=? AND o.archived_at IS NULL
           ORDER BY o.created_at DESC, o.id DESC""",
        (app_id,),
    ).fetchall()
    return [_serialize_offer(r) for r in rows]


@router.post("/applicants/{app_id}/offers")
def create_offer(
    app_id: int,
    data: OfferCreate,
    user=Depends(require_perm("recruitment", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Draft an offer letter for an applicant. The applicant must be in an
    open pipeline stage — once Rejected or Withdrawn we refuse to draft a
    new offer so HR isn't tempted to back-date one onto a closed file."""
    applicant = _load_applicant_for_offer(db, app_id)
    if applicant["status"] in ("Rejected", "Withdrawn"):
        raise HTTPException(400, "Cannot draft an offer for a Rejected or Withdrawn applicant.")
    if data.department_id and not db.execute(
        "SELECT 1 FROM hr_departments WHERE id=? AND archived_at IS NULL",
        (data.department_id,),
    ).fetchone():
        raise HTTPException(400, "Selected department does not exist.")

    now = _now()
    offer_number = _next_offer_number(db)
    cur = db.execute(
        """INSERT INTO recruitment_offers
              (applicant_id, offer_number, status, contract_type, job_title,
               department_id, start_date, end_date, probation_months,
               probation_end_date, work_schedule, weekly_hours,
               annual_leave_days, notice_period_days, salary, salary_currency,
               payment_schedule, include_nssf, include_eos,
               include_confidentiality, include_non_compete, non_compete_months,
               benefits, additional_terms, place_of_work, expires_at,
               created_by, created_at)
           VALUES (?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (app_id, offer_number, data.contract_type,
         data.job_title or applicant["position_title"],
         data.department_id or applicant["position_department_id"],
         data.start_date, data.end_date, data.probation_months,
         data.probation_end_date, data.work_schedule, data.weekly_hours,
         data.annual_leave_days, data.notice_period_days, data.salary,
         data.salary_currency, data.payment_schedule,
         1 if data.include_nssf else 0, 1 if data.include_eos else 0,
         1 if data.include_confidentiality else 0, 1 if data.include_non_compete else 0,
         data.non_compete_months, data.benefits, data.additional_terms,
         data.place_of_work, data.expires_at, user["id"], now),
    )
    offer_id = cur.lastrowid
    log_action(db, user, "create", "recruitment_offer", offer_id,
               f"{applicant['full_name']} — {offer_number}",
               {"salary": data.salary, "currency": data.salary_currency})
    db.commit()
    return {"id": offer_id, "offer_number": offer_number,
            "message": "Offer drafted"}


@router.put("/offers/{offer_id}")
def update_offer(
    offer_id: int,
    data: OfferUpdate,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Edit a Draft offer. Once Sent / Accepted / Declined / Expired, the
    offer freezes — further changes should go through a new draft so the
    audit trail and the candidate's reference copy stay consistent."""
    row = db.execute(
        "SELECT id, status FROM recruitment_offers WHERE id=? AND archived_at IS NULL",
        (offer_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Offer not found")
    if row["status"] != "Draft":
        raise HTTPException(400, "Only Draft offers can be edited. Withdraw and draft a new one.")

    if data.department_id and not db.execute(
        "SELECT 1 FROM hr_departments WHERE id=? AND archived_at IS NULL",
        (data.department_id,),
    ).fetchone():
        raise HTTPException(400, "Selected department does not exist.")

    db.execute(
        """UPDATE recruitment_offers SET
              contract_type=?, job_title=?, department_id=?,
              start_date=?, end_date=?, probation_months=?, probation_end_date=?,
              work_schedule=?, weekly_hours=?, annual_leave_days=?,
              notice_period_days=?, salary=?, salary_currency=?,
              payment_schedule=?, include_nssf=?, include_eos=?,
              include_confidentiality=?, include_non_compete=?,
              non_compete_months=?, benefits=?, additional_terms=?,
              place_of_work=?, expires_at=?, updated_at=?
           WHERE id=?""",
        (data.contract_type, data.job_title, data.department_id,
         data.start_date, data.end_date, data.probation_months,
         data.probation_end_date, data.work_schedule, data.weekly_hours,
         data.annual_leave_days, data.notice_period_days, data.salary,
         data.salary_currency, data.payment_schedule,
         1 if data.include_nssf else 0, 1 if data.include_eos else 0,
         1 if data.include_confidentiality else 0, 1 if data.include_non_compete else 0,
         data.non_compete_months, data.benefits, data.additional_terms,
         data.place_of_work, data.expires_at, _now(), offer_id),
    )
    log_action(db, user, "update", "recruitment_offer", offer_id, f"#{offer_id}")
    db.commit()
    return {"message": "Offer updated"}


@router.post("/offers/{offer_id}/status")
def change_offer_status(
    offer_id: int,
    body: OfferStatusBody,
    user=Depends(require_perm("recruitment", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Lifecycle transitions:
        Draft → Sent       (user clicked 'Mark sent' after emailing the PDF)
        Sent  → Accepted   (candidate accepted; ConvertForm will offer to mint a contract)
        Sent  → Declined   (capture optional declined_reason)
        Sent  → Expired    (offer window passed)
    Backward transitions are blocked — drafting a new offer is the supported
    correction path so the audit trail of what was sent stays intact.
    """
    row = db.execute(
        "SELECT * FROM recruitment_offers WHERE id=? AND archived_at IS NULL",
        (offer_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Offer not found")
    old = row["status"]
    new = body.status
    if old == new:
        return {"message": f"Already {new}", "status": new}

    legal_transitions = {
        "Draft": {"Sent"},
        "Sent":  {"Accepted", "Declined", "Expired"},
        # Terminal: Accepted / Declined / Expired
    }
    if new not in legal_transitions.get(old, set()):
        raise HTTPException(400, f"Cannot transition offer from {old} to {new}.")

    now = _now()
    sets, params = ["status=?"], [new]
    if new == "Sent":
        sets.append("sent_at=?");     params.append(now)
    elif new == "Accepted":
        sets.append("accepted_at=?"); params.append(now)
    elif new == "Declined":
        sets.append("declined_at=?");      params.append(now)
        sets.append("declined_reason=?");  params.append(body.declined_reason or "Declined")
    sets.append("updated_at=?");       params.append(now)
    params.append(offer_id)
    db.execute(f"UPDATE recruitment_offers SET {', '.join(sets)} WHERE id=?", params)

    log_action(db, user, f"status:{new}", "recruitment_offer", offer_id,
               row["offer_number"] or f"#{offer_id}",
               {"declined_reason": body.declined_reason} if body.declined_reason else None)
    db.commit()
    return {"message": f"Offer {new.lower()}", "status": new}


@router.patch("/offers/{offer_id}/archive")
def archive_offer(
    offer_id: int,
    user=Depends(require_perm("recruitment", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Soft-delete. Accepted offers can still be archived for housekeeping but
    that's a separate concern from the contract that may have already minted."""
    row = db.execute(
        "SELECT offer_number FROM recruitment_offers WHERE id=? AND archived_at IS NULL",
        (offer_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Offer not found")
    db.execute("UPDATE recruitment_offers SET archived_at=? WHERE id=?", (_now(), offer_id))
    log_action(db, user, "archive", "recruitment_offer", offer_id, row["offer_number"] or f"#{offer_id}")
    db.commit()
    return {"message": "Offer archived"}


@router.get("/offers/{offer_id}/print-data")
def offer_print_data(
    offer_id: int,
    user=Depends(require_perm("recruitment", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Bundled payload for the client-side print template:
        - offer + joined names (applicant, department)
        - company branding rows from settings
        - Lebanon-aware constants the template renders (max probation, etc.)
    """
    offer_row = db.execute(
        """SELECT o.*, d.name AS department_name,
                  a.full_name AS applicant_name, a.email AS applicant_email,
                  a.phone AS applicant_phone,
                  u.full_name AS created_by_name
           FROM recruitment_offers o
           JOIN recruitment_applicants a ON o.applicant_id = a.id
           LEFT JOIN hr_departments d    ON o.department_id = d.id
           LEFT JOIN users u             ON o.created_by   = u.id
           WHERE o.id=? AND o.archived_at IS NULL""",
        (offer_id,),
    ).fetchone()
    if not offer_row:
        raise HTTPException(404, "Offer not found")

    company_keys = ("company_name", "company_address", "company_phone",
                    "company_email", "company_tax_id", "company_nssf_number",
                    "company_logo_url", "currency", "date_format")
    company = {}
    for k in company_keys:
        row = db.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
        company[k] = row["value"] if row else None

    return {
        "offer":   _serialize_offer(offer_row),
        "company": company,
        # Plain strings the template can drop into the printed footnote. Keeps
        # the legal references in one place instead of scattered across the
        # client.
        "lebanon": {
            "labor_code_reference": "Lebanese Labor Code (Decree of 23 September 1946, as amended)",
            "max_probation_months": LB_MAX_PROBATION_MONTHS,
            "max_weekly_hours":     LB_MAX_WEEKLY_HOURS,
            "min_annual_leave":     15,
            "nssf_full_name":       "National Social Security Fund (NSSF) / الصندوق الوطني للضمان الاجتماعي",
        },
    }
