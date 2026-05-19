"""
Human Resources — employee directory, departments and leave management.

Scope is deliberately focused on what a medium-size company needs day to day:
  • Departments      — organisational units
  • Employees        — the staff directory with lifecycle (Active/On Leave/Terminated)
  • Leave requests   — time-off with a simple Pending → Approved/Rejected flow
  • Summary          — headcount and leave KPIs for the HR dashboard

All records are soft-deleted via `archived_at`, consistent with the rest of
the ERP. Payroll is intentionally out of scope.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from typing import Optional
from datetime import date
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()

# ── Reference values ──────────────────────────────────────────────────────────
EMPLOYMENT_TYPES = {"Full-time", "Part-time", "Contract", "Intern"}
EMPLOYEE_STATUS  = {"Active", "On Leave", "Terminated"}
LEAVE_TYPES      = {"Annual", "Sick", "Unpaid", "Maternity", "Paternity", "Bereavement", "Other"}


# ── Pydantic models ───────────────────────────────────────────────────────────

class DepartmentBody(BaseModel):
    name:        str
    description: Optional[str] = None

    @validator("name")
    def _name_not_blank(cls, v):
        if not (v or "").strip():
            raise ValueError("Department name is required")
        return v.strip()


class EmployeeBody(BaseModel):
    full_name:       str
    job_title:       Optional[str] = None
    department_id:   Optional[int] = None
    employment_type: str           = "Full-time"
    status:          str           = "Active"
    hire_date:       Optional[str] = None
    end_date:        Optional[str] = None
    email:           Optional[str] = None
    phone:           Optional[str] = None
    salary:          float         = 0
    manager_id:      Optional[int] = None
    user_id:         Optional[int] = None
    address:         Optional[str] = None
    notes:           Optional[str] = None

    @validator("full_name")
    def _name_not_blank(cls, v):
        if not (v or "").strip():
            raise ValueError("Employee name is required")
        return v.strip()

    @validator("employment_type")
    def _valid_type(cls, v):
        if v not in EMPLOYMENT_TYPES:
            raise ValueError(f"Invalid employment type. Must be one of: {', '.join(sorted(EMPLOYMENT_TYPES))}")
        return v

    @validator("status")
    def _valid_status(cls, v):
        if v not in EMPLOYEE_STATUS:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(EMPLOYEE_STATUS))}")
        return v

    @validator("salary")
    def _salary_non_negative(cls, v):
        if v is None:
            return 0
        if v < 0:
            raise ValueError("Salary cannot be negative")
        return v


class LeaveBody(BaseModel):
    employee_id: int
    leave_type:  str           = "Annual"
    start_date:  str
    end_date:    str
    reason:      Optional[str] = None

    @validator("leave_type")
    def _valid_leave_type(cls, v):
        if v not in LEAVE_TYPES:
            raise ValueError(f"Invalid leave type. Must be one of: {', '.join(sorted(LEAVE_TYPES))}")
        return v


class ReviewBody(BaseModel):
    note: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _leave_days(start: str, end: str) -> int:
    """Inclusive day count between two ISO dates. Raises 400 on invalid input."""
    try:
        s = date.fromisoformat(start[:10])
        e = date.fromisoformat(end[:10])
    except (ValueError, TypeError):
        raise HTTPException(400, "Start and end dates must be valid (YYYY-MM-DD).")
    if e < s:
        raise HTTPException(400, "End date cannot be before the start date.")
    return (e - s).days + 1


# ══════════════════════════════════════════════════════════════════════════════
# DEPARTMENTS
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/departments")
def list_departments(
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        """SELECT d.*,
                  (SELECT COUNT(*) FROM hr_employees e
                   WHERE e.department_id = d.id AND e.archived_at IS NULL) AS employee_count
           FROM hr_departments d
           WHERE d.archived_at IS NULL
           ORDER BY d.name ASC"""
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/departments")
def create_department(
    data: DepartmentBody,
    user=Depends(require_perm("hr", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if db.execute(
        "SELECT id FROM hr_departments WHERE name=? AND archived_at IS NULL", (data.name,)
    ).fetchone():
        raise HTTPException(400, f"A department named '{data.name}' already exists.")
    cur = db.execute(
        "INSERT INTO hr_departments (name, description, created_at) VALUES (?,?,?)",
        (data.name, data.description, _now()),
    )
    log_action(db, user, "create", "hr_department", cur.lastrowid, data.name)
    db.commit()
    return {"id": cur.lastrowid, "message": "Department created"}


@router.put("/departments/{dept_id}")
def update_department(
    dept_id: int,
    data: DepartmentBody,
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute(
        "SELECT id FROM hr_departments WHERE id=? AND archived_at IS NULL", (dept_id,)
    ).fetchone():
        raise HTTPException(404, "Department not found")
    if db.execute(
        "SELECT id FROM hr_departments WHERE name=? AND id!=? AND archived_at IS NULL",
        (data.name, dept_id),
    ).fetchone():
        raise HTTPException(400, f"Another department named '{data.name}' already exists.")
    db.execute(
        "UPDATE hr_departments SET name=?, description=? WHERE id=?",
        (data.name, data.description, dept_id),
    )
    log_action(db, user, "update", "hr_department", dept_id, data.name)
    db.commit()
    return {"message": "Department updated"}


@router.patch("/departments/{dept_id}/archive")
def archive_department(
    dept_id: int,
    user=Depends(require_perm("hr", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT * FROM hr_departments WHERE id=? AND archived_at IS NULL", (dept_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Department not found")
    staff = db.execute(
        "SELECT COUNT(*) FROM hr_employees WHERE department_id=? AND archived_at IS NULL",
        (dept_id,),
    ).fetchone()[0]
    if staff:
        raise HTTPException(400, f"Cannot archive: {staff} employee(s) are still assigned to this department.")
    db.execute("UPDATE hr_departments SET archived_at=? WHERE id=?", (_now(), dept_id))
    log_action(db, user, "archive", "hr_department", dept_id, row["name"])
    db.commit()
    return {"message": "Department archived"}


@router.patch("/departments/{dept_id}/unarchive")
def unarchive_department(
    dept_id: int,
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT * FROM hr_departments WHERE id=? AND archived_at IS NOT NULL", (dept_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Department not found in archives")
    db.execute("UPDATE hr_departments SET archived_at=NULL WHERE id=?", (dept_id,))
    log_action(db, user, "unarchive", "hr_department", dept_id, row["name"])
    db.commit()
    return {"message": "Department restored from archive"}


# ══════════════════════════════════════════════════════════════════════════════
# EMPLOYEES
# ══════════════════════════════════════════════════════════════════════════════

# Fixed literal statements. The list query's filters are each a no-op when the
# bound value is NULL, so no user input is ever concatenated into the SQL text.
_EMPLOYEE_BY_ID = """
    SELECT e.*,
           d.name  AS department_name,
           m.full_name AS manager_name
    FROM hr_employees e
    LEFT JOIN hr_departments d ON e.department_id = d.id
    LEFT JOIN hr_employees   m ON e.manager_id    = m.id
    WHERE e.id = ?
