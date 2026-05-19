"""
Manufacturing — product types, versioned bills of materials and the full
production-order lifecycle.

Model
-----
* Product types live on `inventory.product_type`:
  raw_material · semi_finished · finished · consumable.
* `boms`              — a versioned recipe. Versions share a `bom_group_id`;
                        the highest non-archived version is the current one.
                        Carries labour + overhead cost.
* `bom_components`    — recipe lines, each with an optional `scrap_pct`
                        allowance folded into the required quantity.
* `production_orders` — Draft → Confirmed → In Progress → Completed / Cancelled.
* `production_order_items` — BOM lines snapshotted + scaled at creation;
                        planned `quantity_required`, actual `quantity_consumed`
                        and `quantity_scrapped` captured at completion.

Lifecycle & inventory
---------------------
* Confirm  reserves raw material (`inventory.reserved_quantity`).
* Cancel   releases any reservation.
* Complete releases the reservation, consumes the *actual* quantities, raises
  finished-goods stock and freezes the cost — all in one transaction.

Costing
-------
Weighted-average. Material is valued at the moving-average `inventory.unit_cost`
at the moment of consumption, so manufacturing cost stays consistent with POS
COGS and inventory valuation. A multi-level BOM rolls a sub-assembly's own BOM
cost up into its parent. Producing goods posts no expense — it transforms
raw-material inventory value into finished-goods value.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, notify
import sqlite3

router = APIRouter()

# ── Lifecycle constants ─────────────────────────────────────────────────────
ST_DRAFT, ST_CONFIRMED, ST_PROGRESS = "Draft", "Confirmed", "In Progress"
ST_COMPLETED, ST_CANCELLED          = "Completed", "Cancelled"
_RESERVED_STATES   = (ST_CONFIRMED, ST_PROGRESS)         # materials are held
_CANCELLABLE       = (ST_DRAFT, ST_CONFIRMED, ST_PROGRESS)
_OPEN_STATES       = (ST_DRAFT, ST_CONFIRMED, ST_PROGRESS)

PRODUCT_TYPES   = ("raw_material", "semi_finished", "finished", "consumable")
_OUTPUT_TYPES   = ("semi_finished", "finished")           # may be a BOM output
_MAX_BOM_DEPTH  = 8                                       # sub-assembly guard


# ── Models ──────────────────────────────────────────────────────────────────
class BomComponentIn(BaseModel):
    component_inventory_id: int
    quantity:               float = 1
    scrap_pct:              float = 0


class BomIn(BaseModel):
    name:                str
    output_inventory_id: int
    output_quantity:     float = 1
    labor_cost:          float = 0
    overhead_cost:       float = 0
    notes:               Optional[str] = None
    revision_note:       Optional[str] = None
    is_active:           bool = True
    components:          list[BomComponentIn] = []


class OrderIn(BaseModel):
    bom_id:        int
    quantity:      float = 1
    labor_cost:    Optional[float] = None     # default: BOM labour, scaled
    overhead_cost: Optional[float] = None     # default: BOM overhead, scaled
    notes:         Optional[str] = None


class OrderUpdate(BaseModel):
    quantity:      float
    labor_cost:    float = 0
    overhead_cost: float = 0
    notes:         Optional[str] = None


class CompleteItemIn(BaseModel):
    id:                int                    # production_order_items.id
    quantity_consumed: float
    quantity_scrapped: float = 0


class CompleteIn(BaseModel):
    quantity_produced: Optional[float] = None  # default: planned order quantity
    labor_cost:        Optional[float] = None  # default: order labour
    overhead_cost:     Optional[float] = None  # default: order overhead
    items:             list[CompleteItemIn] = []


class CancelIn(BaseModel):
    reason: Optional[str] = None


# ── Number helpers ──────────────────────────────────────────────────────────
def _q(v):  return round(float(v or 0), 6)     # quantity
def _c(v):  return round(float(v or 0), 2)     # money
def _u(v):  return round(float(v or 0), 4)     # unit cost


# ── BOM costing (weighted-average, multi-level) ─────────────────────────────
def _active_bom_for_output(db, inventory_id):
    """The current (highest-version, non-archived, active) BOM for a product."""
    return db.execute(
        "SELECT * FROM boms WHERE output_inventory_id=? AND is_active=1 "
        "AND archived_at IS NULL ORDER BY version DESC LIMIT 1",
        (inventory_id,),
    ).fetchone()


def _bom_component_rows(db, bom_id):
    return db.execute(
        "SELECT bc.*, i.name AS component_name, i.unit AS component_unit, "
        "       i.product_type, COALESCE(i.unit_cost, 0) AS raw_unit_cost, "
        "       COALESCE(i.quantity, 0) AS on_hand, "
        "       COALESCE(i.reserved_quantity, 0) AS reserved "
        "FROM bom_components bc "
        "LEFT JOIN inventory i ON bc.component_inventory_id = i.id "
        "WHERE bc.bom_id=? ORDER BY bc.id",
        (bom_id,),
    ).fetchall()


def _component_unit_cost(db, inv_id, product_type, raw_unit_cost, depth, seen):
    """Unit cost of a component, rolling a sub-assembly's BOM up if it has one.

    Returns (unit_cost, is_subassembly).
    """
    if depth >= _MAX_BOM_DEPTH or inv_id in seen or product_type not in _OUTPUT_TYPES:
        return _u(raw_unit_cost), False
    sub = _active_bom_for_output(db, inv_id)
    if not sub:
        return _u(raw_unit_cost), False
    return _bom_unit_cost(db, sub, depth + 1, seen | {inv_id}), True


def _bom_unit_cost(db, bom_row, depth=0, seen=None):
    """Computed cost to make one output unit of a BOM."""
    seen  = seen or set()
    batch = 0.0
    for c in _bom_component_rows(db, bom_row["id"]):
        eff = _q(c["quantity"]) * (1 + _q(c["scrap_pct"]) / 100.0)
        unit, _is = _component_unit_cost(
            db, c["component_inventory_id"], c["product_type"],
            c["raw_unit_cost"], depth, seen)
        batch += eff * unit
    batch += float(bom_row["labor_cost"] or 0) + float(bom_row["overhead_cost"] or 0)
    yield_qty = float(bom_row["output_quantity"] or 1) or 1
    return _u(batch / yield_qty)


def _bom_detail(db, bom_row):
    """A BOM dict enriched with priced component lines and a roll-up tree."""
    d = dict(bom_row)
    comps, lines, material = [], [], 0.0
    for c in _bom_component_rows(db, bom_row["id"]):
        eff  = _q(c["quantity"]) * (1 + _q(c["scrap_pct"]) / 100.0)
        unit, is_sub = _component_unit_cost(
            db, c["component_inventory_id"], c["product_type"],
            c["raw_unit_cost"], 0, {bom_row["output_inventory_id"]})
        line_cost = _c(eff * unit)
        material += eff * unit
        row = dict(c)
        row["effective_quantity"] = eff
        row["unit_cost"]          = unit
        row["line_cost"]          = line_cost
        row["is_subassembly"]     = is_sub
        comps.append(row)
        lines.append({
            "name": c["component_name"] or "Component",
            "quantity": eff, "unit_cost": unit, "line_cost": line_cost,
            "is_subassembly": is_sub,
        })
    labor    = float(bom_row["labor_cost"] or 0)
    overhead = float(bom_row["overhead_cost"] or 0)
    batch    = _c(material + labor + overhead)
    yield_qty = float(bom_row["output_quantity"] or 1) or 1
    d["components"]      = comps
    d["component_count"] = len(comps)
    d["material_cost"]   = _c(material)
    d["batch_cost"]      = batch
    d["unit_cost"]       = _u(batch / yield_qty)
    d["cost_tree"]       = lines
    return d


# ── Production-order helpers ────────────────────────────────────────────────
def _next_order_number(db):
    row = db.execute("SELECT value FROM settings WHERE key='production_prefix'").fetchone()
    prefix = (row["value"] if row and row["value"] else "MO-")
    mx = db.execute("SELECT COALESCE(MAX(id), 0) AS m FROM production_orders").fetchone()
    return f"{prefix}{datetime.utcnow().year}-{mx['m'] + 1:04d}"


def _snapshot_components(db, order_id, bom, quantity):
    """(Re)write an order's component requirements, scaled + scrap-adjusted."""
    db.execute("DELETE FROM production_order_items WHERE production_order_id=?", (order_id,))
    scale = quantity / (float(bom["output_quantity"] or 1) or 1)
    for comp in _bom_component_rows(db, bom["id"]):
        scrap    = _q(comp["scrap_pct"])
        required = _q(float(comp["quantity"]) * scale * (1 + scrap / 100.0))
        db.execute(
            "INSERT INTO production_order_items "
            "(production_order_id, component_inventory_id, name, quantity_required, scrap_pct) "
            "VALUES (?,?,?,?,?)",
            (order_id, comp["component_inventory_id"],
             comp["component_name"] or "Component", required, scrap),
        )


