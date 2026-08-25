"""
Point of Sale — over-the-counter selling, fully integrated with the rest of the ERP.

Integration model
------------------
Every completed checkout creates a real `invoices` row plus an immediate
`invoice_payments` row, so POS revenue flows automatically into Finance, the
VAT report, reconciliation and aging. A thin `pos_sales` table links the sale
to its register session and holds POS-only fields (cashier, tendered, change).
Financial line data lives in `invoice_items`; `pos_sale_items` records only the
inventory linkage needed to restock on a return.

Atomicity
---------
`checkout` and `return_sale` perform every write on one connection and commit
exactly once at the end. Any HTTPException raised mid-way leaves the
transaction uncommitted, so SQLite discards every write — a stock failure
rolls back the invoice, the payment and any earlier movements.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from routers.finance import _check_period_locked
from utils import _now, _today, notify, get_tax_context, resolve_inclusive_tax, money, validate_int_qty
import costing
import costs
import lots
import accounting
import denomination
import installments
import reservations
import branch_access
from routers.promotions import best_promo_for
import sqlite3

router = APIRouter()


# ── Models ─────────────────────────────────────────────────────────────────
class PosSessionOpen(BaseModel):
    opening_float:     float = 0      # USD float in the drawer at open
    opening_float_lbp: float = 0      # LBP float in the drawer at open
    note: Optional[str] = None
    # The warehouse this register session sells out of. Defaults to the
    # cashier's resolved default warehouse so existing API callers keep
    # working. Every sale during the session deducts stock from this
    # warehouse (see step 12 in `create_sale`).
    warehouse_id: Optional[int] = None


class PosSessionClose(BaseModel):
    closing_count:     float          # USD notes counted at close
    closing_count_lbp: float = 0      # LBP notes counted at close
    note: Optional[str] = None


class PosCartItem(BaseModel):
    name:         str
    inventory_id: Optional[int] = None
    quantity:     float = 1
    unit_price:   float = 0          # VAT-inclusive price per unit
    discount:     float = 0          # markdown amount applied to this line
    tax_rate_id:  Optional[int] = None
    line_type:    str = "product"


class PosInstallmentPlan(BaseModel):
    """A sale the customer takes away today and pays for over time.

    The goods leave at the till — that is what an instalment sale is here — so
    nothing about the stock path changes. What changes is the money: only the
    down payment is taken now, and the rest becomes a receivable with agreed
    due dates behind it.
    """
    down_payment: float = 0
    count:        int                       # instalments AFTER the deposit
    frequency:    str = "monthly"
    start_date:   Optional[str] = None      # first instalment; default next period
    note:         Optional[str] = None


class PosCheckout(BaseModel):
    client_id:       Optional[int] = None
    items:           list[PosCartItem]
    payment_method:  str = "Cash"
    currency:        str = "USD"
    exchange_rate:   Optional[float] = None
    amount_tendered: float = 0
    order_discount:  float = 0       # discount applied to the whole sale
    cash_drawer_id:  Optional[int] = None   # drawer a cash sale belongs to
    # Which bank account a card or transfer settled into. A till takes
    # more than notes, and what is not notes does not belong in the
    # drawer's balance.
    bank_account_id: Optional[int] = None
    idempotency_key: str
    note:            Optional[str] = None
    installment_plan: Optional[PosInstallmentPlan] = None


class PosReturn(BaseModel):
    reason: Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────
def _open_session(db, user_id):
    """The caller's currently-open register session, or None."""
    return db.execute(
        "SELECT * FROM pos_sessions WHERE cashier_id=? AND status='open' "
        "ORDER BY id DESC LIMIT 1",
        (user_id,),
    ).fetchone()


def _pos_invoice_prefix(db) -> str:
    """The POS receipt prefix (keeps POS receipts separable from regular
    invoices in the shared invoice-id sequence)."""
    row = db.execute("SELECT value FROM settings WHERE key='pos_invoice_prefix'").fetchone()
    return row["value"] if row and row["value"] else "POS-"


# ── Register sessions ──────────────────────────────────────────────────────
@router.get("/session/current")
def current_session(
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """The caller's open session plus its running sale count/total, or null."""
    session = _open_session(db, user["id"])
    if not session:
        return None
    s = dict(session)
    agg = db.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(total_usd), 0) AS total "
        "FROM pos_sales WHERE session_id=? AND status='completed'",
        (s["id"],),
    ).fetchone()
    s["sales_count"] = agg["n"]
    s["sales_total"] = round(float(agg["total"]), 2)
    return s


