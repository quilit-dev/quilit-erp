"""
Batch / lot tracking with expiry and traceability.

Per-item opt-in (`inventory.lot_tracked`). For a lot-tracked item every stock-IN
creates a **lot** (with manufacture / expiry dates) and every stock-OUT draws
lots **First-Expired-First-Out (FEFO)** — recording each draw for full
forward/backward traceability and taking COGS from the consumed lots' own cost
(specific identification). This replaces the generic FIFO/LIFO/WA cost layers
*for these items only*; non-lot items are untouched and keep the global method.

`inventory.unit_cost` is kept as the weighted average of remaining lots so the
inventory list, valuation and reports still show a sensible per-unit cost.

Two convenience wrappers, `record_stock_in` and `value_stock_out`, branch on
`lot_tracked` and otherwise delegate to `costing` — so a caller can route every
stock movement through them and lot-tracked vs non-lot items just work.

Like costing.py, every function takes an open connection and never commits.
"""
import sqlite3
from datetime import date, timedelta
from utils import _now, money

_EPS = 1e-9


def is_lot_tracked(db: sqlite3.Connection, inventory_id: int) -> bool:
    row = db.execute("SELECT lot_tracked FROM inventory WHERE id=?", (inventory_id,)).fetchone()
    return bool(row and row["lot_tracked"])


def _expiry_from_shelf_life(db, inventory_id, manufacture_date):
    if not manufacture_date:
        return None
    row = db.execute("SELECT shelf_life_days FROM inventory WHERE id=?", (inventory_id,)).fetchone()
    days = row["shelf_life_days"] if row else None
    if not days:
        return None
    try:
        d = date.fromisoformat(str(manufacture_date)[:10])
        return (d + timedelta(days=int(days))).isoformat()
    except (ValueError, TypeError):
        return None


def _recompute_unit_cost(db, inventory_id):
    """Keep inventory.unit_cost = weighted average of the remaining lots."""
    row = db.execute(
        "SELECT COALESCE(SUM(quantity_remaining),0) AS q, "
        "       COALESCE(SUM(quantity_remaining * unit_cost),0) AS v "
        "FROM inventory_lots WHERE inventory_id=? AND quantity_remaining > ?",
        (inventory_id, _EPS),
    ).fetchone()
    q = float(row["q"])
    if q > _EPS:
        db.execute("UPDATE inventory SET unit_cost=? WHERE id=?",
                   (round(float(row["v"]) / q, 6), inventory_id))


def add_lot(db, inventory_id, qty, unit_cost, *, source_type, source_ref, now,
            lot_number=None, manufacture_date=None, expiry_date=None):
    """Create a lot for a stock-IN. Returns the new lot id (None for qty<=0)."""
    qty = float(qty or 0)
    if qty <= _EPS:
        return None
    mfg = manufacture_date or now[:10]
    exp = expiry_date or _expiry_from_shelf_life(db, inventory_id, mfg)
    cur = db.execute(
        "INSERT INTO inventory_lots "
        "(inventory_id, lot_number, quantity_remaining, original_quantity, unit_cost, "
        " manufacture_date, expiry_date, source_type, source_ref, status, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)",
        (inventory_id, None, qty, qty, float(unit_cost or 0), mfg, exp,
         source_type, source_ref, now),
    )
    lot_id = cur.lastrowid
    num = (lot_number or "").strip() or f"LOT-{now[:10].replace('-', '')}-{lot_id}"
    db.execute("UPDATE inventory_lots SET lot_number=? WHERE id=?", (num, lot_id))
    _recompute_unit_cost(db, inventory_id)
    return lot_id


def consume_fefo(db, inventory_id, qty, *, source_type, source_ref, now,
                 production_order_id=None, fallback_unit_cost=0.0):
    """Consume `qty` First-Expired-First-Out. Returns (cogs, [consumption_ids]).

    Records one `lot_consumption` row per lot drawn. If lots can't cover qty
    (stock that predates lot tracking), the remainder is valued at the fallback
    unit cost. Recomputes `inventory.unit_cost` from the remaining lots."""
    qty = float(qty or 0)
    if qty <= _EPS:
        return 0.0, []
    lots = db.execute(
        "SELECT id, quantity_remaining, unit_cost FROM inventory_lots "
        "WHERE inventory_id=? AND quantity_remaining > ? "
        "ORDER BY (expiry_date IS NULL), expiry_date ASC, created_at ASC, id ASC",
        (inventory_id, _EPS),
    ).fetchall()
    remaining, cogs, cons_ids = qty, 0.0, []
    for lot in lots:
        if remaining <= _EPS:
            break
        take = min(float(lot["quantity_remaining"]), remaining)
        uc   = float(lot["unit_cost"])
        cogs += take * uc
        db.execute(
            "UPDATE inventory_lots SET quantity_remaining = quantity_remaining - ?, "
            "status = CASE WHEN quantity_remaining - ? <= ? THEN 'consumed' ELSE status END "
            "WHERE id=?", (take, take, _EPS, lot["id"]),
        )
        cur = db.execute(
            "INSERT INTO lot_consumption "
            "(lot_id, inventory_id, quantity, unit_cost, source_type, source_ref, "
            " production_order_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (lot["id"], inventory_id, take, uc, source_type, source_ref,
             production_order_id, now),
        )
        cons_ids.append(cur.lastrowid)
        remaining -= take
    if remaining > _EPS:
        cogs += remaining * float(fallback_unit_cost or 0)
    _recompute_unit_cost(db, inventory_id)
    return round(cogs, 6), cons_ids