def _order_components(db, order_id):
    return db.execute(
        "SELECT * FROM production_order_items WHERE production_order_id=? ORDER BY id",
        (order_id,),
    ).fetchall()


def _aggregate_required(items):
    """component_inventory_id → total planned quantity_required."""
    agg = {}
    for it in items:
        cid = it["component_inventory_id"]
        if cid is not None:
            agg[cid] = agg.get(cid, 0.0) + float(it["quantity_required"])
    return agg


def _apply_reservation(db, order_id, sign):
    """sign +1 reserves, -1 releases material against confirmed orders."""
    for cid, qty in _aggregate_required(_order_components(db, order_id)).items():
        if sign > 0:
            db.execute(
                "UPDATE inventory SET reserved_quantity = COALESCE(reserved_quantity,0) + ? "
                "WHERE id=?", (qty, cid))
        else:
            db.execute(
                "UPDATE inventory SET reserved_quantity = MAX(0, COALESCE(reserved_quantity,0) - ?) "
                "WHERE id=?", (qty, cid))


def _material_status(db, order_id):
    """Per-component required-vs-stock rows + an overall can_build flag."""
    items  = _order_components(db, order_id)
    needed = _aggregate_required(items)
    inv = {}
    for cid in needed:
        r = db.execute(
            "SELECT name, quantity, COALESCE(reserved_quantity,0) AS reserved, unit "
            "FROM inventory WHERE id=?", (cid,)).fetchone()
        inv[cid] = r
    rows, can_build = [], True
    for it in items:
        d   = dict(it)
        cid = it["component_inventory_id"]
        r   = inv.get(cid)
        on_hand  = float(r["quantity"]) if r else 0.0
        reserved = float(r["reserved"]) if r else 0.0
        required = float(it["quantity_required"])
        d["on_hand"]   = on_hand if r else None
        d["reserved"]  = reserved
        d["available"] = round(on_hand - reserved, 6) if r else None
        d["short"]     = cid is not None and on_hand + 1e-9 < required
        consumed = it["quantity_consumed"]
        d["variance"] = (round(float(consumed) - required, 6)
                         if consumed is not None else None)
        if d["short"]:
            can_build = False
        rows.append(d)
    return rows, can_build


