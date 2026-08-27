from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
import commitments
from routers.audit import log_action
from utils import _now, notify, get_tax_context, resolve_purchase_tax, money, validate_int_qty
from approval_engine import evaluate_and_apply
import branch_access
import costing
import currency
import lots
import accounting
import sqlite3
from datetime import datetime

router = APIRouter()

class PurchaseCreate(BaseModel):
    supplier: str
    inventory_id: Optional[int] = None
    product_name: str
    category: Optional[str] = "Other"
    quantity: float
    unit_cost: float = 0
    additional_costs: float = 0
    tax_rate_id: Optional[int] = None
    status: Optional[str] = "Ordered"
    notes: Optional[str] = None
    # Supplier cost may be entered in LBP. Inventory is carried at historical USD
    # cost, so the cost is converted to USD at entry (using exchange_rate, or the
    # latest stored rate) and stored in USD; cost_currency + the rate are kept on
    # the PO purely as provenance for the audit trail. Default USD = no change.
    cost_currency: Optional[str] = "USD"
    exchange_rate: Optional[float] = None
    # Destination warehouse — defaults to the user's default if omitted so
    # existing API callers keep working. The receipt lands here at status
    # transition to 'Received'.
    warehouse_id: Optional[int] = None

class PurchaseUpdate(BaseModel):
    supplier: Optional[str] = None
    product_name: Optional[str] = None
    category: Optional[str] = None
    quantity: Optional[float] = None
    unit_cost: Optional[float] = None
    additional_costs: Optional[float] = None
    tax_rate_id: Optional[int] = None
    notes: Optional[str] = None
    # See PurchaseCreate: LBP cost is converted to USD at entry.
    cost_currency: Optional[str] = "USD"
    exchange_rate: Optional[float] = None
    # Allow re-routing a not-yet-received PO to a different warehouse —
    # rejected on the server if the purchase has already credited stock.
    warehouse_id: Optional[int] = None

class StatusUpdate(BaseModel):
    status: str
    # How it was settled, and out of which account. Only meaningful on the
    # move to Paid — that is the moment money leaves — and both are optional,
    # so an existing caller that sends only a status still works and still
    # posts to cash, which is what it always meant.
    payment_method:  Optional[str] = None
    bank_account_id: Optional[int] = None


def _col(row, key, default=None):
    """A column that may not exist yet on an un-migrated tenant."""
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def next_po_number(db):
    row = db.execute("SELECT COALESCE(MAX(id), 0) as m FROM purchases").fetchone()
    n = row["m"] + 1
    year = datetime.utcnow().year
    return f"PO-{year}-{n:04d}"

def _total_cost(quantity, unit_cost, additional_costs):
    """Pre-tax cost: goods value plus additional (shipping, handling) costs."""
    return money(float(quantity) * float(unit_cost) + float(additional_costs))

def _compute_purchase_tax(db, quantity, unit_cost, tax_rate_id):
    """Resolve (tax_rate_id, tax_rate, tax_amount) for a purchase. Tax applies
    to the goods value (quantity × unit_cost) only — shipping, customs and
    other additional costs are outside the taxable base in this model."""
    ctx = get_tax_context(db)
    net = money(float(quantity) * float(unit_cost))
    return resolve_purchase_tax(ctx, tax_rate_id, net)

