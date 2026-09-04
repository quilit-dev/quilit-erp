"""
Products, variants and attribute definitions (multi-vertical inventory).

A *product* is the browsable template ("Cotton T-Shirt", "iPhone 15"); its
*variants* are the actual stock-keeping units, which live in the existing
`inventory` table (so every downstream FK — line items, lots, COGS, BOM —
keeps working). One product → many inventory rows, one per combination of
variant-axis values (Size × Color …). Descriptive, non-varying fields (Brand,
Material) live on the product. `attribute_defs` declare which fields a category
or business type uses; industry presets seed sensible defaults.

`inventory.product_id IS NULL` is a standalone "simple" item — unchanged.
"""
import json
import itertools
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import get_db
from permissions import require_perm, require_admin
from routers.audit import log_action
from utils import _now, ArchiveMode, archive_clause
import currency
from routers.inventory import insert_inventory_row

router = APIRouter()

_MAX_VARIANTS = 200   # guard against an accidental huge cross-product


# ── Industry attribute presets ──────────────────────────────────────────────
# scope_type='business', scope_value=<business_type>. Seeded idempotently.
PRESETS = {
    "Apparel": [
        {"name": "Size",  "input_type": "enum", "options": ["XS", "S", "M", "L", "XL", "XXL"], "is_variant_axis": 1, "sort_order": 1},
        {"name": "Color", "input_type": "enum", "options": ["Black", "White", "Red", "Blue", "Green", "Grey"], "is_variant_axis": 1, "sort_order": 2},
        {"name": "Brand", "input_type": "text", "options": None, "is_variant_axis": 0, "sort_order": 3},
        {"name": "Material", "input_type": "text", "options": None, "is_variant_axis": 0, "sort_order": 4},
    ],
    "Electronics": [
        {"name": "Brand",   "input_type": "text", "options": None, "is_variant_axis": 0, "sort_order": 1},
        {"name": "Model",   "input_type": "text", "options": None, "is_variant_axis": 0, "sort_order": 2},
        {"name": "Storage", "input_type": "enum", "options": ["64GB", "128GB", "256GB", "512GB", "1TB"], "is_variant_axis": 1, "sort_order": 3},
        {"name": "Color",   "input_type": "enum", "options": ["Black", "White", "Silver", "Blue"], "is_variant_axis": 1, "sort_order": 4},
    ],
    "Food & Beverage": [
        {"name": "Brand",     "input_type": "text", "options": None, "is_variant_axis": 0, "sort_order": 1},
        {"name": "Pack Size", "input_type": "enum", "options": ["Single", "6-pack", "12-pack", "Case"], "is_variant_axis": 1, "sort_order": 2},
    ],
    "General": [],
}
BUSINESS_TYPES = set(PRESETS.keys())


def seed_attribute_presets(db: sqlite3.Connection, business_type: str):
    """Idempotently seed attribute_defs for a business type. Existing rows with
    the same (scope_type, scope_value, name) are left untouched so an admin's
    edits survive a re-seed."""
    defs = PRESETS.get(business_type)
    if not defs:
        return
    now = _now()
    for d in defs:
        db.execute(
            "INSERT OR IGNORE INTO attribute_defs "
            "(scope_type, scope_value, name, input_type, options, is_variant_axis, sort_order, created_at) "
            "VALUES ('business', ?, ?, ?, ?, ?, ?, ?)",
            (business_type, d["name"], d["input_type"],
             json.dumps(d["options"]) if d["options"] is not None else None,
             d["is_variant_axis"], d["sort_order"], now),
        )
    db.commit()


def _attr_def_dict(row):
    d = dict(row)
    d["options"] = json.loads(d["options"]) if d.get("options") else None
    d["is_variant_axis"] = bool(d.get("is_variant_axis"))
    return d


# ── Attribute definitions CRUD ──────────────────────────────────────────────
class AttrDefBody(BaseModel):
    scope_type:      str = "global"          # 'global' | 'category' | 'business'
    scope_value:     Optional[str] = None
    name:            str
    input_type:      str = "enum"            # 'enum' | 'text' | 'number'
    options:         Optional[list[str]] = None
    is_variant_axis: bool = True
    sort_order:      int = 0


