from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from database import get_db
from permissions import require_perm
import commitments
from routers.audit import log_action
from utils import (_now, notify, get_tax_context, resolve_purchase_tax, money,
                   summarise_lines as _summarise, validate_int_qty,
                   ArchiveMode, archive_clause)
from approval_engine import evaluate_and_apply
import branch_access
import costing
import currency
import lots
import reservations
import warehouse_access as wha
import accounting
from routers.finance import _check_period_locked
import sqlite3
from datetime import datetime

router = APIRouter()

class PurchaseLineIn(BaseModel):
    """One product on a supplier's invoice.

    `discount` is an amount and is what the arithmetic uses; `discount_pct`
    only records how that amount was arrived at, so a percentage typed on the
    screen survives a reload. Exactly the division of labour invoice lines have.
    """
    inventory_id: Optional[int] = None
    product_name: str
    category:     Optional[str] = "Other"
    quantity:     float
    unit_cost:    float = 0
    discount:     float = 0
    discount_pct: Optional[float] = None
    tax_rate_id:  Optional[int] = None


class PurchaseCreate(BaseModel):
    supplier: str
    # A purchase is a document with lines. The flat single-item fields below
    # are still accepted and are normalised into one line, because every
    # existing caller — the seed data and 25 test files among them — sends
    # that shape, and rewriting them all alongside a costing change would make
    # the diff unreadable. `items` wins when both are present.
    items: Optional[List[PurchaseLineIn]] = None
    inventory_id: Optional[int] = None
    product_name: Optional[str] = None
    category: Optional[str] = "Other"
    quantity: Optional[float] = None
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
    # As on create: either a full set of lines, or the legacy flat fields for
    # the single-line case. `None` means "this request is not about the lines"
    # and leaves them alone.
    items: Optional[List[PurchaseLineIn]] = None
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

def _doc_total(row):
    """A purchase's pre-tax cost: its lines, plus the delivery's own charges.

    `subtotal` is maintained from the lines by `_recalc_totals` and is the only
    figure the money aggregates read. They GROUP BY over `purchases`, and
    joining the lines into those queries would turn COUNT(purchases.id) into a
    count of LINES — a fan-out that shows up as a wrong number with nothing
    failing.
    """
    return money(float(row["subtotal"] or 0) + float(row["additional_costs"] or 0))


def _doc_grand_total(row):
    """...and with the VAT the lines carry."""
    return money(_doc_total(row) + float(row["tax_total"] or 0))

def _line_net(quantity, unit_cost, discount=0) -> float:
    """What a line is worth before tax: goods value less its own discount.

    Floored at zero. A discount larger than the line would otherwise make the
    taxable base negative, which turns into a negative tax and a credit nobody
    granted.
    """
    return money(max(float(quantity) * float(unit_cost) - float(discount or 0), 0.0))


def _apportion(total, weights) -> list:
    """Split `total` across `weights` so the parts sum to it EXACTLY.

    Shipping and customs are charged once for a whole delivery but have to
    reach each line, because a line's landed cost is what its goods are worth
    on the shelf. Rounding each share independently leaves a cent unallocated,
    and that cent is the difference between the stock value and the ledger's
    inventory debit — which is precisely what the reconciliation report exists
    to notice. The residue goes to the largest line, where it is least visible
    as a per-unit distortion.

    Falls back to an equal split when every weight is zero (a delivery of free
    samples still carries freight).
    """
    n = len(weights)
    if n == 0:
        return []
    total = money(total)
    w = [max(float(x or 0), 0.0) for x in weights]
    pool = sum(w)
    if pool <= 0:
        w, pool = [1.0] * n, float(n)
    shares = [money(total * x / pool) for x in w]
    residue = money(total - money(sum(shares)))
    if residue:
        biggest = max(range(n), key=lambda k: w[k])
        shares[biggest] = money(shares[biggest] + residue)
    return shares


def _compute_purchase_tax(db, quantity, unit_cost, tax_rate_id):
    """Resolve (tax_rate_id, tax_rate, tax_amount) for a purchase. Tax applies
    to the goods value (quantity × unit_cost) only — shipping, customs and
    other additional costs are outside the taxable base in this model."""
    ctx = get_tax_context(db)
    net = money(float(quantity) * float(unit_cost))
    return resolve_purchase_tax(ctx, tax_rate_id, net)


# ── Lines ────────────────────────────────────────────────────────────────────
# A purchase is a header and its lines. These five functions are the only place
# that writes them, so the header's money and the lines cannot drift apart.