@router.get("/")
def list_purchases(status: Optional[str] = None, supplier: Optional[str] = None,
                   include_archived: bool = False,
                   user=Depends(require_perm("purchases", "view")), db: sqlite3.Connection = Depends(get_db)):
    query = """SELECT p.*, i.name as inventory_name, i.unit as inventory_unit
               FROM purchases p LEFT JOIN inventory i ON p.inventory_id = i.id WHERE p.deleted_at IS NULL"""
    params = []
    # Default view hides archived purchases (previously they leaked into the
    # list — only deleted_at was filtered); include_archived=1 surfaces them.
    if not include_archived:
        query += " AND p.archived_at IS NULL"
    if status:
        query += " AND p.status = ?"
        params.append(status)
    if supplier:
        query += " AND p.supplier LIKE ?"
        params.append(f"%{supplier}%")
    # Branch scoping: a purchase's branch is its destination warehouse.
    bf, bp = branch_access.branch_filter(user, db, column="p.warehouse_id")
    query += bf; params += bp
    query += " ORDER BY p.ordered_at DESC"
    rows = db.execute(query, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["total_cost"]  = _total_cost(d["quantity"], d["unit_cost"], d["additional_costs"])
        d["grand_total"] = money(d["total_cost"] + float(d.get("tax_amount") or 0))
        result.append(d)
    return result

@router.get("/stats")
def purchase_stats(user=Depends(require_perm("purchases", "view")), db: sqlite3.Connection = Depends(get_db)):
    bf, bp = branch_access.branch_filter(user, db, column="warehouse_id")
    rows = db.execute(
        "SELECT status, COUNT(*) as count FROM purchases "
        "WHERE deleted_at IS NULL" + bf + " GROUP BY status", bp
    ).fetchall()
    stats = {r["status"]: r["count"] for r in rows}
    paid_rows = db.execute(
        "SELECT quantity, unit_cost, additional_costs, tax_amount FROM purchases "
        "WHERE status='Paid' AND archived_at IS NULL" + bf, bp
    ).fetchall()
    total_spent = money(sum(
        _total_cost(r["quantity"], r["unit_cost"], r["additional_costs"]) + float(r["tax_amount"] or 0)
        for r in paid_rows
    ))
    return {
        "ordered":     stats.get("Ordered", 0),
        "received":    stats.get("Received", 0),
        "paid":        stats.get("Paid", 0),
        "total_spent": total_spent,
    }

@router.get("/{purchase_id}")
def get_purchase(purchase_id: int, user=Depends(require_perm("purchases", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute(
        """SELECT p.*, i.name as inventory_name, i.unit as inventory_unit, i.quantity as current_stock
           FROM purchases p LEFT JOIN inventory i ON p.inventory_id = i.id WHERE p.id = ?""",
        (purchase_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    branch_access.assert_can_view_branch(user, db, row["warehouse_id"])
    d = dict(row)
    d["total_cost"]  = _total_cost(d["quantity"], d["unit_cost"], d["additional_costs"])
    d["grand_total"] = money(d["total_cost"] + float(d.get("tax_amount") or 0))
    return d

@router.post("/")
def create_purchase(data: PurchaseCreate, user=Depends(require_perm("purchases", "create")), db: sqlite3.Connection = Depends(get_db)):
    if data.quantity <= 0:
        raise HTTPException(400, "Quantity must be positive")
    validate_int_qty(data.quantity, "Purchase quantity")
    po = next_po_number(db)
    now = _now()
    # Lock LBP-entered cost to USD now (inventory = historical USD cost). Keep
    # the entry currency + the rate used as provenance on the PO row.
    cost_currency = (data.cost_currency or "USD").upper()
    if cost_currency not in ("USD", "LBP"):
        raise HTTPException(400, "Unsupported cost currency.")
    cost_rate = currency.resolve_rate(db, data.exchange_rate) if cost_currency == "LBP" else None
    unit_cost = currency.to_usd(data.unit_cost or 0, cost_currency, db, cost_rate)
    additional_costs = currency.to_usd(data.additional_costs or 0, cost_currency, db, cost_rate)
    # Resolve the destination warehouse — falls back to the user's default
    # so existing API callers keep working. Validates row-level access.
    import warehouse_access as wha
    warehouse_id = wha.resolve_warehouse_id(user, db, data.warehouse_id)

    # Auto-create inventory item if no existing item was linked
    inventory_id = data.inventory_id
    if inventory_id and data.category:
        db.execute(
            "UPDATE inventory SET category = ? WHERE id = ? AND (category IS NULL OR category = '' OR category = 'Other')",
            (data.category, inventory_id)
        )
    if not inventory_id:
        cur = db.execute(
            """INSERT INTO inventory
               (name, category, quantity, min_stock, unit_cost, supplier, unit, created_at)
               VALUES (?, ?, 0, 0, 0, ?, 'pcs', ?)""",
            (data.product_name, data.category or 'Other', data.supplier, now),
        )
        inventory_id = cur.lastrowid

    tax_rate_id, tax_rate, tax_amount = _compute_purchase_tax(
        db, data.quantity, unit_cost, data.tax_rate_id)
    c = db.execute(
        """INSERT INTO purchases
           (po_number, supplier, inventory_id, product_name, category, quantity, unit_cost,
            additional_costs, tax_rate_id, tax_rate, tax_amount, status, notes, warehouse_id,
            cost_currency, cost_exchange_rate, ordered_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (po, data.supplier, inventory_id, data.product_name, (data.category or 'Other'),
         data.quantity, unit_cost, additional_costs,
         tax_rate_id, tax_rate, tax_amount, data.status, data.notes, warehouse_id,
         cost_currency, cost_rate, now)
    )
    purchase_id = c.lastrowid

    if data.status in ("Received", "Paid"):
        _credit_stock(purchase_id, db)
    if data.status == "Paid":
        _record_expense(purchase_id, db)

    # Evaluate approval policies before commit
    total_cost = _total_cost(data.quantity, unit_cost, additional_costs)
    entity_data = {
        "total_cost": total_cost,
        "quantity":   data.quantity,
        "status":     data.status,
        "supplier":   data.supplier,
    }
    needs_approval = evaluate_and_apply(
        db,
        module="purchase", action="create",
        entity_data=entity_data,
        user_id=user["id"],
        entity_id=purchase_id,
        entity_label=f"{po} — {data.product_name}",
    )
    if needs_approval:
        db.execute(
            "UPDATE purchases SET status='Pending Approval' WHERE id=?",
            (purchase_id,),
        )

    log_action(db, user, "create", "purchase", purchase_id, po,
               {"supplier": data.supplier, "amount": total_cost})
    db.commit()
    return {"id": purchase_id, "po_number": po, "message": "Purchase created", "pending_approval": needs_approval}


@router.put("/{purchase_id}")
def update_purchase(purchase_id: int, data: PurchaseUpdate,
                    user=Depends(require_perm("purchases", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    if row["status"] != "Ordered":
        raise HTTPException(400, "Can only edit purchases in Ordered status")
    if data.quantity is not None:
        validate_int_qty(data.quantity, "Purchase quantity")

    # Lock any LBP-entered cost to USD before storing (see PurchaseCreate).
    cost_currency = (data.cost_currency or "USD").upper()
    if cost_currency not in ("USD", "LBP"):
        raise HTTPException(400, "Unsupported cost currency.")
    cost_rate = currency.resolve_rate(db, data.exchange_rate) if cost_currency == "LBP" else None
    new_unit_cost = (currency.to_usd(data.unit_cost, cost_currency, db, cost_rate)
                     if data.unit_cost is not None else None)
    new_additional = (currency.to_usd(data.additional_costs, cost_currency, db, cost_rate)
                      if data.additional_costs is not None else None)

    fields, params = [], []
    if data.supplier is not None:
        fields.append("supplier=?");         params.append(data.supplier)
    if data.product_name is not None:
        fields.append("product_name=?");     params.append(data.product_name)
    if data.category is not None:
        fields.append("category=?");         params.append(data.category)
    if data.quantity is not None:
        fields.append("quantity=?");          params.append(data.quantity)
    if new_unit_cost is not None:
        fields.append("unit_cost=?");         params.append(new_unit_cost)
        fields.append("cost_currency=?");     params.append(cost_currency)
        fields.append("cost_exchange_rate=?"); params.append(cost_rate)
    if new_additional is not None:
        fields.append("additional_costs=?");  params.append(new_additional)
    if data.notes is not None:
        fields.append("notes=?");             params.append(data.notes)
    if data.warehouse_id is not None:
        # Re-route the destination — only legal while the PO is still Ordered.
        # (Already enforced above; `_credit_stock` runs at receipt and reads
        # this column to land the units in the right warehouse.)
        import warehouse_access as wha
        new_wid = wha.resolve_warehouse_id(user, db, data.warehouse_id)
        fields.append("warehouse_id=?");      params.append(new_wid)

    if fields:
        # Recompute tax from the effective (new or unchanged) values.
        eff_qty  = data.quantity    if data.quantity    is not None else row["quantity"]
        eff_cost = new_unit_cost    if new_unit_cost    is not None else row["unit_cost"]
        eff_trid = data.tax_rate_id if data.tax_rate_id is not None else row["tax_rate_id"]
        t_rid, t_rate, t_amt = _compute_purchase_tax(db, eff_qty, eff_cost, eff_trid)
        fields += ["tax_rate_id=?", "tax_rate=?", "tax_amount=?"]
        params += [t_rid, t_rate, t_amt]
        params.append(purchase_id)
        db.execute(f"UPDATE purchases SET {', '.join(fields)} WHERE id=?", params)
        log_action(db, user, "update", "purchase", purchase_id, row["po_number"])
        db.commit()
    return {"message": "Purchase updated"}

@router.patch("/{purchase_id}/status")
def update_status(purchase_id: int, data: StatusUpdate,
                  user=Depends(require_perm("purchases", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")

    valid = ["Ordered", "Received", "Paid"]
    if data.status not in valid:
        raise HTTPException(400, f"Status must be one of: {', '.join(valid)}")
    # Enforce forward-only transitions to prevent accounting inconsistencies
    order = {"Ordered": 0, "Received": 1, "Paid": 2}
    current_rank = order.get(row["status"], 0)
    new_rank = order.get(data.status, 0)
    if new_rank < current_rank:
        raise HTTPException(400, f"Cannot move status backward from '{row['status']}' to '{data.status}'. Received/Paid purchases have updated stock and accounting records.")

    now = _now()
    if data.status == "Received":
        db.execute("UPDATE purchases SET status=?, received_at=? WHERE id=?",
                   (data.status, now, purchase_id))
        db.commit()
        _credit_stock(purchase_id, db)
    elif data.status == "Paid":
        db.execute(
            "UPDATE purchases SET status=?, paid_at=?, "
            " payment_method=COALESCE(?, payment_method), "
            " bank_account_id=COALESCE(?, bank_account_id) WHERE id=?",
            (data.status, now, data.payment_method, data.bank_account_id,
             purchase_id))
        db.commit()
        _credit_stock(purchase_id, db)
        _record_expense(purchase_id, db)
    else:
        db.execute("UPDATE purchases SET status=? WHERE id=?", (data.status, purchase_id))

    if data.status == "Received":
        total_val = round(float(row["quantity"]) * float(row["unit_cost"]) + float(row["additional_costs"]), 2)
        notify(db, type="purchase_received",
               title=f"Purchase order {row['po_number']} received",
               body=f"{row['product_name']} from {row['supplier']} — {row['quantity']} units, ${total_val:,.2f}",
               msg="purchase_received", params={"po": row["po_number"], "product": row["product_name"],
                                                "supplier": row["supplier"], "qty": row["quantity"],
                                                "total": float(total_val)},
               link=f"/purchases", entity_type="purchase", entity_id=purchase_id)
    log_action(db, user, "status_change", "purchase", purchase_id,
               row["po_number"], {"status": data.status})
    db.commit()
    return {"message": f"Status updated to {data.status}"}

def _credit_stock(purchase_id: int, db: sqlite3.Connection):
    """Increase inventory stock when purchase is received. Idempotent.
    Blends the receipt into inventory.unit_cost using a WEIGHTED AVERAGE of
    the value already on hand and the landed value of this lot, so the
    moving-average cost stays correct when the same item is restocked at a
    different price. This is the costing every downstream reader assumes —
    POS COGS, project consumption and manufacturing material cost all value
    stock at inventory.unit_cost, and manufacturing output blends the same
    way. Selling prices are NEVER set here — those live exclusively on
    quotation_items.
    """
    # Atomic claim: only one concurrent request can credit stock
    claimed = db.execute(
        "UPDATE purchases SET stock_updated=1 WHERE id=? AND stock_updated=0 AND inventory_id IS NOT NULL AND archived_at IS NULL",
        (purchase_id,),
    ).rowcount
    if claimed == 0:
        return  # already credited or not eligible
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row or not row["inventory_id"]:
        return

    inv = db.execute("SELECT * FROM inventory WHERE id = ?", (row["inventory_id"],)).fetchone()
    if not inv:
        return

    qty_before = float(inv["quantity"])
    old_cost   = float(inv["unit_cost"] or 0)
    qty        = float(row["quantity"])
    qty_after  = round(qty_before + qty, 6)

    # Landed VALUE of this receipt = goods value + apportioned additional
    # (shipping / customs / handling) costs.
    lot_value = float(row["unit_cost"]) * qty + float(row["additional_costs"])
    # Weighted-average the receipt into the value already on hand. With no
    # prior stock this reduces to the lot's landed cost; with existing stock
    # it correctly blends, instead of overwriting the average with this lot's
    # price (which would mis-state inventory value and every downstream COGS).
    new_unit_cost = (round((qty_before * old_cost + lot_value) / qty_after, 6)
                     if qty_after > 0 else old_cost)
    # Landed cost per unit for this receipt — the cost basis of the new lot.
    lot_unit_cost = round(lot_value / qty, 6) if qty > 0 else new_unit_cost

    now = _now()

    db.execute(
        "UPDATE inventory SET quantity = ?, unit_cost = ? WHERE id = ?",
        (qty_after, new_unit_cost, row["inventory_id"])
    )
    # Land the receipt in the purchase's warehouse (or the company default if
    # the purchase was created before warehouses existed) — maintains the
    # per-warehouse breakdown alongside the company-wide quantity above.
    import warehouse_access as wha
    wid = wha.default_warehouse_id_for_row(db, row["warehouse_id"])
    wha.credit_warehouse_stock(db, inventory_id=row["inventory_id"],
                                warehouse_id=wid, delta=qty)
    # Somebody has already paid for some of this. Their claim on it is older
    # than anybody else's, and without this the next walk-in buys it.
    filled = commitments.allocate(db, row["inventory_id"], warehouse_id=wid)
    commitments.notify_allocated(db, filled, source="purchase received")
    # Record the receipt as a tracked lot (lot-tracked items) or a FIFO/LIFO
    # cost layer. The weighted-average unit_cost above already reflects this lot.
    lots.record_stock_in(db, row["inventory_id"], qty, lot_unit_cost,
                         source_type="purchase", source_ref=row["po_number"], now=now)
    db.execute(
        """INSERT INTO stock_movements
           (inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (row["inventory_id"], "purchase", qty, qty_before, qty_after,
         row["po_number"], f"Purchase received: {row['po_number']}", wid, now)
    )

def _record_expense(purchase_id: int, db: sqlite3.Connection):
    """Record purchase cost as Finance expense. Idempotent."""
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row or row["expense_recorded"]:
        return
    base    = _total_cost(row["quantity"], row["unit_cost"], row["additional_costs"])
    tax_amt = float(row["tax_amount"] or 0)
    gross   = money(base + tax_amt)   # expense amount is the tax-inclusive cost
    now = _now()
    exp_cur = db.execute(
        "INSERT INTO expenses (category, description, amount, date, created_at, "
        " tax_rate_id, tax_rate, tax_amount) VALUES (?,?,?,date('now'),?,?,?,?)",
        ("Purchase", f"{row['po_number']} – {row['product_name']} from {row['supplier']}",
         gross, now, row["tax_rate_id"], row["tax_rate"] or 0, tax_amt)
    )
    db.execute("UPDATE purchases SET expense_recorded = 1 WHERE id = ?", (purchase_id,))
    # Auto-post to the General Ledger (F-2 audit fix — perpetual inventory).
    # Inventory is debited at the EX-VAT landed cost — the same value the cost
    # layers carry — so the 1200 balance always equals the physical stock value
    # and is fully relieved when the goods sell (COGS draws from those layers).
    # Debiting the VAT-inclusive gross here capitalised the input VAT into
    # Inventory, where COGS could never relieve it. The input-VAT portion is
    # charged to expense on the purchase date instead — the same gross/cash-
    # basis treatment a plain Finance expense gets. The VAT *declaration* reads
    # the tax snapshot on the `expenses` row above, not the GL, so it is
    # unaffected by this split.
    #   DR  Inventory                  base   (ex-VAT — matches cost layers)
    #   DR  General & Other Expense    VAT    (input VAT, only when taxed)
    #     CR  Cash & Bank                      gross
    # Note: the row also creates an `expenses` entry above so the cash-basis
    # Finance dashboard keeps showing the cash outflow on the purchase date.
    # The GL is the accrual source of truth; the cash-basis dashboard is the
    # cash-flow view. They legitimately differ for inventory purchases.
    tax_part = money(tax_amt)
    lines = [{"code": accounting.code(db, "inventory"), "debit": money(gross - tax_part)}]
    if tax_part > 0:
        # The VAT control account, not an expense: input VAT is reclaimable,
        # so it offsets what is owed rather than costing the business
        # anything. Debiting Other Expenses overstated costs and understated
        # the reclaim — the same error the sales side made in reverse.
        lines.append({"code": accounting.code(db, "vat_control"), "debit": tax_part,
                      "memo": f"Input VAT — {row['po_number']}"})
    # Out of whatever actually paid it. Crediting cash for a transfer
    # overstates the till and understates the bank by the same amount, and
    # neither can then be held against anything.
    lines.append({
        "code": accounting.money_account_for(
            db, method=_col(row, "payment_method"),
            bank_account_id=_col(row, "bank_account_id")),
        "credit": gross})
    accounting.post_entry(
        db,
        entry_date=now[:10],
        memo=f"Purchase {row['po_number']} — {row['product_name']}",
        lines=lines,
        source_type="purchase", source_id=purchase_id, created_by=None,
        branch_id=row["warehouse_id"],
    )

@router.patch("/{purchase_id}/archive")
def archive_purchase(purchase_id: int, user=Depends(require_perm("purchases", "delete")),
                     db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    if row["status"] in ("Received", "Paid"):
        raise HTTPException(400, f"Cannot archive a '{row['status']}' purchase — stock and accounting records are already committed.")
    now = _now()
    db.execute("UPDATE purchases SET archived_at=?, archive_reason='Archived' WHERE id=?", (now, purchase_id))
    log_action(db, user, "archive", "purchase", purchase_id, row["po_number"], {"supplier": row["supplier"]})
    db.commit()
    return {"message": "Purchase archived"}

@router.patch("/{purchase_id}/unarchive")
def unarchive_purchase(purchase_id: int, user=Depends(require_perm("purchases", "edit")),
                       db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NOT NULL", (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found in archives")
    db.execute("UPDATE purchases SET archived_at=NULL, archive_reason=NULL WHERE id=?", (purchase_id,))
    log_action(db, user, "unarchive", "purchase", purchase_id, row["po_number"])
    db.commit()
    return {"message": "Purchase restored from archive"}

@router.get("/supplier/{supplier_name}/history")
def supplier_history(supplier_name: str, user=Depends(require_perm("purchases", "view")),
                     db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute(
        "SELECT * FROM purchases WHERE supplier LIKE ? ORDER BY ordered_at DESC",
        (f"%{supplier_name}%",)
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["total_cost"] = _total_cost(d["quantity"], d["unit_cost"], d["additional_costs"])
        result.append(d)
    return result
