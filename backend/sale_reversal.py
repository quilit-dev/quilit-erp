"""Undoing a sale that moved goods.

Voiding an invoice used to walk back only the money. The receivable came off,
the payments were reversed, the VAT went with them — and the goods stayed gone.
Anything that had left the shelf stayed off it, and the cost of it stayed sitting
in COGS with no revenue on the other side. The trial balance still balanced, so
nothing complained: the books were merely wrong, showing a loss equal to the
cost of goods the business still owned.

Only a POS sale is undone here. It deducts at the till and posts its cost under
`pos_cogs`, and voiding it means the customer handed the goods back. An ordinary
invoice moves nothing — `inventory_id` on its lines is a reference to what was
quoted, not a movement. A service job DOES consume stock, but its parts went
into the customer's equipment: not billing for them is not the same as getting
them back, so that reversal lives on the job's own `reopen` instead.

The physical and the financial halves must move together or not at all. Putting
the goods back without reversing COGS understates cost; reversing COGS without
putting the goods back understates stock. Both live in this one place so they
cannot drift apart, and so the POS return and the invoice void cannot grow two
different ideas of what returning goods means.

## Doing it twice

Nothing here is guarded internally, because the callers already are: a POS
return refuses an invoice that is voided, and a void refuses an invoice that is
already voided. `voided_at` is the single interlock, and every path that
restocks sets it. `accounting.reverse_source` is separately idempotent, so the
ledger half is safe even if the stock half were somehow reached twice.
"""
import sqlite3
from typing import Optional

import accounting
import commitments
import lots
import warehouse_access as wha


def put_back(db: sqlite3.Connection, *, inventory_id: int, quantity: float,
             unit_cost: float, warehouse_id: Optional[int],
             reference: str, note: str, now: str) -> None:
    """One line's goods, back on the shelf and back into stock's value.

    The lot goes in at the cost it left at — the snapshot taken when the line
    was sold — not at today's moving average. Returning goods at a price they
    were never bought at would quietly re-cost the remaining stock.
    """
    if quantity <= 0:
        return
    row = db.execute("SELECT quantity FROM inventory WHERE id=?",
                     (inventory_id,)).fetchone()
    if not row:
        return
    qty_before = float(row["quantity"])
    qty_after = round(qty_before + float(quantity), 6)
    db.execute("UPDATE inventory SET quantity=? WHERE id=?",
               (qty_after, inventory_id))
    wha.credit_warehouse_stock(db, inventory_id=inventory_id,
                               warehouse_id=warehouse_id, delta=float(quantity))
    lots.record_stock_in(db, inventory_id, float(quantity), unit_cost or 0,
                         source_type="return", source_ref=reference, now=now)
    db.execute(
        "INSERT INTO stock_movements "
        "(inventory_id, type, delta, qty_before, qty_after, reference, note, "
        " warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (inventory_id, "return", float(quantity), qty_before, qty_after,
         reference, note, warehouse_id, now),
    )


def _pos_warehouse(db: sqlite3.Connection, sale) -> Optional[int]:
    """Where the goods left from, which is where they go back to.

    The register's own warehouse, read off the session that rang the sale up —
    not whichever session happens to be open now. A void can be done days
    later, from a different till, by somebody who never saw the sale.
    """
    wid = None
    try:
        sess = db.execute("SELECT warehouse_id FROM pos_sessions WHERE id=?",
                          (sale["session_id"],)).fetchone()
        if sess:
            wid = sess["warehouse_id"]
    except (IndexError, KeyError, TypeError):
        pass
    return wha.default_warehouse_id_for_row(db, wid)


