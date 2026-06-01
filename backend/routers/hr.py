"""
Human Resources — full HR workflow for a medium-size company.

Scope:
  • Departments              — organisational units
  • Employees                — directory + lifecycle (Active / On Leave / Terminated)
  • Employment history       — immutable audit trail of every salary / title /
                                department / manager change (auto-captured on
                                employee edits — promotions, raises, transfers).
  • Employee files (PDF)     — CV, contract and other attachments.
  • Leave requests           — Pending → Approved/Rejected flow.
  • Payroll                  — monthly runs (Draft → Approved → Paid). Marking
                                a run Paid posts a single 'Payroll' expense to
                                Finance so monthly P&L is correct, no double-
                                entry. Idempotent.
  • Summary                  — headcount, leave, payroll KPIs.

All business records are soft-deleted via `archived_at`. Salary history is
hard / append-only (an audit log — never edited).
"""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, validator
from typing import Optional
from datetime import date, datetime
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, notify
import accounting
import io


# ── Notification helpers ─────────────────────────────────────────────────────
# Resolve who should be told when an HR event fires. Two recipients matter:
#   1. the **employee** — via their linked system user account (may be None).
#   2. the **HR managers** — every active user whose role can approve HR.
# Both helpers tolerate missing data so a notification failure never blocks the
# transactional path (notify() also swallows its own errors as a final safety).

def _employee_user_id(db, employee_id: int) -> "Optional[int]":
    row = db.execute(
        "SELECT user_id FROM hr_employees WHERE id=? AND archived_at IS NULL",
        (employee_id,),
    ).fetchone()
    return (row["user_id"] if row and row["user_id"] else None)


def _hr_approver_user_ids(db) -> list:
    """Every active user whose role grants `hr.approve` — i.e. the people who
    can review a leave request. Used to fan out "leave requested" alerts."""
    rows = db.execute(
        """SELECT DISTINCT u.id FROM users u
           JOIN role_permissions rp ON rp.role_id = u.role_id
           WHERE u.is_active = 1 AND u.deleted_at IS NULL
             AND rp.module='hr' AND rp.can_approve=1""",
    ).fetchall()
    return [r["id"] for r in rows]
import sqlite3

router = APIRouter()

# ── Reference values ──────────────────────────────────────────────────────────
EMPLOYMENT_TYPES = {"Full-time", "Part-time", "Contract", "Intern"}
EMPLOYEE_STATUS  = {"Active", "On Leave", "Terminated"}
LEAVE_TYPES      = {"Annual", "Sick", "Unpaid", "Maternity", "Paternity", "Bereavement", "Other"}
CHANGE_TYPES     = {"hire", "raise", "promotion", "demotion", "role_change",
                    "transfer", "termination", "adjustment"}
FILE_KINDS       = {"cv", "contract", "other"}
PAYROLL_STATUSES = {"Draft", "Approved", "Paid", "Cancelled"}
MAX_FILE_BYTES   = 8 * 1024 * 1024   # 8MB — hard cap on PDF size per upload


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
    # On PUT only — annotate WHY the change happened. Auto-classified into a
    # change_type if not provided (raise / promotion / role_change / transfer /
    # adjustment). The values are stored in hr_employment_changes.
    change_type:     Optional[str] = None
    change_reason:   Optional[str] = None

    @validator("change_type")
    def _valid_change_type(cls, v):
        if v in (None, "") or v in CHANGE_TYPES:
            return v
        raise ValueError(f"Invalid change_type. Must be one of: {', '.join(sorted(CHANGE_TYPES))}")

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


# ── Employment-change diff ──────────────────────────────────────────────────
# Compares an employee's old row against an incoming PUT payload across the
# four tracked fields. If any of them changed, one row is appended to
# hr_employment_changes — capturing a promotion/raise/transfer/role_change as a
# single atomic event. Pure DB-level: no side effects beyond the INSERT.
_TRACKED_FIELDS = ("salary", "job_title", "department_id", "manager_id")


def _classify_change(old: dict, new: dict) -> str:
    """Infer change_type from the diff when the caller didn't specify one."""
    salary_up   = (new.get("salary") or 0)        > (old.get("salary") or 0)
    salary_down = (new.get("salary") or 0)        < (old.get("salary") or 0)
    title_diff  =  new.get("job_title")           != old.get("job_title")
    dept_diff   =  new.get("department_id")       != old.get("department_id")
    if title_diff and salary_up:
        return "promotion"
    if title_diff and salary_down:
        return "demotion"
    if title_diff:
        return "role_change"
    if dept_diff:
        return "transfer"
    if salary_up or salary_down:
        return "raise" if salary_up else "adjustment"
    return "adjustment"


