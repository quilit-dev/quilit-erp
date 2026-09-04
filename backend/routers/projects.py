from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import costs
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from approval_engine import evaluate_and_apply
from utils import _now, ArchiveMode, archive_clause
import sqlite3

router = APIRouter()

VALID_STATUSES = ["Inquiry", "Quotation Sent", "Approved", "In Progress", "Completed", "Invoiced", "Cancelled"]

# Forward-only progression so a project's status auto-advances as commercial
# milestones happen (quotation sent → invoiced) without ever regressing —
# editing an old quotation on an already-Invoiced project must NOT drag it
# back to "Quotation Sent". Cancelled projects are terminal and never
# auto-advance. Anything off the ladder (custom status, blank) is treated as
# rank 0 so the bump still takes effect.
_PROJECT_STATUS_RANK = {
    "Inquiry":         0,
    "Quotation Sent":  1,
    "Approved":        2,
    "In Progress":     3,
    "Completed":       4,
    "Invoiced":        5,
}


def bump_project_status(db: sqlite3.Connection, project_id, new_status: str) -> None:
    """Advance a project to `new_status` iff it's strictly forward of the
    current status. Idempotent, silently no-ops on None / missing project /
    archived / cancelled. Caller commits."""
    if project_id is None:
        return
    if new_status not in _PROJECT_STATUS_RANK:
        return
    row = db.execute(
        "SELECT status FROM projects WHERE id=? AND archived_at IS NULL",
        (project_id,),
    ).fetchone()
    if not row:
        return
    current = row["status"] or "Inquiry"
    if current in ("Cancelled", "Voided"):
        return
    if _PROJECT_STATUS_RANK.get(new_status, 0) > _PROJECT_STATUS_RANK.get(current, 0):
        db.execute("UPDATE projects SET status=? WHERE id=?", (new_status, project_id))

class ProjectCreate(BaseModel):
    name: str
    client_id: Optional[int] = None
    location: Optional[str] = None
    status: Optional[str] = "Inquiry"
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    estimated_cost: Optional[float] = 0
    actual_cost: Optional[float] = 0
    expected_revenue: Optional[float] = 0
    description: Optional[str] = None

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

@router.get("/")
def list_projects(search: Optional[str] = None, status: Optional[str] = None,
                  archived: ArchiveMode = "exclude",
                  user=Depends(require_perm("projects", "view")), db: sqlite3.Connection = Depends(get_db)):
    query = """SELECT p.*, c.name as client_name,
               (p.expected_revenue - p.estimated_cost) as profit,
               q.quote_number as source_quote_number
               FROM projects p
               LEFT JOIN clients c ON p.client_id = c.id
               LEFT JOIN quotations q ON p.source_quotation_id = q.id
               WHERE 1=1"""
    params = []
    query += f" AND {archive_clause(archived, 'p.archived_at')}"
    if search:
        query += " AND (p.name LIKE ? OR p.location LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s])
    if status:
        query += " AND p.status = ?"
        params.append(status)
    query += " ORDER BY p.created_at DESC"
    rows = db.execute(query, params).fetchall()
    # A project states what it cost to run. Same rule as stock: the columns
    # ride along in the JSON whether or not a screen draws them.
    return costs.strip([dict(r) for r in rows], user, db,
                       extra=costs.PROJECT_DERIVED)

