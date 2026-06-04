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
from utils import _now, notify, validate_int_qty
import costing
import lots
import math
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
# Resource-based overhead costing for SMEs: a reusable list of cost resources
# (Labor, Electricity, Water, CNC Machine, Oven, …), each charged per hour. A
# BOM assigns resources; production cost = Σ(rates) × actual production hours.
RESOURCE_COST_TYPES = ("per_hour",)


class ResourceIn(BaseModel):
    name:        str
    cost_type:   str   = "per_hour"
    hourly_rate: float = 0
    is_active:   bool  = True
    notes:       Optional[str] = None


class BomComponentIn(BaseModel):
    component_inventory_id: int
    quantity:               float = 1
    scrap_pct:              float = 0


class BomResourceIn(BaseModel):
    # `resource_id` pulls a resource from the master list (its name + rate are
    # snapshotted onto the BOM). Omit it to define an inline resource directly
    # on the BOM via `name` + `hourly_rate` (the simplified option).
    resource_id: Optional[int]   = None
    name:        Optional[str]   = None
    hourly_rate: Optional[float] = None


class BomIn(BaseModel):
    name:                str
    output_inventory_id: int
    output_quantity:     float = 1
    labor_cost:          float = 0      # legacy flat fallback (used only when no resources)
    overhead_cost:       float = 0      # legacy flat fallback
    standard_hours:      float = 0      # estimated production time per batch (for cost estimate + variance)
    notes:               Optional[str] = None
    revision_note:       Optional[str] = None
    is_active:           bool = True
    qc_required:         bool = False
    components:          list[BomComponentIn] = []
    resources:           list[BomResourceIn] = []


PRIORITIES = ("Low", "Normal", "High", "Urgent")


class OrderIn(BaseModel):
    bom_id:        int
    quantity:      float = 1
    labor_cost:    Optional[float] = None     # default: BOM labour, scaled
    overhead_cost: Optional[float] = None     # default: BOM overhead, scaled
    priority:      str  = "Normal"
    planned_start_date: Optional[str] = None
    due_date:      Optional[str] = None
    notes:         Optional[str] = None
    # Per Phase 1 design (and your decision to "consume and produce within
    # the same warehouse"): one warehouse per order — components draw from
    # here and the finished output lands here. Defaults to the user's
    # default warehouse so existing API callers keep working.
    warehouse_id:  Optional[int] = None


class OrderUpdate(BaseModel):
    quantity:      float
    labor_cost:    float = 0
    overhead_cost: float = 0
    priority:      Optional[str] = None
    planned_start_date: Optional[str] = None
    due_date:      Optional[str] = None
    notes:         Optional[str] = None
    warehouse_id:  Optional[int] = None       # re-route a draft order


class CompleteItemIn(BaseModel):
    id:                int                    # production_order_items.id
    quantity_consumed: float
    quantity_scrapped: float = 0


class CompleteIn(BaseModel):
    quantity_produced: Optional[float] = None  # default: remaining planned quantity
    production_hours:  Optional[float] = None  # actual hours this run → resource cost = Σ(rates) × hours
    labor_cost:        Optional[float] = None  # legacy flat fallback (used only when the BOM has no resources)
    overhead_cost:     Optional[float] = None  # legacy flat fallback
    items:             list[CompleteItemIn] = []
    # close=False produces a partial run and leaves the order open for more runs;
    # the order auto-closes once the cumulative output reaches the planned qty.
    close:             bool = True


class CancelIn(BaseModel):
    reason: Optional[str] = None


class QCDefectIn(BaseModel):
    reason:   str
    quantity: float = 0
    notes:    Optional[str] = None


class QCResolveIn(BaseModel):
    passed_qty:   float
    rejected_qty: float = 0
    rework_qty:   float = 0          # subset of the rejected units to remake via a linked order
    defects:      list[QCDefectIn] = []
    notes:        Optional[str] = None


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


def _bom_resource_rows(db, bom_id):
    """Cost resources assigned to a BOM (snapshot name + per-hour rate)."""
    return db.execute(
        "SELECT * FROM bom_resources WHERE bom_id=? ORDER BY id", (bom_id,)
    ).fetchall()


def _bom_standard_conversion(db, bom_row):
    """Standard (estimated) overhead cost for one BOM batch.

    Resource model: (Σ resource hourly rates) × the BOM's standard hours. When a
    BOM has no resources it falls back to the legacy flat labor + overhead, so
    older / simpler BOMs keep costing exactly as before."""
    rows = _bom_resource_rows(db, bom_row["id"])
    if not rows:
        labor = float(bom_row["labor_cost"] or 0)
        oh    = float(bom_row["overhead_cost"] or 0)
        return {"resources": [], "rate_sum": 0.0, "standard_hours": 0.0,
                "total": _c(labor + oh), "has_resources": False}
    std_hours = float(bom_row["standard_hours"] or 0) if "standard_hours" in bom_row.keys() else 0.0
    rate_sum  = sum(float(r["hourly_rate"] or 0) for r in rows)
    res = [{"name": r["name"], "hourly_rate": float(r["hourly_rate"] or 0),
            "cost": _c(float(r["hourly_rate"] or 0) * std_hours)} for r in rows]
    return {"resources": res, "rate_sum": _c(rate_sum), "standard_hours": std_hours,
            "total": _c(rate_sum * std_hours), "has_resources": True}


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
    batch += _bom_standard_conversion(db, bom_row)["total"]
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
    conv     = _bom_standard_conversion(db, bom_row)
    batch    = _c(material + conv["total"])
    yield_qty = float(bom_row["output_quantity"] or 1) or 1
    d["components"]      = comps
    d["component_count"] = len(comps)
    d["material_cost"]   = _c(material)
    d["resources"]       = [dict(r) for r in _bom_resource_rows(db, bom_row["id"])]
    d["rate_sum"]        = conv["rate_sum"]
    d["conversion_cost"] = conv["total"]
    d["overhead_cost"]   = conv["total"]      # resource overhead for the batch
    d["has_resources"]   = conv["has_resources"]
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
    """(Re)write an order's component requirements, scaled + scrap-adjusted.

    Required quantities are always rounded UP to the next whole unit — a
    production order can't physically consume 3.6667 of a component, you have
    to grab 4 of them. Rounding up is also the safe direction for material
    planning (never under-reserve)."""
    db.execute("DELETE FROM production_order_items WHERE production_order_id=?", (order_id,))
    scale = quantity / (float(bom["output_quantity"] or 1) or 1)
    for comp in _bom_component_rows(db, bom["id"]):
        scrap    = _q(comp["scrap_pct"])
        raw_qty  = float(comp["quantity"]) * scale * (1 + scrap / 100.0)
        required = float(math.ceil(raw_qty))
        db.execute(
            "INSERT INTO production_order_items "
            "(production_order_id, component_inventory_id, name, quantity_required, scrap_pct) "
            "VALUES (?,?,?,?,?)",
            (order_id, comp["component_inventory_id"],
             comp["component_name"] or "Component", required, scrap),
        )


