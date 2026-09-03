"""Goods sold and paid for that the business does not have yet.

A customer wants five, the shelf has two, the manager says the other three can
be got. The customer pays for five and goes home. What does the system hold?

Not negative stock: `inventory.quantity` is what is physically there, and a
count that can go below zero stops being a count. Not a reservation either —
`stock_reservations` holds stock that EXISTS, and reserving three units nobody
owns drives `reservations.available()` negative, which is the same lie wearing
a different hat.

So there are two mechanisms, meeting at the moment the goods arrive:

    sale with a shortfall  →  COMMITMENT      nothing in the stock tables
                                   ↓  goods received
                              RESERVATION     stock is real, and held for them
                                   ↓  customer collects
                              ordinary sale movement: stock out, COGS, revenue

A commitment guards the future; a reservation guards the present. Receipt is
where one becomes the other, which is why nothing here duplicates the
reservation module — it starts where that one stops.

## What the money does

The till takes the cash for all five units. Three of them are not the
business's to earn yet: the customer has paid for goods they do not have, and
until they get them the business owes either the goods or the money back. That
is a liability, and the chart already has the account for it.

    At the till                        On delivery
      DR  Cash          gross            DR  2400 Deferred    net of that qty
        CR VAT output   all of the tax      CR 4000 Revenue    same
        CR Revenue      delivered net     DR  5000 COGS        cost at delivery
        CR 2400 Deferred undelivered net    CR 1200 Inventory  same

VAT is recognised in full at the till and never touched again: the invoice was
issued and the money was taken, which is what makes the tax due. Deferring it
would understate the liability and change filing behaviour, and no part of this
is meant to change when tax is owed.

Revenue and COGS therefore land in the SAME period — the delivery period —
instead of revenue showing at the till with its cost arriving weeks later and
a hundred per cent margin in between.

## Availability

Committed quantity is NOT subtracted from availability. Those units were never
in `quantity`, so subtracting them counts the shortfall twice. `available()`
stays exactly what it was.
"""
import sqlite3
from typing import Optional

import reservations
from utils import _now

AWAITING = "awaiting"
FULFILLED = "fulfilled"
CANCELLED = "cancelled"

# The same tolerance the rest of the stock code compares quantities at, so a
# fully-fulfilled commitment cannot leave a floating-point crumb behind that
# reads as still owed.
_EPS = 1e-6


# ── Reading ──────────────────────────────────────────────────────────────────

def owed(db: sqlite3.Connection, inventory_id: int) -> float:
    """How much of this item is promised to customers and not yet handed over.

    Reported beside availability rather than subtracted from it. It is a claim
    on stock that does not exist; the shelf count is unaffected.
    """
    row = db.execute(
        "SELECT COALESCE(SUM(quantity_ordered - quantity_fulfilled), 0) AS q "
        "FROM sale_commitments WHERE inventory_id=? AND status=?",
        (inventory_id, AWAITING)).fetchone()
    return round(float(row["q"] or 0), 6)


def open_for(db: sqlite3.Connection, inventory_id: int) -> list:
    """Open commitments for one item, oldest first — the order they are owed."""
    return db.execute(
        "SELECT * FROM sale_commitments WHERE inventory_id=? AND status=? "
        "ORDER BY created_at, id", (inventory_id, AWAITING)).fetchall()


# ── Creating ─────────────────────────────────────────────────────────────────

def create(db: sqlite3.Connection, *, invoice_id: int, invoice_item_id: int,
           inventory_id: int, client_id: int, quantity: float,
           unit_price: float, unit_tax: float = 0.0,
           warehouse_id: Optional[int] = None,
           promised_date: Optional[str] = None,
           approved_by: Optional[int] = None,
           created_by: Optional[int] = None) -> int:
    """Record that `quantity` of an item is owed to a customer.

    A commitment needs somebody to give the goods to, so `client_id` is not
    optional — the same rule the instalment path already enforces, and for the
    same reason: an anonymous walk-in leaves an obligation nobody can discharge.
    """
    quantity = round(float(quantity), 6)
    if quantity <= 0:
        raise ValueError("A commitment needs a positive quantity.")
    if client_id is None:
        raise ValueError(
            "A sale of stock you do not have needs a customer: somebody has to "
            "be given the goods when they arrive.")

    item = db.execute("SELECT name, archived_at FROM inventory WHERE id=?",
                      (inventory_id,)).fetchone()
    if item is None:
        raise ValueError("Inventory item not found.")
    if item["archived_at"]:
        raise ValueError("An archived item cannot be promised to a customer.")

    cur = db.execute(
        "INSERT INTO sale_commitments "
        "(invoice_id, invoice_item_id, inventory_id, client_id, "
        " quantity_ordered, quantity_fulfilled, unit_price, unit_tax, status, "
        " warehouse_id, promised_date, approved_by, created_at, created_by) "
        "VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?,?)",
        (invoice_id, invoice_item_id, inventory_id, client_id, quantity,
         round(float(unit_price), 6), round(float(unit_tax), 6), AWAITING,
         warehouse_id, promised_date, approved_by, _now(), created_by))
    return cur.lastrowid


