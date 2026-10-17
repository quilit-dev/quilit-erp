"""An invoice that takes its goods out of stock.

An ordinary invoice bills; it does not move stock. `inventory_id` on its lines
is a reference, and the goods leave through the till, a delivery, or an
adjustment. That stays the default.

Some businesses invoice the goods as they hand them over and want the invoice
to be the stock movement. Set on an invoice, this takes every line that names a
stock item off the shelf, exactly as the till does for a sale:

    goods leave at their cost (FIFO / LIFO / average, or the lot for a
    lot-tracked item), from the invoice's branch warehouse

        DR  Cost of goods sold      cost
          CR  Inventory                   cost        (source: invoice_cogs)

Each line keeps how much left and at what cost. That is what a void puts back,
and what a credit note restocks at --- never today's average, which would
re-cost the stock that stayed.

It is all or nothing. If any line is short, nothing moves and the operator is
told which items and by how much.
"""
import sqlite3
from typing import Dict, Optional

import accounting
import lots
import reservations
import sale_reversal
import warehouse_access as wha
from utils import _now, money, notify

SOURCE = "invoice_cogs"


class StockError(ValueError):
    """The goods cannot be taken as asked. The message is for the user."""


def _col(row, key, default=None):
    try:
        v = row[key]
        return default if v is None else v
    except (KeyError, IndexError, TypeError):
        return default


def is_deducted(inv) -> bool:
    return bool(_col(inv, "stock_deducted_at"))


def why_not(db, inv) -> Optional[str]:
    """Why this invoice cannot take its goods out of stock, or None if it can."""
    if _col(inv, "voided_at"):
        return "This invoice is voided."
    if _col(inv, "approval_status") == "Pending Approval":
        return "This invoice is awaiting approval; take the goods out once it is approved."
    if is_deducted(inv):
        return "These goods have already been taken out of stock."
    if db.execute("SELECT 1 FROM pos_sales WHERE invoice_id = ?", (inv["id"],)).fetchone():
        return "A till sale already took these goods out of stock."
    if _col(inv, "service_job_id"):
        return "A service job's parts leave stock through the job itself."
    return None


def _stock_lines(db, invoice_id):
    return [r for r in db.execute(
        "SELECT * FROM invoice_items WHERE invoice_id = ? AND inventory_id IS NOT NULL "
        "AND COALESCE(quantity, 0) > 0 ORDER BY id", (invoice_id,)).fetchall()]