def _normalise_lines(data, *, required=True):
    """One shape for the handlers, whatever the caller sent.

    `items` when present; otherwise the flat single-item fields folded into one
    line. Returns None when the request says nothing about the lines at all,
    which on an update means "leave them alone" and is different from an empty
    list.
    """
    if data.items is not None:
        if not data.items:
            raise HTTPException(400, "A purchase needs at least one item.")
        return list(data.items)
    if getattr(data, "product_name", None) is None and getattr(data, "quantity", None) is None:
        if required:
            raise HTTPException(400, "A purchase needs at least one item.")
        return None
    return [PurchaseLineIn(
        inventory_id=data.inventory_id if hasattr(data, "inventory_id") else None,
        product_name=data.product_name or "Item",
        category=data.category,
        quantity=data.quantity if data.quantity is not None else 0,
        unit_cost=data.unit_cost or 0,
        tax_rate_id=data.tax_rate_id,
    )]


def _validate_lines(lines):
    for i, ln in enumerate(lines, 1):
        if ln.quantity is None or ln.quantity <= 0:
            raise HTTPException(400, f"Line {i}: quantity must be positive.")
        validate_int_qty(ln.quantity, f"Line {i} quantity")
        if float(ln.discount or 0) < 0:
            raise HTTPException(400, f"Line {i}: a discount cannot be negative.")


def _link_inventory(db, line, supplier, now):
    """The inventory item this line is for, created if it is a new product."""
    inventory_id = line.inventory_id
    if inventory_id and line.category:
        db.execute(
            "UPDATE inventory SET category = ? WHERE id = ? AND "
            "(category IS NULL OR category = '' OR category = 'Other')",
            (line.category, inventory_id))
    if not inventory_id:
        cur = db.execute(
            """INSERT INTO inventory
               (name, category, quantity, min_stock, unit_cost, supplier, unit, created_at)
               VALUES (?, ?, 0, 0, 0, ?, 'pcs', ?)""",
            (line.product_name, line.category or "Other", supplier, now))
        inventory_id = cur.lastrowid
    return inventory_id


