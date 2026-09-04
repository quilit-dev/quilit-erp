"""
Inventory costing — method-aware stock valuation.

Three methods are supported, selected globally via the `inventory_costing_method`
setting:

  • weighted_avg  (default) — the classic moving weighted-average. The cost of
                    a stock-OUT is the item's current `inventory.unit_cost`,
                    which is blended on every stock-IN by the purchase /
                    manufacturing code. Cost layers are NOT used or maintained,
                    so behaviour is byte-identical to the pre-costing-method ERP.

  • fifo          — First-In, First-Out. Each stock-IN appends a cost *layer*
                    (qty + landed unit cost). A stock-OUT draws down the OLDEST
                    layers first; the COGS is the sum of the consumed layers'
                    costs.

  • lifo          — Last-In, First-Out. Same as FIFO but draws down the NEWEST
                    layers first.

For FIFO/LIFO, `inventory.unit_cost` is kept as the weighted average of the
*remaining* layers after every movement, so the inventory list, reports and any
non-converted reader still see a sensible per-unit valuation (and it serves as a
fallback when an item has no layers — e.g. legacy stock).

Switching the method to fifo/lifo calls `rebase_layers()`, which resets every
item to a single opening layer valued at its current `unit_cost`. This keeps
layers consistent regardless of what happened while the method was
weighted_avg, and avoids trying to reconstruct lots from incomplete history.

All functions take an existing connection and DO NOT commit — the calling
endpoint owns the transaction.
"""
import sqlite3

VALID_METHODS = {"weighted_avg", "fifo", "lifo"}
_EPS = 1e-9


def get_method(db: sqlite3.Connection) -> str:
    """Return the configured costing method, defaulting to weighted_avg."""
    row = db.execute(
        "SELECT value FROM settings WHERE key='inventory_costing_method'"
    ).fetchone()
    m = (row["value"] if row else None) or "weighted_avg"
    return m if m in VALID_METHODS else "weighted_avg"


def add_layer(db: sqlite3.Connection, method: str, inventory_id: int, qty: float,
              unit_cost: float, source_type: str, source_ref, now: str) -> None:
    """Append a cost layer for a stock-IN. No-op under weighted_avg (which does
    not use layers) and for non-positive quantities."""
    if method not in ("fifo", "lifo"):
        return
    qty = float(qty or 0)
    if qty <= _EPS:
        return
    db.execute(
        "INSERT INTO inventory_cost_layers "
        "(inventory_id, qty_remaining, unit_cost, source_type, source_ref, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (inventory_id, qty, float(unit_cost or 0), source_type, source_ref, now),
    )


def _remaining(db: sqlite3.Connection, inventory_id: int):
    row = db.execute(
        "SELECT COALESCE(SUM(qty_remaining),0) AS q, "
        "       COALESCE(SUM(qty_remaining * unit_cost),0) AS v "
        "FROM inventory_cost_layers "
        "WHERE inventory_id=? AND qty_remaining > ?",
        (inventory_id, _EPS),
    ).fetchone()
    return float(row["q"]), float(row["v"])


def _recompute_unit_cost(db: sqlite3.Connection, inventory_id: int,
                         fallback_cost: float) -> float:
    """unit_cost = weighted average of remaining layers, or the fallback when
    no layers remain (item fully consumed or legacy stock)."""
    q, v = _remaining(db, inventory_id)
    if q > _EPS:
        return round(v / q, 6)
    return round(float(fallback_cost or 0), 6)