@router.get("/attribute-defs")
def list_attribute_defs(scope_type: Optional[str] = None, scope_value: Optional[str] = None,
                        user=Depends(require_perm("inventory", "view")),
                        db: sqlite3.Connection = Depends(get_db)):
    q = "SELECT * FROM attribute_defs WHERE 1=1"
    params: list = []
    if scope_type:
        q += " AND scope_type = ?"; params.append(scope_type)
    if scope_value is not None:
        q += " AND scope_value = ?"; params.append(scope_value)
    q += " ORDER BY sort_order, name"
    return [_attr_def_dict(r) for r in db.execute(q, params).fetchall()]


@router.post("/attribute-defs")
def create_attribute_def(data: AttrDefBody, user=Depends(require_perm("inventory", "create")),
                         db: sqlite3.Connection = Depends(get_db)):
    if data.input_type not in ("enum", "text", "number"):
        raise HTTPException(400, "input_type must be enum, text or number.")
    if not data.name.strip():
        raise HTTPException(400, "Attribute name is required.")
    try:
        c = db.execute(
            "INSERT INTO attribute_defs "
            "(scope_type, scope_value, name, input_type, options, is_variant_axis, sort_order, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (data.scope_type, data.scope_value, data.name.strip(), data.input_type,
             json.dumps(data.options) if data.options is not None else None,
             1 if data.is_variant_axis else 0, data.sort_order, _now()),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(400, "An attribute with that name already exists in this scope.")
    db.commit()
    return {"id": c.lastrowid, "message": "Attribute created"}


@router.put("/attribute-defs/{def_id}")
def update_attribute_def(def_id: int, data: AttrDefBody,
                         user=Depends(require_perm("inventory", "edit")),
                         db: sqlite3.Connection = Depends(get_db)):
    if not db.execute("SELECT 1 FROM attribute_defs WHERE id=?", (def_id,)).fetchone():
        raise HTTPException(404, "Attribute not found")
    db.execute(
        "UPDATE attribute_defs SET scope_type=?, scope_value=?, name=?, input_type=?, "
        "options=?, is_variant_axis=?, sort_order=? WHERE id=?",
        (data.scope_type, data.scope_value, data.name.strip(), data.input_type,
         json.dumps(data.options) if data.options is not None else None,
         1 if data.is_variant_axis else 0, data.sort_order, def_id),
    )
    db.commit()
    return {"message": "Attribute updated"}


@router.delete("/attribute-defs/{def_id}")
def delete_attribute_def(def_id: int, user=Depends(require_perm("inventory", "delete")),
                         db: sqlite3.Connection = Depends(get_db)):
    db.execute("DELETE FROM attribute_defs WHERE id=?", (def_id,))
    db.commit()
    return {"message": "Attribute deleted"}


@router.post("/seed-presets")
def seed_presets_endpoint(business_type: str, user=Depends(require_admin),
                          db: sqlite3.Connection = Depends(get_db)):
    if business_type not in BUSINESS_TYPES:
        raise HTTPException(400, f"Unknown business type. Choose one of: {', '.join(sorted(BUSINESS_TYPES))}")
    seed_attribute_presets(db, business_type)
    return {"message": f"Seeded attribute presets for {business_type}",
            "defs": list_attribute_defs(scope_type="business", scope_value=business_type, db=db)}


# ── Products + variants ─────────────────────────────────────────────────────
class VariantAxis(BaseModel):
    name:   str
    values: list[str]


class ProductCreate(BaseModel):
    name:         str
    category:     Optional[str] = None
    brand:        Optional[str] = None
    description:  Optional[str] = None
    barcode_prefix: Optional[str] = None      # variant barcodes = prefix + sequence
    # Base SKU template — every variant inherits these unless overridden later.
    unit:         Optional[str] = "pcs"
    product_type: Optional[str] = None
    min_stock:    Optional[float] = 0
    unit_cost:    Optional[float] = 0
    cost_currency: Optional[str] = None        # LBP cost locks to USD at entry
    exchange_rate: Optional[float] = None
    sale_price:   Optional[float] = 0
    price_currency: Optional[str] = "USD"      # may be native LBP (floats)
    lot_tracked:  Optional[bool] = False
    supplier:     Optional[str] = None
    initial_quantity: Optional[float] = 0      # opening stock PER variant (usually 0)
    axes:         list[VariantAxis] = []       # variant-defining attributes
    # Optional explicit variant list. When provided it wins over `axes` — the
    # builder sends the exact combinations to create after the user has removed
    # any unwanted ones from the preview (so e.g. "256GB / Red" can be dropped).
    variants:     Optional[list[dict]] = None  # [{label, attributes:{name:value}}]
    descriptors:  dict = {}                    # product-level non-varying attributes


