"""Holding stock for a named customer.

`inventory.reserved_quantity` has existed since manufacturing needed it, and it
is a bare number. It is enough to subtract from availability and not enough for
anything else: it cannot say whose reservation it is, so releasing one is
guesswork — take three units off the counter and you may have taken them off
somebody else's hold — and it cannot be shown to the person asking "who is that
for?".

So the counter STAYS. It remains the aggregate every availability check already
reads, manufacturing's arithmetic is untouched, and this module adds the rows
behind it that say who each customer hold belongs to. The counter and the rows
are written together, in the same transaction, and `sync` recomputes the
customer share from the rows so the two cannot drift.

Nothing here posts to the ledger. Reserved goods are still on hand and still
ours; a reservation moves no value, and inventing a transaction for it would
put something in the books that did not happen. The accounting happens when the
customer collects, which is an ordinary sale.
"""
import sqlite3
from typing import Optional

from utils import _now


HELD      = "held"
RELEASED  = "released"
COLLECTED = "collected"

# Quantities are compared at six decimal places everywhere else in the stock
# code; the same tolerance keeps a fully-collected hold from leaving a
# floating-point crumb that reads as still reserved.
_EPS = 1e-6


def _customer_held(db: sqlite3.Connection, inventory_id: int) -> float:
    row = db.execute(
        "SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_reservations "
        "WHERE inventory_id=? AND status=?", (inventory_id, HELD)).fetchone()
    return float(row["q"] or 0)


def production_share(db: sqlite3.Connection, inventory_id: int) -> float:
    """Whatever of the counter is NOT accounted for by customer rows.

    Manufacturing writes straight to the counter and keeps no rows here, so its
    share is the remainder. Deriving it this way means the two mechanisms can
    share one number without either having to know about the other.

    It MUST be read before the customer rows are changed. Read afterwards, a
    release looks like production's share growing by exactly what was freed —
    the counter never drops and the stock stays locked forever.
    """
    row = db.execute("SELECT COALESCE(reserved_quantity, 0) AS r FROM inventory "
                     "WHERE id=?", (inventory_id,)).fetchone()
    total = float(row["r"] or 0) if row else 0.0
    return max(0.0, total - _customer_held(db, inventory_id))


def sync(db: sqlite3.Connection, inventory_id: int, production: float) -> float:
    """Rewrite the counter as production's share plus the live customer rows.

    `production` is the share read BEFORE the change (see `production_share`).
    Recomputing the total rather than incrementing it is what stops a double
    release from freeing the stock twice.
    """
    total = round(production + _customer_held(db, inventory_id), 6)
    db.execute("UPDATE inventory SET reserved_quantity=? WHERE id=?",
               (total, inventory_id))
    return total


def available(db: sqlite3.Connection, inventory_id: int) -> float:
    """On hand minus everything spoken for. What may actually be sold."""
    row = db.execute(
        "SELECT COALESCE(quantity, 0) AS q, COALESCE(reserved_quantity, 0) AS r "
        "FROM inventory WHERE id=?", (inventory_id,)).fetchone()
    if not row:
        return 0.0
    return round(float(row["q"] or 0) - float(row["r"] or 0), 6)


def held_for(db: sqlite3.Connection, inventory_id: int,
             client_id: Optional[int]) -> float:
    """What this customer is holding of this item.

    The reason the counter alone was not enough: a customer collecting their
    own reservation must not be blocked by it, and nobody else may touch it.
    """
    if client_id is None:
        return 0.0
    row = db.execute(
        "SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_reservations "
        "WHERE inventory_id=? AND client_id=? AND status=?",
        (inventory_id, client_id, HELD)).fetchone()
    return float(row["q"] or 0)


def hold(db: sqlite3.Connection, *, inventory_id: int, client_id: int,
         quantity: float, note: str = None, warehouse_id: int = None,
         created_by: int = None) -> int:
    """Put `quantity` aside for a customer. Returns the reservation id.

    Raises ValueError when there is not enough free stock — a promise the shop
    cannot keep is worse than a refusal at the moment of asking.
    """
    quantity = round(float(quantity), 6)
    if quantity <= 0:
        raise ValueError("A reservation needs a positive quantity.")

    item = db.execute("SELECT name, archived_at FROM inventory WHERE id=?",
                      (inventory_id,)).fetchone()
    if item is None:
        raise ValueError("Inventory item not found.")
    if item["archived_at"]:
        raise ValueError("An archived item cannot be reserved.")

    free = available(db, inventory_id)
    if quantity - free > _EPS:
        raise ValueError(
            f"Only {free:g} of '{item['name']}' is available to reserve "
            f"({quantity:g} requested).")

    production = production_share(db, inventory_id)
    cur = db.execute(
        "INSERT INTO stock_reservations "
        "(inventory_id, client_id, quantity, status, note, warehouse_id, "
        " created_at, created_by) VALUES (?,?,?,?,?,?,?,?)",
        (inventory_id, client_id, quantity, HELD, note, warehouse_id,
         _now(), created_by))
    sync(db, inventory_id, production)
    return cur.lastrowid


def close(db: sqlite3.Connection, reservation_id: int, *, status: str,
          closed_by: int = None) -> bool:
    """Release or collect one reservation. False if it was already closed.

    Idempotent on purpose: a second release must not free the stock a second
    time, which is exactly what a bare counter could not defend against.
    """
    row = db.execute("SELECT * FROM stock_reservations WHERE id=?",
                     (reservation_id,)).fetchone()
    if row is None:
        raise ValueError("Reservation not found.")
    if row["status"] != HELD:
        return False

    production = production_share(db, row["inventory_id"])
    db.execute("UPDATE stock_reservations SET status=?, closed_at=?, closed_by=? "
               "WHERE id=?", (status, _now(), closed_by, reservation_id))
    sync(db, row["inventory_id"], production)
    return True


def consume(db: sqlite3.Connection, *, inventory_id: int, client_id: int,
            quantity: float, closed_by: int = None,
            status: str = COLLECTED) -> float:
    """The customer collected some of what was held for them.

    Their own holds are drawn down oldest first, and a hold only partly
    collected is reduced rather than closed. Returns how much was actually
    drawn — less than asked for when they bought more than they had reserved,
    which is fine: the surplus came out of free stock.

    Anyone else's reservations are never touched.

    `status` is what a fully-drawn hold is closed as. It defaults to COLLECTED
    because that is what almost always happened, but a cancelled order gives
    the stock back without anybody collecting anything, and a row that says
    otherwise is a row that misreports the day it describes.
    """
    remaining = round(float(quantity), 6)
    if remaining <= 0 or client_id is None:
        return 0.0

    production = production_share(db, inventory_id)
    drawn = 0.0
    for row in db.execute(
        "SELECT id, quantity FROM stock_reservations "
        "WHERE inventory_id=? AND client_id=? AND status=? ORDER BY id",
        (inventory_id, client_id, HELD),
    ).fetchall():
        if remaining <= _EPS:
            break
        take = min(remaining, float(row["quantity"]))
        if float(row["quantity"]) - take <= _EPS:
            db.execute(
                "UPDATE stock_reservations SET status=?, closed_at=?, closed_by=? "
                "WHERE id=?", (status, _now(), closed_by, row["id"]))
        else:
            db.execute("UPDATE stock_reservations SET quantity=? WHERE id=?",
                       (round(float(row["quantity"]) - take, 6), row["id"]))
        remaining = round(remaining - take, 6)
        drawn = round(drawn + take, 6)

    if drawn > 0:
        sync(db, inventory_id, production)
    return drawn