def consume(db: sqlite3.Connection, method: str, inventory_id: int, qty: float,
            fallback_unit_cost: float) -> float:
    """Value (and, for fifo/lifo, draw down) a stock-OUT of `qty` units.

    Returns the total cost-of-goods-sold for that quantity.

    • weighted_avg — COGS = qty × fallback_unit_cost (the item's moving
      average). Layers and unit_cost are left untouched.
    • fifo / lifo  — draw the oldest / newest layers; COGS = sum of consumed
      layer costs. Any shortfall (layers don't cover qty) is valued at the
      fallback average. `inventory.unit_cost` is then recomputed from the
      remaining layers.
    """
    qty = float(qty or 0)
    fallback_unit_cost = float(fallback_unit_cost or 0)
    if qty <= _EPS:
        return 0.0

    if method not in ("fifo", "lifo"):
        return round(qty * fallback_unit_cost, 6)

    # Oldest-first for FIFO, newest-first for LIFO. The direction is derived
    # from a hard-coded mapping — never from user input — so it is safe to
    # inline into the ORDER BY clause.
    order = "ASC" if method == "fifo" else "DESC"
    layers = db.execute(
        "SELECT id, qty_remaining, unit_cost FROM inventory_cost_layers "
        "WHERE inventory_id=? AND qty_remaining > ? "
        f"ORDER BY created_at {order}, id {order}",
        (inventory_id, _EPS),
    ).fetchall()

    remaining = qty
    cogs = 0.0
    for lyr in layers:
        if remaining <= _EPS:
            break
        take = min(float(lyr["qty_remaining"]), remaining)
        cogs += take * float(lyr["unit_cost"])
        db.execute(
            "UPDATE inventory_cost_layers SET qty_remaining = qty_remaining - ? WHERE id=?",
            (take, lyr["id"]),
        )
        remaining -= take

    # Shortfall: layers didn't cover the whole quantity (legacy stock with no
    # layers, or a rounding edge). Value the remainder at the moving average so
    # COGS is never understated.
    if remaining > _EPS:
        cogs += remaining * fallback_unit_cost

    new_cost = _recompute_unit_cost(db, inventory_id, fallback_unit_cost)
    db.execute("UPDATE inventory SET unit_cost=? WHERE id=?", (new_cost, inventory_id))
    return round(cogs, 6)


def blend_stock_in(db: sqlite3.Connection, inventory_id: int, *,
                   qty_before: float, qty_in: float, unit_cost_in: float):
    """Re-blend `inventory.unit_cost` for stock arriving at a different cost.

    Goods coming back onto the shelf — a voided sale, a reopened service job —
    return at the cost they left at, which is rarely today's average. Adding the
    quantity without moving the average leaves the item valued at a price it no
    longer has: `quantity * unit_cost` then disagrees with the ledger's own
    inventory balance, and with the cost layers under FIFO/LIFO.

    This is the same moving average a purchase receipt applies, and it is
    deliberately method-independent: `unit_cost` is the per-unit valuation every
    reader falls back on, whichever costing method is configured. Call it BEFORE
    `lots.record_stock_in`, so a lot-tracked item's recompute from its own lots
    stays the authority for that case.

    Returns the new unit cost, or None when there was nothing to blend.
    """
    qty_in = float(qty_in or 0)
    if qty_in <= _EPS:
        return None
    row = db.execute("SELECT unit_cost FROM inventory WHERE id=?",
                     (inventory_id,)).fetchone()
    if row is None:
        return None
    old_cost = float(row["unit_cost"] or 0)
    qty_before = float(qty_before or 0)
    qty_after = qty_before + qty_in
    if qty_after <= _EPS:
        return old_cost
    # Negative on-hand should not be possible, but if it ever is, the blend
    # would invert the sign of the average. Leave the cost alone instead.
    if qty_before < 0:
        return old_cost
    new_cost = round(
        (qty_before * old_cost + qty_in * float(unit_cost_in or 0)) / qty_after, 6)
    db.execute("UPDATE inventory SET unit_cost=? WHERE id=?",
               (new_cost, inventory_id))
    return new_cost


def rebase_layers(db: sqlite3.Connection, now: str) -> None:
    """Reset cost layers to a single opening layer per item, valued at the
    item's current `unit_cost`. Called when the method is switched to fifo/lifo
    so layers are consistent with on-hand stock regardless of prior activity."""
    db.execute("DELETE FROM inventory_cost_layers")
    rows = db.execute(
        "SELECT id, quantity, unit_cost FROM inventory "
        "WHERE archived_at IS NULL AND quantity > ?",
        (_EPS,),
    ).fetchall()
    for r in rows:
        db.execute(
            "INSERT INTO inventory_cost_layers "
            "(inventory_id, qty_remaining, unit_cost, source_type, source_ref, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (r["id"], float(r["quantity"]), float(r["unit_cost"] or 0),
             "opening", "method-switch", now),
        )