def _snapshot_resources(db, order_id, bom_id):
    """Copy the BOM's cost resources onto the order (name + rate snapshot). Hours
    and cost are filled in at completion from the actual production duration."""
    db.execute("DELETE FROM production_order_resources WHERE production_order_id=?", (order_id,))
    now = _now()
    for r in _bom_resource_rows(db, bom_id):
        db.execute(
            "INSERT INTO production_order_resources "
            "(production_order_id, resource_id, name, hourly_rate, hours, cost, created_at) "
            "VALUES (?,?,?,?,0,0,?)",
            (order_id, r["resource_id"], r["name"], float(r["hourly_rate"] or 0), now),
        )


def _order_resources(db, order_id):
    return db.execute(
        "SELECT * FROM production_order_resources WHERE production_order_id=? ORDER BY id",
        (order_id,),
    ).fetchall()


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
    d["resources"] = [dict(r) for r in _order_resources(db, order_row["id"])]
    d["qc"] = [dict(q) for q in db.execute(
        "SELECT * FROM production_qc WHERE production_order_id=? ORDER BY id DESC",
        (order_row["id"],)).fetchall()]
    # Lot genealogy: the input lots this order consumed and the output lot(s) it
    # produced (populated only for lot-tracked items — see lots.py).
    d["consumed_lots"] = [dict(r) for r in db.execute(
        "SELECT lc.quantity, lc.unit_cost, lc.created_at, "
        "       il.lot_number, il.expiry_date, i.name AS item_name "
        "FROM lot_consumption lc "
        "JOIN inventory_lots il ON lc.lot_id = il.id "
        "JOIN inventory i       ON lc.inventory_id = i.id "
        "WHERE lc.production_order_id=? ORDER BY lc.id", (order_row["id"],)).fetchall()]
    d["produced_lots"] = [dict(r) for r in db.execute(
        "SELECT l.id, l.lot_number, l.quantity_remaining, l.original_quantity, "
        "       l.unit_cost, l.manufacture_date, l.expiry_date, i.name AS item_name "
        "FROM inventory_lots l JOIN inventory i ON l.inventory_id = i.id "
        "WHERE l.source_type='production' AND l.source_ref=? ORDER BY l.id",
        (order_row["order_number"],)).fetchall()]
    produced = order_row["quantity_produced"]
    d["output_variance"] = (round(float(produced) - float(order_row["quantity"]), 6)
                            if produced is not None else None)
    _done = float(order_row["quantity_completed"] or 0) if "quantity_completed" in order_row.keys() else 0.0
    d["remaining"] = round(float(order_row["quantity"]) - _done, 6)
    d["movements"] = [dict(m) for m in db.execute(
        "SELECT sm.*, i.name AS item_name FROM stock_movements sm "
        "LEFT JOIN inventory i ON sm.inventory_id = i.id "
        "WHERE sm.reference=? ORDER BY sm.id", (order_row["order_number"],),
    ).fetchall()]
    return d


# ════════════════════════════════════════════════════════════════════════════
# RESOURCES — reusable per-hour cost rates (Labor, Electricity, CNC, Oven, …)
# ════════════════════════════════════════════════════════════════════════════
def _validate_resource(data: ResourceIn):
    if not (data.name or "").strip():
        raise HTTPException(400, "Resource name is required.")
    if data.cost_type not in RESOURCE_COST_TYPES:
        raise HTTPException(400, f"cost_type must be one of: {', '.join(RESOURCE_COST_TYPES)}")
    if data.hourly_rate is None or data.hourly_rate < 0:
        raise HTTPException(400, "Hourly rate cannot be negative.")