# ── Allocation: the moment stock becomes real ────────────────────────────────

def allocate(db: sqlite3.Connection, inventory_id: int, *,
             warehouse_id: Optional[int] = None,
             allocated_by: Optional[int] = None) -> list:
    """Hand newly-arrived stock to the customers already waiting for it.

    Called after ANY increase in stock — a purchase received, a transfer
    landed, production finished, a positive adjustment. Without it the first
    walk-in through the door buys the units a paying customer is waiting for,
    and the shop has to explain itself.

    Oldest commitment first, which is the rule a customer expects and the only
    one that does not need explaining. A commitment only partly covered stays
    open for the rest.

    What it creates is an ordinary `stock_reservations` hold, so from here the
    stock is protected by the machinery that already exists: availability drops,
    the till refuses to sell it to somebody else, and the customer collecting
    draws it down. Returns the rows it touched, for notifying.
    """
    filled = []
    for row in open_for(db, inventory_id):
        free = reservations.available(db, inventory_id)
        if free <= _EPS:
            break
        # What this commitment still needs: ordered, less what has been handed
        # over, less what is already on the shelf with its name on it. Counted
        # on the ROW rather than from the customer's holds, because one
        # customer can be waiting on the same item under two commitments and
        # the second would otherwise see the first one's stock as its own.
        want = round(float(row["quantity_ordered"])
                     - float(row["quantity_fulfilled"])
                     - float(row["quantity_allocated"] or 0), 6)
        if want <= _EPS:
            continue
        take = round(min(want, free), 6)
        if take <= _EPS:
            continue
        reservations.hold(
            db, inventory_id=inventory_id, client_id=row["client_id"],
            quantity=take, warehouse_id=warehouse_id or row["warehouse_id"],
            note=f"Awaiting collection — commitment #{row['id']}",
            created_by=allocated_by)
        db.execute("UPDATE sale_commitments SET quantity_allocated=? WHERE id=?",
                   (round(float(row["quantity_allocated"] or 0) + take, 6),
                    row["id"]))
        filled.append({"commitment_id": row["id"], "client_id": row["client_id"],
                       "quantity": take, "invoice_id": row["invoice_id"],
                       "created_by": row["created_by"]})
    return filled


def ready(row) -> float:
    """How much of this commitment is on the shelf with the customer's name on
    it — allocated and not yet handed over."""
    return round(float(row["quantity_allocated"] or 0), 6)


# ── Closing ──────────────────────────────────────────────────────────────────

def notify_allocated(db, filled, *, source: str):
    """Tell whoever made the sale that what they promised has arrived.

    They are the one the customer will ring, and the one who has to decide
    whether to call them or wait for the rest of the order.
    """
    if not filled:
        return
    from utils import notify
    for f in filled:
        row = db.execute(
            "SELECT c.name AS client, i.name AS item, i.unit "
            "FROM sale_commitments sc "
            "JOIN clients c ON c.id = sc.client_id "
            "JOIN inventory i ON i.id = sc.inventory_id "
            "WHERE sc.id=?", (f["commitment_id"],)).fetchone()
        if not row:
            continue
        notify(
            db, user_id=f.get("created_by"),
            type="commitment_ready",
            title=f"Ready for {row['client']}: {row['item']}",
            body=f"{f['quantity']:g} {row['unit'] or 'units'} arrived ({source}). "
                 f"{row['client']} has already paid for it.",
            link="/pos", entity_type="sale_commitment",
            entity_id=f["commitment_id"], dedup_hours=1)