def delivered_quantity(db: sqlite3.Connection, item) -> float:
    """How much of this line actually left the shelf.

    Not the same as what was invoiced. A back-ordered line is billed in full,
    but only the units that were physically there came off the count; the rest
    were a promise. Each later handover deducts what it hands over. So the stock
    this line has genuinely taken is:

        invoiced  -  promised  +  since handed over

    Putting back the invoiced quantity instead — which is what happened before —
    returns goods that never left, and the shop gains stock it never had. Sell
    five with three promised and the count went from two to five on a return.
    """
    qty = float(item["quantity"] or 0)
    try:
        invoice_item_id = item["invoice_item_id"]
    except (IndexError, KeyError):
        return qty
    if not invoice_item_id:
        return qty
    try:
        row = db.execute(
            "SELECT COALESCE(SUM(quantity_ordered), 0)   AS promised, "
            "       COALESCE(SUM(quantity_fulfilled), 0) AS handed "
            "FROM sale_commitments WHERE invoice_item_id = ?",
            (invoice_item_id,)).fetchone()
    except Exception:
        # An install without the commitments table cannot have back-ordered
        # anything, so the invoiced quantity is the delivered quantity.
        return qty
    if row is None:
        return qty
    return round(qty - float(row["promised"] or 0) + float(row["handed"] or 0), 6)


def restock_pos_sale(db: sqlite3.Connection, sale, invoice, *, note: str,
                     now: str, warehouse_id: Optional[int] = None) -> float:
    """Return every inventory-backed line of a till sale. Returns units moved."""
    wid = warehouse_id if warehouse_id is not None else _pos_warehouse(db, sale)
    moved = 0.0
    for it in db.execute(
        "SELECT * FROM pos_sale_items "
        "WHERE pos_sale_id=? AND inventory_id IS NOT NULL", (sale["id"],)
    ).fetchall():
        # What left the shelf, which on a back-ordered line is less than what
        # was invoiced.
        qty = delivered_quantity(db, it)
        if qty <= 0:
            continue
        put_back(db, inventory_id=it["inventory_id"], quantity=qty,
                 unit_cost=it["unit_cost"] or 0, warehouse_id=wid,
                 reference=invoice["invoice_number"], note=note, now=now)
        moved += qty
        # A returned line hands its allowance back to the campaign.
        #
        # KNOWN, DEFERRED: this gives back `int(qty)` of the whole line, while
        # checkout only consumed the CAPPED eligible count (routers/pos.py,
        # `_promo_left`). Where the cap truncated the line the campaign gets
        # back more allowance than the sale took and can oversell its cap; the
        # int() also truncates fractional quantities. Fixing it properly means
        # recording the eligible count on the line at checkout — a column, and
        # a schema change in three places — which is more than this defect
        # justifies. The error is one-directional and small: the campaign is
        # never short-changed, only over-credited.
        if it["promotion_id"]:
            db.execute(
                "UPDATE promotions SET used_quantity = MAX(0, used_quantity - ?) "
                "WHERE id = ?", (int(qty), it["promotion_id"]),
            )
    return moved


def reverse_fulfilment(db: sqlite3.Connection, invoice, *, note: str,
                       user_id: Optional[int], now: str) -> dict:
    """Put back whatever this invoice took out, and unpost what it cost.

    Safe to call for any invoice: one that never moved goods reports zeroes and
    touches nothing.
    """
    out = {"source": None, "units": 0.0, "commitments_cancelled": 0}

    sale = db.execute("SELECT * FROM pos_sales WHERE invoice_id=?",
                      (invoice["id"],)).fetchone()
    if sale and sale["status"] != "returned":
        accounting.reverse_source(
            db, "pos_cogs", invoice["id"],
            memo=f"{note} — COGS {invoice['invoice_number']}", created_by=user_id)
        out["units"] = restock_pos_sale(db, sale, invoice, note=note, now=now)
        db.execute("UPDATE pos_sales SET status='returned', returned_at=? WHERE id=?",
                   (now, sale["id"]))
        out["source"] = "pos_sale"

    # A service job is deliberately NOT reversed here. Its parts were fitted
    # into the customer's equipment; deciding not to bill for the work does not
    # bring them back out. Returning them is a separate, explicit act — the
    # job's own `reopen`, which restocks and reverses `service_cogs` together,
    # and which already refuses to run until this invoice is voided. Doing it
    # here as well returned every part twice.

    # Goods promised and not yet handed over are not an obligation any more:
    # the sale they were promised under no longer exists, and the money behind
    # them has already been reversed with the payment. Left open they would
    # keep the customer on the collection list and quietly reserve the next
    # delivery for a sale that was cancelled.
    out["commitments_cancelled"] = commitments.cancel_for_invoice(
        db, invoice["id"], closed_by=user_id)
    return out