def link_output_lot(db, production_order_id, output_lot_id):
    """Point a production order's input-lot consumption rows at the lot they
    produced — the backward-traceability link (output lot → input lots)."""
    if not production_order_id or not output_lot_id:
        return
    db.execute(
        "UPDATE lot_consumption SET output_lot_id=? "
        "WHERE production_order_id=? AND output_lot_id IS NULL",
        (output_lot_id, production_order_id),
    )


# ── Method-aware wrappers (lot-tracked → lots, else → cost layers) ───────────
def record_stock_in(db, inventory_id, qty, unit_cost, *, source_type, source_ref, now,
                    lot_number=None, manufacture_date=None, expiry_date=None):
    """Stock-IN: create a lot for lot-tracked items, else add a FIFO/LIFO cost
    layer. Returns the lot id when a lot was created, else None."""
    if is_lot_tracked(db, inventory_id):
        return add_lot(db, inventory_id, qty, unit_cost, source_type=source_type,
                       source_ref=source_ref, now=now, lot_number=lot_number,
                       manufacture_date=manufacture_date, expiry_date=expiry_date)
    import costing
    costing.add_layer(db, costing.get_method(db), inventory_id, qty, unit_cost,
                      source_type, source_ref, now)
    return None


def remaining_from(db, inventory_id, *, source_type, source_ref):
    """How much of one stock-IN is still on the shelf, or None when nothing can
    say.

    A lot-tracked item answers from its lot, and a FIFO/LIFO item from its cost
    layer. Under weighted_avg there is neither: the receipt was blended into a
    single average the moment it landed, and no record survives of which units
    came from where. The caller has to fall back to the quantity on hand, which
    is a weaker guarantee, and that is a property of the method rather than
    something this can paper over.
    """
    if is_lot_tracked(db, inventory_id):
        row = db.execute(
            "SELECT COALESCE(SUM(quantity_remaining), 0) AS q FROM inventory_lots "
            "WHERE inventory_id=? AND source_type=? AND source_ref=?",
            (inventory_id, source_type, str(source_ref))).fetchone()
        return round(float(row["q"] or 0), 6) if row else 0.0
    import costing
    if costing.get_method(db) not in ("fifo", "lifo"):
        return None
    return costing.layer_remaining(db, inventory_id, source_type, source_ref)


def reverse_stock_in(db, inventory_id, qty, *, source_type, source_ref):
    """Take back what one stock-IN brought in — the mirror of record_stock_in.

    Draws down that receipt's own lot or cost layer, never the method's queue:
    the units being reversed are the ones that arrived, not the ones that would
    be sold next. Returns the quantity it could NOT take back, which is zero
    whenever the receipt was still intact.
    """
    qty = float(qty or 0)
    if qty <= _EPS:
        return 0.0
    if is_lot_tracked(db, inventory_id):
        remaining = qty
        rows = db.execute(
            "SELECT id, quantity_remaining FROM inventory_lots "
            "WHERE inventory_id=? AND source_type=? AND source_ref=? "
            "AND quantity_remaining > ? ORDER BY id",
            (inventory_id, source_type, str(source_ref), _EPS)).fetchall()
        for lot in rows:
            if remaining <= _EPS:
                break
            take = min(float(lot["quantity_remaining"]), remaining)
            db.execute(
                "UPDATE inventory_lots SET quantity_remaining = quantity_remaining - ? "
                "WHERE id=?", (take, lot["id"]))
            remaining -= take
        _recompute_unit_cost(db, inventory_id)
        return round(max(remaining, 0.0), 6)
    import costing
    if costing.get_method(db) not in ("fifo", "lifo"):
        return 0.0
    return costing.draw_layer(db, inventory_id, qty, source_type, source_ref)


def value_stock_out(db, inventory_id, qty, *, source_type, source_ref, now,
                    production_order_id=None):
    """Stock-OUT COGS: lot-tracked items draw lots FEFO; others use the
    configured cost layers. Returns the cost-of-goods-sold for `qty`."""
    inv = db.execute("SELECT lot_tracked, unit_cost FROM inventory WHERE id=?",
                     (inventory_id,)).fetchone()
    fallback = float(inv["unit_cost"] or 0) if inv else 0.0
    if inv and inv["lot_tracked"]:
        cogs, _ = consume_fefo(db, inventory_id, qty, source_type=source_type,
                               source_ref=source_ref, now=now,
                               production_order_id=production_order_id,
                               fallback_unit_cost=fallback)
        return cogs
    import costing
    return costing.consume(db, costing.get_method(db), inventory_id, qty, fallback)