def mark_fulfilled(db: sqlite3.Connection, commitment_id: int, quantity: float,
                   *, closed_by: Optional[int] = None) -> dict:
    """Record that `quantity` was handed over. Closes the row when it is done."""
    row = db.execute("SELECT * FROM sale_commitments WHERE id=?",
                     (commitment_id,)).fetchone()
    if row is None:
        raise ValueError("Commitment not found.")
    if row["status"] != AWAITING:
        raise ValueError("This commitment is already %s." % row["status"])

    done = round(float(row["quantity_fulfilled"]) + float(quantity), 6)
    outstanding = round(float(row["quantity_ordered"]) - done, 6)
    # Handing the goods over spends the allocation that was holding them.
    left = max(0.0, round(float(row["quantity_allocated"] or 0)
                          - float(quantity), 6))
    if outstanding <= _EPS:
        db.execute(
            "UPDATE sale_commitments SET quantity_fulfilled=?, quantity_allocated=?, "
            "status=?, closed_at=?, closed_by=? WHERE id=?",
            (float(row["quantity_ordered"]), left, FULFILLED, _now(), closed_by,
             commitment_id))
    else:
        db.execute("UPDATE sale_commitments SET quantity_fulfilled=?, "
                   "quantity_allocated=? WHERE id=?",
                   (done, left, commitment_id))
    return {"fulfilled": done, "outstanding": max(0.0, outstanding)}


def cancel(db: sqlite3.Connection, commitment_id: int, *,
           closed_by: Optional[int] = None) -> dict:
    """Give up on a commitment, releasing anything held for it.

    The refund is posted by the caller: this module moves stock and state, not
    money. Any allocation already made goes back to free stock, because the
    customer who was waiting for it no longer is.
    """
    row = db.execute("SELECT * FROM sale_commitments WHERE id=?",
                     (commitment_id,)).fetchone()
    if row is None:
        raise ValueError("Commitment not found.")
    if row["status"] != AWAITING:
        raise ValueError("This commitment is already %s." % row["status"])

    outstanding = round(float(row["quantity_ordered"])
                        - float(row["quantity_fulfilled"]), 6)
    released = 0.0
    allocated = round(float(row["quantity_allocated"] or 0), 6)
    if allocated > _EPS:
        # Drawn down rather than closed outright: the same customer may be
        # holding stock for a different commitment, and released rather than
        # collected, because nobody collected anything.
        released = reservations.consume(
            db, inventory_id=row["inventory_id"], client_id=row["client_id"],
            quantity=allocated, closed_by=closed_by,
            status=reservations.RELEASED)

    db.execute("UPDATE sale_commitments SET status=?, quantity_allocated=0, "
               "closed_at=?, closed_by=? WHERE id=?",
               (CANCELLED, _now(), closed_by, commitment_id))
    return {"outstanding": outstanding, "released": released}


def cancel_for_invoice(db: sqlite3.Connection, invoice_id: int, *,
                       closed_by: Optional[int] = None) -> int:
    """Close every open promise made on one invoice. Returns how many.

    For when the sale itself is undone — a void, a full return. The money side
    is the caller's business and by that point is usually already reversed with
    the payment; this releases the holds and takes the customer off the
    collection list, because there is no longer a sale to collect against.
    """
    rows = db.execute(
        "SELECT id FROM sale_commitments WHERE invoice_id=? AND status=?",
        (invoice_id, AWAITING)).fetchall()
    for row in rows:
        cancel(db, row["id"], closed_by=closed_by)
    return len(rows)


def reverse_deliveries(db: sqlite3.Connection, invoice_id: int, *,
                       memo: str, created_by: Optional[int] = None) -> int:
    """Walk back the ledger for goods already handed over on this invoice.

    A handover posts two entries — the deferred revenue it releases and the
    cost of the goods — both keyed by the DELIVERY's id, not the invoice's. So
    undoing the sale never found them: the reversal walks `invoice_payment`,
    `pos_cogs` and `invoice`, and those three do not include these two.

    The effect was revenue and cost left standing for goods that had come back,
    on a trial balance that still balanced. The stock half is handled elsewhere
    — `sale_reversal.delivered_quantity` counts fulfilled units as having left
    the shelf, so they are restocked — but the money stayed posted.

    Returns how many entries were reversed. `reverse_source` is a no-op on
    anything already reversed, so calling this twice is safe.
    """
    try:
        rows = db.execute(
            "SELECT d.id FROM commitment_deliveries d "
            "JOIN sale_commitments sc ON sc.id = d.commitment_id "
            "WHERE sc.invoice_id = ?", (invoice_id,)).fetchall()
    except Exception:
        # An install with no commitments tables cannot have delivered anything.
        return 0

    import accounting
    reversed_count = 0
    for row in rows:
        for source_type in ("commitment_delivered", "commitment_cogs"):
            if accounting.reverse_source(db, source_type, row["id"],
                                         memo=memo, created_by=created_by):
                reversed_count += 1
    return reversed_count