def _order_detail(db, order_row):
    d = dict(order_row)
    out = db.execute(
        "SELECT name, product_type, unit FROM inventory WHERE id=?",
        (order_row["output_inventory_id"],)).fetchone()
    d["output_name"]         = out["name"] if out else None
    d["output_product_type"] = out["product_type"] if out else None
    d["output_unit"]         = out["unit"] if out else None
    items, can_build = _material_status(db, order_row["id"])
    d["items"]     = items
    d["can_build"] = can_build
    produced = order_row["quantity_produced"]
    d["output_variance"] = (round(float(produced) - float(order_row["quantity"]), 6)
                            if produced is not None else None)
    d["movements"] = [dict(m) for m in db.execute(
        "SELECT sm.*, i.name AS item_name FROM stock_movements sm "
        "LEFT JOIN inventory i ON sm.inventory_id = i.id "
        "WHERE sm.reference=? ORDER BY sm.id", (order_row["order_number"],),
    ).fetchall()]
    return d


# ════════════════════════════════════════════════════════════════════════════
# BILLS OF MATERIALS
# ════════════════════════════════════════════════════════════════════════════
@router.get("/boms")
def list_boms(
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Current version of every BOM group."""
    rows = db.execute(
        "SELECT b.*, i.name AS output_name, i.product_type AS output_product_type "
        "FROM boms b LEFT JOIN inventory i ON b.output_inventory_id = i.id "
        "WHERE b.archived_at IS NULL "
        "  AND b.version = (SELECT MAX(b2.version) FROM boms b2 "
        "                   WHERE b2.bom_group_id = b.bom_group_id "
        "                     AND b2.archived_at IS NULL) "
        "ORDER BY i.name, b.name"
    ).fetchall()
    return [_bom_detail(db, r) for r in rows]


@router.get("/boms/{bom_id}")
def get_bom(
    bom_id: int,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT b.*, i.name AS output_name, i.product_type AS output_product_type "
        "FROM boms b LEFT JOIN inventory i ON b.output_inventory_id = i.id WHERE b.id=?",
        (bom_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "BOM not found")
    d = _bom_detail(db, row)
    d["version_count"] = db.execute(
        "SELECT COUNT(*) FROM boms WHERE bom_group_id=?", (row["bom_group_id"],),
    ).fetchone()[0]
    return d


@router.get("/boms/{bom_id}/versions")
def bom_versions(
    bom_id: int,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT bom_group_id FROM boms WHERE id=?", (bom_id,)).fetchone()
    if not row:
        raise HTTPException(404, "BOM not found")
    rows = db.execute(
        "SELECT id, name, version, is_active, revision_note, archived_at, created_at "
        "FROM boms WHERE bom_group_id=? ORDER BY version DESC", (row["bom_group_id"],),
    ).fetchall()
    return [dict(r) for r in rows]


def _validate_bom(db, data: BomIn):
    if not (data.name or "").strip():
        raise HTTPException(400, "BOM name is required.")
    out = db.execute(
        "SELECT product_type FROM inventory WHERE id=? AND archived_at IS NULL",
        (data.output_inventory_id,)).fetchone()
    if not out:
        raise HTTPException(400, "Output product not found.")
    if out["product_type"] and out["product_type"] not in _OUTPUT_TYPES:
        raise HTTPException(
            400, "A BOM output must be a finished or semi-finished product.")
    if data.output_quantity <= 0:
        raise HTTPException(400, "Output (batch) quantity must be positive.")
    if data.labor_cost < 0 or data.overhead_cost < 0:
        raise HTTPException(400, "Labour and overhead costs cannot be negative.")
    if not data.components:
        raise HTTPException(400, "A BOM needs at least one component.")
    for comp in data.components:
        if comp.component_inventory_id == data.output_inventory_id:
            raise HTTPException(400, "A product cannot be a component of itself.")
        if comp.quantity <= 0:
            raise HTTPException(400, "Component quantity must be positive.")
        if comp.scrap_pct < 0 or comp.scrap_pct > 100:
            raise HTTPException(400, "Scrap % must be between 0 and 100.")
        if not db.execute("SELECT 1 FROM inventory WHERE id=?",
                          (comp.component_inventory_id,)).fetchone():
            raise HTTPException(400, f"Component item #{comp.component_inventory_id} not found.")


def _write_components(db, bom_id, components):
    db.execute("DELETE FROM bom_components WHERE bom_id=?", (bom_id,))
    for comp in components:
        db.execute(
            "INSERT INTO bom_components (bom_id, component_inventory_id, quantity, scrap_pct) "
            "VALUES (?,?,?,?)",
            (bom_id, comp.component_inventory_id, comp.quantity, comp.scrap_pct),
        )


@router.post("/boms")
def create_bom(
    data: BomIn,
    user=Depends(require_perm("manufacturing", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    _validate_bom(db, data)
    now = _now()
    cur = db.execute(
        "INSERT INTO boms (name, output_inventory_id, output_quantity, labor_cost, "
        " overhead_cost, notes, revision_note, is_active, version, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,1,?)",
        (data.name.strip(), data.output_inventory_id, data.output_quantity,
         data.labor_cost, data.overhead_cost, data.notes, data.revision_note,
         1 if data.is_active else 0, now),
    )
    bom_id = cur.lastrowid
    db.execute("UPDATE boms SET bom_group_id=? WHERE id=?", (bom_id, bom_id))
    _write_components(db, bom_id, data.components)
    log_action(db, user, "create", "manufacturing", bom_id, data.name.strip())
    db.commit()
    return {"id": bom_id, "message": "Bill of materials created"}


@router.put("/boms/{bom_id}")
def update_bom(
    bom_id: int,
    data: BomIn,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute("SELECT 1 FROM boms WHERE id=? AND archived_at IS NULL",
                      (bom_id,)).fetchone():
        raise HTTPException(404, "BOM not found")
    _validate_bom(db, data)
    db.execute(
        "UPDATE boms SET name=?, output_inventory_id=?, output_quantity=?, labor_cost=?, "
        " overhead_cost=?, notes=?, is_active=? WHERE id=?",
        (data.name.strip(), data.output_inventory_id, data.output_quantity,
         data.labor_cost, data.overhead_cost, data.notes,
         1 if data.is_active else 0, bom_id),
    )
    _write_components(db, bom_id, data.components)
    log_action(db, user, "update", "manufacturing", bom_id, data.name.strip())
    db.commit()
    return {"message": "Bill of materials updated"}


@router.post("/boms/{bom_id}/new-version")
def new_bom_version(
    bom_id: int,
    data: BomIn,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Clone a BOM into the next version; older versions are deactivated."""
    base = db.execute("SELECT * FROM boms WHERE id=?", (bom_id,)).fetchone()
    if not base:
        raise HTTPException(404, "BOM not found")
    _validate_bom(db, data)
    group = base["bom_group_id"] or base["id"]
    next_v = db.execute(
        "SELECT COALESCE(MAX(version),0)+1 FROM boms WHERE bom_group_id=?", (group,),
    ).fetchone()[0]
    now = _now()
    cur = db.execute(
        "INSERT INTO boms (name, output_inventory_id, output_quantity, labor_cost, "
        " overhead_cost, notes, revision_note, is_active, version, bom_group_id, created_at) "
        "VALUES (?,?,?,?,?,?,?,1,?,?,?)",
        (data.name.strip(), data.output_inventory_id, data.output_quantity,
         data.labor_cost, data.overhead_cost, data.notes, data.revision_note,
         next_v, group, now),
    )
    new_id = cur.lastrowid
    _write_components(db, new_id, data.components)
    # Older versions in the group step aside so pickers use only the newest.
    db.execute("UPDATE boms SET is_active=0 WHERE bom_group_id=? AND id<>?", (group, new_id))
    log_action(db, user, "update", "manufacturing", new_id,
               f"{data.name.strip()} v{next_v}", {"revision_note": data.revision_note})
    db.commit()
    return {"id": new_id, "version": next_v, "message": f"BOM version {next_v} created"}


@router.patch("/boms/{bom_id}/archive")
def archive_bom(
    bom_id: int,
    user=Depends(require_perm("manufacturing", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM boms WHERE id=? AND archived_at IS NULL", (bom_id,)).fetchone()
    if not row:
        raise HTTPException(404, "BOM not found")
    open_orders = db.execute(
        "SELECT COUNT(*) FROM production_orders "
        "WHERE bom_id=? AND status IN ('Draft','Confirmed','In Progress') AND archived_at IS NULL",
        (bom_id,),
    ).fetchone()[0]
    if open_orders:
        raise HTTPException(400, "This BOM has open production orders. Close them first.")
    db.execute("UPDATE boms SET archived_at=? WHERE id=?", (_now(), bom_id))
    log_action(db, user, "archive", "manufacturing", bom_id, row["name"])
    db.commit()
    return {"message": "BOM archived"}


@router.patch("/boms/{bom_id}/unarchive")
def unarchive_bom(
    bom_id: int,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM boms WHERE id=? AND archived_at IS NOT NULL", (bom_id,)).fetchone()
    if not row:
        raise HTTPException(404, "BOM not found in archive")
    db.execute("UPDATE boms SET archived_at=NULL WHERE id=?", (bom_id,))
    log_action(db, user, "unarchive", "manufacturing", bom_id, row["name"])
    db.commit()
    return {"message": "BOM restored"}


# ════════════════════════════════════════════════════════════════════════════
# PRODUCTION ORDERS
# ════════════════════════════════════════════════════════════════════════════
@router.get("/orders")
def list_orders(
    status: Optional[str] = None,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    query = (
        "SELECT po.*, i.name AS output_name FROM production_orders po "
        "LEFT JOIN inventory i ON po.output_inventory_id = i.id "
        "WHERE po.archived_at IS NULL"
    )
    params = []
    if status:
        query += " AND po.status=?"
        params.append(status)
    query += " ORDER BY po.id DESC LIMIT 300"
    return [dict(r) for r in db.execute(query, params).fetchall()]


@router.get("/orders/{order_id}")
def get_order(
    order_id: int,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM production_orders WHERE id=?", (order_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Production order not found")
    return _order_detail(db, row)


@router.post("/orders")
def create_order(
    data: OrderIn,
    user=Depends(require_perm("manufacturing", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    bom = db.execute("SELECT * FROM boms WHERE id=? AND archived_at IS NULL",
                     (data.bom_id,)).fetchone()
    if not bom:
        raise HTTPException(400, "BOM not found")
    if data.quantity <= 0:
        raise HTTPException(400, "Quantity to produce must be positive.")
    if not db.execute("SELECT 1 FROM bom_components WHERE bom_id=?", (data.bom_id,)).fetchone():
        raise HTTPException(400, "This BOM has no components.")

    scale = data.quantity / (float(bom["output_quantity"] or 1) or 1)
    labor = (_c(data.labor_cost) if data.labor_cost is not None
             else _c(float(bom["labor_cost"] or 0) * scale))
    overhead = (_c(data.overhead_cost) if data.overhead_cost is not None
                else _c(float(bom["overhead_cost"] or 0) * scale))
    now      = _now()
    order_no = _next_order_number(db)
    cur = db.execute(
        "INSERT INTO production_orders "
        "(order_number, bom_id, bom_version, output_inventory_id, quantity, status, "
        " labor_cost, overhead_cost, notes, created_by, created_at) "
        "VALUES (?,?,?,?,?, 'Draft', ?,?,?,?,?)",
        (order_no, bom["id"], bom["version"], bom["output_inventory_id"], data.quantity,
         labor, overhead, data.notes, user["id"], now),
    )
    order_id = cur.lastrowid
    _snapshot_components(db, order_id, bom, data.quantity)
    log_action(db, user, "create", "manufacturing", order_id, order_no,
               {"quantity": data.quantity})
    db.commit()
    return {"id": order_id, "order_number": order_no, "message": "Production order created"}


@router.put("/orders/{order_id}")
def update_order(
    order_id: int,
    data: OrderUpdate,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    order = db.execute("SELECT * FROM production_orders WHERE id=? AND archived_at IS NULL",
                       (order_id,)).fetchone()
    if not order:
        raise HTTPException(404, "Production order not found")
    if order["status"] != ST_DRAFT:
        raise HTTPException(400, "Only a draft order can be edited.")
    if data.quantity <= 0:
        raise HTTPException(400, "Quantity to produce must be positive.")
    db.execute(
        "UPDATE production_orders SET quantity=?, labor_cost=?, overhead_cost=?, notes=? WHERE id=?",
        (data.quantity, _c(data.labor_cost), _c(data.overhead_cost), data.notes, order_id),
    )
    bom = db.execute("SELECT * FROM boms WHERE id=?", (order["bom_id"],)).fetchone()
    if bom:
        _snapshot_components(db, order_id, bom, data.quantity)
    log_action(db, user, "update", "manufacturing", order_id, order["order_number"])
    db.commit()
    return {"message": "Production order updated"}


def _get_open_order(db, order_id):
    order = db.execute("SELECT * FROM production_orders WHERE id=? AND archived_at IS NULL",
                       (order_id,)).fetchone()
    if not order:
        raise HTTPException(404, "Production order not found")
    return order


@router.post("/orders/{order_id}/confirm")
def confirm_order(
    order_id: int,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Draft → Confirmed. Reserves the planned raw materials."""
    order = _get_open_order(db, order_id)
    if order["status"] != ST_DRAFT:
        raise HTTPException(400, "Only a draft order can be confirmed.")
    if not _order_components(db, order_id):
        raise HTTPException(400, "This order has no component requirements.")
    _apply_reservation(db, order_id, +1)
    db.execute("UPDATE production_orders SET status=?, confirmed_at=? WHERE id=?",
               (ST_CONFIRMED, _now(), order_id))
    log_action(db, user, "confirm", "manufacturing", order_id, order["order_number"])
    db.commit()
    return {"message": "Production order confirmed — materials reserved"}


@router.post("/orders/{order_id}/start")
def start_order(
    order_id: int,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Confirmed → In Progress."""
    order = _get_open_order(db, order_id)
    if order["status"] != ST_CONFIRMED:
        raise HTTPException(400, "Only a confirmed order can be started.")
    db.execute("UPDATE production_orders SET status=?, started_at=? WHERE id=?",
               (ST_PROGRESS, _now(), order_id))
    log_action(db, user, "start", "manufacturing", order_id, order["order_number"])
    db.commit()
    return {"message": "Production started"}


@router.post("/orders/{order_id}/complete")
def complete_order(
    order_id: int,
    data: CompleteIn = Body(default_factory=CompleteIn),
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Completes a production order. Accepts Draft / Confirmed / In Progress —
    Lebanese SMEs frequently skip the formal start step and just report what
    they built. Releases any reservation, consumes the *actual* quantities,
    raises finished-goods stock and freezes the cost."""
    order = _get_open_order(db, order_id)
    if order["status"] not in _OPEN_STATES:
        raise HTTPException(400, "Only an open order can be completed.")
    items = _order_components(db, order_id)
    if not items:
        raise HTTPException(400, "This order has no component requirements.")

    # Actual consumption per line — default to the planned requirement.
    actual = {it["id"]: {"consumed": float(it["quantity_required"]), "scrapped": 0.0}
              for it in items}
    for ci in data.items:
        if ci.id not in actual:
            raise HTTPException(400, f"Line #{ci.id} does not belong to this order.")
        if ci.quantity_consumed < 0 or ci.quantity_scrapped < 0:
            raise HTTPException(400, "Consumed and scrapped quantities cannot be negative.")
        if ci.quantity_scrapped > ci.quantity_consumed + 1e-9:
            raise HTTPException(400, "Scrapped quantity cannot exceed the consumed quantity.")
        actual[ci.id] = {"consumed": float(ci.quantity_consumed),
                         "scrapped": float(ci.quantity_scrapped)}

    consume, planned = {}, {}
    for it in items:
        cid = it["component_inventory_id"]
        if cid is None:
            continue
        consume[cid] = consume.get(cid, 0.0) + actual[it["id"]]["consumed"]
        planned[cid] = planned.get(cid, 0.0) + float(it["quantity_required"])

    # Verify physical stock up front — nothing is written until all lines pass.
    invs = {}
    for cid, qty in consume.items():
        inv = db.execute("SELECT * FROM inventory WHERE id=? AND archived_at IS NULL",
                         (cid,)).fetchone()
        if not inv:
            raise HTTPException(400, f"Component item #{cid} no longer exists.")
        if round(float(inv["quantity"]) - qty, 6) < 0:
            raise HTTPException(
                400, f"Insufficient stock of '{inv['name']}': "
                     f"{inv['quantity']} on hand, {qty} to consume.")
        invs[cid] = inv

    out_inv = db.execute("SELECT * FROM inventory WHERE id=?",
                         (order["output_inventory_id"],)).fetchone()
    if not out_inv:
        raise HTTPException(400, "The finished product no longer exists in inventory.")

    qty_produced = (float(data.quantity_produced) if data.quantity_produced is not None
                    else float(order["quantity"]))
    if qty_produced <= 0:
        raise HTTPException(400, "Produced quantity must be positive.")

    now = _now()

    # 1. Consume raw materials and release their reservation.
    materials_cost = 0.0
    for cid, qty in consume.items():
        inv        = invs[cid]
        qty_before = float(inv["quantity"])
        qty_after  = _q(qty_before - qty)
        new_res    = max(0.0, _q(float(inv["reserved_quantity"] or 0) - planned.get(cid, 0.0)))
        db.execute("UPDATE inventory SET quantity=?, reserved_quantity=? WHERE id=?",
                   (qty_after, new_res, cid))
        if qty:
            db.execute(
                "INSERT INTO stock_movements "
                "(inventory_id, type, delta, qty_before, qty_after, reference, note, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (cid, "production", -qty, qty_before, qty_after,
                 order["order_number"], "Production consumption", now))
        materials_cost += qty * float(inv["unit_cost"] or 0)
        min_stock = float(inv["min_stock"] or 0)
        if min_stock > 0 and qty_after <= min_stock:
            notify(db, type="low_stock",
                   title=f"Low stock alert: {inv['name']}",
                   body=f"Only {qty_after} {inv['unit'] or 'units'} remaining (minimum: {min_stock})",
                   link="/inventory", entity_type="inventory", entity_id=cid, dedup_hours=24)
    materials_cost = _c(materials_cost)

    # 2. Freeze each line's actual consumption + cost; tally scrap.
    scrap_cost = 0.0
    for it in items:
        cid = it["component_inventory_id"]
        a   = actual[it["id"]]
        uc  = float(invs[cid]["unit_cost"] or 0) if cid in invs else 0.0
        scrap_cost += a["scrapped"] * uc
        db.execute(
            "UPDATE production_order_items SET quantity_consumed=?, quantity_scrapped=?, "
            " unit_cost=?, line_cost=? WHERE id=?",
            (a["consumed"], a["scrapped"], uc, _u(a["consumed"] * uc), it["id"]))
    scrap_cost = _c(scrap_cost)

    labor    = _c(data.labor_cost if data.labor_cost is not None else order["labor_cost"])
    overhead = _c(data.overhead_cost if data.overhead_cost is not None else order["overhead_cost"])
    total_cost = _c(materials_cost + labor + overhead)
    unit_cost  = _u(total_cost / qty_produced)

    # 3. Raise finished-goods stock; weighted-average its unit cost.
    out_before = float(out_inv["quantity"])
    out_after  = _q(out_before + qty_produced)
    old_cost   = float(out_inv["unit_cost"] or 0)
    new_cost   = (_u((out_before * old_cost + qty_produced * unit_cost) / out_after)
                  if out_after else unit_cost)
    db.execute("UPDATE inventory SET quantity=?, unit_cost=? WHERE id=?",
               (out_after, new_cost, order["output_inventory_id"]))
    db.execute(
        "INSERT INTO stock_movements "
        "(inventory_id, type, delta, qty_before, qty_after, reference, note, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (order["output_inventory_id"], "production", qty_produced,
         out_before, out_after, order["order_number"], "Production output", now))

    # 4. Close the order with frozen costs.
    db.execute(
        "UPDATE production_orders SET status=?, materials_cost=?, labor_cost=?, "
        " overhead_cost=?, scrap_cost=?, total_cost=?, unit_cost=?, quantity_produced=?, "
        " completed_at=? WHERE id=?",
        (ST_COMPLETED, materials_cost, labor, overhead, scrap_cost, total_cost,
         unit_cost, qty_produced, now, order_id))
    log_action(db, user, "complete", "manufacturing", order_id, order["order_number"],
               {"materials_cost": materials_cost, "total_cost": total_cost,
                "unit_cost": unit_cost, "quantity_produced": qty_produced})
    notify(db, type="production_completed",
           title=f"Production complete: {order['order_number']}",
           body=f"{qty_produced} × {out_inv['name']} at "
                f"${unit_cost:.2f}/unit (total ${total_cost:.2f})",
           link="/manufacturing", entity_type="production_order",
           entity_id=order_id)
    db.commit()
    return {
        "message":        "Production order completed",
        "materials_cost": materials_cost,
        "labor_cost":     labor,
        "overhead_cost":  overhead,
        "scrap_cost":     scrap_cost,
        "total_cost":     total_cost,
        "unit_cost":      unit_cost,
        "quantity_produced": qty_produced,
    }


@router.post("/orders/{order_id}/cancel")
def cancel_order(
    order_id: int,
    data: CancelIn = Body(default_factory=CancelIn),
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    order = _get_open_order(db, order_id)
    if order["status"] not in _CANCELLABLE:
        raise HTTPException(400, "Only an open order can be cancelled.")
    if order["status"] in _RESERVED_STATES:
        _apply_reservation(db, order_id, -1)
    db.execute(
        "UPDATE production_orders SET status=?, cancelled_at=?, cancel_reason=? WHERE id=?",
        (ST_CANCELLED, _now(), (data.reason or "Cancelled"), order_id))
    log_action(db, user, "cancel", "manufacturing", order_id, order["order_number"],
               {"reason": data.reason})
    db.commit()
    return {"message": "Production order cancelled — any reservation released"}


@router.patch("/orders/{order_id}/archive")
def archive_order(
    order_id: int,
    user=Depends(require_perm("manufacturing", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    order = _get_open_order(db, order_id)
    if order["status"] in _OPEN_STATES:
        raise HTTPException(400, "Complete or cancel the order before archiving it.")
    db.execute("UPDATE production_orders SET archived_at=? WHERE id=?", (_now(), order_id))
    log_action(db, user, "archive", "manufacturing", order_id, order["order_number"])
    db.commit()
    return {"message": "Production order archived"}


@router.patch("/orders/{order_id}/unarchive")
def unarchive_order(
    order_id: int,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    order = db.execute("SELECT * FROM production_orders WHERE id=? AND archived_at IS NOT NULL",
                       (order_id,)).fetchone()
    if not order:
        raise HTTPException(404, "Production order not found in archive")
    db.execute("UPDATE production_orders SET archived_at=NULL WHERE id=?", (order_id,))
    log_action(db, user, "unarchive", "manufacturing", order_id, order["order_number"])
    db.commit()
    return {"message": "Production order restored"}


# ════════════════════════════════════════════════════════════════════════════
# PRODUCT PICKER & SUMMARY
# ════════════════════════════════════════════════════════════════════════════
@router.get("/products")
def list_products(
    search: Optional[str] = None,
    product_type: Optional[str] = None,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Active inventory items, with type + availability for BOM/order pickers."""
    query  = ("SELECT id, name, category, product_type, quantity, "
              "       COALESCE(reserved_quantity,0) AS reserved_quantity, "
              "       unit, unit_cost "
              "FROM inventory WHERE archived_at IS NULL")
    params = []
    if search:
        query += " AND name LIKE ?"
        params.append(f"%{search}%")
    if product_type:
        query += " AND product_type = ?"
        params.append(product_type)
    query += " ORDER BY name LIMIT 300"
    rows = []
    for r in db.execute(query, params).fetchall():
        d = dict(r)
        d["available_quantity"] = round(float(d["quantity"] or 0)
                                        - float(d["reserved_quantity"] or 0), 6)
        rows.append(d)
    return rows


@router.get("/summary")
def summary(
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    def _count(sql, *p):
        return db.execute(sql, p).fetchone()[0]
    reserved_value = db.execute(
        "SELECT COALESCE(SUM(reserved_quantity * COALESCE(unit_cost,0)), 0) "
        "FROM inventory WHERE archived_at IS NULL"
    ).fetchone()[0]
    return {
        "boms": _count("SELECT COUNT(*) FROM boms WHERE archived_at IS NULL AND is_active=1"),
        "draft":       _count("SELECT COUNT(*) FROM production_orders WHERE status='Draft' AND archived_at IS NULL"),
        "confirmed":   _count("SELECT COUNT(*) FROM production_orders WHERE status='Confirmed' AND archived_at IS NULL"),
        "in_progress": _count("SELECT COUNT(*) FROM production_orders WHERE status='In Progress' AND archived_at IS NULL"),
        "completed":   _count("SELECT COUNT(*) FROM production_orders WHERE status='Completed' AND archived_at IS NULL"),
        "reserved_value": _c(reserved_value),
        "completed_value": _c(db.execute(
            "SELECT COALESCE(SUM(total_cost), 0) FROM production_orders "
            "WHERE status='Completed' AND archived_at IS NULL").fetchone()[0]),
    }