@router.get("/{project_id}")
def get_project(project_id: int, user=Depends(require_perm("projects", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute(
        """SELECT p.*, c.name AS client_name,
           (p.expected_revenue - p.estimated_cost) AS profit,
           q.quote_number AS source_quote_number
           FROM projects p
           LEFT JOIN clients c ON p.client_id = c.id
           LEFT JOIN quotations q ON p.source_quotation_id = q.id
           WHERE p.id = ?""",
        (project_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Project not found")

    expenses = db.execute(
        """SELECT id, category, description, amount, date, created_at, voided_at, void_reason
           FROM expenses WHERE project_id = ? AND archived_at IS NULL ORDER BY date DESC""",
        (project_id,)
    ).fetchall()

    invoices = db.execute(
        """SELECT i.id, i.invoice_number, i.amount, i.due_date, i.created_at,
                  i.voided_at,
                  COALESCE(SUM(ip.amount), 0) AS paid_amount,
                  CASE
                    WHEN i.voided_at IS NOT NULL THEN 'Void'
                    WHEN COALESCE(SUM(ip.amount), 0) = 0 THEN 'Unpaid'
                    WHEN COALESCE(SUM(ip.amount), 0) >= i.amount THEN 'Paid'
                    ELSE 'Partial'
                  END AS status
           FROM invoices i
           LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
           WHERE i.project_id = ? AND i.archived_at IS NULL
           GROUP BY i.id ORDER BY i.created_at DESC""",
        (project_id,)
    ).fetchall()

    quotations = db.execute(
        """SELECT id, quote_number, status, total, created_at
           FROM quotations WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC""",
        (project_id,)
    ).fetchall()

    # Documents attached to this project
    documents = db.execute(
        """SELECT id, record_type, record_id, title, created_at
           FROM documents WHERE project_id = ? ORDER BY created_at DESC""",
        (project_id,)
    ).fetchall()

    # Voided invoices stay in the list, labelled, but out of the figures — the
    # same rule the client profile follows. A cancelled invoice must not make a
    # project look billed.
    live_invoices  = [i for i in invoices if not i["voided_at"]]
    total_invoiced = sum(i["amount"] or 0 for i in live_invoices)
    total_paid     = sum(i["paid_amount"] or 0 for i in live_invoices)
    total_expenses = sum(e["amount"] or 0 for e in expenses if not e["voided_at"])
    total_quoted   = sum(q["total"] or 0 for q in quotations)
    estimated      = dict(row).get("estimated_cost") or 0
    expected_rev   = dict(row).get("expected_revenue") or 0

    result = dict(row)
    result["expenses"]   = [dict(e) for e in expenses]
    result["invoices"]   = [dict(i) for i in invoices]
    result["quotations"] = [dict(q) for q in quotations]
    result["documents"]  = [dict(d) for d in documents]
    result["stats"] = {
        "total_quoted":       total_quoted,
        "total_invoiced":     total_invoiced,
        "total_paid":         total_paid,
        "outstanding":        total_invoiced - total_paid,
        "total_expenses":     total_expenses,
        "budget_remaining":   estimated - total_expenses,
        "expected_profit":    expected_rev - estimated,
        "margin_pct":         round((expected_rev - estimated) / expected_rev * 100, 1) if expected_rev > 0 else 0,
    }
    # The derived figures go with the raw ones. `expected_profit` beside
    # `expected_revenue` states the budget by subtraction, so hiding only
    # `estimated_cost` would hide the column and not the number.
    return costs.strip(result, user, db, extra=costs.PROJECT_DERIVED)

@router.post("/")
def create_project(data: ProjectCreate, user=Depends(require_perm("projects", "create")), db: sqlite3.Connection = Depends(get_db)):
    # Validate the client relation up front so a stale id returns a clean 400
    # instead of an unhandled FOREIGN KEY IntegrityError (HTTP 500).
    if data.client_id is not None and not db.execute(
        "SELECT 1 FROM clients WHERE id=?", (data.client_id,)
    ).fetchone():
        raise HTTPException(400, "Client not found")
    now = _now()
    c = db.execute(
        """INSERT INTO projects (name, client_id, location, status, start_date, end_date,
           estimated_cost, actual_cost, expected_revenue, description, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (data.name, data.client_id, data.location, data.status, data.start_date,
         data.end_date, data.estimated_cost, data.actual_cost, data.expected_revenue, data.description, now)
    )
    project_id = c.lastrowid

    # An active policy can gate a new project behind approval. The snapshot keeps
    # the requested status so an approval can release the project back to it.
    entity_data = {
        "estimated_cost":   float(data.estimated_cost or 0),
        "expected_revenue": float(data.expected_revenue or 0),
        "status":           data.status,
    }
    needs_approval = evaluate_and_apply(
        db, module="project", action="create",
        entity_data=entity_data, user_id=user["id"],
        entity_id=project_id, entity_label=data.name,
    )
    if needs_approval:
        db.execute("UPDATE projects SET status='Pending Approval' WHERE id=?", (project_id,))

    log_action(db, user, "create", "project", project_id, data.name)
    db.commit()
    return {
        "id": project_id,
        "pending_approval": bool(needs_approval),
        "message": "Project pending approval" if needs_approval else "Project created",
    }

@router.put("/{project_id}")
def update_project(project_id: int, data: ProjectCreate, user=Depends(require_perm("projects", "edit")), db: sqlite3.Connection = Depends(get_db)):
    existing = db.execute("SELECT status FROM projects WHERE id=?", (project_id,)).fetchone()
    if not existing:
        raise HTTPException(404, "Project not found")
    # Terminal projects — legacy 'Voided' rows, or 'Cancelled' set when an
    # approval is rejected — are read-only, and these terminal statuses can never
    # be entered through a plain edit.
    if existing["status"] in ("Voided", "Cancelled"):
        raise HTTPException(400, "This project is closed and cannot be edited.")
    if data.status in ("Voided", "Cancelled"):
        raise HTTPException(400, "Projects cannot be set to a terminal status manually.")
    db.execute(
        """UPDATE projects SET name=?, client_id=?, location=?, status=?, start_date=?,
           end_date=?, estimated_cost=?, actual_cost=?, expected_revenue=?, description=? WHERE id=?""",
        (data.name, data.client_id, data.location, data.status, data.start_date,
         data.end_date, data.estimated_cost, data.actual_cost, data.expected_revenue, data.description, project_id)
    )
    log_action(db, user, "update", "project", project_id, data.name)
    db.commit()
    return {"message": "Project updated"}

@router.patch("/{project_id}/status")
def update_status(project_id: int, status: str, user=Depends(require_perm("projects", "edit")), db: sqlite3.Connection = Depends(get_db)):
    if status not in VALID_STATUSES or status in ("Voided", "Cancelled"):
        raise HTTPException(400, f"Invalid status '{status}'.")
    proj = db.execute("SELECT name, status FROM projects WHERE id = ?", (project_id,)).fetchone()
    if proj and proj["status"] in ("Voided", "Cancelled"):
        raise HTTPException(400, "This project is closed and cannot change status.")
    db.execute("UPDATE projects SET status = ? WHERE id = ?", (status, project_id))
    log_action(db, user, "status_change", "project", project_id,
               proj["name"] if proj else "", {"status": status})
    db.commit()
    return {"message": "Status updated"}

@router.patch("/{project_id}/archive")
def archive_project(project_id: int, data: ArchiveRequest = ArchiveRequest(),
                    user=Depends(require_perm("projects", "delete")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM projects WHERE id = ? AND archived_at IS NULL", (project_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Project not found")
    now = _now()
    db.execute(
        "UPDATE projects SET archived_at=?, archive_reason=? WHERE id=?",
        (now, data.reason or "Archived", project_id)
    )
    log_action(db, user, "archive", "project", project_id, row["name"], {"reason": data.reason})
    db.commit()
    return {"message": "Project archived"}

@router.patch("/{project_id}/unarchive")
def unarchive_project(project_id: int, user=Depends(require_perm("projects", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM projects WHERE id = ? AND archived_at IS NOT NULL", (project_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Project not found in archives")
    db.execute("UPDATE projects SET archived_at=NULL, archive_reason=NULL WHERE id=?", (project_id,))
    log_action(db, user, "unarchive", "project", project_id, row["name"])
    db.commit()
    return {"message": "Project restored from archive"}
