"""
Suppliers — managed supplier directory linked to purchase orders.

Suppliers replace the free-text supplier field on purchases with a proper
record carrying contact details and payment terms.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()

class SupplierCreate(BaseModel):
    name:               str
    contact_name:       Optional[str] = None
    phone:              Optional[str] = None
    email:              Optional[str] = None
    payment_terms_days: Optional[int] = 30
    notes:              Optional[str] = None

# ── List ──────────────────────────────────────────────────────────────────────
@router.get("/")
def list_suppliers(
    search: Optional[str] = None,
    include_archived: bool = False,
    user=Depends(require_perm("suppliers", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    query = """
        SELECT s.*,
               COUNT(p.id)              AS purchase_count,
               COALESCE(SUM(
                 (p.quantity * p.unit_cost) + COALESCE(p.additional_costs, 0)
               ), 0)                   AS total_spend
        FROM suppliers s
        LEFT JOIN purchases p ON (
            p.supplier_id = s.id OR (p.supplier_id IS NULL AND p.supplier = s.name)
        ) AND p.archived_at IS NULL
        WHERE 1=1
    """
    params = []
    if not include_archived:
        query += " AND s.archived_at IS NULL"
    if search:
        query += " AND (s.name LIKE ? OR s.contact_name LIKE ? OR s.email LIKE ?)"
        q = f"%{search}%"
        params.extend([q, q, q])
    query += " GROUP BY s.id ORDER BY s.name ASC"
    rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]

# ── Single ────────────────────────────────────────────────────────────────────
@router.get("/{supplier_id}")
def get_supplier(
    supplier_id: int,
    user=Depends(require_perm("suppliers", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    # Archived suppliers stay viewable (the list's "Show archived" View opens
    # the detail) — only writes are blocked elsewhere.
    row = db.execute(
        "SELECT * FROM suppliers WHERE id = ?", (supplier_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Supplier not found")

    purchases = db.execute(
        """SELECT p.*, i.name AS item_name
           FROM purchases p
           LEFT JOIN inventory i ON p.inventory_id = i.id
           WHERE (p.supplier_id = ? OR (p.supplier_id IS NULL AND p.supplier = ?))
             AND p.archived_at IS NULL
           ORDER BY p.ordered_at DESC""",
        (supplier_id, row["name"]),
    ).fetchall()

    total_spend = sum(
        (r["quantity"] * r["unit_cost"]) + (r["additional_costs"] or 0)
        for r in purchases
    )

    result = dict(row)
    result["purchases"]   = [dict(p) for p in purchases]
    result["total_spend"] = round(total_spend, 2)
    return result

# ── Create ────────────────────────────────────────────────────────────────────
@router.post("/")
def create_supplier(
    data: SupplierCreate,
    user=Depends(require_perm("suppliers", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    existing = db.execute(
        "SELECT id FROM suppliers WHERE name = ? AND archived_at IS NULL", (data.name,)
    ).fetchone()
    if existing:
        raise HTTPException(400, f"A supplier named '{data.name}' already exists")

    cur = db.execute(
        "INSERT INTO suppliers (name, contact_name, phone, email, payment_terms_days, notes, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (data.name, data.contact_name, data.phone, data.email,
         data.payment_terms_days, data.notes, _now()),
    )
    log_action(db, user, "create", "supplier", cur.lastrowid, data.name)
    db.commit()
    return {"id": cur.lastrowid, "message": "Supplier created"}

# ── Update ────────────────────────────────────────────────────────────────────
@router.put("/{supplier_id}")
def update_supplier(
    supplier_id: int,
    data: SupplierCreate,
    user=Depends(require_perm("suppliers", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT id FROM suppliers WHERE id = ? AND archived_at IS NULL", (supplier_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Supplier not found")

    conflict = db.execute(
        "SELECT id FROM suppliers WHERE name = ? AND id != ? AND archived_at IS NULL",
        (data.name, supplier_id),
    ).fetchone()
    if conflict:
        raise HTTPException(400, f"Another supplier named '{data.name}' already exists")

    db.execute(
        "UPDATE suppliers SET name=?, contact_name=?, phone=?, email=?, "
        "payment_terms_days=?, notes=? WHERE id=?",
        (data.name, data.contact_name, data.phone, data.email,
         data.payment_terms_days, data.notes, supplier_id),
    )
    log_action(db, user, "update", "supplier", supplier_id, data.name)
    db.commit()
    return {"message": "Supplier updated"}

# ── Archive ───────────────────────────────────────────────────────────────────
@router.patch("/{supplier_id}/archive")
def archive_supplier(
    supplier_id: int,
    user=Depends(require_perm("suppliers", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT * FROM suppliers WHERE id = ? AND archived_at IS NULL", (supplier_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Supplier not found")
    active = db.execute(
        "SELECT COUNT(*) FROM purchases WHERE supplier_id = ? AND archived_at IS NULL "
        "AND voided_at IS NULL AND status NOT IN ('Paid')",
        (supplier_id,),
    ).fetchone()[0]
    if active:
        raise HTTPException(400, f"Cannot archive: supplier has {active} active purchase order(s).")
    now = _now()
    db.execute("UPDATE suppliers SET archived_at = ? WHERE id = ?", (now, supplier_id))
    log_action(db, user, "archive", "supplier", supplier_id, row["name"])
    db.commit()
    return {"message": "Supplier archived"}

# ── Unarchive ─────────────────────────────────────────────────────────────────
@router.patch("/{supplier_id}/unarchive")
def unarchive_supplier(
    supplier_id: int,
    user=Depends(require_perm("suppliers", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT * FROM suppliers WHERE id = ? AND archived_at IS NOT NULL", (supplier_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Supplier not found in archives")
    db.execute("UPDATE suppliers SET archived_at = NULL WHERE id = ?", (supplier_id,))
    log_action(db, user, "unarchive", "supplier", supplier_id, row["name"])
    db.commit()
    return {"message": "Supplier restored from archive"}