def _product_dict(db, row):
    d = dict(row)
    agg = db.execute(
        "SELECT COUNT(*) AS variants, COALESCE(SUM(quantity),0) AS stock, "
        "MIN(sale_price) AS min_price, MAX(sale_price) AS max_price "
        "FROM inventory WHERE product_id=? AND archived_at IS NULL", (row["id"],)
    ).fetchone()
    d["variant_count"] = agg["variants"]
    d["total_stock"]   = agg["stock"]
    d["min_price"]     = agg["min_price"]
    d["max_price"]     = agg["max_price"]
    d["attributes"] = {a["name"]: a["value"] for a in db.execute(
        "SELECT name, value FROM product_attributes WHERE product_id=?", (row["id"],)
    ).fetchall()}
    return d


@router.get("/")
def list_products(search: Optional[str] = None, category: Optional[str] = None,
                  archived: ArchiveMode = "exclude",
                  user=Depends(require_perm("inventory", "view")),
                  db: sqlite3.Connection = Depends(get_db)):
    q = "SELECT * FROM products WHERE 1=1"
    params: list = []
    q += f" AND {archive_clause(archived)}"
    if search:
        q += " AND (name LIKE ? OR brand LIKE ?)"
        s = f"%{search}%"; params += [s, s]
    if category:
        q += " AND category = ?"; params.append(category)
    q += " ORDER BY name"
    return [_product_dict(db, r) for r in db.execute(q, params).fetchall()]


