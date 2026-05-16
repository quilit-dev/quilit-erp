"""
Quotations — commercial proposals only.

Workflow:
  Draft → Sent → Accepted → [Convert to Invoice]
                 Rejected / Cancelled

Payments are NOT recorded on quotations. When a quotation is accepted
the user converts it to an Invoice, and payments are recorded there.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, _get_tax_multiplier
import sqlite3
from datetime import datetime, timedelta

router = APIRouter()

class CancelRequest(BaseModel):
    reason: Optional[str] = None

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

class QuoteItem(BaseModel):
    name: str
    quantity: float
    unit_price: float

class QuotationCreate(BaseModel):
    project_id:   Optional[int] = None
    project_name: Optional[str] = None   # free-text name when no project exists yet
    client_id:    Optional[int] = None
    status:       Optional[str] = "Draft"
    notes:        Optional[str] = None
    items:        List[QuoteItem] = []

def _next_quote_number(db):
    prefix_row = db.execute("SELECT value FROM settings WHERE key='quotation_prefix'").fetchone()
    prefix = prefix_row["value"] if prefix_row else "QTN-"
    row  = db.execute("SELECT COALESCE(MAX(id), 0) as m FROM quotations").fetchone()
    year = datetime.utcnow().year
    return f"{prefix}{year}-{row['m'] + 1:04d}"

# ── List ──────────────────────────────────────────────────────────────────
@router.get("/")
def list_quotations(
    status: Optional[str] = None,
    user=Depends(require_perm("quotations", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    query = """
        SELECT q.*,
               p.name  AS project_name,
               c.name  AS client_name,
               -- show whether an invoice has already been raised
               (SELECT COUNT(*) FROM invoices i WHERE i.quotation_id = q.id) AS invoice_count
        FROM quotations q
        LEFT JOIN projects p ON q.project_id = p.id
        LEFT JOIN clients  c ON q.client_id  = c.id
        WHERE q.archived_at IS NULL
    """
    params = []
    if status:
        query += " AND q.status = ?"
        params.append(status)
    query += " ORDER BY q.created_at DESC"
    rows = db.execute(query, params).fetchall()
    tax_mult = _get_tax_multiplier(db)
    result = []
    for r in rows:
        d = dict(r)
        d["total_with_tax"] = round(float(d["total"] or 0) * tax_mult, 2)
        result.append(d)
    return result

# ── Single ────────────────────────────────────────────────────────────────
@router.get("/{quote_id}")
def get_quotation(
    quote_id: int,
    user=Depends(require_perm("quotations", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT q.*, p.name AS project_name, c.name AS client_name
           FROM quotations q
           LEFT JOIN projects p ON q.project_id = p.id
           LEFT JOIN clients  c ON q.client_id  = c.id
           WHERE q.id = ?""",
        (quote_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Quotation not found")

    items = db.execute(
        "SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY id",
        (quote_id,),
    ).fetchall()

    result = dict(row)
    result["items"] = [dict(i) for i in items]
    return result

# ── Create ────────────────────────────────────────────────────────────────
@router.post("/")
def create_quotation(
    data: QuotationCreate,
    user=Depends(require_perm("quotations", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    total = sum(i.quantity * i.unit_price for i in data.items)
    qn    = _next_quote_number(db)
    now   = _now()

    cur = db.execute(
        "INSERT INTO quotations "
        "(quote_number, project_id, client_id, project_name, status, notes, total, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (qn, data.project_id, data.client_id, data.project_name, data.status, data.notes, total, now),
    )
    qid = cur.lastrowid
    for item in data.items:
        db.execute(
            "INSERT INTO quotation_items "
            "(quotation_id, name, quantity, unit_price, total) VALUES (?,?,?,?,?)",
            (qid, item.name, item.quantity, item.unit_price,
             item.quantity * item.unit_price),
        )
    log_action(db, user, "create", "quotation", qid, qn)
    db.commit()
    return {"id": qid, "quote_number": qn, "message": "Quotation created"}

# ── Update ────────────────────────────────────────────────────────────────
@router.put("/{quote_id}")
def update_quotation(
    quote_id: int,
    data: QuotationCreate,
    user=Depends(require_perm("quotations", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    existing = db.execute(
        "SELECT id FROM quotations WHERE id = ?", (quote_id,)
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Quotation not found")

    total = sum(i.quantity * i.unit_price for i in data.items)
    invoice_amount = round(total * _get_tax_multiplier(db), 4)

    # Check if this quotation has already been converted to an invoice.
    # If the total has changed, update the invoice amount — but only when
    # no payments have been recorded yet (editing a paid/partial invoice
    # would break accounting, so we block it with a clear error).
    linked_invoices = db.execute(
        "SELECT id, invoice_number, amount FROM invoices WHERE quotation_id = ? AND deleted_at IS NULL",
        (quote_id,),
    ).fetchall()
    for inv in linked_invoices:
        if abs(float(inv["amount"]) - invoice_amount) > 0.001:
            total_paid = db.execute(
                "SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_payments WHERE invoice_id = ?",
                (inv["id"],),
            ).fetchone()["s"]
            if float(total_paid) > 0:
                raise HTTPException(
                    400,
                    f"Cannot change quotation total: invoice {inv['invoice_number']} "
                    f"already has payments recorded (${float(total_paid):.2f} paid). "
                    "Delete the payments first, or create a new quotation."
                )
            # Safe to sync — no payments yet
            db.execute(
                "UPDATE invoices SET amount = ? WHERE id = ?",
                (invoice_amount, inv["id"]),
            )
            # Replace invoice line items to stay in sync
            db.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (inv["id"],))
            for item in data.items:
                db.execute(
                    "INSERT INTO invoice_items (invoice_id, name, quantity, unit_price) VALUES (?,?,?,?)",
                    (inv["id"], item.name, item.quantity, item.unit_price),
                )

    db.execute(
        "UPDATE quotations "
        "SET project_id=?, client_id=?, project_name=?, status=?, notes=?, total=? WHERE id=?",
        (data.project_id, data.client_id, data.project_name, data.status, data.notes, total, quote_id),
    )
    db.execute(
        "DELETE FROM quotation_items WHERE quotation_id = ?", (quote_id,)
    )
    for item in data.items:
        db.execute(
            "INSERT INTO quotation_items "
            "(quotation_id, name, quantity, unit_price, total) VALUES (?,?,?,?,?)",
            (quote_id, item.name, item.quantity, item.unit_price,
             item.quantity * item.unit_price),
        )
    qref = db.execute("SELECT quote_number FROM quotations WHERE id = ?", (quote_id,)).fetchone()
    log_action(db, user, "update", "quotation", quote_id,
               qref["quote_number"] if qref else "")
    db.commit()
    return {"message": "Quotation updated"}

# ── Convert to Invoice ────────────────────────────────────────────────────
@router.post("/{quote_id}/convert-to-invoice")
def convert_to_invoice(
    quote_id: int,
    user=Depends(require_perm("quotations", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Creates an Invoice from an accepted Quotation.
    The invoice amount equals the quotation total.
    Payments are then recorded on the invoice, not the quotation.
    """
    q = db.execute(
        "SELECT * FROM quotations WHERE id = ?", (quote_id,)
    ).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")

    # Check if an invoice already exists for this quotation
    existing_inv = db.execute(
        "SELECT id, invoice_number FROM invoices WHERE quotation_id = ?",
        (quote_id,),
    ).fetchone()
    if existing_inv:
        return {
            "message":        "Invoice already exists for this quotation",
            "invoice_id":     existing_inv["id"],
            "invoice_number": existing_inv["invoice_number"],
        }

    # Generate invoice number (respects prefix setting)
    prefix_row = db.execute("SELECT value FROM settings WHERE key='invoice_prefix'").fetchone()
    prefix = prefix_row["value"] if prefix_row else "INV-"
    row    = db.execute("SELECT COALESCE(MAX(id), 0) as m FROM invoices").fetchone()
    year   = datetime.utcnow().year
    inv_no = f"{prefix}{year}-{row['m'] + 1:04d}"
    now    = _now()

    # Auto-calculate due_date from payment_terms_days setting
    from datetime import timedelta
    terms_row = db.execute("SELECT value FROM settings WHERE key='payment_terms_days'").fetchone()
    days = int(terms_row["value"]) if terms_row else 15
    due_date = (datetime.utcnow() + timedelta(days=days)).strftime("%Y-%m-%d")

    # Ensure invoice_items table exists
    db.execute("""
        CREATE TABLE IF NOT EXISTS invoice_items (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            name       TEXT    NOT NULL,
            quantity   REAL    NOT NULL DEFAULT 1,
            unit_price REAL    NOT NULL DEFAULT 0
        )
    """)

    invoice_amount = round(float(q["total"]) * _get_tax_multiplier(db), 4)
    cur = db.execute(
        "INSERT INTO invoices "
        "(invoice_number, quotation_id, project_id, client_id, amount, due_date, notes, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (inv_no, quote_id, q["project_id"], q["client_id"],
         invoice_amount, due_date, f"From {q['quote_number']}", now),
    )
    inv_id = cur.lastrowid

    # Copy all line items from quotation_items -> invoice_items
    quote_items = db.execute(
        "SELECT name, quantity, unit_price FROM quotation_items WHERE quotation_id = ? ORDER BY id",
        (quote_id,),
    ).fetchall()
    for item in quote_items:
        db.execute(
            "INSERT INTO invoice_items (invoice_id, name, quantity, unit_price) VALUES (?,?,?,?)",
            (inv_id, item["name"], item["quantity"], item["unit_price"]),
        )

    # Mark quotation as Accepted (if not already)
    db.execute(
        "UPDATE quotations SET status = 'Accepted' WHERE id = ? AND status != 'Accepted'",
        (quote_id,),
    )
    log_action(db, user, "convert_to_invoice", "quotation", quote_id,
               q["quote_number"], {"invoice_number": inv_no})
    db.commit()
    return {
        "message":        "Invoice created from quotation",
        "invoice_id":     inv_id,
        "invoice_number": inv_no,
    }

# ── Convert to Project (project-based workflow) ───────────────────────────
@router.post("/{quote_id}/convert-to-project")
def convert_to_project(
    quote_id: int,
    user=Depends(require_perm("quotations", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Creates a Project from an accepted Quotation.
    - expected_revenue  = quotation total (what the client will pay us)
    - estimated_cost    = 0 initially (updated as expenses/costs are tracked)
    - source_quotation_id links the project back to the originating quote
    """
    q = db.execute(
        "SELECT * FROM quotations WHERE id = ?", (quote_id,)
    ).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    if q["project_id"]:
        return {"message": "Already linked to project", "project_id": q["project_id"]}

    cur = db.execute(
        "INSERT INTO projects "
        "(name, client_id, status, estimated_cost, expected_revenue, source_quotation_id, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (
            q["project_name"] or f"Project from {q['quote_number']}",
            q["client_id"],
            "Approved",
            0,            # estimated_cost starts at 0; updated as costs are tracked
            q["total"],   # expected_revenue = quotation total (client's commitment)
            quote_id,     # link back to originating quotation
            _now(),
        ),
    )
    pid = cur.lastrowid
    db.execute(
        "UPDATE quotations SET project_id = ?, status = 'Accepted' WHERE id = ?",
        (pid, quote_id),
    )
    db.commit()
    return {"message": "Project created from accepted quotation", "project_id": pid}

# ── Cancel ────────────────────────────────────────────────────────────────
@router.patch("/{quote_id}/cancel")
def cancel_quotation(
    quote_id: int,
    data: CancelRequest = CancelRequest(),
    user=Depends(require_perm("quotations", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = db.execute("SELECT * FROM quotations WHERE id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    if q["status"] == "Cancelled":
        raise HTTPException(400, "Quotation is already cancelled.")
    inv = db.execute("SELECT id FROM invoices WHERE quotation_id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if inv:
        raise HTTPException(400, "Cannot cancel a quotation that has an active invoice. Archive the invoice first.")
    db.execute(
        "UPDATE quotations SET status='Cancelled', archive_reason=? WHERE id=?",
        (data.reason or "Cancelled", quote_id)
    )
    log_action(db, user, "cancel", "quotation", quote_id,
               q["quote_number"], {"reason": data.reason})
    db.commit()
    return {"message": "Quotation cancelled"}

# ── Archive ───────────────────────────────────────────────────────────────
@router.patch("/{quote_id}/archive")
def archive_quotation(
    quote_id: int,
    data: ArchiveRequest = ArchiveRequest(),
    user=Depends(require_perm("quotations", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = db.execute("SELECT * FROM quotations WHERE id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    inv = db.execute("SELECT id FROM invoices WHERE quotation_id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if inv:
        raise HTTPException(400, "Cannot archive a quotation that has an active invoice. Archive the invoice first.")
    now = _now()
    db.execute(
        "UPDATE quotations SET archived_at=?, archive_reason=? WHERE id=?",
        (now, data.reason or "Archived", quote_id)
    )
    log_action(db, user, "archive", "quotation", quote_id, q["quote_number"], {"reason": data.reason})
    db.commit()
    return {"message": "Quotation archived"}

# ── Unarchive ─────────────────────────────────────────────────────────────
@router.patch("/{quote_id}/unarchive")
def unarchive_quotation(
    quote_id: int,
    user=Depends(require_perm("quotations", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = db.execute("SELECT * FROM quotations WHERE id = ? AND archived_at IS NOT NULL", (quote_id,)).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found in archives")
    db.execute("UPDATE quotations SET archived_at=NULL, archive_reason=NULL WHERE id=?", (quote_id,))
    log_action(db, user, "unarchive", "quotation", quote_id, q["quote_number"])
    db.commit()
    return {"message": "Quotation restored from archive"}
