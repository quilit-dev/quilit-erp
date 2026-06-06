from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm, require_auth
from utils import _now, notify, validate_int_qty
import costing
import lots
import sqlite3

router = APIRouter()

_PRODUCT_TYPES = {"raw_material", "semi_finished", "finished", "consumable"}


class InventoryCreate(BaseModel):
    name: str
    category: Optional[str] = None
    # product_type classifies the item for manufacturing:
    # raw_material · semi_finished · finished · consumable.
    product_type: Optional[str] = None
    quantity: Optional[float] = 0
    min_stock: Optional[float] = 0
    # unit_cost = landed cost per unit (purchase price + apportioned import/freight costs).
    # Used for stock valuation and POS cost-of-goods-sold.
    unit_cost: Optional[float] = 0
    # sale_price = retail price the POS rings the item up at (VAT-inclusive).
    sale_price: Optional[float] = 0
    supplier: Optional[str] = None
    unit: Optional[str] = "pcs"
    barcode: Optional[str] = None
    # Batch/lot tracking — opt-in per item. Lot-tracked items keep physical lots
    # with expiry and consume them First-Expired-First-Out (see lots.py).
    lot_tracked: Optional[bool] = False
    shelf_life_days: Optional[int] = None

class StockUpdate(BaseModel):
    delta: float
    type: Optional[str] = "adjustment"
    reference: Optional[str] = None
    note: Optional[str] = None
    # Per-warehouse adjustments — falls back to the user's resolved default
    # warehouse when omitted so existing API callers keep working.
    warehouse_id: Optional[int] = None
    # Optional lot metadata for a positive (stock-in) adjustment of a lot-tracked item.
    lot_number: Optional[str] = None
    expiry_date: Optional[str] = None

@router.get("/")
def list_inventory(search: Optional[str] = None, category: Optional[str] = None,
                   low_stock: Optional[bool] = None,
                   user=Depends(require_perm("inventory", "view")), db: sqlite3.Connection = Depends(get_db)):
    query = "SELECT * FROM inventory WHERE archived_at IS NULL"
    params = []
    if search:
        query += " AND (name LIKE ? OR supplier LIKE ? OR barcode = ?)"
        s = f"%{search}%"
        params.extend([s, s, search])
    if category:
        query += " AND category = ?"
        params.append(category)
    if low_stock:
        query += " AND quantity <= min_stock AND min_stock > 0"
    query += " ORDER BY name"
    rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]

