from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from typing import Optional
from database import get_db
from permissions import require_perm, can_view
from routers.audit import log_action
from utils import _now, money
import sqlite3

router = APIRouter()

VAT_STATUSES = ("subject", "exempt")
INSTALMENT_FREQUENCIES = ("monthly", "quarterly", "yearly")


class ClientCreate(BaseModel):
    name: str
    company: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    type: Optional[str] = "private"
    notes: Optional[str] = None
    # What the tax authority knows them as. Printed on their documents.
    financial_id: Optional[str] = None
    # None means "whatever the company bills in", so changing the company
    # currency does not orphan every customer record.
    preferred_currency: Optional[str] = None
    vat_status: str = "subject"
    # A DEFAULT for their invoices, not a rule those invoices must obey.
    allow_installments: bool = False
    default_installment_count: Optional[int] = None
    default_installment_frequency: Optional[str] = None

    @validator("vat_status")
    def _known_vat_status(cls, v):
        if (v or "subject").lower() not in VAT_STATUSES:
            raise ValueError("VAT status must be one of: " + ", ".join(VAT_STATUSES))
        return (v or "subject").lower()

    @validator("preferred_currency")
    def _known_currency(cls, v):
        if v in (None, ""):
            return None
        import currency as currency_mod
        if not currency_mod.is_supported(v):
            raise ValueError("Currency must be one of: "
                             + ", ".join(currency_mod.SUPPORTED))
        return v.upper()

    @validator("default_installment_frequency")
    def _known_frequency(cls, v):
        if v in (None, ""):
            return None
        if v.lower() not in INSTALMENT_FREQUENCIES:
            raise ValueError("Frequency must be one of: "
                             + ", ".join(INSTALMENT_FREQUENCIES))
        return v.lower()

    @validator("default_installment_count")
    def _sensible_count(cls, v):
        if v is not None and int(v) < 1:
            raise ValueError("An instalment plan needs at least one instalment.")
        return v

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

@router.get("/")
def list_clients(search: Optional[str] = None, type: Optional[str] = None,
                 include_archived: bool = False,
                 limit: Optional[int] = None, offset: int = 0,
                 sort: Optional[str] = None, dir: str = "asc",
                 user=Depends(require_perm("clients", "view")), db: sqlite3.Connection = Depends(get_db)):
    # Default view hides archived rows. `include_archived=1` returns them too
    # (each carries archived_at) so the list can offer an in-module "Show
    # archived" filter with inline Restore — the primary archive UX (Option A).
    # The WHERE clause is built once and shared by the row query and the COUNT,
    # so the two can never drift apart and disagree about the total.
    where  = ["1=1"]
    params = []
    if not include_archived:
        where.append("archived_at IS NULL")
    if search:
        where.append("(name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?)")
        s = f"%{search}%"
        params.extend([s, s, s, s])
    if type:
        where.append("type = ?")
        params.append(type)
    where_clause = " WHERE " + " AND ".join(where)

    # Sorting from a fixed allow-list: `sort` reaches ORDER BY, which takes no
    # bind parameters, so only a value from this map may be interpolated.
    _SORTABLE = {"name": "name", "company": "company", "type": "type",
                 "phone": "phone", "email": "email", "created_at": "created_at"}
    _direction = "DESC" if str(dir).lower() == "desc" else "ASC"
    order_sql = (f" ORDER BY {_SORTABLE[sort]} {_direction}"
                 if sort in _SORTABLE else " ORDER BY created_at DESC")

    # Pagination, matching the invoices convention: with no `limit` the response
    # is the full array exactly as before, so every existing caller is
    # untouched. Pass `limit` (capped at 500) for a
    # {items, total, limit, offset} envelope.
    if limit is not None:
        cap   = max(1, min(limit, 500))
        total = db.execute(f"SELECT COUNT(*) FROM clients{where_clause}",
                           params).fetchone()[0]
        rows  = db.execute(
            f"SELECT * FROM clients{where_clause}{order_sql}"
            f" LIMIT ? OFFSET ?", params + [cap, offset]).fetchall()
        return {"items": [dict(r) for r in rows], "total": total,
                "limit": cap, "offset": offset}

    rows = db.execute(
        f"SELECT * FROM clients{where_clause}{order_sql}",
        params).fetchall()
    return [dict(r) for r in rows]