@router.get("/resources")
def list_resources(
    active: Optional[bool] = None,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = "SELECT * FROM manufacturing_resources WHERE archived_at IS NULL"
    params: list = []
    if active is not None:
        q += " AND is_active=?"; params.append(1 if active else 0)
    q += " ORDER BY name"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@router.post("/resources")
def create_resource(
    data: ResourceIn,
    user=Depends(require_perm("manufacturing", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    _validate_resource(data)
    cur = db.execute(
        "INSERT INTO manufacturing_resources "
        "(name, cost_type, hourly_rate, is_active, notes, created_at) VALUES (?,?,?,?,?,?)",
        (data.name.strip(), data.cost_type, _c(data.hourly_rate),
         1 if data.is_active else 0, data.notes, _now()),
    )
    log_action(db, user, "create", "manufacturing", cur.lastrowid, f"Resource: {data.name.strip()}")
    db.commit()
    return {"id": cur.lastrowid, "message": "Resource created"}


@router.put("/resources/{res_id}")
def update_resource(
    res_id: int,
    data: ResourceIn,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not db.execute("SELECT 1 FROM manufacturing_resources WHERE id=? AND archived_at IS NULL",
                      (res_id,)).fetchone():
        raise HTTPException(404, "Resource not found")
    _validate_resource(data)
    db.execute(
        "UPDATE manufacturing_resources SET name=?, cost_type=?, hourly_rate=?, is_active=?, notes=? WHERE id=?",
        (data.name.strip(), data.cost_type, _c(data.hourly_rate),
         1 if data.is_active else 0, data.notes, res_id),
    )
    log_action(db, user, "update", "manufacturing", res_id, f"Resource: {data.name.strip()}")
    db.commit()
    return {"message": "Resource updated"}


@router.patch("/resources/{res_id}/archive")
def archive_resource(
    res_id: int,
    user=Depends(require_perm("manufacturing", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT name FROM manufacturing_resources WHERE id=? AND archived_at IS NULL",
                     (res_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Resource not found")
    db.execute("UPDATE manufacturing_resources SET archived_at=? WHERE id=?", (_now(), res_id))
    log_action(db, user, "archive", "manufacturing", res_id, f"Resource: {row['name']}")
    db.commit()
    return {"message": "Resource archived"}


@router.patch("/resources/{res_id}/unarchive")
def unarchive_resource(
    res_id: int,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT name FROM manufacturing_resources WHERE id=? AND archived_at IS NOT NULL",
                     (res_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Resource not found in archives")
    db.execute("UPDATE manufacturing_resources SET archived_at=NULL WHERE id=?", (res_id,))
    log_action(db, user, "unarchive", "manufacturing", res_id, f"Resource: {row['name']}")
    db.commit()
    return {"message": "Resource restored"}


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
    validate_int_qty(data.output_quantity, "Output (batch) quantity")
    if data.labor_cost < 0 or data.overhead_cost < 0:
        raise HTTPException(400, "Labour and overhead costs cannot be negative.")
    if not data.components:
        raise HTTPException(400, "A BOM needs at least one component.")
    for comp in data.components:
        if comp.component_inventory_id == data.output_inventory_id:
            raise HTTPException(400, "A product cannot be a component of itself.")
        if comp.quantity <= 0:
            raise HTTPException(400, "Component quantity must be positive.")
        validate_int_qty(comp.quantity, "Component quantity")
        if comp.scrap_pct < 0 or comp.scrap_pct > 100:
            raise HTTPException(400, "Scrap % must be between 0 and 100.")
        if not db.execute("SELECT 1 FROM inventory WHERE id=?",
                          (comp.component_inventory_id,)).fetchone():
            raise HTTPException(400, f"Component item #{comp.component_inventory_id} not found.")
    if (data.standard_hours or 0) < 0:
        raise HTTPException(400, "Standard hours cannot be negative.")
    # Resource lines are validated in _write_resources (existence + non-negative rate).


def _write_components(db, bom_id, components):
    db.execute("DELETE FROM bom_components WHERE bom_id=?", (bom_id,))
    for comp in components:
        db.execute(
            "INSERT INTO bom_components (bom_id, component_inventory_id, quantity, scrap_pct) "
            "VALUES (?,?,?,?)",
            (bom_id, comp.component_inventory_id, comp.quantity, comp.scrap_pct),
        )


def _write_resources(db, bom_id, resources):
    """(Re)write a BOM's cost resources. A row with `resource_id` snapshots the
    master resource's name + rate; otherwise the inline name + rate are used."""
    db.execute("DELETE FROM bom_resources WHERE bom_id=?", (bom_id,))
    for r in (resources or []):
        name = (r.name or "").strip()
        rate = r.hourly_rate
        if r.resource_id is not None:
            master = db.execute(
                "SELECT name, hourly_rate FROM manufacturing_resources WHERE id=? AND archived_at IS NULL",
                (r.resource_id,)).fetchone()
            if not master:
                raise HTTPException(400, f"Resource #{r.resource_id} not found.")
            name = name or master["name"]
            if rate is None:
                rate = master["hourly_rate"]
        if not name:
            raise HTTPException(400, "Each resource needs a name.")
        rate = float(rate or 0)
        if rate < 0:
            raise HTTPException(400, "Resource hourly rate cannot be negative.")
        db.execute(
            "INSERT INTO bom_resources (bom_id, resource_id, name, hourly_rate) VALUES (?,?,?,?)",
            (bom_id, r.resource_id, name, rate),
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
        " overhead_cost, standard_hours, notes, revision_note, is_active, qc_required, version, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,1,?)",
        (data.name.strip(), data.output_inventory_id, data.output_quantity,
         data.labor_cost, data.overhead_cost, _q(data.standard_hours), data.notes, data.revision_note,
         1 if data.is_active else 0, 1 if data.qc_required else 0, now),
    )
    bom_id = cur.lastrowid
    db.execute("UPDATE boms SET bom_group_id=? WHERE id=?", (bom_id, bom_id))
    _write_components(db, bom_id, data.components)
    _write_resources(db, bom_id, data.resources)
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
        " overhead_cost=?, standard_hours=?, notes=?, is_active=?, qc_required=? WHERE id=?",
        (data.name.strip(), data.output_inventory_id, data.output_quantity,
         data.labor_cost, data.overhead_cost, _q(data.standard_hours), data.notes,
         1 if data.is_active else 0, 1 if data.qc_required else 0, bom_id),
    )
    _write_components(db, bom_id, data.components)
    _write_resources(db, bom_id, data.resources)
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
        " overhead_cost, standard_hours, notes, revision_note, is_active, qc_required, version, bom_group_id, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)",
        (data.name.strip(), data.output_inventory_id, data.output_quantity,
         data.labor_cost, data.overhead_cost, _q(data.standard_hours), data.notes, data.revision_note,
         1 if data.qc_required else 0, next_v, group, now),
    )
    new_id = cur.lastrowid
    _write_components(db, new_id, data.components)
    _write_resources(db, new_id, data.resources)
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
    sort: Optional[str] = None,
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
    if sort == "schedule":
        # Schedule view: soonest due date first (undated last), then priority.
        query += (" ORDER BY (po.due_date IS NULL), po.due_date ASC, "
                  " CASE po.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 "
                  "   WHEN 'Normal' THEN 2 ELSE 3 END, po.id DESC")
    else:
        query += " ORDER BY po.id DESC"
    query += " LIMIT 300"
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
    validate_int_qty(data.quantity, "Quantity to produce")
    if not db.execute("SELECT 1 FROM bom_components WHERE bom_id=?", (data.bom_id,)).fetchone():
        raise HTTPException(400, "This BOM has no components.")

    scale = data.quantity / (float(bom["output_quantity"] or 1) or 1)
    labor = (_c(data.labor_cost) if data.labor_cost is not None
             else _c(float(bom["labor_cost"] or 0) * scale))
    overhead = (_c(data.overhead_cost) if data.overhead_cost is not None
                else _c(float(bom["overhead_cost"] or 0) * scale))
    now      = _now()
    order_no = _next_order_number(db)
    qc_required = 1 if ("qc_required" in bom.keys() and bom["qc_required"]) else 0
    priority = data.priority if data.priority in PRIORITIES else "Normal"
    # Resolve the warehouse — components consume from here, output lands here.
    import warehouse_access as wha
    warehouse_id = wha.resolve_warehouse_id(user, db, data.warehouse_id)
    cur = db.execute(
        "INSERT INTO production_orders "
        "(order_number, bom_id, bom_version, output_inventory_id, quantity, status, "
        " labor_cost, overhead_cost, qc_required, priority, planned_start_date, due_date, "
        " notes, warehouse_id, created_by, created_at) "
        "VALUES (?,?,?,?,?, 'Draft', ?,?,?,?,?,?,?,?,?,?)",
        (order_no, bom["id"], bom["version"], bom["output_inventory_id"], data.quantity,
         labor, overhead, qc_required, priority, data.planned_start_date, data.due_date,
         data.notes, warehouse_id, user["id"], now),
    )
    order_id = cur.lastrowid
    _snapshot_components(db, order_id, bom, data.quantity)
    _snapshot_resources(db, order_id, bom["id"])
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
    validate_int_qty(data.quantity, "Quantity to produce")
    priority = data.priority if (data.priority in PRIORITIES) else order["priority"]
    db.execute(
        "UPDATE production_orders SET quantity=?, labor_cost=?, overhead_cost=?, "
        " priority=?, planned_start_date=?, due_date=?, notes=? WHERE id=?",
        (data.quantity, _c(data.labor_cost), _c(data.overhead_cost),
         priority,
         data.planned_start_date if data.planned_start_date is not None else order["planned_start_date"],
         data.due_date if data.due_date is not None else order["due_date"],
         data.notes, order_id),
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

    # Partial-completion bookkeeping. The classic single-shot path (close=True on
    # an order with nothing produced yet) is preserved exactly; partial runs
    # accumulate output + cost and leave the order open until the planned qty is
    # reached (or the caller closes it).
    already    = float(order["quantity_completed"] or 0) if "quantity_completed" in order.keys() else 0.0
    planned_qty = float(order["quantity"])
    remaining  = _q(planned_qty - already)
    single_shot = bool(data.close) and already <= 1e-9
    if not single_shot and remaining <= 1e-9:
        raise HTTPException(400, "This order's planned quantity has already been produced.")
    qty_produced = (float(data.quantity_produced) if data.quantity_produced is not None
                    else (planned_qty if single_shot else remaining))
    if qty_produced <= 0:
        raise HTTPException(400, "Produced quantity must be positive.")
    validate_int_qty(qty_produced, "Produced quantity")
    if not single_shot and qty_produced > remaining + 1e-9:
        raise HTTPException(400, f"Only {remaining:g} unit(s) remain to produce on this order.")

    # Actual consumption per line — single-shot defaults to the full planned
    # requirement; a partial run defaults to its proportional share.
    _cfactor = 1.0 if single_shot else (qty_produced / planned_qty if planned_qty else 0.0)
    actual = {it["id"]: {"consumed": (float(it["quantity_required"]) if single_shot
                                      else _q(float(it["quantity_required"]) * _cfactor)),
                         "scrapped": 0.0}
              for it in items}
    for ci in data.items:
        if ci.id not in actual:
            raise HTTPException(400, f"Line #{ci.id} does not belong to this order.")
        if ci.quantity_consumed < 0 or ci.quantity_scrapped < 0:
            raise HTTPException(400, "Consumed and scrapped quantities cannot be negative.")
        validate_int_qty(ci.quantity_consumed, "Consumed quantity")
        validate_int_qty(ci.quantity_scrapped, "Scrapped quantity")
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

    now = _now()
    cost_method  = costing.get_method(db)
    comp_eff_cost = {}   # component inventory_id → effective unit cost consumed

    # 1. Consume raw materials and release their reservation. Material cost
    #    follows the costing method (FIFO/LIFO draw from cost layers).
    # Components are drawn from — and the output lands in — the order's
    # warehouse (Phase 1 design: one warehouse per order).
    import warehouse_access as wha
    order_wid = wha.default_warehouse_id_for_row(db, order["warehouse_id"])
    materials_cost = 0.0
    for cid, qty in consume.items():
        inv        = invs[cid]
        qty_before = float(inv["quantity"])
        qty_after  = _q(qty_before - qty)
        # Single-shot releases the whole planned reservation; a partial run
        # releases only what it consumed so later runs stay reserved.
        _rel       = planned.get(cid, 0.0) if single_shot else qty
        new_res    = max(0.0, _q(float(inv["reserved_quantity"] or 0) - _rel))
        comp_cogs  = lots.value_stock_out(db, cid, qty, source_type="production",
                                          source_ref=order["order_number"], now=now,
                                          production_order_id=order_id)
        comp_eff_cost[cid] = round(comp_cogs / qty, 6) if qty else float(inv["unit_cost"] or 0)
        db.execute("UPDATE inventory SET quantity=?, reserved_quantity=? WHERE id=?",
                   (qty_after, new_res, cid))
        if qty:
            wha.credit_warehouse_stock(db, inventory_id=cid,
                                        warehouse_id=order_wid, delta=-qty)
            db.execute(
                "INSERT INTO stock_movements "
                "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (cid, "production", -qty, qty_before, qty_after,
                 order["order_number"], "Production consumption", order_wid, now))
        materials_cost += comp_cogs
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
        uc  = comp_eff_cost.get(cid, float(invs[cid]["unit_cost"] or 0) if cid in invs else 0.0)
        scrap_cost += a["scrapped"] * uc
        if single_shot:
            db.execute(
                "UPDATE production_order_items SET quantity_consumed=?, quantity_scrapped=?, "
                " unit_cost=?, line_cost=? WHERE id=?",
                (a["consumed"], a["scrapped"], uc, _u(a["consumed"] * uc), it["id"]))
        else:
            db.execute(
                "UPDATE production_order_items SET "
                " quantity_consumed=COALESCE(quantity_consumed,0)+?, "
                " quantity_scrapped=COALESCE(quantity_scrapped,0)+?, "
                " unit_cost=?, line_cost=COALESCE(line_cost,0)+? WHERE id=?",
                (a["consumed"], a["scrapped"], uc, _u(a["consumed"] * uc), it["id"]))
    scrap_cost = _c(scrap_cost)

    # Conversion (overhead) cost from assigned RESOURCES × actual production
    # hours: per-resource cost = hourly_rate × hours; total overhead = Σ. When
    # the operator omits the duration it defaults to the BOM standard hours,
    # scaled to this run. With no resources we fall back to the legacy flat
    # labor + overhead so the simplest BOMs keep costing exactly as before.
    bom_row = db.execute(
        "SELECT standard_hours, output_quantity, labor_cost, overhead_cost FROM boms WHERE id=?",
        (order["bom_id"],)).fetchone() if order["bom_id"] else None
    _bom_out = float(bom_row["output_quantity"] or 1) if bom_row else 1.0
    _std_run = (float(bom_row["standard_hours"] or 0) * (qty_produced / (_bom_out or 1))
                if bom_row else 0.0)
    prod_hours = (float(data.production_hours) if data.production_hours is not None else _std_run)
    if prod_hours < 0:
        raise HTTPException(400, "Production hours cannot be negative.")

    res_rows = _order_resources(db, order_id)
    labor = machine_cost = electricity_cost = overhead = 0.0
    if res_rows:
        for r in res_rows:
            rcost = _c(float(r["hourly_rate"] or 0) * prod_hours)
            overhead += rcost
            if single_shot:
                db.execute("UPDATE production_order_resources SET hours=?, cost=? WHERE id=?",
                           (_q(prod_hours), rcost, r["id"]))
            else:
                db.execute("UPDATE production_order_resources SET "
                           "hours=COALESCE(hours,0)+?, cost=COALESCE(cost,0)+? WHERE id=?",
                           (_q(prod_hours), rcost, r["id"]))
        overhead = _c(overhead)
    else:
        labor    = _c(data.labor_cost if data.labor_cost is not None else order["labor_cost"])
        overhead = _c(data.overhead_cost if data.overhead_cost is not None else order["overhead_cost"])
        if not single_shot:
            # Proportional share of the flat estimate for a partial run.
            share = qty_produced / planned_qty if planned_qty else 0.0
            labor = _c(float(bom_row["labor_cost"] or 0) * (qty_produced / (_bom_out or 1))) if bom_row else _c(labor * share)
            overhead = _c(float(bom_row["overhead_cost"] or 0) * (qty_produced / (_bom_out or 1))) if bom_row else _c(overhead * share)

    run_total     = _c(materials_cost + labor + machine_cost + electricity_cost + overhead)
    run_unit_cost = _u(run_total / qty_produced) if qty_produced else 0.0
    unit_cost     = run_unit_cost   # cost basis for THIS run's output (lot / QC / layer)

    # 3. Output handling. A QC-required order routes the finished batch into a
    #    non-sellable quarantine bucket and opens an inspection; otherwise the
    #    batch enters sellable stock immediately (weighted-average unit cost + a
    #    FIFO/LIFO cost layer).
    qc_required = bool(order["qc_required"]) if "qc_required" in order.keys() else False
    out_before  = float(out_inv["quantity"])
    qc_id = None
    if qc_required:
        quar_before = float(out_inv["quarantine_quantity"] or 0)
        db.execute("UPDATE inventory SET quarantine_quantity=? WHERE id=?",
                   (_q(quar_before + qty_produced), order["output_inventory_id"]))
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (order["output_inventory_id"], "qc_quarantine", qty_produced,
             out_before, out_before, order["order_number"],
             "Production output → quarantine (awaiting QC)", order_wid, now))
        qc_cur = db.execute(
            "INSERT INTO production_qc "
            "(production_order_id, output_inventory_id, quantity, unit_cost, status, created_at) "
            "VALUES (?,?,?,?, 'Pending', ?)",
            (order_id, order["output_inventory_id"], qty_produced, unit_cost, now))
        qc_id = qc_cur.lastrowid
    else:
        out_after  = _q(out_before + qty_produced)
        old_cost   = float(out_inv["unit_cost"] or 0)
        new_cost   = (_u((out_before * old_cost + qty_produced * unit_cost) / out_after)
                      if out_after else unit_cost)
        db.execute("UPDATE inventory SET quantity=?, unit_cost=? WHERE id=?",
                   (out_after, new_cost, order["output_inventory_id"]))
        wha.credit_warehouse_stock(db, inventory_id=order["output_inventory_id"],
                                    warehouse_id=order_wid, delta=qty_produced)
        # The produced batch enters stock as its own lot (lot-tracked) or cost
        # layer; for a lot, link the input lots consumed above to it (genealogy).
        out_lot_id = lots.record_stock_in(
            db, order["output_inventory_id"], qty_produced, unit_cost,
            source_type="production", source_ref=order["order_number"], now=now,
            manufacture_date=now[:10])
        lots.link_output_lot(db, order_id, out_lot_id)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (order["output_inventory_id"], "production", qty_produced,
             out_before, out_after, order["order_number"], "Production output", order_wid, now))

    # 4. Persist costs + status. Single-shot overwrites and closes; a partial run
    #    accumulates ACTUAL costs onto prior runs and closes only when the planned
    #    quantity is reached (or the caller asked to close).
    if single_shot:
        new_completed = qty_produced
        new_status, completed_at = ST_COMPLETED, now
        total_cost, unit_cost = run_total, run_unit_cost
    else:
        prior = {k: (float(order[k] or 0) if already > 1e-9 else 0.0)
                 for k in ("materials_cost", "labor_cost", "machine_cost",
                           "electricity_cost", "overhead_cost", "scrap_cost")}
        materials_cost   = _c(prior["materials_cost"]   + materials_cost)
        labor            = _c(prior["labor_cost"]       + labor)
        machine_cost     = _c(prior["machine_cost"]     + machine_cost)
        electricity_cost = _c(prior["electricity_cost"] + electricity_cost)
        overhead         = _c(prior["overhead_cost"]    + overhead)
        scrap_cost       = _c(prior["scrap_cost"]       + scrap_cost)
        new_completed    = _q(already + qty_produced)
        total_cost       = _c(materials_cost + labor + machine_cost + electricity_cost + overhead)
        unit_cost        = _u(total_cost / new_completed) if new_completed else 0.0
        fully_done       = bool(data.close) or new_completed >= planned_qty - 1e-9
        new_status       = ST_COMPLETED if fully_done else ST_PROGRESS
        completed_at     = now if fully_done else order["completed_at"]

    new_hours = _q(prod_hours if single_shot
                   else float(order["production_hours"] or 0) + prod_hours)
    db.execute(
        "UPDATE production_orders SET status=?, materials_cost=?, labor_cost=?, "
        " machine_cost=?, electricity_cost=?, overhead_cost=?, scrap_cost=?, "
        " total_cost=?, unit_cost=?, quantity_produced=?, quantity_completed=?, "
        " production_hours=?, completed_at=? WHERE id=?",
        (new_status, materials_cost, labor, machine_cost, electricity_cost, overhead,
         scrap_cost, total_cost, unit_cost, new_completed, new_completed,
         new_hours, completed_at, order_id))
    log_action(db, user, "complete" if new_status == ST_COMPLETED else "complete_partial",
               "manufacturing", order_id, order["order_number"],
               {"materials_cost": materials_cost, "total_cost": total_cost,
                "unit_cost": unit_cost, "run_quantity": qty_produced,
                "quantity_completed": new_completed})
    if new_status == ST_COMPLETED:
        notify(db, type="production_completed",
               title=f"Production complete: {order['order_number']}",
               body=(f"{new_completed} × {out_inv['name']} at ${unit_cost:.2f}/unit "
                     + ("→ awaiting quality control" if qc_required
                        else f"(total ${total_cost:.2f})")),
               link="/manufacturing", entity_type="production_order", entity_id=order_id)
    db.commit()
    _msg = ("Production order completed — batch is in quarantine awaiting QC"
            if (qc_required and new_status == ST_COMPLETED)
            else "Production order completed" if new_status == ST_COMPLETED
            else f"Partial run recorded — {new_completed:g}/{planned_qty:g} produced")
    return {
        "message":          _msg,
        "status":           new_status,
        "run_quantity":     qty_produced,
        "quantity_completed": new_completed,
        "remaining":        _q(planned_qty - new_completed),
        "materials_cost":   materials_cost,
        "labor_cost":       labor,
        "machine_cost":     machine_cost,
        "electricity_cost": electricity_cost,
        "overhead_cost":    overhead,
        "scrap_cost":       scrap_cost,
        "total_cost":       total_cost,
        "unit_cost":        unit_cost,
        "quantity_produced": new_completed,
        "qc_required":      qc_required,
        "qc_id":            qc_id,
    }


@router.post("/orders/{order_id}/complete-partial")
def complete_partial(
    order_id: int,
    data: CompleteIn = Body(default_factory=CompleteIn),
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Record a partial production run: produce part of the order now, leaving it
    open for more runs. Auto-closes once cumulative output reaches the plan."""
    data.close = False
    return complete_order(order_id, data, user, db)


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
# QUALITY CONTROL — inspect a quarantined batch; release / reject / rework
# ════════════════════════════════════════════════════════════════════════════
def _create_rework_order(db, src_order, rework_qty, user, now):
    """Spawn a fresh Draft production order to remake rejected units, linked to
    the order whose QC raised the rework. Returns the new order id (or None)."""
    bom = (db.execute("SELECT * FROM boms WHERE id=?", (src_order["bom_id"],)).fetchone()
           if src_order["bom_id"] else None)
    if not bom:
        return None, None
    scale    = rework_qty / (float(bom["output_quantity"] or 1) or 1)
    labor    = _c(float(bom["labor_cost"] or 0) * scale)
    overhead = _c(float(bom["overhead_cost"] or 0) * scale)
    order_no = _next_order_number(db)
    qcr = 1 if ("qc_required" in bom.keys() and bom["qc_required"]) else 0
    cur = db.execute(
        "INSERT INTO production_orders "
        "(order_number, bom_id, bom_version, output_inventory_id, quantity, status, "
        " labor_cost, overhead_cost, qc_required, rework_of_order_id, notes, created_by, created_at) "
        "VALUES (?,?,?,?,?, 'Draft', ?,?,?,?,?,?,?)",
        (order_no, bom["id"], bom["version"], bom["output_inventory_id"], rework_qty,
         labor, overhead, qcr, src_order["id"], f"Rework of {src_order['order_number']}",
         user["id"], now),
    )
    rid = cur.lastrowid
    _snapshot_components(db, rid, bom, rework_qty)
    _snapshot_resources(db, rid, bom["id"])
    return rid, order_no


@router.get("/qc")
def list_qc(
    status: Optional[str] = None,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = ("SELECT q.*, po.order_number, i.name AS output_name, u.full_name AS inspector_name "
         "FROM production_qc q "
         "JOIN production_orders po ON q.production_order_id = po.id "
         "JOIN inventory i          ON q.output_inventory_id = i.id "
         "LEFT JOIN users u         ON q.inspector_id = u.id WHERE 1=1")
    params: list = []
    if status:
        q += " AND q.status=?"; params.append(status)
    q += " ORDER BY (q.status='Pending') DESC, q.created_at DESC LIMIT 500"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@router.get("/qc/{qc_id}")
def get_qc(
    qc_id: int,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT q.*, po.order_number, i.name AS output_name, i.unit AS output_unit, "
        "       u.full_name AS inspector_name "
        "FROM production_qc q "
        "JOIN production_orders po ON q.production_order_id = po.id "
        "JOIN inventory i          ON q.output_inventory_id = i.id "
        "LEFT JOIN users u         ON q.inspector_id = u.id WHERE q.id=?",
        (qc_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Inspection not found")
    d = dict(row)
    d["defects"] = [dict(x) for x in db.execute(
        "SELECT * FROM production_qc_defects WHERE qc_id=? ORDER BY id", (qc_id,)).fetchall()]
    return d


@router.post("/qc/{qc_id}/resolve")
def resolve_qc(
    qc_id: int,
    data: QCResolveIn,
    user=Depends(require_perm("manufacturing", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Release passed units to sellable stock, scrap rejects, log defects, and
    optionally spawn a rework order. passed + rejected must equal the batch."""
    qc = db.execute("SELECT * FROM production_qc WHERE id=?", (qc_id,)).fetchone()
    if not qc:
        raise HTTPException(404, "Inspection not found")
    if qc["status"] != "Pending":
        raise HTTPException(400, f"This inspection is already {qc['status'].lower()}.")

    qty      = float(qc["quantity"])
    passed   = float(data.passed_qty or 0)
    rejected = float(data.rejected_qty or 0)
    rework   = float(data.rework_qty or 0)
    if passed < 0 or rejected < 0 or rework < 0:
        raise HTTPException(400, "Quantities cannot be negative.")
    validate_int_qty(passed,   "Passed quantity")
    validate_int_qty(rejected, "Rejected quantity")
    validate_int_qty(rework,   "Rework quantity")
    if abs(passed + rejected - qty) > 1e-6:
        raise HTTPException(400, f"Passed + rejected must equal the batch quantity ({qty:g}).")
    if rework > rejected + 1e-9:
        raise HTTPException(400, "Rework quantity cannot exceed the rejected quantity.")

    now       = _now()
    unit_cost = float(qc["unit_cost"] or 0)
    out_id    = qc["output_inventory_id"]
    # Resolve the order's warehouse so QC release lands in the same place the
    # batch was produced (it's been in quarantine at that warehouse).
    import warehouse_access as wha
    order_row = db.execute(
        "SELECT order_number, warehouse_id FROM production_orders WHERE id=?",
        (qc["production_order_id"],)).fetchone()
    order_no  = order_row["order_number"]
    order_wid = wha.default_warehouse_id_for_row(db, order_row["warehouse_id"])
    inv = db.execute("SELECT * FROM inventory WHERE id=?", (out_id,)).fetchone()

    # The whole batch leaves quarantine.
    quar = float(inv["quarantine_quantity"] or 0)
    db.execute("UPDATE inventory SET quarantine_quantity=? WHERE id=?",
               (_q(max(0.0, quar - qty)), out_id))

    # Passed → sellable stock (weighted-average) + a FIFO/LIFO cost layer.
    if passed > 0:
        on_before = float(inv["quantity"])
        on_after  = _q(on_before + passed)
        old_cost  = float(inv["unit_cost"] or 0)
        new_cost  = (_u((on_before * old_cost + passed * unit_cost) / on_after)
                     if on_after else unit_cost)
        db.execute("UPDATE inventory SET quantity=?, unit_cost=? WHERE id=?",
                   (on_after, new_cost, out_id))
        wha.credit_warehouse_stock(db, inventory_id=out_id,
                                    warehouse_id=order_wid, delta=passed)
        # Released batch becomes a lot (lot-tracked) or cost layer; link the
        # production order's consumed input lots to it for genealogy.
        out_lot_id = lots.record_stock_in(
            db, out_id, passed, unit_cost, source_type="production",
            source_ref=order_no, now=now, manufacture_date=now[:10])
        lots.link_output_lot(db, qc["production_order_id"], out_lot_id)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (out_id, "qc_release", passed, on_before, on_after, order_no,
             "QC passed — released to stock", order_wid, now))

    scrap_cost = _c(rejected * unit_cost)
    if rejected > 0:
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (out_id, "qc_reject", -rejected, rejected, 0.0, order_no,
             f"QC rejected — scrapped (${scrap_cost:.2f})", order_wid, now))

    for df in (data.defects or []):
        if (df.reason or "").strip():
            db.execute(
                "INSERT INTO production_qc_defects (qc_id, reason, quantity, notes) "
                "VALUES (?,?,?,?)",
                (qc_id, df.reason.strip(), float(df.quantity or 0), df.notes))

    rework_order_id = rework_order_no = None
    if rework > 0:
        src = db.execute("SELECT * FROM production_orders WHERE id=?",
                         (qc["production_order_id"],)).fetchone()
        rework_order_id, rework_order_no = _create_rework_order(db, src, rework, user, now)

    status = "Passed" if rejected == 0 else ("Failed" if passed == 0 else "Partial")
    db.execute(
        "UPDATE production_qc SET passed_qty=?, rejected_qty=?, rework_qty=?, scrap_cost=?, "
        " status=?, notes=?, inspector_id=?, inspected_at=? WHERE id=?",
        (passed, rejected, rework, scrap_cost, status, data.notes, user["id"], now, qc_id))
    log_action(db, user, "qc_resolve", "manufacturing", qc_id,
               f"{order_no} — {status}",
               {"passed": passed, "rejected": rejected, "rework": rework})
    db.commit()
    return {
        "message":         f"Inspection {status.lower()}",
        "status":          status,
        "passed_qty":      passed,
        "rejected_qty":    rejected,
        "scrap_cost":      scrap_cost,
        "rework_order_id": rework_order_id,
        "rework_order_number": rework_order_no,
    }


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


@router.get("/analytics")
def analytics(
    start: Optional[str] = None,
    end: Optional[str] = None,
    user=Depends(require_perm("manufacturing", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Production analytics over completed orders in a date range: output, cost
    breakdown, standard-vs-actual cost variance, time efficiency, on-time
    delivery, QC yield, and per-work-center utilisation."""
    where = "po.status='Completed' AND po.archived_at IS NULL"
    params: list = []
    if start:
        where += " AND date(po.completed_at) >= ?"; params.append(start[:10])
    if end:
        where += " AND date(po.completed_at) <= ?"; params.append(end[:10])

    orders = db.execute(
        f"SELECT po.*, i.name AS output_name FROM production_orders po "
        f"LEFT JOIN inventory i ON po.output_inventory_id = i.id "
        f"WHERE {where} ORDER BY po.completed_at DESC LIMIT 1000", params).fetchall()

    # ── Output + cost breakdown + standard-vs-actual variance ──────────────
    totals = {"orders": 0, "units": 0.0, "materials": 0.0, "labor": 0.0,
              "machine": 0.0, "electricity": 0.0, "overhead": 0.0, "scrap": 0.0,
              "actual": 0.0, "standard": 0.0}
    on_time = late = no_due = 0
    variances = []
    _std_cache = {}
    for o in orders:
        produced = float(o["quantity_produced"] or 0)
        actual   = float(o["total_cost"] or 0)
        totals["orders"]      += 1
        totals["units"]       += produced
        totals["materials"]   += float(o["materials_cost"] or 0)
        totals["labor"]       += float(o["labor_cost"] or 0)
        totals["machine"]     += float(o["machine_cost"] or 0)
        totals["electricity"] += float(o["electricity_cost"] or 0)
        totals["overhead"]    += float(o["overhead_cost"] or 0)
        totals["scrap"]       += float(o["scrap_cost"] or 0)
        totals["actual"]      += actual
        # Standard cost from the order's BOM (cached per BOM).
        std_unit = 0.0
        if o["bom_id"]:
            if o["bom_id"] not in _std_cache:
                bom = db.execute("SELECT * FROM boms WHERE id=?", (o["bom_id"],)).fetchone()
                _std_cache[o["bom_id"]] = _bom_unit_cost(db, bom) if bom else 0.0
            std_unit = _std_cache[o["bom_id"]]
        std_total = round(std_unit * produced, 2)
        totals["standard"] += std_total
        var = round(actual - std_total, 2)
        variances.append({
            "order_number": o["order_number"], "product": o["output_name"],
            "quantity": produced, "standard_cost": std_total, "actual_cost": round(actual, 2),
            "variance": var,
            "variance_pct": round(var / std_total * 100, 1) if std_total else None,
        })
        # On-time delivery.
        if o["due_date"]:
            if str(o["completed_at"] or "")[:10] <= str(o["due_date"])[:10]:
                on_time += 1
            else:
                late += 1
        else:
            no_due += 1

    variances.sort(key=lambda v: abs(v["variance"]), reverse=True)

    # ── Time efficiency (standard vs actual production hours) ──────────────
    eff = db.execute(
        f"SELECT COALESCE(SUM(b.standard_hours * "
        f"        (po.quantity_produced / NULLIF(b.output_quantity,0))),0) AS planned, "
        f"       COALESCE(SUM(po.production_hours),0) AS actual "
        f"FROM production_orders po LEFT JOIN boms b ON po.bom_id = b.id "
        f"WHERE {where}", params).fetchone()
    planned_hrs = float(eff["planned"]); actual_hrs = float(eff["actual"])

    # ── Cost by resource (Labor, Electricity, CNC, …) ──────────────────────
    by_resource = [dict(r) for r in db.execute(
        f"SELECT r.name AS resource, COALESCE(SUM(r.hours),0) AS hours, "
        f"       COALESCE(SUM(r.cost),0) AS cost "
        f"FROM production_order_resources r JOIN production_orders po "
        f"  ON r.production_order_id = po.id "
        f"WHERE {where} GROUP BY r.name ORDER BY cost DESC", params).fetchall()]

    # ── QC yield ───────────────────────────────────────────────────────────
    qc = db.execute(
        f"SELECT COUNT(*) inspections, COALESCE(SUM(q.quantity),0) qty, "
        f"       COALESCE(SUM(q.passed_qty),0) passed, COALESCE(SUM(q.rejected_qty),0) rejected, "
        f"       COALESCE(SUM(q.scrap_cost),0) scrap "
        f"FROM production_qc q JOIN production_orders po ON q.production_order_id = po.id "
        f"WHERE {where} AND q.status != 'Pending'", params).fetchone()
    qc_qty = float(qc["qty"]); qc_passed = float(qc["passed"]); qc_rejected = float(qc["rejected"])

    by_product = [dict(r) for r in db.execute(
        f"SELECT i.name AS product, COALESCE(SUM(po.quantity_produced),0) AS units, "
        f"       COALESCE(SUM(po.total_cost),0) AS cost "
        f"FROM production_orders po LEFT JOIN inventory i ON po.output_inventory_id = i.id "
        f"WHERE {where} GROUP BY po.output_inventory_id, i.name ORDER BY cost DESC LIMIT 20", params).fetchall()]

    return {
        "start": start, "end": end,
        "summary": {
            "orders": totals["orders"], "units": _q(totals["units"]),
            "total_cost": _c(totals["actual"]),
            "avg_unit_cost": _u(totals["actual"] / totals["units"]) if totals["units"] else 0,
            "materials": _c(totals["materials"]),
            "labor": _c(totals["labor"]),
            "overhead": _c(totals["overhead"]),   # resource overhead (Σ resource costs)
            "scrap": _c(totals["scrap"]),
        },
        "cost_variance": {
            "standard": _c(totals["standard"]), "actual": _c(totals["actual"]),
            "variance": _c(totals["actual"] - totals["standard"]),
            "variance_pct": round((totals["actual"] - totals["standard"]) / totals["standard"] * 100, 1)
                            if totals["standard"] else None,
            "top": variances[:15],
        },
        "time_efficiency": {
            "planned_hours": round(planned_hrs, 2), "actual_hours": round(actual_hrs, 2),
            "efficiency_pct": round(planned_hrs / actual_hrs * 100, 1) if actual_hrs else None,
            "by_resource": by_resource,
        },
        "on_time": {"on_time": on_time, "late": late, "no_due_date": no_due,
                    "on_time_pct": round(on_time / (on_time + late) * 100, 1) if (on_time + late) else None},
        "qc": {
            "inspections": qc["inspections"], "quantity": _q(qc_qty),
            "passed": _q(qc_passed), "rejected": _q(qc_rejected),
            "scrap_cost": _c(float(qc["scrap"])),
            "pass_rate": round(qc_passed / qc_qty * 100, 1) if qc_qty else None,
        },
        "by_product": by_product,
    }