@router.get("/categories")
def get_categories(user=Depends(require_auth), db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute(
        "SELECT DISTINCT category FROM inventory WHERE category IS NOT NULL ORDER BY category"
    ).fetchall()
    return [r["category"] for r in rows]

# ── Lot routes are declared BEFORE /{item_id} so "lots" isn't captured as an id.
@router.get("/lots")
def list_lots(
    inventory_id: Optional[int] = None,
    status: Optional[str] = "active",
    expiring: Optional[bool] = None,
    soon_days: int = 30,
    user=Depends(require_perm("inventory", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Lots, soonest-to-expire first. `expiring=true` keeps only expiring/expired."""
    q = ("SELECT l.*, i.name AS item_name, i.unit AS item_unit "
         "FROM inventory_lots l JOIN inventory i ON l.inventory_id = i.id WHERE 1=1")
    params: list = []
    if inventory_id:
        q += " AND l.inventory_id=?"; params.append(inventory_id)
    if status:
        q += " AND l.status=?"; params.append(status)
    q += " ORDER BY (l.expiry_date IS NULL), l.expiry_date ASC, l.id DESC LIMIT 500"
    today = _now()[:10]
    out = []
    for r in db.execute(q, params).fetchall():
        d = dict(r)
        d["expiry_status"] = _expiry_status(r["expiry_date"], today, soon_days)
        if expiring and d["expiry_status"] not in ("expired", "expiring"):
            continue
        out.append(d)
    return out


@router.get("/lots/{lot_id}")
def get_lot(
    lot_id: int,
    user=Depends(require_perm("inventory", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """A lot with full traceability: forward (where it was used) and backward
    (which input lots were consumed to make it, when produced)."""
    lot = db.execute(
        "SELECT l.*, i.name AS item_name, i.unit AS item_unit "
        "FROM inventory_lots l JOIN inventory i ON l.inventory_id = i.id WHERE l.id=?",
        (lot_id,),
    ).fetchone()
    if not lot:
        raise HTTPException(404, "Lot not found")
    d = dict(lot)
    d["expiry_status"] = _expiry_status(lot["expiry_date"], _now()[:10])
    # Forward: every draw from this lot (sales, project use, production input…).
    d["used_in"] = [dict(x) for x in db.execute(
        "SELECT c.quantity, c.unit_cost, c.source_type, c.source_ref, c.created_at, "
        "       po.order_number, ol.lot_number AS output_lot_number, oi.name AS output_item_name "
        "FROM lot_consumption c "
        "LEFT JOIN production_orders po ON c.production_order_id = po.id "
        "LEFT JOIN inventory_lots ol    ON c.output_lot_id = ol.id "
        "LEFT JOIN inventory oi         ON ol.inventory_id = oi.id "
        "WHERE c.lot_id=? ORDER BY c.id", (lot_id,)).fetchall()]
    # Backward: the input lots consumed to produce this lot.
    d["made_from"] = [dict(x) for x in db.execute(
        "SELECT c.quantity, c.unit_cost, c.created_at, "
        "       il.lot_number AS input_lot_number, ii.name AS input_item_name "
        "FROM lot_consumption c "
        "JOIN inventory_lots il ON c.lot_id = il.id "
        "JOIN inventory ii      ON il.inventory_id = ii.id "
        "WHERE c.output_lot_id=? ORDER BY c.id", (lot_id,)).fetchall()]
    return d


@router.get("/{item_id}")
def get_item(item_id: int, user=Depends(require_perm("inventory", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    return dict(row)

@router.get("/{item_id}/by-warehouse")
def get_item_by_warehouse(
    item_id: int,
    user=Depends(require_perm("inventory", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Per-warehouse breakdown for a single item — what feeds the inventory
    detail page's location panel. Lists every active warehouse with a row,
    including those holding zero (so the operator can see where they could
    transfer to)."""
    if not db.execute("SELECT 1 FROM inventory WHERE id=? AND archived_at IS NULL",
                       (item_id,)).fetchone():
        raise HTTPException(404, "Item not found")
    rows = db.execute(
        "SELECT w.id AS warehouse_id, w.code, w.name, w.type, w.is_default, "
        "       COALESCE(s.quantity, 0)            AS quantity, "
        "       COALESCE(s.reserved_quantity, 0)   AS reserved_quantity, "
        "       COALESCE(s.quarantine_quantity, 0) AS quarantine_quantity "
        "FROM warehouses w "
        "LEFT JOIN inventory_stock s "
        "  ON s.warehouse_id = w.id AND s.inventory_id = ? "
        "WHERE w.is_active = 1 AND w.archived_at IS NULL "
        "ORDER BY w.is_default DESC, w.code",
        (item_id,),
    ).fetchall()
    return [dict(r) for r in rows]

@router.get("/{item_id}/movements")
def get_movements(item_id: int, user=Depends(require_perm("inventory", "view")), db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute(
        "SELECT * FROM stock_movements WHERE inventory_id = ? ORDER BY created_at DESC LIMIT 100",
        (item_id,)
    ).fetchall()
    return [dict(r) for r in rows]


# ── Batch / lot tracking + traceability ──────────────────────────────────────
def _expiry_status(expiry_date, today, soon_days=30):
    """none / ok / expiring (within soon_days) / expired."""
    if not expiry_date:
        return "none"
    e = str(expiry_date)[:10]
    if e < today:
        return "expired"
    from datetime import date, timedelta
    try:
        if date.fromisoformat(e) <= date.fromisoformat(today) + timedelta(days=int(soon_days)):
            return "expiring"
    except (ValueError, TypeError):
        pass
    return "ok"


@router.post("/")
def create_item(data: InventoryCreate, user=Depends(require_perm("inventory", "create")),
                db: sqlite3.Connection = Depends(get_db)):
    now = _now()
    # Stock-affecting numbers must be whole units everywhere they're accepted.
    validate_int_qty(data.quantity or 0,  "Initial quantity")
    validate_int_qty(data.min_stock or 0, "Minimum stock")
    barcode = (data.barcode or "").strip() or None
    if barcode and db.execute(
        "SELECT 1 FROM inventory WHERE barcode = ? AND archived_at IS NULL", (barcode,)
    ).fetchone():
        raise HTTPException(400, "Another item already uses this barcode.")
    ptype = (data.product_type or None)
    if ptype and ptype not in _PRODUCT_TYPES:
        raise HTTPException(400, "Invalid product type.")
    c = db.execute(
        "INSERT INTO inventory (name, category, product_type, quantity, min_stock, unit_cost, sale_price, supplier, unit, barcode, lot_tracked, shelf_life_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (data.name, data.category, ptype, data.quantity, data.min_stock, data.unit_cost, data.sale_price, data.supplier, data.unit, barcode,
         1 if data.lot_tracked else 0, data.shelf_life_days, now)
    )
    item_id = c.lastrowid
    if data.quantity and data.quantity != 0:
        # Opening stock lands at the user's default warehouse so the per-
        # warehouse breakdown is correct from day one.
        import warehouse_access as wha
        wid = wha.resolve_warehouse_id(user, db, None)
        db.execute(
            "INSERT OR IGNORE INTO inventory_stock "
            "(inventory_id, warehouse_id, quantity, reserved_quantity, quarantine_quantity) "
            "VALUES (?, ?, ?, 0, 0)",
            (item_id, wid, data.quantity),
        )
        db.execute(
            "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, note, warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (item_id, "adjustment", data.quantity, 0, data.quantity, "Initial stock", wid, now)
        )
        # Opening stock: a lot for lot-tracked items, else a FIFO/LIFO cost layer.
        lots.record_stock_in(db, item_id, data.quantity, data.unit_cost or 0,
                             source_type="opening", source_ref="Initial stock", now=now)
    db.commit()
    return {"id": item_id, "message": "Item created"}

@router.put("/{item_id}")
def update_item(item_id: int, data: InventoryCreate, user=Depends(require_perm("inventory", "edit")),
                db: sqlite3.Connection = Depends(get_db)):
    # Stock-quantity is managed via /stock so we don't validate data.quantity
    # here, but min_stock still has to be whole.
    validate_int_qty(data.min_stock or 0, "Minimum stock")
    existing = db.execute("SELECT quantity FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)).fetchone()
    if not existing:
        raise HTTPException(404, "Item not found")
    barcode = (data.barcode or "").strip() or None
    if barcode and db.execute(
        "SELECT 1 FROM inventory WHERE barcode = ? AND id <> ? AND archived_at IS NULL", (barcode, item_id)
    ).fetchone():
        raise HTTPException(400, "Another item already uses this barcode.")
    ptype = (data.product_type or None)
    if ptype and ptype not in _PRODUCT_TYPES:
        raise HTTPException(400, "Invalid product type.")
    # quantity is managed exclusively via /stock — never overwritten by edit
    db.execute(
        "UPDATE inventory SET name=?, category=?, product_type=?, min_stock=?, unit_cost=?, sale_price=?, supplier=?, unit=?, barcode=?, lot_tracked=?, shelf_life_days=? WHERE id=?",
        (data.name, data.category, ptype, data.min_stock, data.unit_cost, data.sale_price, data.supplier, data.unit, barcode,
         1 if data.lot_tracked else 0, data.shelf_life_days, item_id)
    )
    db.commit()
    return {"message": "Item updated"}

@router.patch("/{item_id}/stock")
def update_stock(item_id: int, data: StockUpdate, user=Depends(require_perm("inventory", "edit")),
                 db: sqlite3.Connection = Depends(get_db)):
    # Stock adjustments (positive or negative) move whole units only.
    validate_int_qty(data.delta, "Adjustment")
    row = db.execute("SELECT * FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    # Resolve the target warehouse — adjustments must always credit/debit a
    # specific location, otherwise we can't reconcile counts against reality.
    # `warehouse_access.resolve_warehouse_id` validates access + activeness.
    import warehouse_access as wha
    wid = wha.resolve_warehouse_id(user, db, data.warehouse_id)

    # Per-warehouse balance check — the on-hand at this location, not the
    # company-wide total. (You can't draw down 5 from BRANCH-A if MAIN holds
    # everything; that's what makes adjustments warehouse-specific.)
    ws_row = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, wid),
    ).fetchone()
    wh_before = float(ws_row["quantity"]) if ws_row else 0.0
    wh_after  = round(wh_before + data.delta, 6)
    if wh_after < 0:
        raise HTTPException(
            400,
            f"Insufficient stock at this warehouse. Current: {wh_before}, "
            f"attempted change: {data.delta}"
        )

    qty_before = float(row["quantity"])         # company-wide total
    qty_after  = round(qty_before + data.delta, 6)
    now = _now()
    # Update BOTH per-warehouse balance and the company-wide total. The two
    # invariants stay in sync because every quantity-changing path goes
    # through this kind of paired write.
    db.execute("UPDATE inventory SET quantity = ? WHERE id = ?", (qty_after, item_id))
    db.execute(
        "INSERT OR IGNORE INTO inventory_stock "
        "(inventory_id, warehouse_id, quantity, reserved_quantity, quarantine_quantity) "
        "VALUES (?, ?, 0, 0, 0)",
        (item_id, wid),
    )
    db.execute(
        "UPDATE inventory_stock SET quantity=? WHERE inventory_id=? AND warehouse_id=?",
        (wh_after, item_id, wid),
    )
    db.execute(
        "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (item_id, data.type, data.delta, qty_before, qty_after, data.reference, data.note, wid, now)
    )
    # Keep lots / cost layers in step with the adjustment. A positive delta adds
    # a lot (lot-tracked) or cost layer; a negative delta draws them down. A
    # plain adjustment posts no COGS, so the consumed value is discarded — we
    # only care that the depth stays consistent with on-hand qty.
    if data.delta > 0:
        lots.record_stock_in(db, item_id, data.delta, row["unit_cost"] or 0,
                             source_type="adjustment", source_ref=data.reference, now=now,
                             lot_number=data.lot_number, expiry_date=data.expiry_date)
    elif data.delta < 0:
        lots.value_stock_out(db, item_id, -data.delta,
                             source_type="adjustment", source_ref=data.reference, now=now)
    min_stock = float(row["min_stock"] or 0)
    if min_stock > 0:
        # Company-wide alert when the global total drops below min_stock —
        # historical behaviour, kept for back-compat.
        if qty_after <= min_stock:
            notify(db, type="low_stock",
                   title=f"Low stock alert: {row['name']}",
                   body=f"Only {qty_after} {row['unit'] or 'units'} remaining (minimum: {min_stock})",
                   link=f"/inventory", entity_type="inventory", entity_id=item_id,
                   dedup_hours=24)
        # Per-warehouse alert — fires when this specific warehouse drops below
        # min_stock even if the company-wide total is still fine. Includes the
        # warehouse code in the dedup key so simultaneous low-stock events at
        # different warehouses each surface independently.
        wh_code = db.execute("SELECT code, name FROM warehouses WHERE id=?", (wid,)).fetchone()
        if wh_code and wh_after <= min_stock:
            notify(db, type="low_stock_warehouse",
                   title=f"Low stock at {wh_code['code']}: {row['name']}",
                   body=f"Only {wh_after} {row['unit'] or 'units'} at {wh_code['name']} (minimum: {min_stock})",
                   link=f"/inventory", entity_type="inventory", entity_id=item_id,
                   dedup_hours=24)
    db.commit()
    return {"message": "Stock updated", "qty_before": qty_before, "qty_after": qty_after,
            "warehouse_id": wid, "warehouse_qty_after": wh_after}


class DeductToProject(BaseModel):
    project_id: int
    quantity:   float
    note:       Optional[str] = None
    # Per-warehouse consumption — the materials are physically pulled from
    # this warehouse. Defaults to the user's default warehouse so existing
    # API callers keep working (the old behaviour effectively assumed MAIN).
    warehouse_id: Optional[int] = None


@router.post("/{item_id}/deduct-to-project")
def deduct_to_project(item_id: int, data: DeductToProject,
                      user=Depends(require_perm("inventory", "create")),
                      db: sqlite3.Connection = Depends(get_db)):
    """
    Deduct qty from inventory and record the material cost as a project expense.
    Cost = quantity × unit_cost (landed cost per unit).
    """
    item = db.execute(
        "SELECT * FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)
    ).fetchone()
    if not item:
        raise HTTPException(404, "Inventory item not found")

    project = db.execute(
        "SELECT id, name FROM projects WHERE id = ? AND archived_at IS NULL", (data.project_id,)
    ).fetchone()
    if not project:
        raise HTTPException(404, "Project not found")

    if data.quantity <= 0:
        raise HTTPException(400, "Quantity must be positive")
    validate_int_qty(data.quantity, "Quantity")

    # Resolve + validate the source warehouse (row-level access enforced).
    import warehouse_access as wha
    wid = wha.resolve_warehouse_id(user, db, data.warehouse_id)

    # Per-warehouse balance check — you can't draw 10 from BRANCH-A if all
    # the stock is actually at MAIN. The old code only checked the company
    # total, which silently desynced the per-warehouse balances.
    ws_row = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, wid),
    ).fetchone()
    wh_before = float(ws_row["quantity"]) if ws_row else 0.0
    if data.quantity > wh_before:
        raise HTTPException(
            400,
            f"Insufficient stock at this warehouse: {wh_before} {item['unit']} "
            f"available, {data.quantity} requested."
        )
    wh_after = round(wh_before - data.quantity, 6)

    qty_before = float(item["quantity"])
    qty_after  = round(qty_before - data.quantity, 6)
    unit_cost  = float(item["unit_cost"] or 0)
    now        = _now()
    note_text  = data.note or f"Used on project: {project['name']}"

    # 1. Deduct stock. The material cost charged to the project follows the
    #    configured costing method (FIFO/LIFO draw from cost layers; weighted
    #    average values at the moving unit cost).
    total_cost = round(
        lots.value_stock_out(db, item_id, data.quantity,
                             source_type="project", source_ref=f"PRJ-{data.project_id}", now=now), 2
    )
    # Maintain BOTH balances in lock-step (the sync invariant the rest of
    # the system relies on) and stamp the movement with the source warehouse.
    db.execute("UPDATE inventory SET quantity = ? WHERE id = ?", (qty_after, item_id))
    db.execute(
        "UPDATE inventory_stock SET quantity = ? "
        "WHERE inventory_id = ? AND warehouse_id = ?",
        (wh_after, item_id, wid),
    )
    db.execute(
        "INSERT INTO stock_movements "
        "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (item_id, "project_use", -data.quantity, qty_before, qty_after,
         f"PRJ-{data.project_id}", note_text, wid, now)
    )

    # 2. Record as project expense (Materials category). The unit rate shown is
    #    the effective cost (total ÷ qty) so the description reconciles to the
    #    amount even when layers were valued at mixed costs.
    eff_unit = round(total_cost / data.quantity, 2) if data.quantity else unit_cost
    desc = f"{data.quantity} × {item['name']} @ {eff_unit:.2f}/{item['unit']}"
    if data.note:
        desc += f" — {data.note}"
    db.execute(
        "INSERT INTO expenses (project_id, category, description, amount, date, created_at) "
        "VALUES (?,?,?,?,date('now'),?)",
        (data.project_id, "Materials", desc, total_cost, now)
    )

    db.commit()
    return {
        "message":    "Stock deducted and project expense recorded",
        "qty_before": qty_before,
        "qty_after":  qty_after,
        "cost":       total_cost,
    }

@router.patch("/{item_id}/archive")
def archive_item(item_id: int, user=Depends(require_perm("inventory", "delete")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    if float(row["quantity"]) > 0:
        raise HTTPException(400, f"Cannot archive item with {row['quantity']} units in stock. Adjust stock to 0 first.")
    if float(row["reserved_quantity"] or 0) > 0:
        raise HTTPException(400, "Cannot archive an item reserved by an open production order.")
    now = _now()
    db.execute("UPDATE inventory SET archived_at = ? WHERE id = ?", (now, item_id))
    db.commit()
    return {"message": "Item archived"}

@router.patch("/{item_id}/unarchive")
def unarchive_item(item_id: int, user=Depends(require_perm("inventory", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT id FROM inventory WHERE id = ? AND archived_at IS NOT NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found in archives")
    db.execute("UPDATE inventory SET archived_at = NULL WHERE id = ?", (item_id,))
    db.commit()
    return {"message": "Item restored from archive"}
