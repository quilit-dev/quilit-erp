"""Returns: credit notes (customer returns) and debit notes (returns to suppliers).

The engine and its accounting live in `returns.py`; this is the door to it ---
permissions, branch scoping, period locks, and the lists the screens read.
"""
import sqlite3
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import branch_access
import returns as engine
from audit_log import log_action
from database import get_db
from permissions import require_perm
from routers.finance import _check_period_locked
from utils import _now, money

router = APIRouter()


class SalesLine(BaseModel):
    invoice_item_id: int
    quantity: float
    condition: Optional[str] = None      # restock | damaged | none


class SalesReturnIn(BaseModel):
    invoice_id: int
    lines: List[SalesLine]
    reason: Optional[str] = None
    return_date: Optional[str] = None
    settlement: Optional[str] = None     # refund | credit (when already paid)
    refund_method: Optional[str] = None
    bank_account_id: Optional[int] = None
    cash_drawer_id: Optional[int] = None


class PurchaseLine(BaseModel):
    purchase_item_id: int
    quantity: float


class PurchaseReturnIn(BaseModel):
    purchase_id: int
    lines: List[PurchaseLine]
    reason: Optional[str] = None
    return_date: Optional[str] = None
    settlement: Optional[str] = None
    refund_method: Optional[str] = None
    bank_account_id: Optional[int] = None


class VoidIn(BaseModel):
    reason: Optional[str] = None