"""

_EMPLOYEE_LIST_SQL = """
    SELECT e.*,
           d.name  AS department_name,
           m.full_name AS manager_name
    FROM hr_employees e
    LEFT JOIN hr_departments d ON e.department_id = d.id
    LEFT JOIN hr_employees   m ON e.manager_id    = m.id
    WHERE e.archived_at IS NULL
      AND (? IS NULL OR (e.full_name LIKE ? OR e.job_title LIKE ?
                         OR e.employee_code LIKE ? OR e.email LIKE ?))
      AND (? IS NULL OR e.department_id = ?)
      AND (? IS NULL OR e.status = ?)
    ORDER BY e.full_name ASC
"""


def _refresh_leave_statuses(db: sqlite3.Connection) -> None:
    """Reconcile employees' `On Leave` flag with today's approved-leave window.

    We have no scheduled job runner, so this lazy refresh runs on every HR
    read (list / single / summary). Two cheap UPDATEs:
      • An Active employee whose approved leave covers today → On Leave.
      • An On-Leave employee with no approved leave covering today → back to
        Active. (Terminated employees are never auto-changed.)

    Without this, the first time someone takes a vacation they get stuck
    `On Leave` forever — the Notifications page and HR dashboard would
    over-report long after the leave window closed.
    """
    today = _now()[:10]
    # Flip into On Leave
    db.execute(
        """UPDATE hr_employees SET status='On Leave'
           WHERE archived_at IS NULL
             AND status='Active'
             AND EXISTS (
                 SELECT 1 FROM hr_leave_requests l
                 WHERE l.employee_id = hr_employees.id
                   AND l.status='Approved'
                   AND l.start_date <= ?  AND l.end_date >= ?
             )""",
        (today, today),
    )
    # Flip back to Active
    db.execute(
        """UPDATE hr_employees SET status='Active'
           WHERE archived_at IS NULL
             AND status='On Leave'
             AND NOT EXISTS (
                 SELECT 1 FROM hr_leave_requests l
                 WHERE l.employee_id = hr_employees.id
                   AND l.status='Approved'
                   AND l.start_date <= ?  AND l.end_date >= ?
             )""",
        (today, today),
    )
    db.commit()


def _validate_refs(db: sqlite3.Connection, data: EmployeeBody, self_id: Optional[int] = None):
    if data.department_id and not db.execute(
        "SELECT id FROM hr_departments WHERE id=? AND archived_at IS NULL", (data.department_id,)
    ).fetchone():
        raise HTTPException(400, "Selected department does not exist.")
    if data.manager_id:
        if self_id and data.manager_id == self_id:
            raise HTTPException(400, "An employee cannot be their own manager.")
        if not db.execute(
            "SELECT id FROM hr_employees WHERE id=? AND archived_at IS NULL", (data.manager_id,)
        ).fetchone():
            raise HTTPException(400, "Selected manager does not exist.")
    if data.user_id and not db.execute(
        "SELECT id FROM users WHERE id=? AND deleted_at IS NULL", (data.user_id,)
    ).fetchone():
        raise HTTPException(400, "Linked user account does not exist.")


@router.get("/employees")
def list_employees(
    search:        Optional[str] = None,
    department_id: Optional[int] = None,
    status:        Optional[str] = None,
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    _refresh_leave_statuses(db)
    like = f"%{search}%" if search else None
    params = [search, like, like, like, like,
              department_id, department_id, status, status]
    return [dict(r) for r in db.execute(_EMPLOYEE_LIST_SQL, params).fetchall()]


@router.get("/employees/{emp_id}")
def get_employee(
    emp_id: int,
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    _refresh_leave_statuses(db)
    row = db.execute(_EMPLOYEE_BY_ID, (emp_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Employee not found")
    result = dict(row)
    result["leave_history"] = [
        dict(r) for r in db.execute(
            "SELECT * FROM hr_leave_requests WHERE employee_id=? ORDER BY start_date DESC",
            (emp_id,),
        ).fetchall()
    ]
    result["direct_reports"] = [
        dict(r) for r in db.execute(
            "SELECT id, full_name, job_title FROM hr_employees "
            "WHERE manager_id=? AND archived_at IS NULL ORDER BY full_name",
            (emp_id,),
        ).fetchall()
    ]
    return result


@router.post("/employees")
def create_employee(
    data: EmployeeBody,
    user=Depends(require_perm("hr", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    _validate_refs(db, data)
    cur = db.execute(
        """INSERT INTO hr_employees
               (full_name, job_title, department_id, employment_type, status,
                hire_date, end_date, email, phone, salary, manager_id, user_id,
                address, notes, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.full_name, data.job_title, data.department_id, data.employment_type,
         data.status, data.hire_date or None, data.end_date or None, data.email,
         data.phone, data.salary, data.manager_id, data.user_id, data.address,
         data.notes, _now()),
    )
    emp_id = cur.lastrowid
    code   = f"EMP-{emp_id:04d}"
    db.execute("UPDATE hr_employees SET employee_code=? WHERE id=?", (code, emp_id))
    log_action(db, user, "create", "hr_employee", emp_id, data.full_name)
    db.commit()
    return {"id": emp_id, "employee_code": code, "message": "Employee created"}


