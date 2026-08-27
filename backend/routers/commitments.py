"""What customers have paid for and not yet received.

The till records the promise; this is where it is kept, met and, when it has to
be, given up on. See `commitments.py` for why a promise is not inventory and
why the money waits in deferred revenue until the goods are handed over.
"""
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import accounting
import commitments as core
import lots
import reservations
import warehouse_access as wha
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, money, notify

router = APIRouter()


class DeliverBody(BaseModel):
    quantity: Optional[float] = None      # default: everything that is ready
    note:     Optional[str] = None


class CancelBody(BaseModel):
    reason:          Optional[str] = None
    # Cash back over the counter, or left on the customer's account. A shop
    # that has already banked the money often prefers the second.
    refund:          bool = True
    refund_method:   str = "Cash"
    bank_account_id: Optional[int] = None
    idempotency_key: Optional[str] = None


def _row(db, commitment_id: int):
    row = db.execute(
        "SELECT sc.*, i.name AS item_name, i.unit, i.unit_cost, "
        "       c.name AS client_name, inv.invoice_number, inv.currency "
        "FROM sale_commitments sc "
        "JOIN inventory i ON i.id = sc.inventory_id "
        "JOIN clients c   ON c.id = sc.client_id "
        "LEFT JOIN invoices inv ON inv.id = sc.invoice_id "
        "WHERE sc.id=?", (commitment_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Commitment not found.")
    return row


def _revenue_code(db, row):
    """Where this line's revenue belongs — the account the invoice line named,
    or the default. Goods and services are not the same turnover."""
    if row["invoice_item_id"]:
        item = db.execute("SELECT revenue_account FROM invoice_items WHERE id=?",
                          (row["invoice_item_id"],)).fetchone()
        if item and item["revenue_account"]:
            return item["revenue_account"]
    return accounting.code(db, "revenue")


# ── Reading ──────────────────────────────────────────────────────────────────

@router.get("/")
def list_commitments(
    status:       Optional[str] = None,
    client_id:    Optional[int] = None,
    inventory_id: Optional[int] = None,
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Who is waiting for what.

    Defaults to the open ones, because that is the question anybody opening
    this list is asking. `ready` is what is on the shelf with their name on it
    — the difference between "we are still waiting" and "come and collect it".
    """
    where, params = ["1=1"], []
    where.append("sc.status = ?")
    params.append(status or core.AWAITING)
    for col, val in (("sc.client_id", client_id), ("sc.inventory_id", inventory_id)):
        if val:
            where.append(f"{col} = ?")
            params.append(val)

    rows = db.execute(
        "SELECT sc.*, i.name AS item_name, i.unit, c.name AS client_name, "
        "       c.phone AS client_phone, inv.invoice_number, "
        "       COALESCE(NULLIF(u.full_name,''), u.username) AS sold_by "
        "FROM sale_commitments sc "
        "JOIN inventory i ON i.id = sc.inventory_id "
        "JOIN clients c   ON c.id = sc.client_id "
        "LEFT JOIN invoices inv ON inv.id = sc.invoice_id "
        "LEFT JOIN users u ON u.id = sc.created_by "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY sc.created_at, sc.id", params).fetchall()

    out = []
    for r in rows:
        d = dict(r)
        d["outstanding"] = round(float(r["quantity_ordered"])
                                 - float(r["quantity_fulfilled"]), 6)
        d["ready"] = core.ready(r)
        d["value"] = money((float(r["unit_price"])) * d["outstanding"])
        out.append(d)
    return out


@router.get("/count")
def open_count(
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """For the badge. `ready` is the number somebody should act on today."""
    row = db.execute(
        "SELECT COUNT(*) AS n, "
        "       COALESCE(SUM(CASE WHEN quantity_allocated > 0 THEN 1 ELSE 0 END), 0) AS ready "
        "FROM sale_commitments WHERE status=?", (core.AWAITING,)).fetchone()
    return {"open": int(row["n"] or 0), "ready": int(row["ready"] or 0)}


# ── Meeting the promise ─────────────────────────────────────────────────────

@router.post("/{commitment_id}/deliver")
def deliver(
    commitment_id: int,
    data: DeliverBody,
    user=Depends(require_perm("pos", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Hand the goods over.

    This is where the sale finally happens for these units: the stock leaves,
    its cost is recognised, and the money that has been sitting in deferred
    revenue since the till becomes revenue. Revenue and cost land in the same
    period, which is the whole point of having waited.

    No register session is needed. The money moved at the till, possibly on
    another day and by somebody else; collecting is a stock event.
    """
    row = _row(db, commitment_id)
    if row["status"] != core.AWAITING:
        raise HTTPException(409, f"This commitment is already {row['status']}.")

    ready = core.ready(row)
    outstanding_now = round(float(row["quantity_ordered"])
                            - float(row["quantity_fulfilled"]), 6)
    if ready <= 0:
        # "Nothing to hand over" is true and useless. The person asking is
        # standing in front of a customer and needs to know which of the two
        # answers it is: it has not arrived, or it has and nobody matched it.
        raise HTTPException(
            400, f"None of the {outstanding_now:g} {row['unit'] or 'units'} of "
                 f"'{row['item_name']}' owed to {row['client_name']} has arrived "
                 "yet — it has still to come in.")
    qty = float(data.quantity) if data.quantity is not None else ready
    qty = round(qty, 6)
    if qty <= 0:
        raise HTTPException(400, "Nothing to hand over.")
    outstanding = round(float(row["quantity_ordered"])
                        - float(row["quantity_fulfilled"]), 6)
    if qty - outstanding > 1e-6:
        raise HTTPException(
            400, f"Only {outstanding:g} is still owed on this commitment.")
    if qty - ready > 1e-6:
        raise HTTPException(
            400, f"Only {ready:g} {row['unit'] or 'units'} of "
                 f"'{row['item_name']}' has arrived for {row['client_name']}. "
                 "The rest has still to come in.")

    now = _now()
    # The period the goods actually leave in — not the one the money arrived in.
    from routers.pos import _check_period_locked
    _check_period_locked(db, now[:7] + "-01")

    inv = db.execute("SELECT * FROM inventory WHERE id=?",
                     (row["inventory_id"],)).fetchone()
    qty_before = float(inv["quantity"])
    if round(qty_before - qty, 6) < 0:
        raise HTTPException(400, f"Only {qty_before:g} of '{row['item_name']}' "
                                 "is physically in stock.")
    wid = wha.default_warehouse_id_for_row(db, row["warehouse_id"])

    # Cost is taken at DELIVERY, because that is what these goods cost. The
    # price the customer paid was fixed months ago; what it cost to honour it
    # was not.
    cogs = lots.value_stock_out(db, row["inventory_id"], qty,
                                source_type="sale",
                                source_ref=row["invoice_number"], now=now)
    qty_after = round(qty_before - qty, 6)
    db.execute("UPDATE inventory SET quantity=? WHERE id=?",
               (qty_after, row["inventory_id"]))
    wha.credit_warehouse_stock(db, inventory_id=row["inventory_id"],
                               warehouse_id=wid, delta=-qty)
    db.execute(
        "INSERT INTO stock_movements "
        "(inventory_id, type, delta, qty_before, qty_after, reference, note, "
        " warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (row["inventory_id"], "sale", -qty, qty_before, qty_after,
         row["invoice_number"], f"Collected by {row['client_name']}", wid, now))

    # The hold that was keeping it for them has done its job.
    reservations.consume(db, inventory_id=row["inventory_id"],
                         client_id=row["client_id"], quantity=qty,
                         closed_by=user["id"])

    d = db.execute(
        "INSERT INTO commitment_deliveries "
        "(commitment_id, quantity, unit_cost, warehouse_id, note, created_at, created_by) "
        "VALUES (?,?,?,?,?,?,?)",
        (commitment_id, qty, round(cogs / qty, 6) if qty else 0.0, wid,
         data.note, now, user["id"]))
    delivery_id = d.lastrowid

    # The money stops being a liability and becomes turnover. VAT was settled
    # at the till and is not touched.
    gross = money(float(row["unit_price"]) * qty)
    vat = money(float(row["unit_tax"]) * qty)
    net = money(gross - vat)
    if net > 0:
        accounting.post_entry(
            db, entry_date=now[:10],
            memo=f"Delivered — {row['invoice_number']} ({row['item_name']})",
            lines=[
                {"code": accounting.code(db, "deferred_revenue"), "debit": net,
                 "memo": "Goods handed over"},
                {"code": _revenue_code(db, row), "credit": net},
            ],
            source_type="commitment_delivered", source_id=delivery_id,
            created_by=user["id"], branch_id=wid)
    if cogs > 0:
        accounting.post_entry(
            db, entry_date=now[:10],
            memo=f"Delivered COGS — {row['invoice_number']}",
            lines=[
                {"code": accounting.code(db, "cogs"), "debit": cogs},
                {"code": accounting.code(db, "inventory"), "credit": cogs},
            ],
            source_type="commitment_cogs", source_id=delivery_id,
            created_by=user["id"], branch_id=wid)

    state = core.mark_fulfilled(db, commitment_id, qty, closed_by=user["id"])
    log_action(db, user, "deliver", "commitment", commitment_id,
               row["invoice_number"],
               {"quantity": qty, "client": row["client_name"], "cogs": cogs})
    db.commit()
    return {"message": "Handed over", "delivered": qty,
            "outstanding": state["outstanding"], "cogs": cogs}


# ── Giving up on it ─────────────────────────────────────────────────────────

@router.post("/{commitment_id}/cancel")
def cancel(
    commitment_id: int,
    data: CancelBody,
    user=Depends(require_perm("pos", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """The goods are not coming, or the customer no longer wants them.

    The money goes back: it was never earned. Anything already put aside for
    them returns to free stock, and the reservation is closed as released
    rather than collected, because nobody collected anything.
    """
    row = _row(db, commitment_id)
    if row["status"] != core.AWAITING:
        raise HTTPException(409, f"This commitment is already {row['status']}.")

    now = _now()
    from routers.pos import _check_period_locked
    _check_period_locked(db, now[:7] + "-01")

    result = core.cancel(db, commitment_id, closed_by=user["id"])
    outstanding = result["outstanding"]

    gross = money(float(row["unit_price"]) * outstanding)
    vat = money(float(row["unit_tax"]) * outstanding)
    net = money(gross - vat)

    if data.refund and gross > 0:
        # Deferred revenue was never income, so refunding it is not a loss —
        # it is handing back money that was always the customer's if the goods
        # did not arrive. The VAT charged on it goes back too.
        cash_code = accounting.money_account_for(
            db, method=data.refund_method, currency=row["currency"] or "USD",
            bank_account_id=data.bank_account_id)
        lines = [{"code": accounting.code(db, "deferred_revenue"), "debit": net,
                  "memo": "Order cancelled"}]
        if vat > 0:
            lines.append({"code": accounting.code(db, "vat_output"), "debit": vat,
                          "memo": "VAT on cancelled order"})
        lines.append({"code": cash_code, "credit": gross,
                      "memo": f"Refund — {row['client_name']}"})
        accounting.post_entry(
            db, entry_date=now[:10],
            memo=f"Cancelled — {row['invoice_number']} ({row['item_name']})",
            lines=lines, source_type="commitment_cancelled",
            source_id=commitment_id, created_by=user["id"])

    notify(db, user_id=row["created_by"], type="commitment_cancelled",
           title=f"Order cancelled: {row['item_name']}",
           body=f"{outstanding:g} for {row['client_name']} — "
                f"{data.reason or 'no reason given'}",
           link="/pos", entity_type="sale_commitment", entity_id=commitment_id)
    log_action(db, user, "cancel", "commitment", commitment_id,
               row["invoice_number"],
               {"quantity": outstanding, "refunded": gross if data.refund else 0,
                "reason": data.reason})
    db.commit()
    return {"message": "Commitment cancelled",
            "cancelled": outstanding,
            "released_to_stock": result["released"],
            "refunded": gross if data.refund else 0.0}


# ── The safety net ──────────────────────────────────────────────────────────

@router.post("/allocate/{inventory_id}")
def allocate_now(
    inventory_id: int,
    user=Depends(require_perm("pos", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Match free stock against who is waiting, on demand.

    Receipts do this on their own. This exists for the stock that arrives some
    other way — an adjustment, a correction, a count — and for the moment
    somebody is looking at a full shelf and a waiting customer and wants to
    know why the two have not met.
    """
    filled = core.allocate(db, inventory_id, allocated_by=user["id"])
    core.notify_allocated(db, filled, source="stock on hand")
    db.commit()
    return {"allocated": filled,
            "total": round(sum(f["quantity"] for f in filled), 6)}
