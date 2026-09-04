from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm, require_auth
import costs
from routers.audit import log_action
from utils import _now, notify, validate_int_qty, ArchiveMode, archive_clause
import costing
import currency
import lots
import reservations
import sqlite3

router = APIRouter()

_PRODUCT_TYPES = {"raw_material", "semi_finished", "finished", "consumable"}
_CURRENCIES = {"USD", "LBP"}


def _resolve_item_currencies(data, db):
    """Validate the item's currencies and lock cost to USD.

    Returns (price_currency, unit_cost_usd):
      - price_currency: validated native currency for sale_price (stays native).
      - unit_cost_usd: the cost to STORE — always USD. When cost_currency is LBP
        the entered unit_cost is converted now (inventory = historical USD cost).
    """
    price_currency = (data.price_currency or "USD").upper()
    if price_currency not in _CURRENCIES:
        raise HTTPException(400, "Unsupported price currency.")
    cost_currency = (data.cost_currency or "USD").upper()
    if cost_currency not in _CURRENCIES:
        raise HTTPException(400, "Unsupported cost currency.")
    unit_cost_usd = currency.to_usd(data.unit_cost or 0, cost_currency, db, data.exchange_rate)
    return price_currency, unit_cost_usd


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
    # Held in `price_currency` (USD or LBP). An LBP price is *native* — it floats:
    # POS converts it to USD at the sale-time rate, so its USD value tracks the
    # exchange rate. Default USD keeps every existing item unchanged.
    sale_price: Optional[float] = 0
    price_currency: Optional[str] = "USD"
    # Cost may be *entered* in LBP for convenience, but unlike the sale price it
    # is locked to USD at entry (inventory is carried at historical USD cost and
    # the costing engine owns unit_cost). When cost_currency='LBP', unit_cost is
    # converted to USD via exchange_rate (or the latest stored rate) before save.
    cost_currency: Optional[str] = None
    exchange_rate: Optional[float] = None
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
                   low_stock: Optional[bool] = None, archived: ArchiveMode = "exclude",
                   user=Depends(require_perm("inventory", "view")), db: sqlite3.Connection = Depends(get_db)):
    query = ("SELECT i.*, p.name AS product_name FROM inventory i "
             "LEFT JOIN products p ON i.product_id = p.id WHERE 1=1")
    params = []
    query += f" AND {archive_clause(archived, 'i.archived_at')}"
    if search:
        query += " AND (i.name LIKE ? OR i.supplier LIKE ? OR i.barcode = ?)"
        s = f"%{search}%"
        params.extend([s, s, search])
    if category:
        query += " AND i.category = ?"
        params.append(category)
    if low_stock:
        query += " AND i.quantity <= i.min_stock AND i.min_stock > 0"
    query += " ORDER BY COALESCE(p.name, i.name), i.id"
    rows = db.execute(query, params).fetchall()
    out = [dict(r) for r in rows]
    # Attach resolved variant attributes (Size=M, Color=Red…) so the UI can
    # group by product and filter by attribute. One query, mapped in-process.
    ids = [r["id"] for r in out]
    if ids:
        attrs: dict = {}
        ph = ",".join("?" * len(ids))
        for a in db.execute(
            f"SELECT inventory_id, name, value FROM item_attributes WHERE inventory_id IN ({ph})",
            ids,
        ).fetchall():
            attrs.setdefault(a["inventory_id"], {})[a["name"]] = a["value"]
        for r in out:
            r["attributes"] = attrs.get(r["id"], {})
    return costs.strip(out, user, db)

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
    return costs.strip(out, user, db)


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
    return costs.strip(d, user, db)


class ReservationCreate(BaseModel):
    inventory_id: int
    client_id:    int
    quantity:     float
    note:         Optional[str] = None
    warehouse_id: Optional[int] = None


class ReservationClose(BaseModel):
    note: Optional[str] = None