@router.put("/employees/{emp_id}")
def update_employee(
    emp_id: int,
    data: EmployeeBody,
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute(
        "SELECT id FROM hr_employees WHERE id=? AND archived_at IS NULL", (emp_id,)
    ).fetchone():
        raise HTTPException(404, "Employee not found")
    _validate_refs(db, data, self_id=emp_id)
    db.execute(
        """UPDATE hr_employees SET
               full_name=?, job_title=?, department_id=?, employment_type=?, status=?,
               hire_date=?, end_date=?, email=?, phone=?, salary=?, manager_id=?,
               user_id=?, address=?, notes=?
           WHERE id=?""",
        (data.full_name, data.job_title, data.department_id, data.employment_type,
         data.status, data.hire_date or None, data.end_date or None, data.email,
         data.phone, data.salary, data.manager_id, data.user_id, data.address,
         data.notes, emp_id),
    )
    log_action(db, user, "update", "hr_employee", emp_id, data.full_name)
    db.commit()
    return {"message": "Employee updated"}


@router.patch("/employees/{emp_id}/archive")
def archive_employee(
    emp_id: int,
    user=Depends(require_perm("hr", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT * FROM hr_employees WHERE id=? AND archived_at IS NULL", (emp_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Employee not found")
    db.execute("UPDATE hr_employees SET archived_at=? WHERE id=?", (_now(), emp_id))
    # Detach this person as a manager so reports are not left pointing at an archived record.
    db.execute("UPDATE hr_employees SET manager_id=NULL WHERE manager_id=?", (emp_id,))
    log_action(db, user, "archive", "hr_employee", emp_id, row["full_name"])
    db.commit()
    return {"message": "Employee archived"}


@router.patch("/employees/{emp_id}/unarchive")
def unarchive_employee(
    emp_id: int,
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT * FROM hr_employees WHERE id=? AND archived_at IS NOT NULL", (emp_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Employee not found in archives")
    db.execute("UPDATE hr_employees SET archived_at=NULL WHERE id=?", (emp_id,))
    log_action(db, user, "unarchive", "hr_employee", emp_id, row["full_name"])
    db.commit()
    return {"message": "Employee restored from archive"}


# ══════════════════════════════════════════════════════════════════════════════
# LEAVE REQUESTS
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/leave")
def list_leave(
    status:      Optional[str] = None,
    employee_id: Optional[int] = None,
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    query = """
        SELECT l.*,
               e.full_name     AS employee_name,
               e.employee_code AS employee_code,
               r.full_name     AS reviewer_name
        FROM hr_leave_requests l
        JOIN hr_employees e ON l.employee_id = e.id
        LEFT JOIN users    r ON l.reviewed_by = r.id
        WHERE 1=1
    """
    params: list = []
    if status:
        query += " AND l.status = ?"
        params.append(status)
    if employee_id:
        query += " AND l.employee_id = ?"
        params.append(employee_id)
    query += " ORDER BY l.created_at DESC LIMIT 500"
    return [dict(r) for r in db.execute(query, params).fetchall()]


@router.post("/leave")
def create_leave(
    data: LeaveBody,
    user=Depends(require_perm("hr", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    emp = db.execute(
        "SELECT id, full_name FROM hr_employees WHERE id=? AND archived_at IS NULL",
        (data.employee_id,),
    ).fetchone()
    if not emp:
        raise HTTPException(400, "Selected employee does not exist.")
    days = _leave_days(data.start_date, data.end_date)
    cur = db.execute(
        """INSERT INTO hr_leave_requests
               (employee_id, leave_type, start_date, end_date, days, reason, status, created_at)
           VALUES (?,?,?,?,?,?,'Pending',?)""",
        (data.employee_id, data.leave_type, data.start_date[:10], data.end_date[:10],
         days, data.reason, _now()),
    )
    log_action(db, user, "create", "hr_leave", cur.lastrowid,
               f"{emp['full_name']} — {data.leave_type}")
    db.commit()
    return {"id": cur.lastrowid, "days": days, "message": "Leave request submitted"}


@router.put("/leave/{leave_id}")
def update_leave(
    leave_id: int,
    data: LeaveBody,
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM hr_leave_requests WHERE id=?", (leave_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Leave request not found")
    if row["status"] != "Pending":
        raise HTTPException(400, f"Cannot edit a leave request that is already {row['status']}.")
    if not db.execute(
        "SELECT id FROM hr_employees WHERE id=? AND archived_at IS NULL", (data.employee_id,)
    ).fetchone():
        raise HTTPException(400, "Selected employee does not exist.")
    days = _leave_days(data.start_date, data.end_date)
    db.execute(
        """UPDATE hr_leave_requests
           SET employee_id=?, leave_type=?, start_date=?, end_date=?, days=?, reason=?
           WHERE id=?""",
        (data.employee_id, data.leave_type, data.start_date[:10], data.end_date[:10],
         days, data.reason, leave_id),
    )
    log_action(db, user, "update", "hr_leave", leave_id, data.leave_type)
    db.commit()
    return {"message": "Leave request updated", "days": days}


def _review_leave(db, leave_id, user, decision: str, note):
    row = db.execute(
        """SELECT l.*, e.full_name AS employee_name, e.status AS emp_status
           FROM hr_leave_requests l JOIN hr_employees e ON l.employee_id = e.id
           WHERE l.id=?""",
        (leave_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Leave request not found")
    if row["status"] != "Pending":
        raise HTTPException(400, f"This request is already {row['status']}.")
    db.execute(
        "UPDATE hr_leave_requests SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?",
        (decision, user["id"], _now(), note, leave_id),
    )
    # Reflect an approved, currently-running leave on the employee's status.
    if decision == "Approved":
        today = _now()[:10]
        if row["start_date"] <= today <= row["end_date"] and row["emp_status"] == "Active":
            db.execute("UPDATE hr_employees SET status='On Leave' WHERE id=?", (row["employee_id"],))
    log_action(db, user, decision.lower(), "hr_leave", leave_id, row["employee_name"])
    db.commit()
    return {"message": f"Leave request {decision.lower()}"}


@router.post("/leave/{leave_id}/approve")
def approve_leave(
    leave_id: int,
    data: ReviewBody,
    user=Depends(require_perm("hr", "approve")),
    db: sqlite3.Connection = Depends(get_db),
):
    return _review_leave(db, leave_id, user, "Approved", data.note)


@router.post("/leave/{leave_id}/reject")
def reject_leave(
    leave_id: int,
    data: ReviewBody,
    user=Depends(require_perm("hr", "approve")),
    db: sqlite3.Connection = Depends(get_db),
):
    return _review_leave(db, leave_id, user, "Rejected", data.note)


@router.delete("/leave/{leave_id}")
def delete_leave(
    leave_id: int,
    user=Depends(require_perm("hr", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM hr_leave_requests WHERE id=?", (leave_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Leave request not found")
    if row["status"] != "Pending":
        raise HTTPException(400, "Only pending leave requests can be removed; reviewed ones are kept for the record.")
    db.execute("DELETE FROM hr_leave_requests WHERE id=?", (leave_id,))
    log_action(db, user, "delete", "hr_leave", leave_id, row["leave_type"])
    db.commit()
    return {"message": "Leave request removed"}


# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/summary")
def hr_summary(
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    _refresh_leave_statuses(db)
    totals = db.execute(
        """SELECT
               COUNT(*)                                          AS total_employees,
               COALESCE(SUM(status='Active'), 0)                 AS active,
               COALESCE(SUM(status='On Leave'), 0)               AS on_leave,
               COALESCE(SUM(status='Terminated'), 0)             AS terminated
           FROM hr_employees WHERE archived_at IS NULL"""
    ).fetchone()

    dept_count = db.execute(
        "SELECT COUNT(*) FROM hr_departments WHERE archived_at IS NULL"
    ).fetchone()[0]

    pending_leave = db.execute(
        "SELECT COUNT(*) FROM hr_leave_requests WHERE status='Pending'"
    ).fetchone()[0]

    by_department = [
        dict(r) for r in db.execute(
            """SELECT d.name AS department, COUNT(e.id) AS count
               FROM hr_departments d
               LEFT JOIN hr_employees e
                      ON e.department_id = d.id AND e.archived_at IS NULL
               WHERE d.archived_at IS NULL
               GROUP BY d.id ORDER BY count DESC, d.name"""
        ).fetchall()
    ]

    by_type = [
        dict(r) for r in db.execute(
            """SELECT employment_type AS type, COUNT(*) AS count
               FROM hr_employees WHERE archived_at IS NULL
               GROUP BY employment_type ORDER BY count DESC"""
        ).fetchall()
    ]

    return {
        "total_employees": totals["total_employees"],
        "active":          totals["active"],
        "on_leave":        totals["on_leave"],
        "terminated":      totals["terminated"],
        "departments":     dept_count,
        "pending_leave":   pending_leave,
        "by_department":   by_department,
        "by_type":         by_type,
    }