def _write_lines(db, purchase_id, lines, *, supplier, cost_currency, cost_rate, now):
    """Replace this purchase's lines. Costs arrive in the entry currency and are
    stored in USD, because inventory is carried at historical USD cost."""
    db.execute("DELETE FROM purchase_items WHERE purchase_id = ?", (purchase_id,))
    ctx = get_tax_context(db)
    for ln in lines:
        inventory_id = _link_inventory(db, ln, supplier, now)
        unit_cost = currency.to_usd(ln.unit_cost or 0, cost_currency, db, cost_rate)
        discount  = currency.to_usd(ln.discount or 0, cost_currency, db, cost_rate)
        net = _line_net(ln.quantity, unit_cost, discount)
        t_rid, t_rate, t_amt = resolve_purchase_tax(ctx, ln.tax_rate_id, net)
        db.execute(
            """INSERT INTO purchase_items
               (purchase_id, inventory_id, product_name, category, quantity,
                unit_cost, discount, discount_pct, tax_rate_id, tax_rate,
                tax_amount, line_total)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (purchase_id, inventory_id, ln.product_name, ln.category or "Other",
             ln.quantity, unit_cost, discount, ln.discount_pct,
             t_rid, t_rate, t_amt, net))


def _layer_ref(po_number, line_id) -> str:
    """The key a receipt's cost layer is filed under.

    The PO number alone is not enough: two lines of the same item on one order
    would share it, and reversing one of them would draw down the other's
    goods. The line's own id is never reused, so it names exactly one receipt.
    """
    return f"{po_number}#{line_id}"


def _lines_of(db, purchase_id):
    return db.execute(
        "SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id",
        (purchase_id,)).fetchall()


def _recalc_totals(db, purchase_id):
    """The ONLY writer of the header's money.

    The supplier and insights figures GROUP BY over `purchases`; joining the
    lines into those queries would turn COUNT(purchases.id) into a count of
    lines. They read these columns instead, which is safe only because this is
    the single place they are set — and `test_purchase_lines.py` asserts they
    equal the sum of the lines for every purchase in the database.
    """
    row = db.execute(
        "SELECT COALESCE(SUM(line_total), 0) AS sub, COALESCE(SUM(tax_amount), 0) AS tax "
        "FROM purchase_items WHERE purchase_id = ?", (purchase_id,)).fetchone()
    db.execute("UPDATE purchases SET subtotal = ?, tax_total = ? WHERE id = ?",
               (money(row["sub"]), money(row["tax"]), purchase_id))


def _save_lines(db, purchase_id, lines, *, supplier, cost_currency, cost_rate, now):
    """Write the lines and bring every derived figure back into step."""
    _write_lines(db, purchase_id, lines, supplier=supplier,
                 cost_currency=cost_currency, cost_rate=cost_rate, now=now)
    _recalc_totals(db, purchase_id)


@router.get("/")
def list_purchases(status: Optional[str] = None, supplier: Optional[str] = None,
                   archived: ArchiveMode = "exclude",
                   user=Depends(require_perm("purchases", "view")), db: sqlite3.Connection = Depends(get_db)):
    query = """SELECT p.* FROM purchases p WHERE p.deleted_at IS NULL"""
    params = []
    # The default view is the working list; `archived=only` swaps it for the
    # archive rather than widening it.
    query += f" AND {archive_clause(archived, 'p.archived_at')}"
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
    # One query for the whole page's lines. A per-row lookup would be a query
    # per purchase, which is how a list page quietly becomes slow.
    by_purchase = {}
    if rows:
        marks = ",".join("?" for _ in rows)
        for l in db.execute(
                f"SELECT * FROM purchase_items WHERE purchase_id IN ({marks}) ORDER BY id",
                [r["id"] for r in rows]).fetchall():
            by_purchase.setdefault(l["purchase_id"], []).append(l)
    result = []
    for r in rows:
        d = dict(r)
        d["total_cost"]  = _doc_total(r)
        d["grand_total"] = _doc_grand_total(r)
        # What the list needs to DESCRIBE a document that has several lines.
        # `product_name` and `quantity` on the header are a roll-up that is
        # about to go away; these are derived from the lines and are what the
        # screen and the export read.
        rows_l = by_purchase.get(r["id"], [])
        d["items"]         = [dict(x) for x in rows_l]
        d["line_count"]    = len(rows_l)
        d["item_summary"]  = _summarise(rows_l[0]["product_name"] if rows_l else None,
                                        len(rows_l))
        d["total_quantity"] = money(sum(float(x["quantity"] or 0) for x in rows_l))
        d["categories"]    = sorted({(x["category"] or "Other") for x in rows_l})
        result.append(d)
    return result

@router.get("/stats")
def purchase_stats(user=Depends(require_perm("purchases", "view")), db: sqlite3.Connection = Depends(get_db)):
    bf, bp = branch_access.branch_filter(user, db, column="warehouse_id")
    # A voided purchase counts as nothing: not an outstanding order, not a
    # receipt, not money spent. The row stays in the list so the history reads
    # true, exactly as a voided invoice does — it is only the figures it has to
    # stay out of.
    rows = db.execute(
        "SELECT status, COUNT(*) as count FROM purchases "
        "WHERE deleted_at IS NULL AND voided_at IS NULL" + bf + " GROUP BY status", bp
    ).fetchall()
    stats = {r["status"]: r["count"] for r in rows}
    paid_rows = db.execute(
        "SELECT subtotal, additional_costs, tax_total FROM purchases "
        "WHERE status='Paid' AND archived_at IS NULL AND voided_at IS NULL" + bf, bp
    ).fetchall()
    total_spent = money(sum(_doc_grand_total(r) for r in paid_rows))
    return {
        "ordered":     stats.get("Ordered", 0),
        "received":    stats.get("Received", 0),
        "paid":        stats.get("Paid", 0),
        "total_spent": total_spent,
    }

@router.get("/{purchase_id}")
def get_purchase(purchase_id: int, user=Depends(require_perm("purchases", "view")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute(
        """SELECT p.* FROM purchases p WHERE p.id = ?""",
        (purchase_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    branch_access.assert_can_view_branch(user, db, row["warehouse_id"])
    d = dict(row)
    d["total_cost"]  = _doc_total(row)
    d["grand_total"] = _doc_grand_total(row)
    # The lines are the document. A caller opening one purchase wants them.
    d["items"] = [dict(l) for l in _lines_of(db, purchase_id)]
    return d

@router.post("/")
def create_purchase(data: PurchaseCreate, user=Depends(require_perm("purchases", "create")), db: sqlite3.Connection = Depends(get_db)):
    lines = _normalise_lines(data)
    _validate_lines(lines)
    po = next_po_number(db)
    now = _now()
    # Lock LBP-entered cost to USD now (inventory = historical USD cost). Keep
    # the entry currency + the rate used as provenance on the PO row. The
    # currency belongs to the document: a supplier invoice is written in one.
    cost_currency = (data.cost_currency or "USD").upper()
    if cost_currency not in ("USD", "LBP"):
        raise HTTPException(400, "Unsupported cost currency.")
    cost_rate = currency.resolve_rate(db, data.exchange_rate) if cost_currency == "LBP" else None
    additional_costs = currency.to_usd(data.additional_costs or 0, cost_currency, db, cost_rate)
    # Resolve the destination warehouse — falls back to the user's default
    # so existing API callers keep working. Validates row-level access.
    import warehouse_access as wha
    warehouse_id = wha.resolve_warehouse_id(user, db, data.warehouse_id)

    # The header is inserted first so the lines have something to hang off.
    # Its per-item columns are placeholders; `_save_lines` fills them from the
    # lines a moment later, and they disappear entirely once the last reader
    # has moved across.
    c = db.execute(
        """INSERT INTO purchases
           (po_number, supplier, additional_costs, status, notes, warehouse_id,
            cost_currency, cost_exchange_rate, ordered_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (po, data.supplier, additional_costs, data.status, data.notes,
         warehouse_id, cost_currency, cost_rate, now)
    )
    purchase_id = c.lastrowid
    _save_lines(db, purchase_id, lines, supplier=data.supplier,
                cost_currency=cost_currency, cost_rate=cost_rate, now=now)

    if data.status in ("Received", "Paid"):
        _credit_stock(purchase_id, db)
    if data.status == "Paid":
        _record_expense(purchase_id, db)

    # Evaluate approval policies before commit. `quantity` is now the total
    # across the lines and `category` the distinct set, so a policy written
    # against a single-item purchase keeps the meaning it had while a
    # multi-line one gets an honest answer rather than the first line's.
    head = db.execute("SELECT subtotal FROM purchases WHERE id=?",
                      (purchase_id,)).fetchone()
    rows = _lines_of(db, purchase_id)
    total_cost = money(float(head["subtotal"]) + additional_costs)
    entity_data = {
        "total_cost": total_cost,
        "quantity":   money(sum(float(r["quantity"] or 0) for r in rows)),
        "category":   ", ".join(sorted({(r["category"] or "Other") for r in rows})),
        "line_count": len(rows),
        "status":     data.status,
        "supplier":   data.supplier,
    }
    needs_approval = evaluate_and_apply(
        db,
        module="purchase", action="create",
        entity_data=entity_data,
        user_id=user["id"],
        entity_id=purchase_id,
        entity_label=f"{po} — {lines[0].product_name}",
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

    # Lock any LBP-entered cost to USD before storing (see PurchaseCreate).
    cost_currency = (data.cost_currency or "USD").upper()
    if cost_currency not in ("USD", "LBP"):
        raise HTTPException(400, "Unsupported cost currency.")
    cost_rate = currency.resolve_rate(db, data.exchange_rate) if cost_currency == "LBP" else None
    new_additional = (currency.to_usd(data.additional_costs, cost_currency, db, cost_rate)
                      if data.additional_costs is not None else None)

    # `None` means the request is not about the lines and leaves them alone;
    # a list replaces them wholesale. Replacing rather than patching is the
    # invoice-line pattern, and it is the only way a request can remove a line.
    lines = _normalise_lines(data, required=False)
    if lines is not None:
        _validate_lines(lines)

    fields, params = [], []
    if data.supplier is not None:
        fields.append("supplier=?");           params.append(data.supplier)
    if new_additional is not None:
        fields.append("additional_costs=?");   params.append(new_additional)
    if data.notes is not None:
        fields.append("notes=?");              params.append(data.notes)
    if lines is not None:
        fields.append("cost_currency=?");      params.append(cost_currency)
        fields.append("cost_exchange_rate=?"); params.append(cost_rate)
    if data.warehouse_id is not None:
        # Re-route the destination — only legal while the PO is still Ordered.
        # (Already enforced above; `_credit_stock` runs at receipt and reads
        # this column to land the units in the right warehouse.)
        import warehouse_access as wha
        new_wid = wha.resolve_warehouse_id(user, db, data.warehouse_id)
        fields.append("warehouse_id=?");       params.append(new_wid)

    if not fields and lines is None:
        return {"message": "Purchase updated"}

    if fields:
        params.append(purchase_id)
        db.execute(f"UPDATE purchases SET {', '.join(fields)} WHERE id=?", params)
    if lines is not None:
        _save_lines(db, purchase_id, lines,
                    supplier=data.supplier or row["supplier"],
                    cost_currency=cost_currency, cost_rate=cost_rate, now=_now())
    elif new_additional is not None:
        # Shipping changed but the lines did not. Their share of it — and so
        # what the goods will land at — moves with it, and the header totals
        # have to be recomputed from the lines either way.
        _recalc_totals(db, purchase_id)
    log_action(db, user, "update", "purchase", purchase_id, row["po_number"])
    db.commit()
    return {"message": "Purchase updated"}

@router.patch("/{purchase_id}/status")
def update_status(purchase_id: int, data: StatusUpdate,
                  user=Depends(require_perm("purchases", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")

    if _col(row, "voided_at"):
        raise HTTPException(
            400, "This purchase has been voided. Raise a new one rather than "
                 "moving this one forward.")
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
        # Re-read: the totals and the lines are what arrived, and `row` was
        # loaded before the receipt ran.
        got = db.execute("SELECT * FROM purchases WHERE id=?", (purchase_id,)).fetchone()
        got_lines = _lines_of(db, purchase_id)
        total_val = _doc_total(got)
        product = _summarise(got_lines[0]["product_name"] if got_lines else None,
                             len(got_lines))
        qty = money(sum(float(l["quantity"] or 0) for l in got_lines))
        notify(db, type="purchase_received",
               title=f"Purchase order {row['po_number']} received",
               body=f"{product} from {row['supplier']} — {qty:g} units, ${total_val:,.2f}",
               msg="purchase_received", params={"po": row["po_number"], "product": product,
                                                "supplier": row["supplier"], "qty": qty,
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
    # Atomic claim: only one concurrent request can credit stock. It is taken on
    # the HEADER, so it guards the whole loop below rather than a single line.
    # `voided_at IS NULL` belongs in the claim itself, not only in the callers:
    # voiding releases the flag so the receipt cannot be counted twice, which is
    # exactly what would let a later status change credit the goods again.
    claimed = db.execute(
        "UPDATE purchases SET stock_updated=1 WHERE id=? AND stock_updated=0 "
        "AND archived_at IS NULL AND voided_at IS NULL",
        (purchase_id,),
    ).rowcount
    if claimed == 0:
        return  # already credited or not eligible
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row:
        return
    lines = _lines_of(db, purchase_id)
    if not lines:
        return

    now = _now()
    import warehouse_access as wha
    wid = wha.default_warehouse_id_for_row(db, row["warehouse_id"])
    # Shipping and customs are charged once for the delivery but belong to the
    # goods, so each line carries its share and lands at that cost.
    shares = _apportion(row["additional_costs"] or 0,
                        [l["line_total"] for l in lines])
    filled = []

    for line, share in zip(lines, shares):
        inventory_id = line["inventory_id"]
        if not inventory_id:
            continue
        # Re-read the item INSIDE the loop. Two lines of the same product on one
        # order is an ordinary delivery, and hoisting this read would blend the
        # second line against the stock level from before the first one landed.
        inv = db.execute("SELECT * FROM inventory WHERE id = ?", (inventory_id,)).fetchone()
        if not inv:
            continue

        qty_before = float(inv["quantity"])
        old_cost   = float(inv["unit_cost"] or 0)
        qty        = float(line["quantity"] or 0)
        if qty <= 0:
            continue
        qty_after  = round(qty_before + qty, 6)

        # Landed VALUE of this line = its goods value, net of its own discount,
        # plus its share of the delivery's additional costs.
        lot_value = money(float(line["line_total"] or 0) + share)
        # Weighted-average the receipt into the value already on hand. With no
        # prior stock this reduces to the lot's landed cost; with existing stock
        # it correctly blends, instead of overwriting the average with this
        # lot's price (which would mis-state inventory value and every
        # downstream COGS).
        new_unit_cost = (round((qty_before * old_cost + lot_value) / qty_after, 6)
                         if qty_after > 0 else old_cost)
        # Landed cost per unit for this line — the cost basis of the new lot,
        # and the number a reversal has to un-blend with. Stored on the line
        # rather than recomputed later, so the two cannot round differently.
        lot_unit_cost = round(lot_value / qty, 6) if qty > 0 else new_unit_cost
        db.execute(
            "UPDATE purchase_items SET additional_cost_share=?, landed_unit_cost=?, "
            " stock_updated=1 WHERE id=?",
            (money(share), lot_unit_cost, line["id"]))

        db.execute(
            "UPDATE inventory SET quantity = ?, unit_cost = ? WHERE id = ?",
            (qty_after, new_unit_cost, inventory_id)
        )
        # Land the receipt in the purchase's warehouse (or the company default
        # if the purchase was created before warehouses existed) — maintains the
        # per-warehouse breakdown alongside the company-wide quantity above.
        wha.credit_warehouse_stock(db, inventory_id=inventory_id,
                                   warehouse_id=wid, delta=qty)
        # Somebody has already paid for some of this. Their claim on it is older
        # than anybody else's, and without this the next walk-in buys it.
        filled += commitments.allocate(db, inventory_id, warehouse_id=wid)
        # Record the receipt as a tracked lot (lot-tracked items) or a FIFO/LIFO
        # cost layer, keyed to the LINE: two lines of the same item would
        # otherwise share one key, and reversing either would draw down the
        # other's goods.
        lots.record_stock_in(db, inventory_id, qty, lot_unit_cost,
                             source_type="purchase",
                             source_ref=_layer_ref(row["po_number"], line["id"]), now=now)
        db.execute(
            """INSERT INTO stock_movements
               (inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (inventory_id, "purchase", qty, qty_before, qty_after,
             row["po_number"], f"Purchase received: {row['po_number']}", wid, now)
        )

    # Told once for the whole delivery. Notifying inside the loop would send a
    # customer the same "your order is ready" twice for a two-line receipt.
    commitments.notify_allocated(db, filled, source="purchase received")

def _record_expense(purchase_id: int, db: sqlite3.Connection):
    """Record purchase cost as Finance expense. Idempotent."""
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row or row["expense_recorded"]:
        return
    lines   = _lines_of(db, purchase_id)
    add     = float(row["additional_costs"] or 0)
    net     = money(sum(float(l["line_total"] or 0) for l in lines))
    tax_amt = money(sum(float(l["tax_amount"] or 0) for l in lines))
    base    = money(net + add)
    gross   = money(base + tax_amt)   # expense amount is the tax-inclusive cost
    now = _now()
    # A purchase that cost nothing still brings goods in — free samples, a
    # warranty replacement, a supplier making good on a short delivery. There
    # is simply no value to move and no cash to credit, and an all-zero journal
    # entry is not a record of anything, so post_entry rightly refuses it.
    # Before this, that refusal surfaced as a 500 on the very last step of
    # marking the purchase paid: the stock had already been received and the
    # status already changed, so the operator saw a server error over a
    # purchase that had in fact gone through. Take the goods, post nothing, and
    # do not leave the row looking unposted so it is retried on every status
    # change from here on.
    if gross <= 0:
        db.execute("UPDATE purchases SET expense_recorded = 1 WHERE id = ?",
                   (purchase_id,))
        return
    # ONE EXPENSE ROW PER VAT RATE, not one per purchase.
    #
    # The VAT return groups input tax by `expenses.tax_rate` (see
    # routers/reports.py). A single row carries a single rate snapshot, so the
    # moment one delivery mixes a standard-rated item with a zero-rated one,
    # that row cannot describe both — and the per-rate table on the return goes
    # wrong while the headline total still balances, which is the kind of error
    # nobody notices until an auditor does.
    #
    # Shipping is outside the taxable base in this model, so it is its own
    # zero-rated row rather than being folded into a rated one, where it would
    # overstate that rate's base.
    #
    # Every description still opens with the PO number and a space, which is
    # how voiding finds them all (`LIKE '<po> %'`, no LIMIT).
    groups = {}
    for l in lines:
        key = (l["tax_rate_id"], money(l["tax_rate"] or 0))
        g = groups.setdefault(key, {"net": 0.0, "tax": 0.0})
        g["net"] += float(l["line_total"] or 0)
        g["tax"] += float(l["tax_amount"] or 0)
    if add:
        g = groups.setdefault((None, 0.0), {"net": 0.0, "tax": 0.0})
        g["net"] += add

    label = _summarise(lines[0]["product_name"] if lines else None, len(lines))
    for (t_rid, t_rate), g in groups.items():
        amount = money(g["net"] + g["tax"])
        if amount <= 0:
            continue
        db.execute(
            "INSERT INTO expenses (category, description, amount, date, created_at, "
            " tax_rate_id, tax_rate, tax_amount) VALUES (?,?,?,date('now'),?,?,?,?)",
            ("Purchase", f"{row['po_number']} – {label} from {row['supplier']}",
             amount, now, t_rid, t_rate, money(g["tax"])))
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
        memo=f"Purchase {row['po_number']} — {label}",
        lines=lines,
        source_type="purchase", source_id=purchase_id, created_by=None,
        branch_id=row["warehouse_id"],
    )

class VoidRequest(BaseModel):
    reason: Optional[str] = None


@router.patch("/{purchase_id}/void")
def void_purchase(
    purchase_id: int,
    data: VoidRequest,
    user=Depends(require_perm("purchases", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Take a purchase back: the goods off the shelf, the money out of the books.

    The mirror of voiding an invoice, and needed for the same reason. A purchase
    entered against the wrong supplier, keyed twice, or received for goods that
    never arrived had no way out: archiving hid the row while leaving the stock
    on the shelf and the entry in the ledger, and editing is refused once
    received — correctly, because by then the goods and the money have moved. So
    the only remedy was a hand-typed stock adjustment plus a manual journal,
    from memory, with nothing tying the two together.

    Everything the purchase did is undone, and nothing is deleted:

      * the goods come off the shelf, drawing down THIS receipt's own lot or
        cost layer rather than whatever the costing method would sell next;
      * `inventory.unit_cost` is un-blended, so the average returns to what it
        was before the receipt landed;
      * the ledger entry is reversed by a mirror entry, never edited;
      * the expense row is voided, so the cash-basis view drops it too.

    It is refused while the goods are not all still here — see `_can_reverse`.
    That is the one thing this cannot do honestly: units already sold cannot be
    unbought, and inventing the shortfall would put the ledger and the shelf
    into exactly the disagreement this endpoint exists to prevent.
    """
    row = db.execute(
        "SELECT * FROM purchases WHERE id=? AND archived_at IS NULL",
        (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    branch_access.assert_can_view_branch(user, db, row["warehouse_id"])
    if _col(row, "voided_at"):
        raise HTTPException(400, "Purchase is already voided.")

    # Both months matter. The receipt posted into the month it was received and
    # the reversal posts into today, so a lock on either has to stop it — the
    # same rule the invoice unvoid and the till return follow.
    _check_period_locked(db, row["paid_at"] or row["received_at"] or row["ordered_at"])
    _check_period_locked(db, _now())

    now = _now()
    undone = _reverse_stock(row, db, now)

    # The ledger, by a mirror entry rather than an edit. A no-op when the
    # purchase was never paid: nothing was posted, so there is nothing to undo.
    if row["expense_recorded"]:
        accounting.reverse_source(
            db, "purchase", purchase_id,
            memo=f"Reversal — voided purchase {row['po_number']}",
            created_by=user["id"])
        # And the cash-basis view of the same money. The expense row carries no
        # link back to its purchase, but `_record_expense` opens its description
        # with the PO number, which is unique.
        #
        # The trailing space matters. PO numbers are zero-padded to four digits
        # and then grow, so a bare prefix would let PO-2026-1000 also match
        # PO-2026-10000 — and void a different purchase's expense. The
        # description is "<po> - <product> from <supplier>", so the space after
        # the number is always there and always ends it.
        db.execute(
            "UPDATE expenses SET voided_at=?, void_reason=? "
            "WHERE category='Purchase' AND voided_at IS NULL "
            "AND description LIKE ?",
            (now, f"Voided purchase {row['po_number']}", f"{row['po_number']} %"))

    db.execute("UPDATE purchases SET voided_at=?, void_reason=? WHERE id=?",
               (now, data.reason or "Voided", purchase_id))
    log_action(db, user, "void", "purchase", purchase_id, row["po_number"],
               {"reason": data.reason or "Voided", **undone})
    db.commit()
    return {"message": "Purchase voided", "voided_at": now, **undone}


def _can_reverse(row, lines, db) -> tuple:
    """Whether this receipt's goods are all still here. Returns (ok, why_not).

    Three questions, because three things can hold the goods:

      * the receipt's own lot or cost layer, which answers exactly whether THESE
        units are still on the shelf. Under weighted_avg there is no such
        record — the receipt was blended into one average the moment it landed —
        so on-hand quantity is the best available answer;
      * what a customer has already been promised. Receiving stock hands it to
        whoever was waiting (`commitments.allocate`), and those units are spoken
        for even though they are physically present;
      * the warehouse it landed in, since company-wide stock says nothing about
        whether this particular location still holds it.

    All three are asked PER ITEM, totalled across the lines that carry it — not
    per line. Two lines of ten of the same product, with twelve on hand, would
    each pass a line-by-line check and together take the item to minus eight.
    """
    if not row["stock_updated"]:
        return True, None

    need, names, layer_have = {}, {}, {}
    for line in lines:
        iid = line["inventory_id"]
        if not iid or not line["stock_updated"]:
            continue
        qty = float(line["quantity"] or 0)
        need[iid] = need.get(iid, 0.0) + qty
        names.setdefault(iid, line["product_name"])
        # Each line has its own layer, so the answer for the item is the sum of
        # its lines' answers. `None` means the costing method keeps no such
        # record and the question cannot be asked of a specific receipt.
        intact = lots.remaining_from(db, iid, source_type="purchase",
                                     source_ref=_layer_ref(row["po_number"], line["id"]))
        if intact is None:
            layer_have[iid] = None
        elif layer_have.get(iid, 0.0) is not None:
            layer_have[iid] = layer_have.get(iid, 0.0) + intact

    if not need:
        return True, None

    wid = wha.default_warehouse_id_for_row(db, row["warehouse_id"])
    for iid, qty in need.items():
        name = names[iid]
        intact = layer_have.get(iid)
        if intact is not None and intact + 1e-6 < qty:
            return False, (
                f"Only {intact:g} of the {qty:g} units of '{name}' received are "
                f"still in stock — the rest of this receipt has been sold or "
                f"used. Voiding it would remove goods that are no longer there. "
                f"Record a supplier return or a stock adjustment instead.")

        free = reservations.available(db, iid)
        if free + 1e-6 < qty:
            on_hand = float(db.execute(
                "SELECT COALESCE(quantity, 0) AS q FROM inventory WHERE id=?",
                (iid,)).fetchone()["q"] or 0)
            if on_hand + 1e-6 < qty:
                return False, (
                    f"Only {on_hand:g} of '{name}' is in stock but this purchase "
                    f"brought in {qty:g}. Voiding it would take the item negative.")
            return False, (
                f"{qty:g} units of '{name}' are needed to reverse this purchase "
                f"but only {free:g} are unspoken for — the rest is reserved for "
                f"a customer. Release the reservation first, or record a "
                f"supplier return instead.")

        ws = db.execute(
            "SELECT COALESCE(quantity, 0) AS q FROM inventory_stock "
            "WHERE inventory_id=? AND warehouse_id=?", (iid, wid)).fetchone()
        at_location = float(ws["q"] or 0) if ws else 0.0
        if at_location + 1e-6 < qty:
            return False, (
                f"The goods landed in this warehouse but only {at_location:g} of "
                f"{qty:g} '{name}' are still there — the rest has moved or been "
                f"sold. Transfer it back before voiding, or record a supplier "
                f"return.")
    return True, None


def _reverse_stock(row, db: sqlite3.Connection, now: str) -> dict:
    """Take the received goods back off the shelf. The mirror of _credit_stock.

    Refuses rather than improvises: a receipt whose goods have moved on cannot
    be reversed without inventing stock, and the whole order is checked before a
    single write so a refusal leaves nothing half-done.
    """
    purchase_id = row["id"]
    if not row["stock_updated"]:
        return {"restocked": 0.0, "lines": []}

    lines = _lines_of(db, purchase_id)
    ok, why = _can_reverse(row, lines, db)
    if not ok:
        raise HTTPException(409, why)

    wid = wha.default_warehouse_id_for_row(db, row["warehouse_id"])
    undone, total = [], 0.0

    for line in lines:
        inventory_id = line["inventory_id"]
        if not inventory_id or not line["stock_updated"]:
            continue
        qty = float(line["quantity"] or 0)
        if qty <= 0:
            continue
        # Re-read per line, for the same reason the receipt does: two lines of
        # the same product must each see the level the previous one left.
        inv = db.execute("SELECT * FROM inventory WHERE id=?", (inventory_id,)).fetchone()
        if not inv:
            continue
        qty_before = float(inv["quantity"] or 0)
        qty_after  = round(qty_before - qty, 6)
        # The cost this line actually landed at, read back rather than
        # recomputed. Reversing at the item's CURRENT average would leave the
        # difference between the two behind as a silent gain or loss, and
        # recomputing the apportionment would re-round it.
        lot_unit_cost = float(line["landed_unit_cost"] or 0)

        # Order matters: draw the line's own layer down first, then un-blend the
        # average, then move the quantity. `reverse_stock_in` recomputes
        # unit_cost from the remaining LOTS for a lot-tracked item, so the
        # un-blend below must not run for those or it would overwrite the
        # authoritative figure.
        tracked = lots.is_lot_tracked(db, inventory_id)
        lots.reverse_stock_in(db, inventory_id, qty, source_type="purchase",
                              source_ref=_layer_ref(row["po_number"], line["id"]))
        if not tracked:
            costing.reverse_stock_in(db, inventory_id, qty_before=qty_before,
                                     qty_out=qty, unit_cost_out=lot_unit_cost)
        db.execute("UPDATE inventory SET quantity=? WHERE id=?", (qty_after, inventory_id))
        wha.credit_warehouse_stock(db, inventory_id=inventory_id,
                                   warehouse_id=wid, delta=-qty)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, "
            " warehouse_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (inventory_id, "purchase_void", -qty, qty_before, qty_after,
             row["po_number"], "Purchase voided", wid, now))
        db.execute("UPDATE purchase_items SET stock_updated=0 WHERE id=?", (line["id"],))
        undone.append({"product": line["product_name"], "quantity": qty,
                       "unit_cost": lot_unit_cost})
        total += qty

    # The claim is released, so the receipt cannot be credited a second time by
    # a later status change replaying _credit_stock.
    db.execute("UPDATE purchases SET stock_updated=0 WHERE id=?", (purchase_id,))
    return {"restocked": money(total), "lines": undone}


@router.patch("/{purchase_id}/archive")
def archive_purchase(purchase_id: int, user=Depends(require_perm("purchases", "delete")),
                     db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM purchases WHERE id = ? AND archived_at IS NULL", (purchase_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Purchase not found")
    # Void first, then archive. The old rule refused anything Received or Paid,
    # because its stock and its ledger entry were committed — but that also
    # refused a purchase that had been properly voided, which is precisely the
    # one that SHOULD be filed away. Voiding is what releases the stock and
    # reverses the entry; archiving is only what hides the row afterwards.
    if not _col(row, "voided_at"):
        raise HTTPException(
            400,
            "Void this purchase before archiving it. Until it is voided its "
            "goods are on the shelf and its cost is in the ledger, and "
            "archiving would only hide the record of them.")
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
        d["total_cost"] = _doc_total(r)
        result.append(d)
    return result
