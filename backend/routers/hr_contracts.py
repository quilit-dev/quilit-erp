"""
HR Contracts — formal employment contracts (separate from the contract PDF
attachment on an employee record).

Storage is structured (salary, type, dates, benefits, schedule) so a printable
PDF can be rendered server-side from a template — the PDF endpoint returns the
HTML payload + company branding so the frontend's existing print/PDF pipeline
can render it consistently with quotations & invoices.

Lifecycle: Draft → Active → Expired / Terminated.
A contract becoming Active updates the employee's salary and adds a row to
hr_employment_changes — keeping the salary timeline complete without manual
double-entry.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()

CONTRACT_TYPES   = {"Permanent", "Fixed-term", "Probation", "Internship", "Consultant"}
CONTRACT_STATUS  = {"Draft", "Active", "Expired", "Terminated"}


class ContractBody(BaseModel):
    employee_id:        int
    contract_type:      str           = "Permanent"
    status:             str           = "Draft"
    start_date:         str
    end_date:           Optional[str] = None
    probation_end_date: Optional[str] = None
    job_title:          Optional[str] = None
    work_schedule:      Optional[str] = None
    weekly_hours:       Optional[float] = None
    salary:             float         = 0
    salary_currency:    Optional[str] = "USD"
    benefits:           Optional[str] = None
    terms:              Optional[str] = None
    contract_number:    Optional[str] = None

    @validator("contract_type")
    def _valid_type(cls, v):
        if v not in CONTRACT_TYPES:
            raise ValueError(f"Invalid contract_type. Must be one of: {', '.join(sorted(CONTRACT_TYPES))}")
        return v

    @validator("status")
    def _valid_status(cls, v):
        if v not in CONTRACT_STATUS:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(CONTRACT_STATUS))}")
        return v

    @validator("salary")
    def _salary_non_negative(cls, v):
        if v is None or v < 0:
            raise ValueError("Salary cannot be negative")
        return v


class StatusBody(BaseModel):
    status: str
    reason: Optional[str] = None       # required when terminating

    @validator("status")
    def _valid_status(cls, v):
        if v not in CONTRACT_STATUS:
            raise ValueError(f"Invalid status. Must be one of: {', '.join(sorted(CONTRACT_STATUS))}")
        return v


def _next_contract_number(db: sqlite3.Connection) -> str:
    row = db.execute("SELECT value FROM settings WHERE key='contract_prefix'").fetchone()
    prefix = (row["value"] if row and row["value"] else "CTR-")
    mx = db.execute("SELECT COALESCE(MAX(id), 0) AS m FROM hr_contracts").fetchone()
    year = _now()[:4]
    return f"{prefix}{year}-{mx['m'] + 1:04d}"


@router.get("/")
def list_contracts(
    employee_id: Optional[int] = None,
    status:      Optional[str] = None,
    user=Depends(require_perm("hr_contracts", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = """SELECT c.*, e.full_name AS employee_name, e.employee_code,
                  d.name AS department_name
           FROM hr_contracts c
           JOIN hr_employees e ON c.employee_id = e.id
           LEFT JOIN hr_departments d ON e.department_id = d.id
           WHERE c.archived_at IS NULL"""
    params: list = []
    if employee_id:
        q += " AND c.employee_id = ?"; params.append(employee_id)
    if status:
        q += " AND c.status = ?"; params.append(status)
    q += " ORDER BY c.start_date DESC, c.id DESC"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@router.get("/{contract_id}")
def get_contract(
    contract_id: int,
    user=Depends(require_perm("hr_contracts", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT c.*, e.full_name AS employee_name, e.employee_code, e.email AS employee_email,
                  e.phone AS employee_phone, e.address AS employee_address,
                  d.name AS department_name, m.full_name AS manager_name,
                  u.full_name AS created_by_name
           FROM hr_contracts c
           JOIN hr_employees e ON c.employee_id = e.id
           LEFT JOIN hr_departments d ON e.department_id = d.id
           LEFT JOIN hr_employees   m ON e.manager_id    = m.id
           LEFT JOIN users u          ON c.created_by    = u.id
           WHERE c.id=?""",
        (contract_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Contract not found")
    return dict(row)


@router.post("/")
def create_contract(
    data: ContractBody,
    user=Depends(require_perm("hr_contracts", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    emp = db.execute(
        "SELECT id, full_name FROM hr_employees WHERE id=? AND archived_at IS NULL",
        (data.employee_id,),
    ).fetchone()
    if not emp:
        raise HTTPException(400, "Employee not found.")

    contract_number = (data.contract_number or "").strip() or _next_contract_number(db)
    cur = db.execute(
        """INSERT INTO hr_contracts
           (employee_id, contract_number, contract_type, status, start_date, end_date,
            probation_end_date, job_title, work_schedule, weekly_hours, salary,
            salary_currency, benefits, terms, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.employee_id, contract_number, data.contract_type, data.status,
         data.start_date, data.end_date, data.probation_end_date,
         data.job_title, data.work_schedule, data.weekly_hours,
         data.salary, data.salary_currency or "USD",
         data.benefits, data.terms, user["id"], _now()),
    )
    contract_id = cur.lastrowid
    log_action(db, user, "create", "hr_contract", contract_id,
               f"{emp['full_name']} — {data.contract_type}",
               {"salary": data.salary})
    db.commit()
    return {"id": contract_id, "contract_number": contract_number,
            "message": "Contract created"}


@router.put("/{contract_id}")
def update_contract(
    contract_id: int,
    data: ContractBody,
    user=Depends(require_perm("hr_contracts", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    existing = db.execute(
        "SELECT * FROM hr_contracts WHERE id=? AND archived_at IS NULL", (contract_id,),
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Contract not found")
    if existing["status"] in ("Active", "Expired", "Terminated") and existing["employee_id"] != data.employee_id:
        raise HTTPException(400, "Cannot reassign a non-draft contract to a different employee.")
    db.execute(
        """UPDATE hr_contracts SET
           contract_type=?, start_date=?, end_date=?, probation_end_date=?,
           job_title=?, work_schedule=?, weekly_hours=?, salary=?, salary_currency=?,
           benefits=?, terms=?
           WHERE id=?""",
        (data.contract_type, data.start_date, data.end_date, data.probation_end_date,
         data.job_title, data.work_schedule, data.weekly_hours,
         data.salary, data.salary_currency or "USD",
         data.benefits, data.terms, contract_id),
    )
    log_action(db, user, "update", "hr_contract", contract_id,
               existing["contract_number"] or f"#{contract_id}")
    db.commit()
    return {"message": "Contract updated"}


@router.post("/{contract_id}/status")
def change_contract_status(
    contract_id: int,
    body: StatusBody,
    user=Depends(require_perm("hr_contracts", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Transition the contract. Activating syncs the employee's current salary
    and appends a row to hr_employment_changes so the salary timeline stays
    consistent without a separate employee edit."""
    contract = db.execute(
        """SELECT c.*, e.salary AS emp_salary, e.job_title AS emp_title,
                  e.department_id AS emp_dept, e.manager_id AS emp_mgr,
                  e.full_name AS employee_name
           FROM hr_contracts c JOIN hr_employees e ON c.employee_id = e.id
           WHERE c.id=? AND c.archived_at IS NULL""",
        (contract_id,),
    ).fetchone()
    if not contract:
        raise HTTPException(404, "Contract not found")
    old_status = contract["status"]
    if old_status == body.status:
        return {"message": f"Already {body.status}", "status": body.status}

    now = _now()
    if body.status == "Active":
        db.execute(
            "UPDATE hr_contracts SET status='Active', signed_at=? WHERE id=?",
            (now, contract_id),
        )
        # Sync the employee's current salary + job_title to the new contract
        # and write one row in the salary timeline so history reads correctly.
        new_salary = float(contract["salary"] or 0)
        new_title  = contract["job_title"] or contract["emp_title"]
        if abs(new_salary - float(contract["emp_salary"] or 0)) > 0.005 or (new_title != contract["emp_title"]):
            db.execute(
                "UPDATE hr_employees SET salary=?, job_title=? WHERE id=?",
                (new_salary, new_title, contract["employee_id"]),
            )
            db.execute(
                """INSERT INTO hr_employment_changes
                   (employee_id, effective_date, change_type,
                    old_salary, new_salary, old_title, new_title,
                    old_department_id, new_department_id,
                    old_manager_id, new_manager_id,
                    reason, created_by, created_at)
                   VALUES (?, ?, 'adjustment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (contract["employee_id"], contract["start_date"] or now[:10],
                 contract["emp_salary"], new_salary,
                 contract["emp_title"], new_title,
                 contract["emp_dept"], contract["emp_dept"],
                 contract["emp_mgr"],  contract["emp_mgr"],
                 f"Contract {contract['contract_number'] or contract_id} activated",
                 user["id"], now),
            )
    elif body.status == "Terminated":
        db.execute(
            "UPDATE hr_contracts SET status='Terminated', terminated_at=?, terminated_reason=? "
            "WHERE id=?",
            (now, body.reason or "Terminated", contract_id),
        )
    elif body.status == "Expired":
        db.execute("UPDATE hr_contracts SET status='Expired' WHERE id=?", (contract_id,))
    elif body.status == "Draft":
        # Allow reverting to Draft only from Draft (no-op) — protect history.
        raise HTTPException(400, "Cannot move a non-draft contract back to Draft.")

    log_action(db, user, f"status:{body.status}", "hr_contract", contract_id,
               contract["contract_number"] or f"#{contract_id}",
               {"reason": body.reason} if body.reason else None)
    db.commit()
    return {"message": f"Contract {body.status.lower()}", "status": body.status}


@router.patch("/{contract_id}/archive")
def archive_contract(
    contract_id: int,
    user=Depends(require_perm("hr_contracts", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT contract_number FROM hr_contracts WHERE id=? AND archived_at IS NULL",
        (contract_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Contract not found")
    db.execute("UPDATE hr_contracts SET archived_at=? WHERE id=?", (_now(), contract_id))
    log_action(db, user, "archive", "hr_contract", contract_id, row["contract_number"] or f"#{contract_id}")
    db.commit()
    return {"message": "Contract archived"}


# ── Printable contract payload ─────────────────────────────────────────────
# The frontend's existing print-pipeline (used by quotations & invoices) renders
# an HTML document and triggers the browser's print dialog. This endpoint
# returns the structured contract + company settings so the SPA can build the
# HTML on the client. Keeping rendering on the client matches the rest of the
# ERP and avoids adding a backend PDF dependency (ReportLab).
@router.get("/{contract_id}/print-data")
def contract_print_data(
    contract_id: int,
    user=Depends(require_perm("hr_contracts", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    contract = get_contract(contract_id, user=user, db=db)
    # Pull a small set of company-branding settings — title block on the PDF
    # should match what already appears on quotations/invoices.
    keys = ("company_name", "company_address", "company_phone", "company_email",
            "company_tax_id", "company_logo_url",
            "currency", "date_format")
    company = {}
    for k in keys:
        row = db.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
        company[k] = row["value"] if row else None
    return {"contract": contract, "company": company}