@router.get("/{client_id}")
def get_client(client_id: int, user=Depends(require_perm("clients", "view")), db: sqlite3.Connection = Depends(get_db)):
    # Archived clients are still viewable (the list's "Show archived" opens the
    # detail) — only writes are blocked elsewhere. So no archived_at filter here.
    row = db.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
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
           GROUP BY i.id, p.name ORDER BY i.created_at DESC""",
        (client_id,)
    ).fetchall()

    # The customer's machines and the work done on them. Guarded by the module
    # permission rather than the clients one: a salesperson who may read a client
    # has no business reading their service history, and a tenant that has not
    # licensed service has no such tables to read.
    equipment, service_jobs = [], []
    if can_view(user, db, "service"):
        equipment = db.execute(
            """SELECT id, name, manufacturer, model, serial_number, install_date,
                      location
               FROM service_equipment
               WHERE client_id = ? AND archived_at IS NULL ORDER BY name""",
            (client_id,)
        ).fetchall()
        service_jobs = db.execute(
            """SELECT j.id, j.job_number, j.job_type, j.status, j.scheduled_date,
                      j.completed_at, j.total, e.name AS equipment_name
               FROM service_jobs j
               LEFT JOIN service_equipment e ON e.id = j.equipment_id
               WHERE j.client_id = ? AND j.archived_at IS NULL
               ORDER BY COALESCE(j.completed_at, j.scheduled_date, j.created_at) DESC""",
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
    result["equipment"]    = [dict(e) for e in equipment]
    result["service_jobs"] = [dict(j) for j in service_jobs]
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
        "INSERT INTO clients (name, company, phone, email, address, type, notes, "
        "financial_id, preferred_currency, vat_status, allow_installments, default_installment_count, default_installment_frequency, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (data.name, data.company, data.phone, data.email, data.address, data.type,
         data.notes, data.financial_id, data.preferred_currency, data.vat_status,
         1 if data.allow_installments else 0,
         data.default_installment_count, data.default_installment_frequency, now)
    )
    log_action(db, user, "create", "client", c.lastrowid, data.name)
    db.commit()
    return {"id": c.lastrowid, "message": "Client created"}

@router.put("/{client_id}")
def update_client(client_id: int, data: ClientCreate, user=Depends(require_perm("clients", "edit")), db: sqlite3.Connection = Depends(get_db)):
    # A soft-deleted (or non-existent) client must not be updatable.
    if not db.execute(
        "SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL", (client_id,)
    ).fetchone():
        raise HTTPException(404, "Client not found")
    db.execute(
        "UPDATE clients SET name=?, company=?, phone=?, email=?, address=?, type=?, "
        " notes=?, financial_id=?, preferred_currency=?, vat_status=?, "
        " allow_installments=?, default_installment_count=?, "
        " default_installment_frequency=? WHERE id=?",
        (data.name, data.company, data.phone, data.email, data.address, data.type,
         data.notes, data.financial_id, data.preferred_currency, data.vat_status,
         1 if data.allow_installments else 0,
         data.default_installment_count, data.default_installment_frequency, client_id)
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
        "SELECT COUNT(*) FROM projects WHERE client_id = ? AND archived_at IS NULL AND status NOT IN ('Cancelled','Voided','Completed','Invoiced')",
        (client_id,)
    ).fetchone()[0]
    if active_projects:
        raise HTTPException(400, f"Cannot archive: this client has {active_projects} active project(s). Void or complete them first.")
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


@router.get("/{client_id}/statement")
def client_statement(client_id: int,
                     start: Optional[str] = None, end: Optional[str] = None,
                     user=Depends(require_perm("clients", "view")),
                     db: sqlite3.Connection = Depends(get_db)):
    """A statement of account: what was invoiced, what was paid, what is left.

    One chronological run of movements with a running balance, which is the
    document a customer asks for when they want to know why they owe what they
    owe. Built from invoices and their payments rather than from the ledger:
    the ledger knows the totals but not which invoice a payment settled, and
    that is the whole question a statement answers.

    An opening balance carries in everything before `start`, so a period
    statement still adds up rather than beginning mid-story.
    """
    row = db.execute(
        "SELECT id, name, company, financial_id, preferred_currency, vat_status "
        "FROM clients WHERE id=? AND deleted_at IS NULL", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found")

    invoices = db.execute(
        "SELECT id, invoice_number, created_at, amount, voided_at "
        "FROM invoices WHERE client_id=? AND archived_at IS NULL "
        "ORDER BY created_at, id", (client_id,)).fetchall()
    live = [i for i in invoices if not i["voided_at"]]
    ids = [i["id"] for i in live]

    payments = []
    if ids:
        ph = ",".join("?" * len(ids))
        payments = db.execute(
            f"SELECT p.id, p.invoice_id, p.amount, p.method, p.paid_at, "
            f"       p.paid_currency, p.paid_amount, i.invoice_number "
            f"FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id "
            f"WHERE p.invoice_id IN ({ph}) ORDER BY p.paid_at, p.id", ids).fetchall()

    # One list of movements: an invoice adds to what is owed, a payment reduces
    # it. Sorted together so the running balance reads the way it happened.
    movements = []
    for i in live:
        movements.append({
            "date": (i["created_at"] or "")[:10], "_ts": i["created_at"] or "",
            "type": "invoice",
            "reference": i["invoice_number"], "invoice_id": i["id"],
            "description": f"Invoice {i['invoice_number']}",
            "charged": money(i["amount"]), "paid": 0.0,
        })
    for p in payments:
        movements.append({
            "date": (p["paid_at"] or "")[:10], "_ts": p["paid_at"] or "",
            "type": "payment",
            "reference": p["invoice_number"], "invoice_id": p["invoice_id"],
            "description": f"Payment — {p['method'] or 'Cash'}"
                           + (f" ({p['paid_currency']})" if p["paid_currency"] not in (None, "USD") else ""),
            "charged": 0.0, "paid": money(p["amount"]),
        })
    # Ordered by when it actually happened, not merely by day: several
    # movements on one date must read in sequence or the running balance tells
    # a story that did not occur. The type only breaks a tie between two
    # identical timestamps, where an invoice necessarily precedes its payment.
    movements.sort(key=lambda m: (m["_ts"], 0 if m["type"] == "invoice" else 1))

    opening = 0.0
    if start:
        before = [m for m in movements if m["date"] < start[:10]]
        opening = money(sum(m["charged"] - m["paid"] for m in before))
        movements = [m for m in movements if m["date"] >= start[:10]]
    if end:
        movements = [m for m in movements if m["date"] <= end[:10]]

    balance = opening
    for m in movements:
        m.pop("_ts", None)
        balance = money(balance + m["charged"] - m["paid"])
        m["balance"] = balance

    charged = money(sum(m["charged"] for m in movements))
    paid = money(sum(m["paid"] for m in movements))
    return {
        "client": {"id": row["id"], "name": row["name"], "company": row["company"],
                   "financial_id": row["financial_id"],
                   "preferred_currency": row["preferred_currency"],
                   "vat_status": row["vat_status"]},
        "start": start, "end": end,
        "opening_balance": opening,
        "movements": movements,
        "total_charged": charged,
        "total_paid": paid,
        "closing_balance": money(opening + charged - paid),
    }
