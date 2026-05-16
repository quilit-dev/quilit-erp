from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()

VALID_STATUSES = ["Inquiry", "Quotation Sent", "Approved", "In Progress", "Completed", "Invoiced", "Cancelled"]

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

class CancelRequest(BaseModel):
    reason: Optional[str] = None

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

@router.get("/")
def list_projects(search: Optional[str] = None, status: Optional[str] = None,
                  user=Depends(require_perm("projects", "view")), db: sqlite3.Connection = Depends(get_db)):
    query = """SELECT p.*, c.name as client_name,
               (p.expected_revenue - p.estimated_cost) as profit,
               q.quote_number as source_quote_number
               FROM projects p
               LEFT JOIN clients c ON p.client_id = c.id
               LEFT JOIN quotations q ON p.source_quotation_id = q.id
               WHERE p.archived_at IS NULL"""
    params = []
    if search:
        query += " AND (p.name LIKE ? OR p.location LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s])
    if status:
        query += " AND p.status = ?"
        params.append(status)
    query += " ORDER BY p.created_at DESC"
    rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]

@router.get("/{project_id}")
def get_project(project_id: int, user=Depends(require_perm("projects", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute(
        """SELECT p.*, c.name AS client_name,
           (p.expected_revenue - p.estimated_cost) AS profit,
           q.quote_number AS source_quote_number
           FROM projects p
           LEFT JOIN clients c ON p.client_id = c.id
           LEFT JOIN quotations q ON p.source_quotation_id = q.id
           WHERE p.id = ? AND p.archived_at IS NULL""",
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
                  COALESCE(SUM(ip.amount), 0) AS paid_amount,
                  CASE
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

    total_invoiced = sum(i["amount"] or 0 for i in invoices)
    total_paid     = sum(i["paid_amount"] or 0 for i in invoices)
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
    return result

@router.post("/")
def create_project(data: ProjectCreate, user=Depends(require_perm("projects", "create")), db: sqlite3.Connection = Depends(get_db)):
    now = _now()
    c = db.execute(
        """INSERT INTO projects (name, client_id, location, status, start_date, end_date,
           estimated_cost, actual_cost, expected_revenue, description, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (data.name, data.client_id, data.location, data.status, data.start_date,
         data.end_date, data.estimated_cost, data.actual_cost, data.expected_revenue, data.description, now)
    )
    log_action(db, user, "create", "project", c.lastrowid, data.name)
    db.commit()
    return {"id": c.lastrowid, "message": "Project created"}

@router.put("/{project_id}")
def update_project(project_id: int, data: ProjectCreate, user=Depends(require_perm("projects", "edit")), db: sqlite3.Connection = Depends(get_db)):
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
    if status not in VALID_STATUSES:
        raise HTTPException(400, f"Invalid status '{status}'. Must be one of: {VALID_STATUSES}")
    proj = db.execute("SELECT name FROM projects WHERE id = ?", (project_id,)).fetchone()
    db.execute("UPDATE projects SET status = ? WHERE id = ?", (status, project_id))
    log_action(db, user, "status_change", "project", project_id,
               proj["name"] if proj else "", {"status": status})
    db.commit()
    return {"message": "Status updated"}

@router.patch("/{project_id}/cancel")
def cancel_project(project_id: int, data: CancelRequest = CancelRequest(),
                   user=Depends(require_perm("projects", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM projects WHERE id = ? AND archived_at IS NULL", (project_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Project not found")
    if row["status"] == "Cancelled":
        raise HTTPException(400, "Project is already cancelled.")
    db.execute(
        "UPDATE projects SET status='Cancelled', archive_reason=? WHERE id=?",
        (data.reason or "Cancelled", project_id)
    )
    log_action(db, user, "cancel", "project", project_id, row["name"], {"reason": data.reason})
    db.commit()
    return {"message": "Project cancelled"}

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