def deduct(db, user, invoice_id: int, *, warehouse_id: Optional[int] = None) -> Dict:
    """Take the invoice's stock lines off the shelf. Does not commit."""
    inv = db.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not inv:
        raise StockError("Invoice not found.")
    reason = why_not(db, inv)
    if reason:
        raise StockError(reason)
    lines = _stock_lines(db, invoice_id)
    if not lines:
        raise StockError("None of this invoice's lines is a stock item.")

    # Everything is checked before anything moves.
    needed: Dict[int, float] = {}
    for ln in lines:
        needed[ln["inventory_id"]] = needed.get(ln["inventory_id"], 0.0) + float(ln["quantity"])
    rows, short = {}, []
    for inv_id, qty in needed.items():
        row = db.execute("SELECT * FROM inventory WHERE id = ?", (inv_id,)).fetchone()
        if not row:
            short.append(f"item #{inv_id} no longer exists")
            continue
        sellable = round(reservations.available(db, inv_id)
                         + reservations.held_for(db, inv_id, inv["client_id"]), 6)
        if qty > sellable + 1e-9:
            short.append(f"{row['name']}: {max(sellable, 0):g} available, {qty:g} needed")
        rows[inv_id] = row
    if short:
        raise StockError("Not enough stock: " + "; ".join(short) + ".")

    wid = wha.default_warehouse_id_for_row(db, warehouse_id or _col(inv, "branch_id"))
    now = _now()
    number = inv["invoice_number"]
    cogs_total = 0.0
    for ln in lines:
        inv_id, qty = ln["inventory_id"], float(ln["quantity"])
        before = float(db.execute("SELECT quantity FROM inventory WHERE id = ?",
                                  (inv_id,)).fetchone()["quantity"] or 0)
        after = round(before - qty, 6)
        cost = lots.value_stock_out(db, inv_id, qty, source_type="sale",
                                    source_ref=number, now=now)
        cogs_total += cost
        db.execute("UPDATE inventory SET quantity = ? WHERE id = ?", (after, inv_id))
        wha.credit_warehouse_stock(db, inventory_id=inv_id, warehouse_id=wid, delta=-qty)
        db.execute(
            "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, "
            " reference, note, warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (inv_id, "sale", -qty, before, after, number, "Invoice", wid, now))
        db.execute("UPDATE invoice_items SET stock_quantity = ?, stock_unit_cost = ? WHERE id = ?",
                   (qty, round(cost / qty, 6) if qty else 0.0, ln["id"]))
        row = rows[inv_id]
        floor = float(_col(row, "min_stock", 0))
        if floor > 0 and after <= floor:
            notify(db, type="low_stock", title=f"Low stock alert: {row['name']}",
                   body=f"Only {after} {_col(row, 'unit', 'units')} remaining (minimum: {floor})",
                   msg="low_stock", params={"name": row["name"], "qty": after,
                                            "unit": _col(row, "unit", "units"), "min": floor},
                   link="/inventory", entity_type="inventory", entity_id=inv_id,
                   dedup_hours=24)

    # The customer's own reservation is what they are collecting.
    if inv["client_id"]:
        for inv_id, qty in needed.items():
            reservations.consume(db, inventory_id=inv_id, client_id=inv["client_id"],
                                 quantity=qty, closed_by=user["id"])

    cogs_total = money(cogs_total)
    if cogs_total > 0:
        accounting.post_entry(
            db, entry_date=now[:10], memo=f"Invoice COGS — {number}",
            lines=[{"code": accounting.code(db, "cogs"), "debit": cogs_total},
                   {"code": accounting.code(db, "inventory"), "credit": cogs_total}],
            source_type=SOURCE, source_id=invoice_id, created_by=user["id"],
            branch_id=_col(inv, "branch_id"))
    db.execute("UPDATE invoices SET stock_deducted_at = ?, stock_warehouse_id = ? WHERE id = ?",
               (now, wid, invoice_id))
    return {"units": round(sum(needed.values()), 6), "cost": cogs_total, "warehouse_id": wid}


def restore(db, user, invoice_id: int, *, note: str) -> float:
    """Put back what the invoice took, at the cost it left at, and unpost it.
    A no-op for an invoice that moved nothing. Does not commit."""
    inv = db.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
    if not inv or not is_deducted(inv):
        return 0.0
    now = _now()
    wid = _col(inv, "stock_warehouse_id")
    moved = 0.0
    for ln in db.execute("SELECT * FROM invoice_items WHERE invoice_id = ? "
                         "AND COALESCE(stock_quantity, 0) > 0", (invoice_id,)).fetchall():
        if not ln["inventory_id"]:
            continue
        q = float(ln["stock_quantity"])
        sale_reversal.put_back(db, inventory_id=ln["inventory_id"], quantity=q,
                               unit_cost=float(_col(ln, "stock_unit_cost", 0)),
                               warehouse_id=wid, reference=inv["invoice_number"],
                               note=note, now=now)
        moved += q
    accounting.reverse_source(db, SOURCE, invoice_id,
                              memo=f"{note} — COGS {inv['invoice_number']}",
                              created_by=user["id"] if user else None)
    db.execute("UPDATE invoice_items SET stock_quantity = 0, stock_unit_cost = 0 "
               "WHERE invoice_id = ?", (invoice_id,))
    db.execute("UPDATE invoices SET stock_deducted_at = NULL, stock_warehouse_id = NULL "
               "WHERE id = ?", (invoice_id,))
    return round(moved, 6)