def _log_employment_change(
    db: sqlite3.Connection,
    employee_id: int,
    old: dict,
    new: dict,
    *,
    explicit_type: Optional[str] = None,
    reason:        Optional[str] = None,
    actor_id:      Optional[int] = None,
) -> bool:
    """Insert an immutable history row when any tracked field changed.

    Returns True if a row was inserted. Caller commits."""
    changed = any(
        (old.get(f) if old.get(f) is not None else 0) !=
        (new.get(f) if new.get(f) is not None else 0)
        if f == "salary"
        else (old.get(f) or None) != (new.get(f) or None)
        for f in _TRACKED_FIELDS
    )
    if not changed:
        return False
    change_type = explicit_type if explicit_type in CHANGE_TYPES else _classify_change(old, new)
    db.execute(
        """INSERT INTO hr_employment_changes
           (employee_id, effective_date, change_type,
            old_salary, new_salary, old_title, new_title,
            old_department_id, new_department_id,
            old_manager_id, new_manager_id,
            reason, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            employee_id, _now()[:10], change_type,
            old.get("salary"),       new.get("salary"),
            old.get("job_title"),    new.get("job_title"),
            old.get("department_id"), new.get("department_id"),
            old.get("manager_id"),    new.get("manager_id"),
            reason, actor_id, _now(),
        ),
    )
    return True


# ── Payroll & file models ───────────────────────────────────────────────────
class PayrollRunCreate(BaseModel):
    period_start: str
    period_end:   str
    notes:        Optional[str] = None

    @validator("period_start", "period_end")
    def _valid_iso(cls, v):
        try:
            date.fromisoformat(v[:10])
        except (ValueError, TypeError):
            raise ValueError("Period dates must be YYYY-MM-DD")
        return v[:10]


class PayrollLineUpdate(BaseModel):
    base_salary:      Optional[float] = None
    bonuses:          Optional[float] = None
    deductions:       Optional[float] = None
    overtime_hours:   Optional[float] = None
    overtime_amount:  Optional[float] = None
    notes:            Optional[str]   = None

    @validator("base_salary", "bonuses", "deductions",
               "overtime_hours", "overtime_amount")
    def _non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError("Value cannot be negative")
        return v


def _payroll_settings(db: sqlite3.Connection) -> dict:
    """Read the payroll % settings. All default to 0 (opt-in)."""
    keys = ("payroll_tax_pct", "payroll_nssf_employee_pct",
            "payroll_nssf_employer_pct", "payroll_overtime_multiplier")
    rows = {r["key"]: r["value"] for r in db.execute(
        f"SELECT key, value FROM settings WHERE key IN ({','.join('?'*len(keys))})",
        keys,
    ).fetchall()}
    def _f(k, default=0.0):
        try: return float(rows.get(k) or 0)
        except (TypeError, ValueError): return default
    return {
        "tax_pct":             _f("payroll_tax_pct"),
        "nssf_employee_pct":   _f("payroll_nssf_employee_pct"),
        "nssf_employer_pct":   _f("payroll_nssf_employer_pct"),
        "overtime_multiplier": _f("payroll_overtime_multiplier") or 1.5,
    }


def _compute_payroll_line(base, bonus, deduct, overtime_amount, settings):
    """Pure breakdown. Returns the full set of columns persisted on a line.

    gross           = base + bonus + overtime_amount
    nssf_employee   = gross × nssf_employee_pct / 100   (employee contribution)
    nssf_employer   = gross × nssf_employer_pct / 100   (employer cost only)
    taxable         = gross − nssf_employee             (NSSF is pre-tax)
    tax             = taxable × tax_pct / 100
    net             = gross − deductions − nssf_employee − tax
    """
    base   = float(base or 0); bonus = float(bonus or 0)
    deduct = float(deduct or 0); ot   = float(overtime_amount or 0)
    gross  = round(base + bonus + ot, 2)
    nssf_e = round(gross * settings["nssf_employee_pct"] / 100.0, 2)
    nssf_c = round(gross * settings["nssf_employer_pct"] / 100.0, 2)
    taxable = max(0.0, gross - nssf_e)
    tax     = round(taxable * settings["tax_pct"] / 100.0, 2)
    net     = round(gross - deduct - nssf_e - tax, 2)
    return {
        "gross_total":     gross,
        "nssf_employee":   nssf_e,
        "nssf_employer":   nssf_c,
        "tax_amount":      tax,
        "net_amount":      net,
    }


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
    # Salary / role / department / manager timeline — newest first.
    result["history"] = [
        dict(r) for r in db.execute(
            """SELECT h.*,
                      od.name AS old_department_name, nd.name AS new_department_name,
                      om.full_name AS old_manager_name, nm.full_name AS new_manager_name,
                      u.full_name AS created_by_name
               FROM hr_employment_changes h
               LEFT JOIN hr_departments od ON h.old_department_id = od.id
               LEFT JOIN hr_departments nd ON h.new_department_id = nd.id
               LEFT JOIN hr_employees   om ON h.old_manager_id    = om.id
               LEFT JOIN hr_employees   nm ON h.new_manager_id    = nm.id
               LEFT JOIN users          u  ON h.created_by        = u.id
               WHERE h.employee_id=?
               ORDER BY h.effective_date DESC, h.id DESC""",
            (emp_id,),
        ).fetchall()
    ]
    # Files metadata (binary fetched separately via /files/{id}/download).
    result["files"] = [
        dict(r) for r in db.execute(
            "SELECT id, kind, filename, content_type, size_bytes, created_at "
            "FROM hr_employee_files WHERE employee_id=? ORDER BY created_at DESC",
            (emp_id,),
        ).fetchall()
    ]
    # Payroll history — what's been paid out, by run.
    result["payroll_history"] = [
        dict(r) for r in db.execute(
            """SELECT pl.id, pl.base_salary, pl.bonuses, pl.deductions, pl.net_amount,
                      pl.notes, pr.id AS run_id, pr.period_start, pr.period_end,
                      pr.status, pr.paid_at
               FROM hr_payroll_lines pl
               JOIN hr_payroll_runs  pr ON pr.id = pl.payroll_run_id
               WHERE pl.employee_id=? AND pr.archived_at IS NULL
               ORDER BY pr.period_start DESC, pr.id DESC""",
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
    # Seed the timeline with the hire row, so the employee detail page is
    # never blank.
    db.execute(
        """INSERT INTO hr_employment_changes
           (employee_id, effective_date, change_type,
            old_salary, new_salary, old_title, new_title,
            old_department_id, new_department_id,
            old_manager_id, new_manager_id,
            reason, created_by, created_at)
           VALUES (?, ?, 'hire', NULL, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?)""",
        (emp_id, (data.hire_date or _now())[:10],
         data.salary or 0, data.job_title, data.department_id, data.manager_id,
         data.change_reason or "Hired", user["id"], _now()),
    )
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
    existing = db.execute(
        "SELECT * FROM hr_employees WHERE id=? AND archived_at IS NULL", (emp_id,)
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Employee not found")
    _validate_refs(db, data, self_id=emp_id)

    # Capture the salary/title/department/manager diff BEFORE the UPDATE so the
    # timeline reflects what actually changed, not the new state vs. itself.
    old = {
        "salary":        existing["salary"],
        "job_title":     existing["job_title"],
        "department_id": existing["department_id"],
        "manager_id":    existing["manager_id"],
    }
    new = {
        "salary":        data.salary,
        "job_title":     data.job_title,
        "department_id": data.department_id,
        "manager_id":    data.manager_id,
    }
    # Status transition → 'Terminated' is also a tracked employment event.
    becoming_terminated = (existing["status"] != "Terminated" and data.status == "Terminated")

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

    # One history row per edit when any tracked field changed. Termination is
    # logged even if salary/title/etc. didn't move.
    inserted = _log_employment_change(
        db, emp_id, old, new,
        explicit_type=data.change_type,
        reason=data.change_reason,
        actor_id=user["id"],
    )
    if becoming_terminated and not inserted:
        db.execute(
            """INSERT INTO hr_employment_changes
               (employee_id, effective_date, change_type,
                old_salary, new_salary, old_title, new_title,
                old_department_id, new_department_id,
                old_manager_id, new_manager_id,
                reason, created_by, created_at)
               VALUES (?, ?, 'termination', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (emp_id, _now()[:10],
             old["salary"], new["salary"], old["job_title"], new["job_title"],
             old["department_id"], new["department_id"],
             old["manager_id"], new["manager_id"],
             data.change_reason or "Terminated", user["id"], _now()),
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
    leave_id = cur.lastrowid
    log_action(db, user, "create", "hr_leave", leave_id,
               f"{emp['full_name']} — {data.leave_type}")

    # Tell the HR approvers — they need to act. Dedup-safe (1 alert per leave
    # row) so a manager isn't pinged twice if the requester edits a typo. The
    # notification is suppressed for the approver who created the row themselves
    # (e.g. an HR admin logging a leave on someone's behalf).
    title = f"Leave request: {emp['full_name']}"
    body  = f"{data.leave_type} — {days} day{'s' if days != 1 else ''} · {data.start_date[:10]} → {data.end_date[:10]}"
    for uid in _hr_approver_user_ids(db):
        if uid == user.get("id"):
            continue
        notify(
            db, user_id=uid, type="leave_requested",
            title=title, body=body, link="/hr",
            entity_type="hr_leave", entity_id=leave_id, dedup_hours=24,
        )

    db.commit()
    return {"id": leave_id, "days": days, "message": "Leave request submitted"}


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

    # Tell the employee — the person who cares most about the outcome. No-op
    # when the employee record isn't linked to a system user (very common
    # for back-office staff who never log in).
    emp_uid = _employee_user_id(db, row["employee_id"])
    if emp_uid:
        kind = "leave_approved" if decision == "Approved" else "leave_rejected"
        verb = "approved" if decision == "Approved" else "declined"
        body = (
            f"{row['leave_type']} · {row['start_date']} → {row['end_date']}"
            + (f" — {note}" if note else "")
        )
        notify(
            db, user_id=emp_uid, type=kind,
            title=f"Your leave request was {verb}",
            body=body, link="/hr",
            entity_type="hr_leave", entity_id=leave_id,
        )

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

    open_runs = db.execute(
        "SELECT COUNT(*) FROM hr_payroll_runs "
        "WHERE archived_at IS NULL AND status IN ('Draft','Approved')"
    ).fetchone()[0]
    ytd_payroll = db.execute(
        "SELECT COALESCE(SUM(total_net),0) FROM hr_payroll_runs "
        "WHERE status='Paid' AND archived_at IS NULL "
        "  AND substr(period_start,1,4) = strftime('%Y','now')"
    ).fetchone()[0]

    return {
        "total_employees": totals["total_employees"],
        "active":          totals["active"],
        "on_leave":        totals["on_leave"],
        "terminated":      totals["terminated"],
        "departments":     dept_count,
        "pending_leave":   pending_leave,
        "by_department":   by_department,
        "by_type":         by_type,
        "open_payroll_runs": open_runs,
        "ytd_payroll":       float(ytd_payroll or 0),
    }


# ══════════════════════════════════════════════════════════════════════════════
# EMPLOYEE FILES — CV / Contract / Other (PDFs)
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/employees/{emp_id}/files")
async def upload_employee_file(
    emp_id: int,
    kind: str = Form("other"),
    file: UploadFile = File(...),
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Attach a PDF (CV, contract, other) to an employee.

    Replaces any previous file of the same `kind` — each employee has at most
    one current CV and one current contract. Other-kind files accumulate."""
    if kind not in FILE_KINDS:
        raise HTTPException(400, f"kind must be one of: {', '.join(sorted(FILE_KINDS))}")
    if not db.execute(
        "SELECT 1 FROM hr_employees WHERE id=? AND archived_at IS NULL", (emp_id,)
    ).fetchone():
        raise HTTPException(404, "Employee not found")

    content_type = (file.content_type or "").lower()
    if content_type != "application/pdf":
        raise HTTPException(400, "Only PDF files are accepted.")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            400,
            f"File too large ({len(data) // 1024} KB). "
            f"Maximum is {MAX_FILE_BYTES // (1024 * 1024)} MB.",
        )

    # CV / Contract are single-slot: replace the previous one.
    if kind in ("cv", "contract"):
        db.execute("DELETE FROM hr_employee_files WHERE employee_id=? AND kind=?",
                   (emp_id, kind))
    cur = db.execute(
        """INSERT INTO hr_employee_files
           (employee_id, kind, filename, content_type, size_bytes, data,
            uploaded_by, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (emp_id, kind, file.filename or f"{kind}.pdf", content_type,
         len(data), data, user["id"], _now()),
    )
    log_action(db, user, "upload", "hr_employee_file", cur.lastrowid,
               f"emp #{emp_id} — {kind}")
    db.commit()
    return {
        "id":       cur.lastrowid,
        "kind":     kind,
        "filename": file.filename,
        "size":     len(data),
        "message":  "File uploaded",
    }


@router.get("/employees/{emp_id}/files")
def list_employee_files(
    emp_id: int,
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Files metadata only — binary fetched separately to keep this cheap."""
    return [
        dict(r) for r in db.execute(
            "SELECT id, kind, filename, content_type, size_bytes, created_at "
            "FROM hr_employee_files WHERE employee_id=? ORDER BY created_at DESC",
            (emp_id,),
        ).fetchall()
    ]


@router.get("/files/{file_id}/download")
def download_employee_file(
    file_id: int,
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Stream the PDF bytes inline so the browser previews it in a new tab."""
    row = db.execute(
        "SELECT filename, content_type, data FROM hr_employee_files WHERE id=?",
        (file_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "File not found")
    # `inline` disposition so the browser shows the PDF in-tab; `download`
    # query toggle could be added later if a forced-download button is needed.
    return Response(
        content=row["data"],
        media_type=row["content_type"] or "application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{row["filename"]}"',
            "Cache-Control": "private, max-age=0, must-revalidate",
        },
    )


@router.delete("/files/{file_id}")
def delete_employee_file(
    file_id: int,
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT employee_id, kind, filename FROM hr_employee_files WHERE id=?",
        (file_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "File not found")
    db.execute("DELETE FROM hr_employee_files WHERE id=?", (file_id,))
    log_action(db, user, "delete", "hr_employee_file", file_id,
               f"emp #{row['employee_id']} — {row['kind']}")
    db.commit()
    return {"message": "File deleted"}


# ══════════════════════════════════════════════════════════════════════════════
# PAYROLL — Draft → Approved → Paid (with Finance auto-post)
# ══════════════════════════════════════════════════════════════════════════════

def _recompute_run_totals(db: sqlite3.Connection, run_id: int) -> None:
    """Sum the run's lines and write the totals back on the header row.
    Idempotent; called after every line edit and after run creation.
    Note: `total_gross` is the SUM of per-line gross (base + bonus + overtime),
    not just base — matches what 'gross pay' usually means on a payslip."""
    agg = db.execute(
        """SELECT COALESCE(SUM(gross_total),0)     AS gross,
                  COALESCE(SUM(bonuses),0)        AS bonuses,
                  COALESCE(SUM(deductions),0)     AS deductions,
                  COALESCE(SUM(tax_amount),0)     AS tax,
                  COALESCE(SUM(nssf_employee),0)  AS nssf_e,
                  COALESCE(SUM(nssf_employer),0)  AS nssf_c,
                  COALESCE(SUM(overtime_amount),0) AS overtime,
                  COALESCE(SUM(net_amount),0)     AS net
           FROM hr_payroll_lines WHERE payroll_run_id=?""",
        (run_id,),
    ).fetchone()
    db.execute(
        "UPDATE hr_payroll_runs SET "
        "  total_gross=?, total_bonuses=?, total_deductions=?, total_net=?, "
        "  total_tax=?, total_nssf_employee=?, total_nssf_employer=?, total_overtime=? "
        "WHERE id=?",
        (agg["gross"], agg["bonuses"], agg["deductions"], agg["net"],
         agg["tax"], agg["nssf_e"], agg["nssf_c"], agg["overtime"], run_id),
    )


@router.get("/payroll/runs")
def list_payroll_runs(
    status: Optional[str] = None,
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT pr.*,
                  u1.full_name AS approved_by_name,
                  u2.full_name AS paid_by_name,
                  (SELECT COUNT(*) FROM hr_payroll_lines l WHERE l.payroll_run_id = pr.id) AS line_count
           FROM hr_payroll_runs pr
           LEFT JOIN users u1 ON pr.approved_by = u1.id
           LEFT JOIN users u2 ON pr.paid_by     = u2.id
           WHERE pr.archived_at IS NULL"""
    params: list = []
    if status:
        q += " AND pr.status = ?"
        params.append(status)
    q += " ORDER BY pr.period_start DESC, pr.id DESC"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@router.get("/payroll/runs/{run_id}")
def get_payroll_run(
    run_id: int,
    user=Depends(require_perm("hr", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    run = db.execute(
        """SELECT pr.*, u1.full_name AS approved_by_name, u2.full_name AS paid_by_name
           FROM hr_payroll_runs pr
           LEFT JOIN users u1 ON pr.approved_by = u1.id
           LEFT JOIN users u2 ON pr.paid_by     = u2.id
           WHERE pr.id=?""",
        (run_id,),
    ).fetchone()
    if not run:
        raise HTTPException(404, "Payroll run not found")
    lines = db.execute(
        """SELECT pl.*, e.full_name AS employee_name, e.employee_code, e.job_title,
                  d.name AS department_name
           FROM hr_payroll_lines pl
           JOIN hr_employees e ON pl.employee_id = e.id
           LEFT JOIN hr_departments d ON e.department_id = d.id
           WHERE pl.payroll_run_id=?
           ORDER BY e.full_name""",
        (run_id,),
    ).fetchall()
    result = dict(run)
    result["lines"] = [dict(r) for r in lines]
    return result


@router.post("/payroll/runs")
def create_payroll_run(
    data: PayrollRunCreate,
    user=Depends(require_perm("hr", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Open a new draft run for the given period and seed one line per active
    employee, pre-filled from their current salary. Caller can then tweak each
    line's bonus / deduction before approving."""
    if data.period_end < data.period_start:
        raise HTTPException(400, "Period end cannot be before period start.")
    now = _now()
    cur = db.execute(
        """INSERT INTO hr_payroll_runs
           (period_start, period_end, status, notes, created_by, created_at)
           VALUES (?, ?, 'Draft', ?, ?, ?)""",
        (data.period_start, data.period_end, data.notes, user["id"], now),
    )
    run_id = cur.lastrowid
    settings = _payroll_settings(db)
    employees = db.execute(
        "SELECT id, salary FROM hr_employees "
        "WHERE archived_at IS NULL AND status != 'Terminated'"
    ).fetchall()
    for e in employees:
        base   = float(e["salary"] or 0)
        breakd = _compute_payroll_line(base, 0, 0, 0, settings)
        # Snapshot the salary currency from the employee's most recent ACTIVE
        # contract (F-6 audit fix). Falls back to USD if no contract row
        # exists — matches the historical default and won't surprise existing
        # all-USD installs. The currency is frozen on the line so a contract
        # change after the run was opened doesn't retroactively reinterpret it.
        contract_row = db.execute(
            "SELECT salary_currency FROM hr_contracts "
            "WHERE employee_id=? AND archived_at IS NULL AND status='Active' "
            "ORDER BY signed_at DESC, id DESC LIMIT 1",
            (e["id"],),
        ).fetchone()
        line_currency = (contract_row["salary_currency"] if contract_row else "USD") or "USD"
        db.execute(
            """INSERT INTO hr_payroll_lines
               (payroll_run_id, employee_id, base_salary, bonuses, deductions,
                overtime_hours, overtime_amount,
                gross_total, tax_amount, nssf_employee, nssf_employer,
                net_amount, salary_currency, created_at)
               VALUES (?,?,?,0,0,0,0,?,?,?,?,?,?,?)""",
            (run_id, e["id"], base,
             breakd["gross_total"], breakd["tax_amount"],
             breakd["nssf_employee"], breakd["nssf_employer"],
             breakd["net_amount"], line_currency, now),
        )
    _recompute_run_totals(db, run_id)
    log_action(db, user, "create", "hr_payroll_run", run_id,
               f"{data.period_start} → {data.period_end}",
               {"employees": len(employees)})
    db.commit()
    return {"id": run_id, "lines": len(employees), "message": "Payroll run created"}


@router.put("/payroll/lines/{line_id}")
def update_payroll_line(
    line_id: int,
    data: PayrollLineUpdate,
    user=Depends(require_perm("hr", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Tweak a single line's amounts. Disallowed once the run is Paid."""
    row = db.execute(
        """SELECT pl.*, pr.status AS run_status
           FROM hr_payroll_lines pl
           JOIN hr_payroll_runs  pr ON pr.id = pl.payroll_run_id
           WHERE pl.id=?""",
        (line_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Payroll line not found")
    if row["run_status"] in ("Paid", "Cancelled"):
        raise HTTPException(400, f"Cannot edit a {row['run_status']} run.")

    base   = float(data.base_salary if data.base_salary is not None else row["base_salary"])
    bonus  = float(data.bonuses     if data.bonuses     is not None else row["bonuses"])
    deduct = float(data.deductions  if data.deductions  is not None else row["deductions"])
    ot_hrs = float(data.overtime_hours  if data.overtime_hours  is not None else (row["overtime_hours"] or 0))

    # If the caller supplied an explicit overtime_amount, use it. Otherwise
    # derive from hours × hourly_rate × multiplier so the UX can be either
    # "just enter the dollars" or "enter hours and let the engine compute".
    if data.overtime_amount is not None:
        ot_amt = float(data.overtime_amount)
    elif ot_hrs > 0 and base > 0:
        settings_for_rate = _payroll_settings(db)
        # Approximate hourly rate: monthly base ÷ 173.33 (40h × 4.33wks).
        hourly = base / 173.33
        ot_amt = round(ot_hrs * hourly * settings_for_rate["overtime_multiplier"], 2)
    else:
        ot_amt = float(row["overtime_amount"] or 0)

    settings = _payroll_settings(db)
    breakd = _compute_payroll_line(base, bonus, deduct, ot_amt, settings)
    if breakd["net_amount"] < 0:
        raise HTTPException(400, "Net amount cannot be negative.")
    notes = data.notes if data.notes is not None else row["notes"]
    db.execute(
        """UPDATE hr_payroll_lines SET
           base_salary=?, bonuses=?, deductions=?,
           overtime_hours=?, overtime_amount=?,
           gross_total=?, tax_amount=?, nssf_employee=?, nssf_employer=?,
           net_amount=?, notes=?
           WHERE id=?""",
        (base, bonus, deduct, ot_hrs, ot_amt,
         breakd["gross_total"], breakd["tax_amount"],
         breakd["nssf_employee"], breakd["nssf_employer"],
         breakd["net_amount"], notes, line_id),
    )
    _recompute_run_totals(db, row["payroll_run_id"])
    db.commit()
    return {"net_amount": breakd["net_amount"], "breakdown": breakd, "message": "Payroll line updated"}


@router.post("/payroll/runs/{run_id}/approve")
def approve_payroll_run(
    run_id: int,
    user=Depends(require_perm("hr", "approve")),
    db: sqlite3.Connection = Depends(get_db),
):
    run = db.execute(
        "SELECT * FROM hr_payroll_runs WHERE id=? AND archived_at IS NULL", (run_id,)
    ).fetchone()
    if not run:
        raise HTTPException(404, "Payroll run not found")
    if run["status"] != "Draft":
        raise HTTPException(400, f"Only Draft runs can be approved (currently {run['status']}).")
    line_count = db.execute(
        "SELECT COUNT(*) FROM hr_payroll_lines WHERE payroll_run_id=?", (run_id,)
    ).fetchone()[0]
    if line_count == 0:
        raise HTTPException(400, "Cannot approve an empty payroll run.")
    db.execute(
        "UPDATE hr_payroll_runs SET status='Approved', approved_at=?, approved_by=? WHERE id=?",
        (_now(), user["id"], run_id),
    )
    log_action(db, user, "approve", "hr_payroll_run", run_id,
               f"{run['period_start']} → {run['period_end']}")

    # Global, module-gated alert — HR users see it, sales reps don't (NOTIFICATION_
    # TYPE_MODULE maps `payroll_approved` to `hr`). Cues the next step (mark-paid).
    notify(
        db, type="payroll_approved",
        title=f"Payroll run approved — {run['period_start']} → {run['period_end']}",
        body=f"{line_count} employee{'s' if line_count != 1 else ''} · ready to mark paid.",
        link="/hr", entity_type="hr_payroll_run", entity_id=run_id,
    )

    db.commit()
    return {"message": "Payroll run approved"}


@router.post("/payroll/runs/{run_id}/mark-paid")
def mark_payroll_run_paid(
    run_id: int,
    user=Depends(require_perm("hr", "approve")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Finalise a run: posts ONE row to Finance's expenses table for the net
    total, links it back via posted_expense_id, and stamps every line as paid.
    Idempotent — re-running on an already-Paid run returns the same expense."""
    run = db.execute(
        "SELECT * FROM hr_payroll_runs WHERE id=? AND archived_at IS NULL", (run_id,)
    ).fetchone()
    if not run:
        raise HTTPException(404, "Payroll run not found")
    if run["status"] == "Paid":
        return {"message": "Already paid", "expense_id": run["posted_expense_id"]}
    if run["status"] != "Approved":
        raise HTTPException(
            400,
            f"Only Approved runs can be marked paid (currently {run['status']}).",
        )
    if float(run["total_net"] or 0) <= 0:
        raise HTTPException(400, "Cannot post a zero-net payroll run as an expense.")
    # The payroll expense is dated to the run's period end — block posting it
    # into a locked month or a closed financial year.
    from routers.finance import _check_period_locked
    _check_period_locked(db, run["period_end"])

    now = _now()
    line_count = db.execute(
        "SELECT COUNT(*) FROM hr_payroll_lines WHERE payroll_run_id=?", (run_id,)
    ).fetchone()[0]
    desc = (f"Payroll {run['period_start']} → {run['period_end']} "
            f"({line_count} employee{'s' if line_count != 1 else ''})")

    # ── Currency-aware payroll posting (F-6 audit fix) ─────────────────────
    # Group the run's net amounts by the line's `salary_currency`. Non-USD
    # totals are translated to USD at the latest spot rate so the expense and
    # GL entry post in the functional currency. If an LBP line exists but no
    # exchange rate has been entered yet, refuse to post — we must NOT silently
    # treat LBP face value as USD (that would inflate Salaries 89,000×).
    by_ccy = db.execute(
        "SELECT COALESCE(NULLIF(salary_currency,''),'USD') AS ccy, "
        "       COALESCE(SUM(net_amount),0) AS net "
        "FROM hr_payroll_lines WHERE payroll_run_id=? "
        "GROUP BY ccy",
        (run_id,),
    ).fetchall()
    rate_row = db.execute(
        "SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1"
    ).fetchone()
    spot = float(rate_row["rate"]) if rate_row and rate_row["rate"] else None
    total_usd = 0.0
    gl_lines  = []        # one DR Salaries line per currency segment
    cash_lines = []       # the matching CR Cash / Cash—LBP lines
    for row in by_ccy:
        ccy = (row["ccy"] or "USD").upper()
        amt = float(row["net"] or 0)
        if amt <= 0:
            continue
        if ccy == "USD":
            amt_usd = round(amt, 2)
        elif ccy == "LBP":
            if not spot or spot <= 0:
                raise HTTPException(
                    400,
                    "Cannot post payroll: this run contains LBP-denominated "
                    "lines but no exchange rate is configured. Set the LBP→USD "
                    "rate in Settings → Exchange Rate, then retry.",
                )
            amt_usd = round(amt / spot, 2)
        else:
            raise HTTPException(
                400, f"Unsupported salary currency {ccy!r} on this payroll run."
            )
        total_usd += amt_usd
        gl_lines.append({
            "code": accounting.SALARIES, "debit": amt_usd,
            "memo": f"{ccy} {amt:,.2f}" + (f" @ {spot:,.0f}" if ccy != "USD" else ""),
        })
        cash_lines.append({
            "code": accounting.cash_account_for(ccy), "credit": amt_usd,
        })
    total_usd = round(total_usd, 2)
    if total_usd <= 0:
        raise HTTPException(400, "Cannot post a zero-net payroll run as an expense.")

    exp_cur = db.execute(
        "INSERT INTO expenses (category, description, amount, date, created_at) "
        "VALUES ('Payroll', ?, ?, ?, ?)",
        (desc, total_usd, run["period_end"], now),
    )
    expense_id = exp_cur.lastrowid
    db.execute(
        "UPDATE hr_payroll_runs SET status='Paid', paid_at=?, paid_by=?, "
        "posted_expense_id=? WHERE id=?",
        (now, user["id"], expense_id, run_id),
    )
    # Auto-post to the general ledger. Debits and credits stay split by
    # currency so the cash account (1000 vs 1010) reflects where the money
    # physically left from.
    accounting.post_entry(
        db,
        entry_date=run["period_end"][:10],
        memo=desc,
        lines=gl_lines + cash_lines,
        source_type="payroll", source_id=run_id, created_by=user["id"],
    )
    log_action(db, user, "mark_paid", "hr_payroll_run", run_id, desc,
               {"expense_id": expense_id, "amount": total_usd,
                "currencies": [{"ccy": r["ccy"], "net": float(r["net"])} for r in by_ccy]})

    # Notify each paid employee personally (if their employee row is linked to a
    # user account) so they see their payslip moved to "Paid". HR managers get
    # the global cue too, via the unlinked-recipient row below.
    paid_lines = db.execute(
        """SELECT pl.net_amount, pl.salary_currency, e.user_id, e.full_name
           FROM hr_payroll_lines pl
           JOIN hr_employees e ON e.id = pl.employee_id
           WHERE pl.payroll_run_id=?""",
        (run_id,),
    ).fetchall()
    for line in paid_lines:
        if not line["user_id"]:
            continue
        notify(
            db, user_id=line["user_id"], type="payroll_paid",
            title="You have been paid",
            body=f"{run['period_start']} → {run['period_end']} · "
                 f"{float(line['net_amount']):,.2f} {line['salary_currency'] or 'USD'}",
            link="/hr",
            entity_type="hr_payroll_run", entity_id=run_id,
        )
    # Global HR-gated alert (manager view).
    notify(
        db, type="payroll_paid",
        title=f"Payroll paid — {run['period_start']} → {run['period_end']}",
        body=f"${total_usd:,.2f} disbursed across {len(paid_lines)} "
             f"employee{'s' if len(paid_lines) != 1 else ''}.",
        link="/hr", entity_type="hr_payroll_run", entity_id=run_id,
    )

    db.commit()
    return {
        "message":    "Payroll run paid and posted to Finance",
        "expense_id": expense_id,
        "amount":     total_usd,
    }


@router.post("/payroll/runs/{run_id}/cancel")
def cancel_payroll_run(
    run_id: int,
    user=Depends(require_perm("hr", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Cancel a Draft/Approved run. Paid runs cannot be cancelled — their
    posted expense is real money out the door; reverse it via Finance instead."""
    run = db.execute(
        "SELECT * FROM hr_payroll_runs WHERE id=? AND archived_at IS NULL", (run_id,)
    ).fetchone()
    if not run:
        raise HTTPException(404, "Payroll run not found")
    if run["status"] == "Paid":
        raise HTTPException(
            400,
            "Paid payroll runs cannot be cancelled — reverse the linked "
            "expense in Finance to undo.",
        )
    if run["status"] == "Cancelled":
        raise HTTPException(400, "Already cancelled.")
    db.execute(
        "UPDATE hr_payroll_runs SET status='Cancelled', archived_at=? WHERE id=?",
        (_now(), run_id),
    )
    log_action(db, user, "cancel", "hr_payroll_run", run_id,
               f"{run['period_start']} → {run['period_end']}")
    db.commit()
    return {"message": "Payroll run cancelled"}