def _date_ok(value: Optional[str]) -> str:
    when = (value or _now())[:10]
    try:
        from datetime import datetime
        datetime.strptime(when, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Return date must be YYYY-MM-DD.")
    if when > _now()[:10]:
        raise HTTPException(400, "A return cannot be dated in the future.")
    return when


# ════════════════════════════════════════════════════════════════════════════
# Credit notes
# ════════════════════════════════════════════════════════════════════════════
@router.get("/sales")
def list_sales_returns(search: Optional[str] = None, date_from: Optional[str] = None,
                       date_to: Optional[str] = None, include_voided: bool = True,
                       branch_id: Optional[int] = None,
                       user=Depends(require_perm("returns", "view")),
                       db: sqlite3.Connection = Depends(get_db)):
    where, params = ["1=1"], []
    bf, bp = branch_access.branch_filter(user, db, column="r.branch_id", selected=branch_id)
    if bf:
        where.append(bf[len(" AND "):]); params += bp
    if not include_voided:
        where.append("r.voided_at IS NULL")
    if date_from:
        where.append("r.return_date >= ?"); params.append(date_from[:10])
    if date_to:
        where.append("r.return_date <= ?"); params.append(date_to[:10])
    if search:
        like = f"%{search.strip()}%"
        where.append("(r.return_number LIKE ? OR i.invoice_number LIKE ? OR c.name LIKE ?)")
        params += [like, like, like]
    rows = db.execute(
        "SELECT r.*, i.invoice_number, c.name AS client_name "
        "  FROM sales_returns r JOIN invoices i ON i.id = r.invoice_id "
        "  LEFT JOIN clients c ON c.id = r.client_id "
        " WHERE " + " AND ".join(where) + " ORDER BY r.return_date DESC, r.id DESC",
        params).fetchall()
    return [dict(r) for r in rows]


def _sales_return_or_404(db, user, return_id):
    row = db.execute(
        "SELECT r.*, i.invoice_number, i.currency, c.name AS client_name, c.email AS client_email, "
        "       c.phone AS client_phone, c.address AS client_address "
        "  FROM sales_returns r JOIN invoices i ON i.id = r.invoice_id "
        "  LEFT JOIN clients c ON c.id = r.client_id WHERE r.id = ?",
        (return_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Credit note not found")
    branch_access.assert_can_view_branch(user, db, row["branch_id"])
    return row


@router.get("/sales/{return_id}")
def get_sales_return(return_id: int, user=Depends(require_perm("returns", "view")),
                     db: sqlite3.Connection = Depends(get_db)):
    row = _sales_return_or_404(db, user, return_id)
    items = db.execute("SELECT * FROM sales_return_items WHERE return_id = ? ORDER BY id",
                       (return_id,)).fetchall()
    out = dict(row)
    out["items"] = [dict(i) for i in items]
    return out


@router.get("/sales/invoice/{invoice_id}/returnable")
def sales_returnable(invoice_id: int, user=Depends(require_perm("returns", "view")),
                     db: sqlite3.Connection = Depends(get_db)):
    inv = db.execute("SELECT branch_id FROM invoices WHERE id = ? AND archived_at IS NULL",
                     (invoice_id,)).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    try:
        return engine.sales_returnable(db, invoice_id)
    except engine.ReturnError as e:
        raise HTTPException(400, str(e))


@router.post("/sales")
def create_sales_return(data: SalesReturnIn, user=Depends(require_perm("returns", "create")),
                        db: sqlite3.Connection = Depends(get_db)):
    inv = db.execute("SELECT * FROM invoices WHERE id = ? AND archived_at IS NULL",
                     (data.invoice_id,)).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    when = _date_ok(data.return_date)
    if when < str(inv["created_at"])[:10]:
        raise HTTPException(400, "A return cannot be dated before the invoice.")
    _check_period_locked(db, when)
    if data.cash_drawer_id is not None and not db.execute(
            "SELECT 1 FROM cash_drawers WHERE id = ?", (data.cash_drawer_id,)).fetchone():
        raise HTTPException(400, "Cash drawer not found")
    try:
        rid = engine.create_sales_return(
            db, user, invoice_id=data.invoice_id,
            lines=[l.model_dump() for l in data.lines], reason=(data.reason or "").strip(),
            return_date=when, settlement=data.settlement, refund_method=data.refund_method,
            bank_account_id=data.bank_account_id, cash_drawer_id=data.cash_drawer_id)
    except engine.ReturnError as e:
        db.rollback()
        raise HTTPException(400, str(e))
    ret = db.execute("SELECT * FROM sales_returns WHERE id = ?", (rid,)).fetchone()
    log_action(db, user, "create", "sales_return", rid, ret["return_number"],
               {"invoice": inv["invoice_number"], "total": money(ret["total"]),
                "applied": money(ret["applied_to_invoice"]),
                "refunded": money(ret["refunded"]), "credited": money(ret["credited"])})
    db.commit()
    return {"id": rid, "return_number": ret["return_number"], "message": "Credit note raised"}


@router.patch("/sales/{return_id}/void")
def void_sales_return(return_id: int, data: VoidIn,
                      user=Depends(require_perm("returns", "delete")),
                      db: sqlite3.Connection = Depends(get_db)):
    row = _sales_return_or_404(db, user, return_id)
    _check_period_locked(db, row["return_date"])
    _check_period_locked(db, _now())
    try:
        engine.void_sales_return(db, user, return_id, (data.reason or "").strip())
    except engine.ReturnError as e:
        db.rollback()
        raise HTTPException(409, str(e))
    log_action(db, user, "void", "sales_return", return_id, row["return_number"],
               {"reason": data.reason})
    db.commit()
    return {"message": "Credit note voided"}


# ════════════════════════════════════════════════════════════════════════════
# Debit notes
# ════════════════════════════════════════════════════════════════════════════
@router.get("/purchases")
def list_purchase_returns(search: Optional[str] = None, date_from: Optional[str] = None,
                          date_to: Optional[str] = None, include_voided: bool = True,
                          branch_id: Optional[int] = None,
                          user=Depends(require_perm("returns", "view")),
                          db: sqlite3.Connection = Depends(get_db)):
    where, params = ["1=1"], []
    bf, bp = branch_access.branch_filter(user, db, column="r.warehouse_id", selected=branch_id)
    if bf:
        where.append(bf[len(" AND "):]); params += bp
    if not include_voided:
        where.append("r.voided_at IS NULL")
    if date_from:
        where.append("r.return_date >= ?"); params.append(date_from[:10])
    if date_to:
        where.append("r.return_date <= ?"); params.append(date_to[:10])
    if search:
        like = f"%{search.strip()}%"
        where.append("(r.return_number LIKE ? OR p.po_number LIKE ? OR r.supplier LIKE ?)")
        params += [like, like, like]
    rows = db.execute(
        "SELECT r.*, p.po_number FROM purchase_returns r "
        "  JOIN purchases p ON p.id = r.purchase_id "
        " WHERE " + " AND ".join(where) + " ORDER BY r.return_date DESC, r.id DESC",
        params).fetchall()
    return [dict(r) for r in rows]


def _purchase_return_or_404(db, user, return_id):
    row = db.execute(
        "SELECT r.*, p.po_number FROM purchase_returns r "
        "  JOIN purchases p ON p.id = r.purchase_id WHERE r.id = ?", (return_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Debit note not found")
    branch_access.assert_can_view_branch(user, db, row["warehouse_id"])
    return row


@router.get("/purchases/{return_id}")
def get_purchase_return(return_id: int, user=Depends(require_perm("returns", "view")),
                        db: sqlite3.Connection = Depends(get_db)):
    row = _purchase_return_or_404(db, user, return_id)
    items = db.execute("SELECT * FROM purchase_return_items WHERE return_id = ? ORDER BY id",
                       (return_id,)).fetchall()
    out = dict(row)
    sup = None
    if row["supplier_id"]:
        sup = db.execute("SELECT * FROM suppliers WHERE id = ?", (row["supplier_id"],)).fetchone()
    out["supplier_email"] = sup["email"] if sup and "email" in sup.keys() else None
    out["supplier_phone"] = sup["phone"] if sup and "phone" in sup.keys() else None
    out["items"] = [dict(i) for i in items]
    return out


@router.get("/purchases/purchase/{purchase_id}/returnable")
def purchase_returnable(purchase_id: int, user=Depends(require_perm("returns", "view")),
                        db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT warehouse_id FROM purchases WHERE id = ? AND archived_at IS NULL",
                     (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    branch_access.assert_can_view_branch(user, db, row["warehouse_id"])
    try:
        return engine.purchase_returnable(db, purchase_id)
    except engine.ReturnError as e:
        raise HTTPException(400, str(e))


@router.post("/purchases")
def create_purchase_return(data: PurchaseReturnIn,
                           user=Depends(require_perm("returns", "create")),
                           db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL",
                     (data.purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    branch_access.assert_can_view_branch(user, db, row["warehouse_id"])
    when = _date_ok(data.return_date)
    if row["received_at"] and when < str(row["received_at"])[:10]:
        raise HTTPException(400, "A return cannot be dated before the goods were received.")
    _check_period_locked(db, when)
    try:
        rid = engine.create_purchase_return(
            db, user, purchase_id=data.purchase_id,
            lines=[l.model_dump() for l in data.lines], reason=(data.reason or "").strip(),
            return_date=when, settlement=data.settlement, refund_method=data.refund_method,
            bank_account_id=data.bank_account_id)
    except engine.ReturnError as e:
        db.rollback()
        raise HTTPException(400, str(e))
    ret = db.execute("SELECT * FROM purchase_returns WHERE id = ?", (rid,)).fetchone()
    log_action(db, user, "create", "purchase_return", rid, ret["return_number"],
               {"purchase": row["po_number"], "total": money(ret["total"]),
                "applied": money(ret["applied_to_purchase"]),
                "refunded": money(ret["refunded"]), "credited": money(ret["credited"])})
    db.commit()
    return {"id": rid, "return_number": ret["return_number"], "message": "Debit note raised"}


@router.patch("/purchases/{return_id}/void")
def void_purchase_return(return_id: int, data: VoidIn,
                         user=Depends(require_perm("returns", "delete")),
                         db: sqlite3.Connection = Depends(get_db)):
    row = _purchase_return_or_404(db, user, return_id)
    _check_period_locked(db, row["return_date"])
    _check_period_locked(db, _now())
    try:
        engine.void_purchase_return(db, user, return_id, (data.reason or "").strip())
    except engine.ReturnError as e:
        db.rollback()
        raise HTTPException(409, str(e))
    log_action(db, user, "void", "purchase_return", return_id, row["return_number"],
               {"reason": data.reason})
    db.commit()
    return {"message": "Debit note voided"}


# ════════════════════════════════════════════════════════════════════════════
# Credit balances
# ════════════════════════════════════════════════════════════════════════════
@router.get("/credit/customer/{client_id}")
def customer_credit(client_id: int, user=Depends(require_perm("invoices", "view")),
                    db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute("SELECT * FROM customer_credits WHERE client_id = ? "
                      "ORDER BY created_at DESC, id DESC", (client_id,)).fetchall()
    return {"balance": engine.customer_credit_balance(db, client_id),
            "history": [dict(r) for r in rows]}


@router.get("/credit/supplier")
def supplier_credit(supplier_id: Optional[int] = None, supplier: Optional[str] = None,
                    user=Depends(require_perm("purchases", "view")),
                    db: sqlite3.Connection = Depends(get_db)):
    if supplier_id:
        rows = db.execute("SELECT * FROM supplier_credits WHERE supplier_id = ? "
                          "ORDER BY created_at DESC, id DESC", (supplier_id,)).fetchall()
    elif supplier:
        rows = db.execute("SELECT * FROM supplier_credits WHERE supplier_id IS NULL "
                          "AND supplier = ? ORDER BY created_at DESC, id DESC",
                          (supplier,)).fetchall()
    else:
        raise HTTPException(400, "Name the supplier.")
    return {"balance": engine.supplier_credit_balance(db, supplier_id, supplier),
            "history": [dict(r) for r in rows]}
