from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm, require_auth
from utils import _now, notify
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

class StockUpdate(BaseModel):
    delta: float
    type: Optional[str] = "adjustment"
    reference: Optional[str] = None
    note: Optional[str] = None

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

@router.get("/{item_id}")
def get_item(item_id: int, user=Depends(require_perm("inventory", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    return dict(row)

@router.get("/{item_id}/movements")
def get_movements(item_id: int, user=Depends(require_perm("inventory", "view")), db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute(
        "SELECT * FROM stock_movements WHERE inventory_id = ? ORDER BY created_at DESC LIMIT 100",
        (item_id,)
    ).fetchall()
    return [dict(r) for r in rows]

@router.post("/")
def create_item(data: InventoryCreate, user=Depends(require_perm("inventory", "create")),
                db: sqlite3.Connection = Depends(get_db)):
    now = _now()
    barcode = (data.barcode or "").strip() or None
    if barcode and db.execute(
        "SELECT 1 FROM inventory WHERE barcode = ? AND archived_at IS NULL", (barcode,)
    ).fetchone():
        raise HTTPException(400, "Another item already uses this barcode.")
    ptype = (data.product_type or None)
    if ptype and ptype not in _PRODUCT_TYPES:
        raise HTTPException(400, "Invalid product type.")
    c = db.execute(
        "INSERT INTO inventory (name, category, product_type, quantity, min_stock, unit_cost, sale_price, supplier, unit, barcode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (data.name, data.category, ptype, data.quantity, data.min_stock, data.unit_cost, data.sale_price, data.supplier, data.unit, barcode, now)
    )
    item_id = c.lastrowid
    if data.quantity and data.quantity != 0:
        db.execute(
            "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, note, created_at) VALUES (?,?,?,?,?,?,?)",
            (item_id, "adjustment", data.quantity, 0, data.quantity, "Initial stock", now)
        )
    db.commit()
    return {"id": item_id, "message": "Item created"}

@router.put("/{item_id}")
def update_item(item_id: int, data: InventoryCreate, user=Depends(require_perm("inventory", "edit")),
                db: sqlite3.Connection = Depends(get_db)):
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
        "UPDATE inventory SET name=?, category=?, product_type=?, min_stock=?, unit_cost=?, sale_price=?, supplier=?, unit=?, barcode=? WHERE id=?",
        (data.name, data.category, ptype, data.min_stock, data.unit_cost, data.sale_price, data.supplier, data.unit, barcode, item_id)
    )
    db.commit()
    return {"message": "Item updated"}

@router.patch("/{item_id}/stock")
def update_stock(item_id: int, data: StockUpdate, user=Depends(require_perm("inventory", "edit")),
                 db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM inventory WHERE id = ? AND archived_at IS NULL", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    qty_before = float(row["quantity"])
    qty_after  = round(qty_before + data.delta, 6)
    if qty_after < 0:
        raise HTTPException(400, f"Insufficient stock. Current: {qty_before}, attempted change: {data.delta}")
    now = _now()
    db.execute("UPDATE inventory SET quantity = ? WHERE id = ?", (qty_after, item_id))
    db.execute(
        "INSERT INTO stock_movements (inventory_id, type, delta, qty_before, qty_after, reference, note, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (item_id, data.type, data.delta, qty_before, qty_after, data.reference, data.note, now)
    )
    min_stock = float(row["min_stock"] or 0)
    if min_stock > 0 and qty_after <= min_stock:
        notify(db, type="low_stock",
               title=f"Low stock alert: {row['name']}",
               body=f"Only {qty_after} {row['unit'] or 'units'} remaining (minimum: {min_stock})",
               link=f"/inventory", entity_type="inventory", entity_id=item_id,
               dedup_hours=24)
    db.commit()
    return {"message": "Stock updated", "qty_before": qty_before, "qty_after": qty_after}


class DeductToProject(BaseModel):
    project_id: int
    quantity:   float
    note:       Optional[str] = None


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

    qty_before = float(item["quantity"])
    if data.quantity > qty_before:
        raise HTTPException(
            400,
            f"Insufficient stock: {qty_before} {item['unit']} available, "
            f"{data.quantity} requested."
        )

    qty_after  = round(qty_before - data.quantity, 6)
    unit_cost  = float(item["unit_cost"] or 0)
    total_cost = round(data.quantity * unit_cost, 2)
    now        = _now()
    note_text  = data.note or f"Used on project: {project['name']}"

    # 1. Deduct stock
    db.execute("UPDATE inventory SET quantity = ? WHERE id = ?", (qty_after, item_id))
    db.execute(
        "INSERT INTO stock_movements "
        "(inventory_id, type, delta, qty_before, qty_after, reference, note, created_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (item_id, "project_use", -data.quantity, qty_before, qty_after,
         f"PRJ-{data.project_id}", note_text, now)
    )

    # 2. Record as project expense (Materials category)
    desc = f"{data.quantity} × {item['name']} @ {unit_cost:.2f}/{item['unit']}"
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
