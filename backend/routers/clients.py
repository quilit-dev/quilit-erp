from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()

class ClientCreate(BaseModel):
    name: str
    company: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    type: Optional[str] = "private"
    notes: Optional[str] = None

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

@router.get("/")
def list_clients(search: Optional[str] = None, type: Optional[str] = None,
                 user=Depends(require_perm("clients", "view")), db: sqlite3.Connection = Depends(get_db)):
    query = "SELECT * FROM clients WHERE archived_at IS NULL"
    params = []
    if search:
        query += " AND (name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s, s, s])
    if type:
        query += " AND type = ?"
        params.append(type)
    query += " ORDER BY created_at DESC"
    rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]

@router.get("/{client_id}")
def get_client(client_id: int, user=Depends(require_perm("clients", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM clients WHERE id = ? AND archived_at IS NULL", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found")

    projects = db.execute(
        """SELECT id, name, status, estimated_cost, actual_cost, start_date, end_date, location
           FROM projects WHERE client_id = ? AND archived_at IS NULL ORDER BY created_at DESC""",
        (client_id,)
    ).fetchall()

    quotations = db.execute(
        """SELECT q.id, q.quote_number, q.status, q.total, q.created_at, q.project_id,
                  p.name AS project_name
           FROM quotations q
           LEFT JOIN projects p ON p.id = q.project_id
           WHERE q.client_id = ? AND q.archived_at IS NULL ORDER BY q.created_at DESC""",
        (client_id,)
    ).fetchall()

    invoices = db.execute(
        """SELECT i.id, i.invoice_number, i.amount, i.due_date, i.created_at, i.project_id,
                  p.name AS project_name,
                  COALESCE(SUM(ip.amount), 0) AS paid_amount,
                  CASE
                    WHEN COALESCE(SUM(ip.amount), 0) = 0 THEN 'Unpaid'
                    WHEN COALESCE(SUM(ip.amount), 0) >= i.amount THEN 'Paid'
                    ELSE 'Partial'
                  END AS status
           FROM invoices i
           LEFT JOIN projects p ON p.id = i.project_id
           LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
           WHERE i.client_id = ? AND i.archived_at IS NULL
           GROUP BY i.id ORDER BY i.created_at DESC""",
        (client_id,)
    ).fetchall()

    # Documents attached to this client
    documents = db.execute(
        """SELECT id, record_type, record_id, title, created_at
           FROM documents WHERE client_id = ? ORDER BY created_at DESC""",
        (client_id,)
    ).fetchall()

    total_invoiced = sum(i["amount"] or 0 for i in invoices)
    total_paid     = sum(i["paid_amount"] or 0 for i in invoices)
    total_quoted   = sum(q["total"] or 0 for q in quotations)

    result = dict(row)
    result["projects"]   = [dict(p) for p in projects]
    result["quotations"] = [dict(q) for q in quotations]
    result["invoices"]   = [dict(i) for i in invoices]
    result["documents"]  = [dict(d) for d in documents]
    result["stats"] = {
        "project_count":   len(projects),
        "quotation_count": len(quotations),
        "invoice_count":   len(invoices),
        "total_quoted":    total_quoted,
        "total_invoiced":  total_invoiced,
        "total_paid":      total_paid,
        "outstanding":     total_invoiced - total_paid,
    }
    return result

@router.post("/")
def create_client(data: ClientCreate, user=Depends(require_perm("clients", "create")), db: sqlite3.Connection = Depends(get_db)):
    now = _now()
    c = db.execute(
        "INSERT INTO clients (name, company, phone, email, address, type, notes, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (data.name, data.company, data.phone, data.email, data.address, data.type, data.notes, now)
    )
    log_action(db, user, "create", "client", c.lastrowid, data.name)
    db.commit()
    return {"id": c.lastrowid, "message": "Client created"}

@router.put("/{client_id}")
def update_client(client_id: int, data: ClientCreate, user=Depends(require_perm("clients", "edit")), db: sqlite3.Connection = Depends(get_db)):
    db.execute(
        "UPDATE clients SET name=?, company=?, phone=?, email=?, address=?, type=?, notes=? WHERE id=?",
        (data.name, data.company, data.phone, data.email, data.address, data.type, data.notes, client_id)
    )
    log_action(db, user, "update", "client", client_id, data.name)
    db.commit()
    return {"message": "Client updated"}

@router.patch("/{client_id}/archive")
def archive_client(client_id: int, data: ArchiveRequest = ArchiveRequest(),
                   user=Depends(require_perm("clients", "delete")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM clients WHERE id = ? AND archived_at IS NULL", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found")
    active_projects = db.execute(
        "SELECT COUNT(*) FROM projects WHERE client_id = ? AND archived_at IS NULL AND status NOT IN ('Cancelled','Completed','Invoiced')",
        (client_id,)
    ).fetchone()[0]
    if active_projects:
        raise HTTPException(400, f"Cannot archive: this client has {active_projects} active project(s). Cancel or complete them first.")
    now = _now()
    db.execute(
        "UPDATE clients SET archived_at=?, archive_reason=? WHERE id=?",
        (now, data.reason or "Archived", client_id)
    )
    log_action(db, user, "archive", "client", client_id, row["name"], {"reason": data.reason})
    db.commit()
    return {"message": "Client archived"}

@router.patch("/{client_id}/unarchive")
def unarchive_client(client_id: int, user=Depends(require_perm("clients", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM clients WHERE id = ? AND archived_at IS NOT NULL", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found in archives")
    db.execute("UPDATE clients SET archived_at=NULL, archive_reason=NULL WHERE id=?", (client_id,))
    log_action(db, user, "unarchive", "client", client_id, row["name"])
    db.commit()
    return {"message": "Client restored from archive"}