@router.post("/reservations")
def create_reservation(
    data: ReservationCreate,
    user=Depends(require_perm("inventory", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Hold stock for a named customer.

    Nothing is posted: the goods are still on hand and still ours. What changes
    is that nobody else can sell them.
    """
    if not db.execute("SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL",
                      (data.client_id,)).fetchone():
        raise HTTPException(400, "Client not found")
    try:
        rid = reservations.hold(
            db, inventory_id=data.inventory_id, client_id=data.client_id,
            quantity=data.quantity, note=data.note,
            warehouse_id=data.warehouse_id, created_by=user["id"])
    except ValueError as e:
        raise HTTPException(400, str(e))

    item = db.execute("SELECT name FROM inventory WHERE id=?",
                      (data.inventory_id,)).fetchone()
    log_action(db, user, "reserve", "inventory", data.inventory_id, item["name"],
               {"quantity": data.quantity, "client_id": data.client_id})
    db.commit()
    return {"id": rid, "message": "Stock reserved",
            "available": reservations.available(db, data.inventory_id)}


@router.get("/reservations")
def list_reservations(
    inventory_id: Optional[int] = None,
    client_id:    Optional[int] = None,
    status:       Optional[str] = "held",
    user=Depends(require_perm("inventory", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Who is holding what. `status=all` includes closed reservations."""
    where, params = ["1=1"], []
    if inventory_id is not None:
        where.append("r.inventory_id=?"); params.append(inventory_id)
    if client_id is not None:
        where.append("r.client_id=?"); params.append(client_id)
    if status and status != "all":
        where.append("r.status=?"); params.append(status)

    rows = db.execute(
        f"SELECT r.*, i.name AS item_name, i.unit, c.name AS client_name, "
        f"       u.full_name AS created_by_name "
        f"FROM stock_reservations r "
        f"JOIN inventory i ON i.id = r.inventory_id "
        f"LEFT JOIN clients c ON c.id = r.client_id "
        f"LEFT JOIN users u ON u.id = r.created_by "
        f"WHERE {' AND '.join(where)} ORDER BY r.id DESC LIMIT 500",
        params,
    ).fetchall()
    return [dict(r) for r in rows]


@router.patch("/reservations/{reservation_id}/release")
def release_reservation(
    reservation_id: int,
    data: ReservationClose,
    user=Depends(require_perm("inventory", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Give the stock back to general availability.

    Releasing an already-closed reservation is a no-op rather than an error:
    two operators pressing the same button must not free the stock twice.
    """
    try:
        changed = reservations.close(db, reservation_id, status=reservations.RELEASED,
                                     closed_by=user["id"])
    except ValueError as e:
        raise HTTPException(404, str(e))

    row = db.execute("SELECT inventory_id FROM stock_reservations WHERE id=?",
                     (reservation_id,)).fetchone()
    if changed:
        log_action(db, user, "release", "inventory", row["inventory_id"],
                   f"Reservation #{reservation_id}", {"note": data.note})
    db.commit()
    return {"message": "Reservation released" if changed
                       else "Reservation was already closed",
            "available": reservations.available(db, row["inventory_id"])}


@router.get("/{item_id}")
def get_item(item_id: int, user=Depends(require_perm("inventory", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    d = dict(row)
    # On hand is not the same as sellable once anything is spoken for, and the
    # difference is the number an operator promising a delivery date needs.
    d["available_quantity"] = reservations.available(db, item_id)
    return costs.strip(d, user, db)

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
    return costs.strip([dict(r) for r in rows], user, db)

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


def insert_inventory_row(db, user, *, name, category=None, product_type=None,
                         quantity=0, min_stock=0, unit_cost=0, sale_price=0,
                         price_currency="USD", supplier=None, unit="pcs",
                         barcode=None, lot_tracked=False, shelf_life_days=None,
                         product_id=None, variant_label=None, now=None):
    """Create one inventory (SKU) row + its opening stock, movement and cost
    lot/layer. Shared by the inventory create endpoint and the products router's
    variant generator so every SKU — simple item or variant — is seeded
    identically. `unit_cost` must already be USD; callers convert LBP first.
    Returns the new inventory id. Does NOT commit."""
    now = now or _now()
    c = db.execute(
        "INSERT INTO inventory (name, category, product_type, quantity, min_stock, "
        "unit_cost, sale_price, price_currency, supplier, unit, barcode, lot_tracked, "
        "shelf_life_days, product_id, variant_label, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (name, category, product_type, quantity, min_stock, unit_cost, sale_price,
         price_currency, supplier, unit, barcode, 1 if lot_tracked else 0,
         shelf_life_days, product_id, variant_label, now),
    )
    item_id = c.lastrowid
    if quantity and quantity != 0:
        # Opening stock lands at the user's default warehouse so the per-
        # warehouse breakdown is correct from day one.
        import warehouse_access as wha
        wid = wha.resolve_warehouse_id(user, db, None)
        db.execute(
            "INSERT OR IGNORE INTO inventory_stock "
            "(inventory_id, warehouse_id, quantity, reserved_quantity, quarantine_quantity) "
            "VALUES (?, ?, ?, 0, 0)",
            (item_id, wid, quantity),
        )
        db.execute(
            "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, note, warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (item_id, "adjustment", quantity, 0, quantity, "Initial stock", wid, now),
        )
        # Opening stock: a lot for lot-tracked items, else a FIFO/LIFO cost layer.
        lots.record_stock_in(db, item_id, quantity, unit_cost,
                             source_type="opening", source_ref="Initial stock", now=now)
    return item_id


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
    price_currency, unit_cost = _resolve_item_currencies(data, db)
    item_id = insert_inventory_row(
        db, user, name=data.name, category=data.category, product_type=ptype,
        quantity=data.quantity, min_stock=data.min_stock, unit_cost=unit_cost,
        sale_price=data.sale_price, price_currency=price_currency, supplier=data.supplier,
        unit=data.unit, barcode=barcode, lot_tracked=data.lot_tracked,
        shelf_life_days=data.shelf_life_days, now=now,
    )
    log_action(db, user, "create", "inventory", item_id, data.name,
               {"quantity": data.quantity, "unit_cost": unit_cost})
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
    price_currency, unit_cost = _resolve_item_currencies(data, db)
    # A user who cannot SEE cost cannot set it either, and their form has no
    # field to send — so whatever arrives is ignored and the stored figure is
    # kept. Trusting the payload here is how an absent field posts back as 0
    # and silently zeroes an item's cost, taking stock valuation and every
    # future COGS posting with it. They can still rename the item.
    if not costs.visible(user, db):
        _kept = db.execute("SELECT unit_cost FROM inventory WHERE id=?", (item_id,)).fetchone()
        if _kept is not None:
            unit_cost = _kept["unit_cost"]
    # quantity is managed exclusively via /stock — never overwritten by edit
    db.execute(
        "UPDATE inventory SET name=?, category=?, product_type=?, min_stock=?, unit_cost=?, sale_price=?, price_currency=?, supplier=?, unit=?, barcode=?, lot_tracked=?, shelf_life_days=? WHERE id=?",
        (data.name, data.category, ptype, data.min_stock, unit_cost, data.sale_price, price_currency, data.supplier, data.unit, barcode,
         1 if data.lot_tracked else 0, data.shelf_life_days, item_id)
    )
    log_action(db, user, "update", "inventory", item_id, data.name)
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
                   msg="low_stock", params={"name": row["name"], "qty": qty_after,
                                            "unit": row["unit"] or "units", "min": min_stock},
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
                   msg="low_stock_warehouse", params={"code": wh_code["code"], "name": row["name"],
                                                      "qty": wh_after, "unit": row["unit"] or "units",
                                                      "wh": wh_code["name"], "min": min_stock},
                   link=f"/inventory", entity_type="inventory", entity_id=item_id,
                   dedup_hours=24)
    log_action(db, user, "stock_adjust", "inventory", item_id, row["name"],
               {"delta": data.delta, "type": data.type, "qty_after": qty_after,
                "warehouse_id": wid, "reference": data.reference})
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

    log_action(db, user, "deduct_to_project", "inventory", item_id, item["name"],
               {"project_id": data.project_id, "quantity": data.quantity, "cost": total_cost})
    db.commit()
    return {
        "message":    "Stock deducted and project expense recorded",
        "qty_before": qty_before,
        "qty_after":  qty_after,
        "cost":       total_cost,
    }

# Everything that can point at an inventory item, and what to call it when it
# is the reason a delete was refused. Anything listed here is HISTORY: a record
# of something that happened, which deleting the item would falsify. An invoice
# line naming a product that no longer exists is not a tidier database, it is a
# document that can no longer be explained.
#
# `test_inventory_delete.py` asserts this covers every table in the schema that
# references an item, so a new table cannot quietly open a hole here.
_USED_BY = [
    ("invoice_items",          "inventory_id",           "invoices"),
    ("quotation_items",        "inventory_id",           "quotations"),
    ("pos_sale_items",         "inventory_id",           "till sales"),
    # A purchase is a document with lines, and the line is where the item
    # reference lives. The header column that used to hold it is gone.
    ("purchase_items",         "inventory_id",           "purchase orders"),
    ("stock_movements",        "inventory_id",           "stock movements"),
    ("inventory_cost_layers",  "inventory_id",           "cost layers"),
    ("inventory_lots",         "inventory_id",           "lots"),
    ("lot_consumption",        "inventory_id",           "lot consumption"),
    ("sale_commitments",       "inventory_id",           "customer orders"),
    ("stock_reservations",     "inventory_id",           "reservations"),
    ("bom_components",         "component_inventory_id", "bills of materials"),
    ("boms",                   "output_inventory_id",    "bills of materials"),
    ("production_order_items", "component_inventory_id", "production orders"),
    ("production_orders",      "output_inventory_id",    "production orders"),
    ("production_qc",          "output_inventory_id",    "quality checks"),
    ("service_job_lines",      "inventory_id",           "service jobs"),
    ("service_equipment",      "inventory_id",           "service equipment"),
    ("stock_transfer_items",   "inventory_id",           "stock transfers"),
]

# The item's own definition rather than a record of anything: these go when it
# does. `inventory_stock` is the per-warehouse quantity, which the zero-stock
# precondition has already established is empty.
_OWN_ROWS = [
    ("item_attributes",  "inventory_id"),
    ("inventory_stock",  "inventory_id"),
]


def _item_usage(db: sqlite3.Connection, item_id: int) -> dict:
    """What refers to this item, counted per kind of record."""
    used = {}
    for table, column, label in _USED_BY:
        try:
            n = db.execute(
                f"SELECT COUNT(*) AS n FROM {table} WHERE {column} = ?",
                (item_id,)).fetchone()["n"]
        except Exception:
            # A table this install has not migrated to yet cannot hold a
            # reference to anything, so it is not a reason to refuse.
            continue
        if n:
            used[label] = used.get(label, 0) + n
    return used


@router.get("/{item_id}/usage")
def item_usage(item_id: int, user=Depends(require_perm("inventory", "view")),
               db: sqlite3.Connection = Depends(get_db)):
    """Whether this item can be deleted, and what is stopping it if not.

    The screen asks before offering the button, so the operator is told which
    of the two things they can do BEFORE they commit to one.
    """
    row = db.execute("SELECT * FROM inventory WHERE id = ?", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    used = _item_usage(db, item_id)
    blockers = []
    if float(row["quantity"] or 0) != 0:
        blockers.append("stock on hand")
    if float(row["reserved_quantity"] or 0) > 0:
        blockers.append("reservations")
    return {"used_by": used, "stock_blockers": blockers,
            "can_delete": not used and not blockers}


@router.delete("/{item_id}")
def delete_item(item_id: int, user=Depends(require_perm("inventory", "delete")),
                db: sqlite3.Connection = Depends(get_db)):
    """Remove an item that was never used — a typo, a duplicate, a mistake.

    An item that HAS been used is archived, never deleted. Its name sits on
    invoices, purchase orders and stock movements that must go on making sense
    for as long as those records are kept; removing the row it points at does
    not clean anything up, it breaks the paper trail. Archive already covers
    that case and is what the refusal points at.

    So this is deliberately narrow: it deletes only an item nothing refers to,
    and it says exactly what refers to one when it will not.
    """
    row = db.execute("SELECT * FROM inventory WHERE id = ?", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")

    if float(row["quantity"] or 0) != 0:
        raise HTTPException(
            400, f"Cannot delete an item with {row['quantity']:g} units in stock. "
                 f"Adjust the stock to zero first, or archive it instead.")
    if float(row["reserved_quantity"] or 0) > 0:
        raise HTTPException(
            400, "Cannot delete an item that is reserved. Release the "
                 "reservation first, or archive it instead.")

    used = _item_usage(db, item_id)
    if used:
        detail = ", ".join(f"{n} {label}" for label, n in sorted(used.items()))
        raise HTTPException(
            409, f"'{row['name']}' has been used and cannot be deleted: it appears "
                 f"on {detail}. Archive it instead — that takes it out of the "
                 f"lists and leaves those records intact.")

    for table, column in _OWN_ROWS:
        try:
            db.execute(f"DELETE FROM {table} WHERE {column} = ?", (item_id,))
        except Exception:
            pass
    db.execute("DELETE FROM inventory WHERE id = ?", (item_id,))
    # Logged before the commit so the record of the deletion lands with it.
    log_action(db, user, "delete", "inventory", item_id, row["name"],
               {"category": row["category"], "barcode": row["barcode"],
                "unit_cost": row["unit_cost"], "sale_price": row["sale_price"]})
    db.commit()
    return {"message": "Item deleted", "name": row["name"]}


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
    log_action(db, user, "archive", "inventory", item_id, row["name"])
    db.commit()
    return {"message": "Item archived"}

@router.patch("/{item_id}/unarchive")
def unarchive_item(item_id: int, user=Depends(require_perm("inventory", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT id FROM inventory WHERE id = ? AND archived_at IS NOT NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found in archives")
    db.execute("UPDATE inventory SET archived_at = NULL WHERE id = ?", (item_id,))
    log_action(db, user, "unarchive", "inventory", item_id)
    db.commit()
    return {"message": "Item restored from archive"}