@router.get("/{product_id}")
def get_product(product_id: int, user=Depends(require_perm("inventory", "view")),
                db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Product not found")
    d = _product_dict(db, row)
    # Variants with their resolved attributes.
    variants = []
    for v in db.execute(
        "SELECT * FROM inventory WHERE product_id=? AND archived_at IS NULL ORDER BY id",
        (product_id,)
    ).fetchall():
        vd = dict(v)
        vd["attributes"] = {a["name"]: a["value"] for a in db.execute(
            "SELECT name, value FROM item_attributes WHERE inventory_id=?", (v["id"],)
        ).fetchall()}
        variants.append(vd)
    d["variants"] = variants
    return d


@router.post("/")
def create_product(data: ProductCreate, user=Depends(require_perm("inventory", "create")),
                   db: sqlite3.Connection = Depends(get_db)):
    if not data.name.strip():
        raise HTTPException(400, "Product name is required.")
    ptype = (data.product_type or None)

    # Cost entered in LBP is locked to USD now (inventory = historical USD cost).
    cost_currency = (data.cost_currency or "USD").upper()
    price_currency = (data.price_currency or "USD").upper()
    if cost_currency not in ("USD", "LBP") or price_currency not in ("USD", "LBP"):
        raise HTTPException(400, "Unsupported currency.")
    unit_cost = currency.to_usd(data.unit_cost or 0, cost_currency, db, data.exchange_rate)

    # Resolve the variants to create as a list of (label, attributes) pairs.
    # An explicit `variants` list (from the builder's editable preview, after
    # the user removed any combos) wins; otherwise build the axes cross-product.
    specs = []   # [(label_or_None, {name: value})]
    if data.variants is not None:
        for v in data.variants:
            attrs = {str(k): str(val) for k, val in (v.get("attributes") or {}).items()}
            label = v.get("label") or (" / ".join(attrs.values()) if attrs else None)
            specs.append((label, attrs))
    else:
        axes = [a for a in data.axes if a.values]
        combos = list(itertools.product(*[a.values for a in axes])) if axes else [()]
        for combo in combos:
            label = " / ".join(combo) if combo else None
            attrs = {ax.name: val for ax, val in zip(axes, combo)}
            specs.append((label, attrs))

    if not specs:
        raise HTTPException(400, "Add at least one variant.")
    if len(specs) > _MAX_VARIANTS:
        raise HTTPException(400, f"That would create {len(specs)} variants (limit {_MAX_VARIANTS}). Reduce the options.")
    has_attrs = any(attrs for _, attrs in specs)

    now = _now()
    pc = db.execute(
        "INSERT INTO products (name, category, brand, description, product_kind, barcode, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (data.name.strip(), data.category, data.brand, data.description,
         "variant" if has_attrs else "simple", (data.barcode_prefix or None), now),
    )
    product_id = pc.lastrowid

    # Product-level descriptors (Brand/Material…). Brand also kept on the column.
    for k, v in (data.descriptors or {}).items():
        if v is None or v == "":
            continue
        db.execute(
            "INSERT OR IGNORE INTO product_attributes (product_id, name, value) VALUES (?,?,?)",
            (product_id, k, str(v)),
        )

    variant_ids = []
    for i, (label, attrs) in enumerate(specs, start=1):
        barcode = f"{data.barcode_prefix}{i:03d}" if data.barcode_prefix else None
        item_id = insert_inventory_row(
            db, user,
            name=data.name.strip() + (f" — {label}" if label else ""),
            category=data.category, product_type=ptype,
            quantity=data.initial_quantity or 0, min_stock=data.min_stock or 0,
            unit_cost=unit_cost, sale_price=data.sale_price or 0,
            price_currency=price_currency, supplier=data.supplier, unit=data.unit,
            barcode=barcode, lot_tracked=data.lot_tracked,
            product_id=product_id, variant_label=label, now=now,
        )
        # Record each attribute value for filtering/reporting.
        for name, val in attrs.items():
            db.execute(
                "INSERT OR IGNORE INTO item_attributes (inventory_id, name, value) VALUES (?,?,?)",
                (item_id, name, val),
            )
        variant_ids.append(item_id)

    log_action(db, user, "create", "product", product_id, data.name,
               {"variants": len(variant_ids)})
    db.commit()
    return {"id": product_id, "variant_ids": variant_ids,
            "variant_count": len(variant_ids), "message": "Product created"}


class ProductUpdate(BaseModel):
    name:        Optional[str] = None
    category:    Optional[str] = None
    brand:       Optional[str] = None
    description: Optional[str] = None
    descriptors: Optional[dict] = None


@router.put("/{product_id}")
def update_product(product_id: int, data: ProductUpdate,
                   user=Depends(require_perm("inventory", "edit")),
                   db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Product not found")
    fields, params = [], []
    for col in ("name", "category", "brand", "description"):
        val = getattr(data, col)
        if val is not None:
            fields.append(f"{col}=?"); params.append(val)
    if fields:
        params.append(product_id)
        db.execute(f"UPDATE products SET {', '.join(fields)} WHERE id=?", params)
    if data.descriptors is not None:
        for k, v in data.descriptors.items():
            db.execute(
                "INSERT INTO product_attributes (product_id, name, value) VALUES (?,?,?) "
                "ON CONFLICT(product_id, name) DO UPDATE SET value=excluded.value",
                (product_id, k, str(v)),
            )
    log_action(db, user, "update", "product", product_id, row["name"])
    db.commit()
    return {"message": "Product updated"}


@router.patch("/{product_id}/archive")
def archive_product(product_id: int, user=Depends(require_perm("inventory", "delete")),
                    db: sqlite3.Connection = Depends(get_db)):
    """Archive a product and all its variants. Variant inventory rows are
    archived (never hard-deleted) so stock/ledger history is preserved."""
    row = db.execute("SELECT name FROM products WHERE id=?", (product_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Product not found")
    now = _now()
    db.execute("UPDATE products SET archived_at=? WHERE id=?", (now, product_id))
    db.execute("UPDATE inventory SET archived_at=? WHERE product_id=? AND archived_at IS NULL",
               (now, product_id))
    log_action(db, user, "archive", "product", product_id, row["name"])
    db.commit()
    return {"message": "Product archived"}