@router.post("/session/open")
def open_session(
    data: PosSessionOpen,
    user=Depends(require_perm("pos", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if _open_session(db, user["id"]):
        raise HTTPException(409, "You already have an open register session.")
    if data.opening_float < 0 or data.opening_float_lbp < 0:
        raise HTTPException(400, "Opening float cannot be negative.")
    # Resolve the warehouse this register sells out of (validates access).
    import warehouse_access as wha
    wid = wha.resolve_warehouse_id(user, db, data.warehouse_id)
    now = _now()
    cur = db.execute(
        "INSERT INTO pos_sessions "
        "(cashier_id, cashier_name, status, opening_float, opening_float_lbp, note, warehouse_id, opened_at) "
        "VALUES (?,?,'open',?,?,?,?,?)",
        (user["id"], user.get("username"), data.opening_float, data.opening_float_lbp,
         data.note, wid, now),
    )
    log_action(db, user, "open", "pos", cur.lastrowid, f"Session #{cur.lastrowid}",
               {"opening_float": data.opening_float, "opening_float_lbp": data.opening_float_lbp,
                "warehouse_id": wid})
    db.commit()
    return {"id": cur.lastrowid, "message": "Register session opened"}


@router.post("/session/close")
def close_session(
    data: PosSessionClose,
    user=Depends(require_perm("pos", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    session = _open_session(db, user["id"])
    if not session:
        raise HTTPException(409, "You have no open register session.")
    if data.closing_count < 0 or (data.closing_count_lbp or 0) < 0:
        raise HTTPException(400, "Counted cash cannot be negative.")

    # Expected drawer = opening float + cash taken in − cash refunded, computed
    # PER CURRENCY (USD and LBP are never summed). Cash-in is attributed to the
    # session that recorded the sale; a refund counts against the session that
    # processed the return. `amount_tendered − change_given` is the net cash
    # kept, in that sale's own currency.
    def _cash_in(currency):
        return float(db.execute(
            "SELECT COALESCE(SUM(amount_tendered - change_given), 0) FROM pos_sales "
            "WHERE session_id=? AND payment_method='Cash' AND paid_currency=?",
            (session["id"], currency),
        ).fetchone()[0])

    def _cash_out(currency):
        return float(db.execute(
            "SELECT COALESCE(SUM(s.amount_tendered - s.change_given), 0) "
            "FROM pos_returns r JOIN pos_sales s ON r.pos_sale_id = s.id "
            "WHERE r.session_id=? AND s.payment_method='Cash' AND s.paid_currency=?",
            (session["id"], currency),
        ).fetchone()[0])

    exp_usd = round(float(session["opening_float"]) + _cash_in("USD") - _cash_out("USD"), 2)
    exp_lbp = round(float(session["opening_float_lbp"] or 0) + _cash_in("LBP") - _cash_out("LBP"), 2)
    var_usd = round(float(data.closing_count) - exp_usd, 2)
    var_lbp = round(float(data.closing_count_lbp or 0) - exp_lbp, 2)
    now = _now()
    db.execute(
        "UPDATE pos_sessions SET status='closed', "
        "closing_count=?, expected_cash=?, variance=?, "
        "closing_count_lbp=?, expected_cash_lbp=?, variance_lbp=?, "
        "note=COALESCE(?, note), closed_at=? WHERE id=?",
        (data.closing_count, exp_usd, var_usd,
         (data.closing_count_lbp or 0), exp_lbp, var_lbp,
         data.note, now, session["id"]),
    )
    log_action(db, user, "close", "pos", session["id"], f"Session #{session['id']}",
               {"expected_usd": exp_usd, "variance_usd": var_usd,
                "expected_lbp": exp_lbp, "variance_lbp": var_lbp})
    db.commit()
    return {
        "message":           "Register session closed",
        "expected_cash":     exp_usd,
        "closing_count":     data.closing_count,
        "variance":          var_usd,
        "expected_cash_lbp": exp_lbp,
        "closing_count_lbp": (data.closing_count_lbp or 0),
        "variance_lbp":      var_lbp,
    }


@router.get("/sessions")
def list_sessions(
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute("SELECT * FROM pos_sessions ORDER BY id DESC LIMIT 100").fetchall()
    return [dict(r) for r in rows]


@router.get("/sessions/{session_id}")
def get_session(
    session_id: int,
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM pos_sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Session not found")
    s = dict(row)
    sales = db.execute(
        "SELECT ps.*, i.invoice_number FROM pos_sales ps "
        "JOIN invoices i ON ps.invoice_id = i.id "
        "WHERE ps.session_id=? ORDER BY ps.id DESC",
        (session_id,),
    ).fetchall()
    s["sales"] = [dict(x) for x in sales]
    return s


# ── Product lookup for the register ────────────────────────────────────────
@router.get("/products")
def search_products(
    search: Optional[str] = None,
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Fast item lookup for the cashier.

    A cashier types the words they can see on the packet, in whatever order
    they come to mind: "blue shirt" for BLUE COTTON SHIRT, "nescafe 200" for
    NESCAFE GOLD 200G. Matching the whole phrase as one string found neither,
    because the words are not adjacent — which is most of what "the search does
    not work" meant.

    So the term is split and every word has to match something: the name, the
    category, the variant, the product it belongs to, or the barcode. Any
    order, any gap between them.

    A scanned barcode is treated apart. When the term is exactly a barcode it
    returns that one item and nothing else, because the register adds a single
    result straight to the cart and a scan must never be ambiguous. Typed
    fragments of a barcode — the digits still legible on a damaged label —
    match as an ordinary word.
    """
    term = (search or "").strip()

    query  = ("SELECT i.id, i.name, i.category, i.quantity, i.unit, i.unit_cost, i.sale_price, "
              "i.price_currency, i.barcode, i.product_id, i.variant_label, "
              "p.name AS product_name "
              "FROM inventory i LEFT JOIN products p ON i.product_id = p.id "
              "WHERE i.archived_at IS NULL")
    params: list = []

    scanned = False
    if term:
        scanned = db.execute(
            "SELECT 1 FROM inventory WHERE barcode = ? AND archived_at IS NULL "
            "LIMIT 1", (term,)).fetchone() is not None
        if scanned:
            query += " AND i.barcode = ?"
            params.append(term)
        else:
            # Every word must match somewhere; which field is not important.
            for word in term.split():
                query += (" AND (i.name LIKE ? OR i.category LIKE ? "
                          "OR i.barcode LIKE ? OR i.variant_label LIKE ? "
                          "OR p.name LIKE ?)")
                like = f"%{word}%"
                params += [like] * 5

    if term and not scanned:
        # Best match first, because Enter acts on the top tile. Something whose
        # name STARTS with what was typed is what the cashier meant far more
        # often than something that merely contains it.
        starts = f"{term}%"
        query += (" ORDER BY (COALESCE(p.name, i.name) LIKE ?) DESC, "
                  "LENGTH(COALESCE(p.name, i.name)), "
                  "COALESCE(p.name, i.name), i.id LIMIT 100")
        params.append(starts)
    else:
        # Browsing. No-barcode items lead the grid: they are the loose,
        # quick-sell goods a cashier cannot scan, so they need to be tap-ready
        # up front. Barcoded items follow, alphabetical within each group.
        query += (" ORDER BY (i.barcode IS NULL OR i.barcode = '') DESC, "
                  "COALESCE(p.name, i.name), i.id LIMIT 100")

    # The register works in PRICE. What an item cost to buy rode along in
    # this response whether or not a column drew it, so a cashier had it
    # one devtools panel away — on the one screen the whole permission
    # exists to keep it off. Checkout re-reads cost from stock server-side,
    # so nothing downstream needs it here.
    return costs.strip([dict(r) for r in db.execute(query, params).fetchall()],
                       user, db)


@router.get("/cash-drawers")
def list_cash_drawers(
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Active cash drawers for the register's drawer picker (no cash permission
    needed — a cashier must be able to choose which till a sale lands in)."""
    try:
        return [dict(r) for r in db.execute(
            "SELECT id, name, auto_capture FROM cash_drawers "
            "WHERE is_active=1 ORDER BY name"
        ).fetchall()]
    except sqlite3.OperationalError:
        return []


# ── Checkout ───────────────────────────────────────────────────────────────
@router.post("/checkout")
def checkout(
    data: PosCheckout,
    user=Depends(require_perm("pos", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Record a complete sale: invoice + line items + payment + real-time stock
    deduction + pos_sale, all in one atomic transaction."""
    # 1. Accounting period must be open.
    _check_period_locked(db, _now()[:7] + "-01")

    # 2. A sale requires an open register session.
    session = _open_session(db, user["id"])
    if not session:
        raise HTTPException(409, "Open a register session before recording a sale.")

    # 3. Validate the cart and the optional customer.
    if not data.items:
        raise HTTPException(400, "Cannot complete a sale with an empty cart.")
    for it in data.items:
        if it.quantity <= 0:
            raise HTTPException(400, f"Quantity for '{it.name}' must be positive.")
        validate_int_qty(it.quantity, f"Quantity for '{it.name}'")
        if it.unit_price < 0:
            raise HTTPException(400, f"Price for '{it.name}' cannot be negative.")
    if data.client_id is not None and not db.execute(
        "SELECT 1 FROM clients WHERE id=?", (data.client_id,)
    ).fetchone():
        raise HTTPException(400, "Client not found")

    # 3a. An instalment sale is credit. Credit needs somebody to extend it to —
    #     an anonymous walk-in leaves a receivable nobody can chase.
    plan = data.installment_plan
    if plan is not None:
        if data.client_id is None:
            raise HTTPException(
                400, "An instalment sale needs a customer: the balance is owed "
                     "by someone.")
        cli = db.execute(
            "SELECT name, COALESCE(allow_installments, 0) AS allowed, "
            "       default_installment_count, default_installment_frequency "
            "FROM clients WHERE id=?", (data.client_id,)).fetchone()
        if cli and not cli["allowed"]:
            raise HTTPException(
                400, f"{cli['name']} is not approved for instalments. "
                     "Enable it on the customer first if that has changed.")
        if plan.count < 1:
            raise HTTPException(400, "A plan needs at least one instalment.")
        if plan.down_payment < 0:
            raise HTTPException(400, "The down payment cannot be negative.")

    # 4. Idempotency — a repeated submit (same key) is rejected before any write.
    if not data.idempotency_key:
        raise HTTPException(400, "An idempotency key is required.")
    if db.execute(
        "SELECT id FROM invoice_payments WHERE idempotency_key=?", (data.idempotency_key,)
    ).fetchone():
        raise HTTPException(409, "This sale was already recorded (duplicate submission).")

    # 5. Currency.
    currency = (data.currency or "USD").upper()
    if currency not in ("USD", "LBP"):
        raise HTTPException(400, "Unsupported payment currency")
    rate = None
    if currency == "LBP":
        if not data.exchange_rate or data.exchange_rate <= 0:
            raise HTTPException(400, "An exchange rate is required for LBP payments.")
        rate = float(data.exchange_rate)

    # 6. Pre-flight stock check — aggregate per item so the same product added
    #    to the cart twice is validated against the combined quantity.
    needed = {}
    for it in data.items:
        if it.inventory_id is not None:
            needed[it.inventory_id] = needed.get(it.inventory_id, 0.0) + float(it.quantity)
    stock_rows = {}
    for inv_id, qty_needed in needed.items():
        row = db.execute(
            "SELECT * FROM inventory WHERE id=? AND archived_at IS NULL", (inv_id,)
        ).fetchone()
        if not row:
            raise HTTPException(400, f"Inventory item #{inv_id} not found.")
        # On hand is not what may be sold. Stock reserved for a customer, or
        # committed to a confirmed production order, is spoken for — and the
        # till used to ignore that entirely, so the factory found out its
        # material had been sold when it went to build.
        #
        # The buyer's OWN reservation is theirs to collect, so it is added
        # back: holding eight for someone and then refusing to sell them eight
        # would be the reservation working against the person it was for.
        sellable = round(
            reservations.available(db, inv_id)
            + reservations.held_for(db, inv_id, data.client_id), 6)
        if round(sellable - qty_needed, 6) < 0:
            raise HTTPException(
                400,
                f"Insufficient stock for '{row['name']}': "
                f"{sellable:g} available, {qty_needed:g} requested."
                + (f" ({float(row['reserved_quantity'] or 0):g} reserved.)"
                   if float(row["reserved_quantity"] or 0) > 0 else ""),
            )
        stock_rows[inv_id] = row

    # 7. Per-line pricing. POS prices are VAT-INCLUSIVE: apply the line
    #    markdown, distribute any order-level discount proportionally, then
    #    EXTRACT the tax from the resulting gross (retail standard).
    ctx = get_tax_context(db)

    # 7a. Automatic promotions (server-authoritative). For each stock-backed
    #     line, find the best live promo and discount its *eligible* units —
    #     respecting the quantity cap, which is shared across lines hitting the
    #     same promo in this one sale. The client only displays these; the cap
    #     and the recorded discount are decided here so "first N units" can't be
    #     over-spent. Promo discount is added on top of any manual markdown.
    today = _now()[:10]
    promo_disc   = [0.0] * len(data.items)   # promo currency-off per line
    promo_id_for = [None] * len(data.items)  # which promo hit each line
    promo_units  = {}                        # promo_id -> eligible units this sale
    _promo_left  = {}                        # promo_id -> remaining cap (None = unlimited)
    for idx, it in enumerate(data.items):
        if it.inventory_id is None:
            continue
        srow  = stock_rows.get(it.inventory_id)
        promo = best_promo_for(db, it.inventory_id, srow["category"] if srow else None, today)
        if not promo:
            continue
        pid = promo["id"]
        if pid not in _promo_left:
            _promo_left[pid] = (None if promo["max_quantity"] is None
                                else max(0, int(promo["max_quantity"]) - int(promo["used_quantity"] or 0)))
        rem   = _promo_left[pid]
        units = int(float(it.quantity))
        eligible = units if rem is None else min(units, rem)
        if eligible <= 0:
            continue
        promo_disc[idx]   = round(eligible * float(it.unit_price) * float(promo["discount_value"]) / 100.0, 4)
        promo_id_for[idx] = pid
        promo_units[pid]  = promo_units.get(pid, 0) + eligible
        if rem is not None:
            _promo_left[pid] = rem - eligible

    gross_after_line = []                       # line gross after its own markdown
    eff_line_disc    = []                        # manual + promo, capped to gross
    for idx, it in enumerate(data.items):
        line_gross = round(float(it.quantity) * float(it.unit_price), 4)
        manual     = round(float(it.discount or 0), 4)
        if manual < 0:
            raise HTTPException(400, f"Discount for '{it.name}' cannot be negative.")
        if manual > line_gross + 0.001:
            raise HTTPException(400, f"Discount for '{it.name}' exceeds the line total.")
        line_disc = min(round(manual + promo_disc[idx], 4), line_gross)
        eff_line_disc.append(line_disc)
        gross_after_line.append(round(line_gross - line_disc, 4))

    order_discount = round(float(data.order_discount or 0), 4)
    if order_discount < 0:
        raise HTTPException(400, "Order discount cannot be negative.")
    gross_sum = round(sum(gross_after_line), 4)
    if order_discount > gross_sum + 0.001:
        raise HTTPException(400, "Order discount exceeds the order total.")

    # Distribute the order discount proportionally; the last line absorbs the
    # rounding remainder so the shares sum to exactly order_discount.
    order_shares = [0.0] * len(data.items)
    if order_discount > 0 and gross_sum > 0:
        acc, last = 0.0, len(data.items) - 1
        for i, g in enumerate(gross_after_line):
            if i == last:
                order_shares[i] = round(order_discount - acc, 4)
            else:
                order_shares[i] = round(order_discount * g / gross_sum, 4)
                acc += order_shares[i]

    lines = []
    subtotal = tax_total = grand_total = cogs_total = discount_total = 0.0
    for idx, it in enumerate(data.items):
        # Cent-rounded gross per line — guarantees the customer-facing total
        # equals SUM(line gross) exactly.
        final_gross = money(gross_after_line[idx] - order_shares[idx])
        if final_gross < 0:
            final_gross = 0.0
        rid, line_rate, tax_amt = resolve_inclusive_tax(ctx, it.tax_rate_id, final_gross)
        net      = money(final_gross - tax_amt)
        qty      = float(it.quantity)
        # Net unit price stays at 6 dp so a unit-priced item can round-trip
        # without losing precision on small qty * unit_price = small total.
        net_unit = round(net / qty, 6) if qty else 0.0
        line_disc_total = money(eff_line_disc[idx] + order_shares[idx])
        unit_cost = (float(stock_rows[it.inventory_id]["unit_cost"] or 0)
                     if it.inventory_id is not None else 0.0)
        lines.append({
            "rid": rid, "rate": line_rate, "tax_amt": tax_amt, "net_unit": net_unit,
            "discount": line_disc_total, "unit_cost": unit_cost,
        })
        subtotal       += net
        tax_total      += tax_amt
        grand_total    += final_gross
        discount_total += line_disc_total
    subtotal       = money(subtotal)
    tax_total      = money(tax_total)
    grand_total    = money(grand_total)
    discount_total = money(discount_total)
    # COGS is computed during the actual stock deduction (step 12) so it can
    # follow the configured costing method (FIFO/LIFO draw from cost layers).
    cogs_total     = 0.0
    cost_method    = costing.get_method(db)
    item_eff_cost  = {}   # inventory_id → effective unit cost for this sale
    if grand_total <= 0:
        raise HTTPException(400, "Sale total must be positive.")
    # On an instalment sale only the deposit is taken at the till; the rest is
    # owed. Everywhere below, `due_now` is what the customer hands over and
    # `grand_total` stays what the sale was worth.
    if plan is not None:
        due_now = money(plan.down_payment)
        if due_now >= grand_total - 0.005:
            raise HTTPException(
                400, "The down payment covers the whole sale. Record it as an "
                     "ordinary sale rather than a plan.")
    else:
        due_now = grand_total
    total_in_currency = due_now if currency == "USD" else round(due_now * rate, 2)

    # 8. Payment must cover the total (the deposit, on an instalment sale).
    method = (data.payment_method or "Cash").strip() or "Cash"
    # A cash sale may be attributed to a specific cash drawer.
    pos_drawer_id = data.cash_drawer_id if method.lower() == "cash" else None
    if pos_drawer_id is not None and not db.execute(
        "SELECT 1 FROM cash_drawers WHERE id=?", (pos_drawer_id,)).fetchone():
        raise HTTPException(400, "Cash drawer not found")
    if method.lower() == "cash":
        if data.amount_tendered + 0.01 < total_in_currency:
            raise HTTPException(400, "Amount tendered is less than the sale total.")
        # Cash offered against a plan with no deposit. Nothing is due at the
        # till, so every note of it comes straight back as change — the sale
        # completes, the balance is untouched, and the customer watches their
        # money returned. That is never what anybody meant: the money belongs
        # in the deposit, where it comes off what they owe.
        if (plan is not None and due_now <= 0.005
                and float(data.amount_tendered or 0) > 0.005):
            raise HTTPException(
                400,
                f"This sale has no deposit, so nothing is collected at the "
                f"till and the {float(data.amount_tendered):,.2f} entered "
                "would be handed straight back. Enter it as the deposit if "
                "the customer is paying some of it now.")
        tendered     = float(data.amount_tendered)
        change_given = round(tendered - total_in_currency, 2)
    else:
        tendered     = total_in_currency       # card etc. — charged exactly
        change_given = 0.0

    now, today = _now(), _today()

    # A till sale to a customer with a currency of their own is billed in it.
    # The prices came off the company's price list, in the company's currency,
    # so the customer's figure is derived from the base one at today's rate —
    # the same way a service job works, and the opposite way round from an
    # operator typing a negotiated price.
    #
    # A walk-in has no currency, so nothing changes for the overwhelming
    # majority of sales.
    doc_currency = None
    if data.client_id is not None:
        _c = db.execute("SELECT preferred_currency FROM clients WHERE id=?",
                        (data.client_id,)).fetchone()
        doc_currency = _c["preferred_currency"] if _c else None
    try:
        inv_currency, inv_rate = denomination.resolve(
            db, doc_currency, on_date=today)
    except denomination.RateUnavailable as e:
        raise HTTPException(400, str(e))
    txn_total    = denomination.to_txn(grand_total, inv_rate)
    txn_subtotal = denomination.to_txn(subtotal, inv_rate)
    txn_tax      = denomination.to_txn(tax_total, inv_rate)

    # 9. Invoice (amount = the VAT-inclusive total the customer pays).
    #    Insert with a placeholder number, then derive the real number from the
    #    new row's id — collision-free under concurrent checkouts (see
    #    routers/invoices.py helpers).
    from routers.invoices import _placeholder_invoice_number, _finalize_invoice_number
    cur = db.execute(
        "INSERT INTO invoices "
        "(invoice_number, client_id, amount, subtotal, tax_total, due_date, notes, created_at, version, branch_id, "
        " currency, exchange_rate, txn_amount, txn_subtotal, txn_tax_total) "
        "VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)",
        (_placeholder_invoice_number(), data.client_id, grand_total, subtotal, tax_total, today,
         data.note or "POS sale", now, session["warehouse_id"],
         inv_currency, inv_rate, txn_total, txn_subtotal, txn_tax),
    )
    invoice_id = cur.lastrowid
    # POS draws from the SAME series as every other invoice now. Its origin is
    # recorded as `pos` instead of being spelled into the number, so the
    # document a customer holds is an invoice like any other and the till sale
    # behind it is still findable.
    #
    # `pos_invoice_prefix` is deliberately no longer consulted. Invoices already
    # issued under it keep their numbers — the number is stored, not derived.
    from routers.invoices import _invoice_prefix
    inv_no = _finalize_invoice_number(db, invoice_id, _invoice_prefix(db),
                                      "pos", f"POS-{invoice_id}")

    # 10. Invoice line items — normalised to the exclusive form (unit_price =
    #     post-discount NET unit price) so every existing invoice / VAT /
    #     finance reader stays correct without modification.
    invoice_item_ids = []
    for idx, it in enumerate(data.items):
        ln = lines[idx]
        ic = db.execute(
            "INSERT INTO invoice_items "
            "(invoice_id, name, quantity, unit_price, tax_rate_id, tax_rate, tax_amount, discount, "
            " txn_unit_price, txn_tax_amount) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (invoice_id, it.name, it.quantity, ln["net_unit"],
             ln["rid"], ln["rate"], ln["tax_amt"], ln["discount"],
             denomination.to_txn(ln["net_unit"], inv_rate),
             denomination.to_txn(ln["tax_amt"], inv_rate)),
        )
        invoice_item_ids.append(ic.lastrowid)

    # 10a. On an instalment sale the balance is a claim on the customer, so the
    #      invoice carries a receivable exactly as an ordinary credit invoice
    #      does. This is what makes the deposit — and every instalment after it
    #      — post through the normal payment path instead of the till's
    #      settled-in-full shortcut. No new accounts, no new posting shapes.
    if plan is not None:
        accounting.post_receivable(
            db, invoice_id, invoice_number=inv_no, amount=grand_total,
            entry_date=now[:10], created_by=user["id"],
            branch_id=session["warehouse_id"])

    # 11. Payment — the whole sale at the till, or the deposit on a plan.
    payment_id = None
    if due_now > 0.005:
        pay_cur = db.execute(
            "INSERT INTO invoice_payments "
            "(invoice_id, amount, method, note, paid_at, idempotency_key, "
            " paid_currency, paid_amount, exchange_rate, cash_drawer_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (invoice_id, due_now, method,
             "POS deposit" if plan is not None else "POS sale",
             now, data.idempotency_key,
             currency, total_in_currency, rate, pos_drawer_id),
        )
        payment_id = pay_cur.lastrowid

    # 11a. Auto-post the sale to the General Ledger (F-1 audit fix).
    # Cash sale recognition (cash-basis):
    #   DR  Cash & Bank / Cash — LBP        grand_total (USD-equivalent)
    #     CR  Sales Revenue                            grand_total
    # The cash account is selected by the tendered currency so LBP cash
    # accumulates on its own ledger line (IAS 21 — monetary item in a non-
    # functional currency stays separate so it can be revalued).
    # Idempotent by (source_type, source_id) — a re-run of POS checkout would
    # only ever happen via the idempotency key on the payment, but belt-and-
    # braces: accounting.post_entry already de-dups on the same key.
    #
    # An instalment sale takes the receivable branch instead: `payment_lines`
    # sees the receivable posted above and turns the deposit into cash against
    # the claim, earning only the part of the revenue that was actually
    # received. The rest stays in deferred until the customer pays it.
    if payment_id is not None:
        # A card or transfer at the till is not cash in the drawer.
        cash_code = accounting.money_account_for(
            db, method=method, currency=currency,
            bank_account_id=data.bank_account_id)
        lines_for_payment = (
            accounting.payment_lines(
                db, invoice_id, cash_code=cash_code, amount=due_now,
                method_memo=f"{method} ({currency})")
            if plan is not None else
            [{"code": cash_code, "debit": grand_total,
              "memo": f"{method} ({currency})"},
             {"code": accounting.code(db, "revenue"), "credit": grand_total}]
        )
        accounting.post_entry(
            db,
            entry_date=now[:10],
            memo=(f"POS deposit — {inv_no}" if plan is not None
                  else f"POS sale — {inv_no}"),
            lines=lines_for_payment,
            source_type="invoice_payment", source_id=payment_id,
            created_by=user["id"],
            branch_id=session["warehouse_id"],
        )

    # 12. Real-time stock deduction. COGS for each item is drawn here so it
    #     honours the costing method (FIFO/LIFO from cost layers; weighted
    #     average values at the item's moving unit cost). The deduction comes
    #     out of the POS session's warehouse (defaults to MAIN for sessions
    #     opened before warehouses existed).
    import warehouse_access as wha
    # `session` is a sqlite3.Row — access via subscript, falling back to None
    # so the helper resolves the company default.
    sess_wid = None
    try:
        sess_wid = session["warehouse_id"]
    except (IndexError, KeyError):
        pass
    pos_wid = wha.default_warehouse_id_for_row(db, sess_wid)
    for inv_id, qty_needed in needed.items():
        row        = stock_rows[inv_id]
        qty_before = float(row["quantity"])
        qty_after  = round(qty_before - qty_needed, 6)
        if qty_after < 0:                       # defensive — pre-flight already checked
            raise HTTPException(400, f"Insufficient stock for '{row['name']}'.")
        line_cogs = lots.value_stock_out(db, inv_id, qty_needed,
                                         source_type="sale", source_ref=inv_no, now=now)
        cogs_total += line_cogs
        item_eff_cost[inv_id] = round(line_cogs / qty_needed, 6) if qty_needed else 0.0
        db.execute("UPDATE inventory SET quantity=? WHERE id=?", (qty_after, inv_id))
        wha.credit_warehouse_stock(db, inventory_id=inv_id,
                                   warehouse_id=pos_wid, delta=-qty_needed)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (inv_id, "sale", -qty_needed, qty_before, qty_after, inv_no, "POS sale", pos_wid, now),
        )
        min_stock = float(row["min_stock"] or 0)
        if min_stock > 0 and qty_after <= min_stock:
            notify(db, type="low_stock",
                   title=f"Low stock alert: {row['name']}",
                   body=f"Only {qty_after} {row['unit'] or 'units'} remaining (minimum: {min_stock})",
                   msg="low_stock", params={"name": row["name"], "qty": qty_after,
                                            "unit": row["unit"] or "units", "min": min_stock},
                   link="/inventory", entity_type="inventory", entity_id=inv_id,
                   dedup_hours=24)

    cogs_total = money(cogs_total)

    # 12a. Relieve inventory and recognise COGS for the goods that just left
    # the warehouse (F-2 audit fix — perpetual inventory model):
    #   DR  Cost of Goods Sold                  cogs_total
    #     CR  Inventory                                  cogs_total
    # `cogs_total` was already computed at FIFO/LIFO/weighted-avg layer cost in
    # step 12; we just need to mirror the physical movement in the GL.
    # Service-only sales (no stock-backed lines) have cogs_total == 0 and we
    # skip the posting — accounting.post_entry would reject an all-zero entry.
    if cogs_total > 0:
        accounting.post_entry(
            db,
            entry_date=now[:10],
            memo=f"POS COGS — {inv_no}",
            lines=[
                {"code": accounting.code(db, "cogs"),      "debit":  cogs_total},
                {"code": accounting.code(db, "inventory"), "credit": cogs_total},
            ],
            source_type="pos_cogs", source_id=invoice_id, created_by=user["id"],
            branch_id=session["warehouse_id"],
        )

    # 12b. The customer collecting stock held for them consumes that hold.
    #      Without this the goods leave and the reservation stays behind, so
    #      the item is permanently short by whatever was collected. Draws only
    #      from THIS customer's holds, oldest first; anyone else's are never
    #      touched, and buying more than was reserved simply takes the surplus
    #      from free stock.
    if data.client_id is not None:
        for inv_id, qty in needed.items():
            reservations.consume(db, inventory_id=inv_id,
                                 client_id=data.client_id, quantity=qty,
                                 closed_by=user["id"])

    # 13. POS sale record (carries the sale's discount + cost-of-goods-sold).
    ps = db.execute(
        "INSERT INTO pos_sales "
        "(session_id, invoice_id, cashier_id, cashier_name, payment_method, paid_currency, "
        " amount_tendered, change_given, total_usd, discount_total, cogs_total, "
        " bank_account_id, status, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'completed', ?)",
        (session["id"], invoice_id, user["id"], user.get("username"), method, currency,
         tendered, change_given, grand_total, discount_total, cogs_total,
         data.bank_account_id, now),
    )
    pos_sale_id = ps.lastrowid

    # 14. POS sale items — the receipt-native view: VAT-inclusive unit price,
    #     the discount applied, and the unit-cost snapshot used for COGS.
    for idx, it in enumerate(data.items):
        ln = lines[idx]
        line_type = "product" if it.inventory_id is not None else "service"
        # Store the effective unit cost actually used for COGS (FIFO/LIFO layers
        # may value it differently from the moving average). Falls back to the
        # average snapshot for service lines and any item not deducted.
        line_unit_cost = (item_eff_cost.get(it.inventory_id, ln["unit_cost"])
                          if it.inventory_id is not None else ln["unit_cost"])
        db.execute(
            "INSERT INTO pos_sale_items "
            "(pos_sale_id, invoice_item_id, inventory_id, name, quantity, unit_price, "
            " line_type, discount, unit_cost, promotion_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (pos_sale_id, invoice_item_ids[idx], it.inventory_id, it.name,
             it.quantity, it.unit_price, line_type, ln["discount"], line_unit_cost,
             promo_id_for[idx]),
        )

    # 14a. Record promotion usage so the quantity cap holds across sales. Done
    #      in the same transaction as the sale, so a rolled-back checkout never
    #      consumes cap.
    for pid, used in promo_units.items():
        db.execute("UPDATE promotions SET used_quantity = used_quantity + ? WHERE id = ?",
                   (used, pid))

    # 14b. The agreed schedule, written through the same engine the invoice
    #      screen uses — one plan model, so arrears reporting, the customer
    #      statement and the plan view all read a POS plan without knowing it
    #      came from a till.
    plan_rows = []
    if plan is not None:
        try:
            plan_rows = installments.build_schedule(
                grand_total, plan.count,
                plan.start_date or today,
                frequency=plan.frequency,
                first_amount=due_now if due_now > 0.005 else None)
        except ValueError as e:
            raise HTTPException(400, str(e))
        for seq, due, amount in plan_rows:
            db.execute(
                "INSERT INTO invoice_installments "
                "(invoice_id, seq, due_date, amount, note, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (invoice_id, seq, due, amount, plan.note, now))
        # The invoice's own due date becomes the final instalment, so anything
        # still reading a single date says the plan ends then rather than
        # claiming the whole balance was due the day it was sold.
        db.execute("UPDATE invoices SET due_date=? WHERE id=?",
                   (plan_rows[-1][1], invoice_id))

    # 15. Audit + single commit.
    log_action(db, user, "create", "pos", pos_sale_id, inv_no,
               {"total": grand_total, "method": method, "currency": currency,
                **({"plan": len(plan_rows), "deposit": due_now}
                   if plan is not None else {})})
    db.commit()
    return {
        "id":             pos_sale_id,
        "invoice_id":     invoice_id,
        "invoice_number": inv_no,
        "subtotal":       subtotal,
        "tax_total":      tax_total,
        "discount_total": discount_total,
        "cogs_total":     cogs_total,
        "total":          grand_total,
        "paid_now":       due_now,
        "balance":        money(grand_total - due_now),
        "change_given":   change_given,
        "payment_status": "Paid" if plan is None else "Partial",
        "installments":   [{"seq": s, "due_date": str(d), "amount": a}
                           for s, d, a in plan_rows],
        "message":        "Sale completed" if plan is None
                          else "Sale completed on a payment plan",
    }


# ── Sales history ──────────────────────────────────────────────────────────
@router.get("/sales")
def list_sales(
    session_id: Optional[int] = None,
    status:     Optional[str] = None,
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    # `amount_paid` comes from the invoice, not from pos_sales: an instalment
    # sale keeps being paid long after the till closed, so the row's own
    # tendered figure stops being the answer the moment the customer pays
    # again. Without this the history calls every sale Paid, including ones
    # still carrying a balance.
    query  = ("SELECT ps.*, i.invoice_number, c.name AS client_name, "
              "       COALESCE(("
              "         SELECT SUM(p.amount) FROM invoice_payments p "
              "         WHERE p.invoice_id = i.id), 0) AS amount_paid "
              "FROM pos_sales ps "
              "JOIN invoices i ON ps.invoice_id = i.id "
              "LEFT JOIN clients c ON i.client_id = c.id WHERE 1=1")
    params = []
    if session_id is not None:
        query += " AND ps.session_id=?"
        params.append(session_id)
    if status:
        query += " AND ps.status=?"
        params.append(status)
    # Branch scoping: a POS sale's branch is its invoice's branch.
    bf, bp = branch_access.branch_filter(user, db, column="i.branch_id")
    query += bf; params += bp
    query += " ORDER BY ps.id DESC LIMIT 200"

    rows = []
    for r in db.execute(query, params).fetchall():
        d = dict(r)
        d["balance"] = money((d.get("total_usd") or 0) - (d.get("amount_paid") or 0))
        d["payment_status"] = (
            "Returned" if d.get("status") == "returned"
            else "Paid" if d["balance"] <= 0.005
            else "Partial" if (d.get("amount_paid") or 0) > 0.005
            else "Unpaid")
        rows.append(d)
    return rows


@router.get("/sales/{sale_id}")
def get_sale(
    sale_id: int,
    user=Depends(require_perm("pos", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT ps.*, i.invoice_number, i.amount, i.subtotal, i.tax_total, "
        "       i.voided_at, i.branch_id, c.name AS client_name "
        "FROM pos_sales ps "
        "JOIN invoices i ON ps.invoice_id = i.id "
        "LEFT JOIN clients c ON i.client_id = c.id "
        "WHERE ps.id=?",
        (sale_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Sale not found")
    branch_access.assert_can_view_branch(user, db, row["branch_id"])
    d = dict(row)
    # POS-native line view: VAT-inclusive unit price, discount and cost.
    d["items"] = [dict(x) for x in db.execute(
        "SELECT * FROM pos_sale_items WHERE pos_sale_id=? ORDER BY id", (sale_id,)
    ).fetchall()]
    payment = db.execute(
        "SELECT * FROM invoice_payments WHERE invoice_id=? ORDER BY id LIMIT 1",
        (d["invoice_id"],),
    ).fetchone()
    d["payment"] = dict(payment) if payment else None
    # Margin = net (ex-VAT) revenue − cost of goods sold.
    d["margin"] = round(float(d["subtotal"] or 0) - float(d["cogs_total"] or 0), 2)
    return d


# ── Return / refund ────────────────────────────────────────────────────────
@router.post("/sales/{sale_id}/return")
def return_sale(
    sale_id: int,
    data: PosReturn,
    user=Depends(require_perm("pos", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Full return: void the sale's invoice, restock every inventory-backed
    line, and record a pos_returns row — all in one atomic transaction."""
    sale = db.execute("SELECT * FROM pos_sales WHERE id=?", (sale_id,)).fetchone()
    if not sale:
        raise HTTPException(404, "Sale not found")
    if sale["status"] == "returned":
        raise HTTPException(400, "This sale has already been returned.")

    session = _open_session(db, user["id"])
    if not session:
        raise HTTPException(409, "Open a register session before processing a return.")

    inv = db.execute("SELECT * FROM invoices WHERE id=?", (sale["invoice_id"],)).fetchone()
    if not inv:
        raise HTTPException(404, "Linked invoice not found")
    if inv["voided_at"]:
        raise HTTPException(400, "The linked invoice is already voided.")

    # The original sale's accounting period must still be open.
    _check_period_locked(db, str(sale["created_at"])[:7] + "-01")

    now = _now()

    # Void the invoice (keeps the payment row for audit; finance/VAT exclude voids).
    db.execute(
        "UPDATE invoices SET voided_at=?, void_reason=?, version=version+1 WHERE id=?",
        (now, f"POS return: {data.reason or 'Customer return'}", inv["id"]),
    )

    # Walk the general ledger back with the void (mirrors PATCH /invoices/{id}/void,
    # which this raw UPDATE bypasses). The payment reversal credits the cash back
    # out — that IS the refund leaving the till — and removes the revenue; the
    # COGS reversal returns the goods' value to Inventory, matching the physical
    # restock below. reverse_source is a no-op for anything already reversed.
    for pay in db.execute(
        "SELECT id FROM invoice_payments WHERE invoice_id=?", (inv["id"],)
    ).fetchall():
        accounting.reverse_source(db, "invoice_payment", pay["id"],
                                  memo=f"POS return — {inv['invoice_number']}",
                                  created_by=user["id"])
    accounting.reverse_source(db, "pos_cogs", inv["id"],
                              memo=f"POS return COGS — {inv['invoice_number']}",
                              created_by=user["id"])
    # An instalment sale also raised a receivable. Left standing, the books
    # would keep a claim on a customer who has handed the goods back, and the
    # deferred revenue behind it would never clear. A no-op on an ordinary
    # till sale, which never had one.
    accounting.reverse_source(db, "invoice", inv["id"],
                              memo=f"POS return — {inv['invoice_number']}",
                              created_by=user["id"])
    # The agreed schedule goes with it: the arrears sweep walks unpaid
    # instalments by date and would chase a returned sale every month. The
    # void is the record that this happened; the schedule is not.
    db.execute("DELETE FROM invoice_installments WHERE invoice_id=?", (inv["id"],))

    # Restock every inventory-backed line, returning the goods to the same
    # warehouse the original sale was deducted from (the session's warehouse).
    import warehouse_access as wha
    ret_sess_wid = None
    try:
        ret_sess_wid = session["warehouse_id"]
    except (IndexError, KeyError):
        pass
    return_wid = wha.default_warehouse_id_for_row(db, ret_sess_wid)
    for it in db.execute(
        "SELECT * FROM pos_sale_items WHERE pos_sale_id=? AND inventory_id IS NOT NULL",
        (sale_id,),
    ).fetchall():
        row = db.execute("SELECT * FROM inventory WHERE id=?", (it["inventory_id"],)).fetchone()
        if not row:
            continue
        qty_before = float(row["quantity"])
        qty_after  = round(qty_before + float(it["quantity"]), 6)
        db.execute("UPDATE inventory SET quantity=? WHERE id=?", (qty_after, it["inventory_id"]))
        wha.credit_warehouse_stock(db, inventory_id=it["inventory_id"],
                                   warehouse_id=return_wid, delta=float(it["quantity"]))
        # Put the returned stock back as a new lot / cost layer at the price it
        # left at (the COGS snapshot on the sale line).
        lots.record_stock_in(db, it["inventory_id"], float(it["quantity"]),
                             it["unit_cost"] or 0, source_type="return",
                             source_ref=inv["invoice_number"], now=now)
        db.execute(
            "INSERT INTO stock_movements "
            "(inventory_id, type, delta, qty_before, qty_after, reference, note, warehouse_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (it["inventory_id"], "return", float(it["quantity"]), qty_before, qty_after,
             inv["invoice_number"], "POS return", return_wid, now),
        )
        # Hand the promo's quantity-cap allowance back when a discounted line is
        # returned, so the campaign reflects reality (clamped at 0).
        if it["promotion_id"]:
            db.execute(
                "UPDATE promotions SET used_quantity = MAX(0, used_quantity - ?) WHERE id = ?",
                (int(float(it["quantity"])), it["promotion_id"]),
            )

    refund_amount = float(sale["total_usd"])
    db.execute(
        "INSERT INTO pos_returns "
        "(pos_sale_id, session_id, invoice_id, cashier_id, refund_amount, reason, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (sale_id, session["id"], inv["id"], user["id"], refund_amount, data.reason, now),
    )
    db.execute("UPDATE pos_sales SET status='returned', returned_at=? WHERE id=?", (now, sale_id))

    log_action(db, user, "return", "pos", sale_id, inv["invoice_number"],
               {"refund_amount": refund_amount, "reason": data.reason})
    db.commit()
    return {"message": "Sale returned", "refund_amount": refund_amount}
