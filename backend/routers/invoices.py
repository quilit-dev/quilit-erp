"""
Invoices — the financial document where payments are recorded.

Financial safety rules enforced here:
  • Once any payment is recorded, invoice amount and line items are LOCKED
    (only metadata — due_date, notes, client, project — can be edited).
  • Invoices with payments cannot be deleted; use PATCH /{id}/void instead.
  • Voided invoices are excluded from all financial totals but kept for audit.
  • Optimistic locking: every PUT includes the current version; a concurrent
    edit returns 409 Conflict so the user is told to refresh.
  • Payment idempotency: the frontend sends a UUID per submit; the server
    rejects exact duplicates (same key), preventing double-click double charges.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from routers.promotions import apply_promotions_to_lines
from routers.finance import _check_period_locked
from routers.projects import bump_project_status
from approval_engine import evaluate_and_apply
from utils import _now, _today, get_tax_context, resolve_line_tax, money, notify
import accounting
import currency as currency_mod
import denomination
import branch_access
import line_items
import installments
import sqlite3
import uuid
from datetime import datetime, timedelta

router = APIRouter()

def _payment_total(db, invoice_id: int) -> float:
    row = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM invoice_payments WHERE invoice_id = ?",
        (invoice_id,),
    ).fetchone()
    return float(row["total"])

def _derive_status(amount: float, total_paid: float, voided_at=None) -> str:
    if voided_at:
        return "Void"
    if total_paid <= 0:
        return "Unpaid"
    if total_paid >= amount - 0.001:
        return "Paid"
    return "Partial"

def _is_overdue(due_date: Optional[str], payment_status: str) -> bool:
    if payment_status in ("Paid", "Void") or not due_date:
        return False
    return due_date < _today()

# ── Pydantic models ───────────────────────────────────────────────────────
class InvoiceItemCreate(BaseModel):
    name:        str
    quantity:    float = 1
    unit_price:  float = 0
    # Per-line discount in functional currency. Optional — defaults to 0
    # for callers (and customers) that don't use line discounts. The pricing
    # engine subtracts it from the net before computing tax.
    discount:    float = 0
    # Which stock item this line came from, when it was picked rather than
    # typed. Carries the promotion lookup — matching on `name` instead would
    # silently misprice the moment an item is renamed.
    inventory_id: Optional[int] = None
    # True when `discount` was NOT set by a human — the form left it to the
    # promotion. The server then derives the amount itself and snapshots which
    # promotion produced it.
    #
    # This flag exists so an explicit zero is possible. Without it the server
    # cannot tell "no discount typed" from "deliberately zero", and a customer
    # who was told they get no discount would silently receive the promotion
    # anyway. Defaults True so older callers keep the previous behaviour.
    # Optional[bool] rather than bool: a client that sends an explicit null
    # (the mobile app serialising an absent value) should mean "not set",
    # not fail validation on a field it never knew about.
    discount_auto: Optional[bool] = True
    # The percentage the operator typed, when they typed one. `discount` stays
    # the authoritative MONEY figure — the ledger and every issued document
    # depend on it — and is computed from this when it is present.
    #
    # None means "the amount was given directly": every line written before this
    # existed is in that state, and those documents must keep their exact money
    # rather than have it recomputed from a derived percentage.
    discount_pct: Optional[float] = None
    tax_rate_id: Optional[int] = None

class InvoiceCreate(BaseModel):
    quotation_id: Optional[int]  = None
    project_id:   Optional[int]  = None
    client_id:    Optional[int]  = None
    amount:       float          = 0
    due_date:     Optional[str]  = None
    notes:        Optional[str]  = None
    items:        Optional[list[InvoiceItemCreate]] = None
    version:      Optional[int]  = None   # required on PUT for optimistic locking
    branch_id:    Optional[int]  = None   # branch == warehouse; resolved on create
    # The currency the deal was struck in. Omitted, the customer's own is used;
    # omitted with no customer preference, the company's. `exchange_rate` is a
    # negotiated rate — given, it is stored as given rather than replaced by
    # the table's figure.
    currency:      Optional[str]   = None
    exchange_rate: Optional[float] = None

class PaymentCreate(BaseModel):
    amount:           float                   # value tendered, expressed in `currency`
    currency:         str   = "USD"           # 'USD' or 'LBP'
    exchange_rate:    Optional[float] = None  # LBP per USD — required when currency='LBP'
    method:           Optional[str] = "Cash"
    note:             Optional[str] = None
    cash_drawer_id:   Optional[int] = None    # which cash drawer received a cash payment
    idempotency_key:  str   # UUID required — generated by client via crypto.randomUUID()

class VoidRequest(BaseModel):
    reason: Optional[str] = "Voided"

# ── Helpers ───────────────────────────────────────────────────────────────
# Invoice numbers are derived from the row's own AUTOINCREMENT id, NOT from
# MAX(id)+1. The old MAX(id)+1 scheme read the current max and wrote a number
# in two non-atomic steps, so two concurrent creates could compute the SAME
# number and collide on the UNIQUE invoice_number constraint (one create then
# failed). Reserving the row first hands us an id that is unique by construction
# and never reused under AUTOINCREMENT, so the derived number is collision-free
# without any locking.
def _placeholder_invoice_number() -> str:
    """A guaranteed-unique temporary value to satisfy UNIQUE/NOT NULL for the
    instant between INSERT and the UPDATE that sets the real number."""
    return f"__pending__{uuid.uuid4().hex}"

def _invoice_prefix(db) -> str:
    from utils import get_setting
    # Empty or unset → default "INV-" (preserves prior behavior exactly).
    return get_setting(db, "invoice_prefix") or "INV-"

def _finalize_invoice_number(db, invoice_id: int, prefix: str,
                             source_type: str = None, source_reference: str = None) -> str:
    """Set the real, collision-free number on a freshly-inserted invoice row.
    Call right after the INSERT (before commit). Returns the number assigned.

    The sequence has always been the row id, so sales, POS, service and project
    invoices never collided — they only wore different prefixes. Origin now
    lives in `source_type` / `source_reference` instead, which is what lets one
    number series run across all of them while a POS sale stays identifiable.

    Six digits rather than four. Invoices already issued keep the number they
    were issued under: the number is stored, not derived at read time, so
    widening it changes nothing that has already been printed.
    """
    inv_no = f"{prefix}{datetime.utcnow().year}-{invoice_id:06d}"
    db.execute(
        "UPDATE invoices SET invoice_number=?, source_type=COALESCE(?, source_type), "
        " source_reference=COALESCE(?, source_reference) WHERE id=?",
        (inv_no, source_type, source_reference, invoice_id))
    return inv_no

def _apply_pending(row: dict) -> None:
    """An invoice awaiting approval is a draft: surface 'Pending Approval' as its
    display status and keep it off the overdue radar until it clears."""
    if row.get("approval_status") == "Pending Approval":
        row["payment_status"] = "Pending Approval"
        row["is_overdue"]     = False

def _enrich(row: dict, db) -> dict:
    total_paid = _payment_total(db, row["id"])
    amount     = float(row["amount"])
    row["total_paid"]     = money(total_paid)
    row["remaining"]      = money(amount - total_paid)
    row["payment_status"] = _derive_status(amount, total_paid, row.get("voided_at"))
    row["is_overdue"]     = _is_overdue(row.get("due_date"), row["payment_status"])
    _apply_pending(row)
    return row

def _table_exists(db, name):
    row = db.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row[0] > 0

def _ensure_invoice_items_table(db):
    db.execute("""
        CREATE TABLE IF NOT EXISTS invoice_items (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            name       TEXT    NOT NULL,
            quantity   REAL    NOT NULL DEFAULT 1,
            unit_price REAL    NOT NULL DEFAULT 0,
            discount   REAL    NOT NULL DEFAULT 0
        )
    """)
    db.commit()

def _has_payments(db, invoice_id: int) -> bool:
    row = db.execute(
        "SELECT COUNT(*) FROM invoice_payments WHERE invoice_id = ?", (invoice_id,)
    ).fetchone()
    return row[0] > 0

def _in_base(item, fx_rate):
    """One line restated in the base currency.

    A copy, never a mutation: `items` is what the customer agreed and is
    written to the document as such. Only unit price and any cash discount
    convert — quantities, tax rates and ids are currency-free.
    """
    from types import SimpleNamespace
    fields = {k: getattr(item, k, None) for k in
              ("name", "quantity", "unit_price", "discount", "discount_pct",
               "tax_rate_id", "inventory_id", "revenue_account")}
    fields["unit_price"] = denomination.to_base(fields.get("unit_price") or 0, fx_rate)
    if fields.get("discount"):
        fields["discount"] = denomination.to_base(fields["discount"], fx_rate)
    return SimpleNamespace(**fields)


def _price_items(db, items, fallback_amount, client_id=None):
    """Roll up invoice line totals with per-line tax AND per-line discount.

    Per-line net is computed as `qty * unit_price - discount`, floored at 0.
    Tax is then computed on the discounted net (which matches how the rest of
    the world prices a discounted invoice — tax follows the customer's actual
    consideration, not the pre-discount sticker price). An itemless invoice
    treats `fallback_amount` as the net and applies the default rate.

    Returns (subtotal, tax_total, grand_total, line_tax) where line_tax is a
    list parallel to `items` of (tax_rate_id, tax_rate, tax_amount).
    """
    # The customer decides whether VAT applies at all: one registered as
    # exempt is charged none, whatever the line rates say.
    ctx = get_tax_context(db, client_id)
    line_tax = []
    if items:
        subtotal = tax_total = 0.0
        for it in items:
            qty   = float(getattr(it, "quantity", 0) or 0)
            price = float(getattr(it, "unit_price", 0) or 0)
            disc  = float(getattr(it, "discount", 0) or 0)
            # Per-line net at cents (after discount), tax is cent-rounded by
            # the helper. max(0,...) keeps an over-large discount from
            # producing a negative line that would distort the rollup.
            net = money(max(0.0, qty * price - disc))
            rid, rate, tax_amt = resolve_line_tax(ctx, it.tax_rate_id, net)
            subtotal  += net
            tax_total += tax_amt
            line_tax.append((rid, rate, tax_amt))
        # Header rollups are simple sums of cent-rounded lines, so they
        # always reconcile exactly with SUM(line.tax_amount).
        subtotal, tax_total = money(subtotal), money(tax_total)
    else:
        subtotal = money(fallback_amount or 0)
        _, _, tax_total = resolve_line_tax(ctx, None, subtotal)
    return subtotal, tax_total, money(subtotal + tax_total), line_tax


# ── List ──────────────────────────────────────────────────────────────────
@router.get("/")
def list_invoices(
    status: Optional[str] = None,
    include_archived: bool = False,
    branch_id: Optional[int] = None,
    limit: Optional[int] = None,
    offset: int = 0,
    search: Optional[str] = None,
    client_id: Optional[int] = None,
    project_id: Optional[int] = None,
    sort: Optional[str] = None,
    dir: str = "asc",
    user=Depends(require_perm("invoices", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """List invoices.

    Backward-compatible pagination: with no `limit` the response is the full
    array exactly as before (the current UI and the finance aggregators rely on
    that). Pass `limit` (capped at 500) to get a `{items, total, limit, offset}`
    envelope instead — for scale-aware / programmatic consumers.
    """
    # `include_archived=1` returns archived invoices too (for the in-module
    # "Show archived" filter); the default view still hides them.
    conditions, params = [], []
    if not include_archived:
        conditions.append("i.archived_at IS NULL")
    # Branch scoping: restricted users see only their branches; admins may pass
    # branch_id to focus one branch, or omit it to see all.
    bf, bp = branch_access.branch_filter(user, db, column="i.branch_id", selected=branch_id)
    if bf:
        conditions.append(bf[len(" AND "):])   # branch_filter returns a leading " AND "
        params += bp
    # Free-text search, server-side. The same five fields the list screen used
    # to match in the browser — which it could only do because it had already
    # downloaded every invoice. Doing it here is what lets that screen stop.
    if search and search.strip():
        like = f"%{search.strip()}%"
        conditions.append(
            "(i.invoice_number LIKE ? OR q.quote_number LIKE ? OR c.name LIKE ?"
            " OR p.name LIKE ? OR i.notes LIKE ?)"
        )
        params += [like] * 5
    if client_id is not None:
        conditions.append("i.client_id = ?")
        params.append(client_id)
    if project_id is not None:
        conditions.append("i.project_id = ?")
        params.append(project_id)
    where_clause = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    select_sql = f"""SELECT i.*,
                  p.name AS project_name,
                  c.name AS client_name, c.phone AS client_phone,
                  q.quote_number,
                  COALESCE((SELECT SUM(ip.amount)
                            FROM invoice_payments ip
                            WHERE ip.invoice_id = i.id), 0) AS total_paid
           FROM invoices i
           LEFT JOIN projects   p ON i.project_id   = p.id
           LEFT JOIN clients    c ON i.client_id    = c.id
           LEFT JOIN quotations q ON i.quotation_id = q.id
           {where_clause}
           ORDER BY {{order_by}}"""

    # Sorting, from a fixed allow-list. `sort` reaches ORDER BY, which takes no
    # bind parameters, so nothing but a value from this map may ever be
    # interpolated. `payment_status` is absent on purpose: it is derived after
    # the query, so it is handled by the slower path below rather than faked
    # here.
    _SORTABLE = {
        "invoice_number": "i.invoice_number",
        "quote_number":   "q.quote_number",
        "client_name":    "c.name",
        "project_name":   "p.name",
        "amount":         "i.amount",
        "due_date":       "i.due_date",
        "created_at":     "i.created_at",
        "total_paid":     "total_paid",
        "remaining":      "(i.amount - total_paid)",
    }
    _direction = "DESC" if str(dir).lower() == "desc" else "ASC"
    order_by = (f"{_SORTABLE[sort]} {_direction}"
                if sort in _SORTABLE else "i.created_at DESC")
    select_sql = select_sql.format(order_by=order_by)
    # A derived sort key cannot be expressed in SQL, so it takes the same
    # fetch-derive-slice route as the derived `status` filter.
    _derived_sort = sort == "payment_status"

    def _derive(r):
        d          = dict(r)
        total_paid = float(d["total_paid"])
        d["total_paid"]     = round(total_paid, 4)
        d["remaining"]      = round(float(d["amount"]) - total_paid, 4)
        d["payment_status"] = _derive_status(float(d["amount"]), total_paid, d.get("voided_at"))
        d["is_overdue"]     = _is_overdue(d.get("due_date"), d["payment_status"])
        _apply_pending(d)
        return d

    # Fast path: no `status` filter and no derived sort key means the row set
    # and ordering are both plain SQL, so pagination pushes straight down to the
    # database (no full-table load).
    if limit is not None and not status and not _derived_sort:
        cap   = max(1, min(limit, 500))
        # Same JOINs as the row query: the search predicate reaches into
        # clients/projects/quotations, so a bare COUNT over `invoices` alone
        # would fail to resolve those columns.
        total = db.execute(
            f"""SELECT COUNT(*) FROM invoices i
                LEFT JOIN projects   p ON i.project_id   = p.id
                LEFT JOIN clients    c ON i.client_id    = c.id
                LEFT JOIN quotations q ON i.quotation_id = q.id
                {where_clause}""", params
        ).fetchone()[0]
        rows = db.execute(select_sql + " LIMIT ? OFFSET ?", params + [cap, offset]).fetchall()
        return {"items": [_derive(r) for r in rows], "total": total,
                "limit": cap, "offset": offset}

    # `status` (Overdue / Void / a payment state) is derived AFTER the query, so
    # it can't be a SQL predicate — fetch, derive, then filter. When paginating,
    # slice the filtered set so `total` is the true post-filter count.
    result = [_derive(r) for r in db.execute(select_sql, params).fetchall()]
    if status == "Overdue":
        result = [r for r in result if r["is_overdue"]]
    elif status == "Void":
        result = [r for r in result if r["payment_status"] == "Void"]
    elif status:
        result = [r for r in result if r["payment_status"] == status and r["payment_status"] != "Void"]

    # Sort the derived value here, since SQL never saw it.
    if _derived_sort:
        result.sort(key=lambda r: (r.get("payment_status") or ""),
                    reverse=_direction == "DESC")

    if limit is not None:
        cap = max(1, min(limit, 500))
        return {"items": result[offset:offset + cap], "total": len(result),
                "limit": cap, "offset": offset}
    return result

# ── Single ────────────────────────────────────────────────────────────────
@router.get("/{invoice_id}")
def get_invoice(
    invoice_id: int,
    user=Depends(require_perm("invoices", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT i.*, p.name AS project_name,
                  c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
                  c.allow_installments AS client_allow_installments,
                  c.default_installment_count AS client_installment_count,
                  c.default_installment_frequency AS client_installment_frequency,
                  c.preferred_currency AS client_preferred_currency,
                  q.quote_number
           FROM invoices i
           LEFT JOIN projects   p ON i.project_id   = p.id
           LEFT JOIN clients    c ON i.client_id    = c.id
           LEFT JOIN quotations q ON i.quotation_id = q.id
           WHERE i.id = ?""",
        (invoice_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, row["branch_id"])

    payments = db.execute(
        "SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_at DESC",
        (invoice_id,),
    ).fetchall()

    items = db.execute(
        "SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id",
        (invoice_id,),
    ).fetchall() if _table_exists(db, "invoice_items") else []

    d = _enrich(dict(row), db)
    d["payments"] = [dict(p) for p in payments]
    d["items"]    = line_items.attach_barcodes(db, [dict(i) for i in items])
    d["amounts_locked"] = _has_payments(db, invoice_id)
    # The plan, with each instalment's settled state derived from the payments
    # already counted above — never stored, so it cannot disagree with them.
    d["installments"] = installments.plan_for(db, invoice_id, d.get("total_paid") or 0)
    d["next_due"] = installments.next_due(d["installments"])
    return d

# ── Create ────────────────────────────────────────────────────────────────
def build_invoice(
    db, *, user,
    client_id=None,
    items=None,
    amount=None,
    due_date=None,
    notes=None,
    quotation_id=None,
    project_id=None,
    service_job_id=None,
    branch_id=None,
    apply_promos=True,
    gate_approval=True,
    currency=None,
    exchange_rate=None,
):
    """Create one invoice and its item rows. The single correct way to raise an
    invoice from anywhere in the system.

    Does NOT commit and does NOT write the audit log: the caller owns the
    transaction and logs under its own module label, so a service job or a
    quotation records the event as its own rather than as an invoice edit.

    This exists because it was previously impossible to reuse. `create_invoice`
    was the only correct constructor and it is a FastAPI endpoint, so
    `quotations.convert_to_invoice` re-implemented it by hand and drifted: it
    lost the approval gate, the branch tag, and the discount, inventory and
    promotion columns on its items. A third copy would have compounded that.

    `items` is duck-typed - anything with .name/.quantity/.unit_price and
    optionally .discount/.discount_pct/.tax_rate_id/.inventory_id/
    .revenue_account. `_price_items` already reads them with getattr, so a
    SimpleNamespace works as well as a Pydantic model.

    `apply_promos=False` is for callers whose lines already carry a negotiated
    discount (a quotation): re-running promotions there would either
    double-discount or overwrite the figure the customer was quoted.

    Returns {invoice_id, invoice_number, subtotal, tax_total, amount,
             pending_approval}.
    """
    _ensure_invoice_items_table(db)
    # Validate foreign relations up front: a stale id must return a clean 400,
    # never an unhandled FOREIGN KEY IntegrityError (HTTP 500).
    if client_id is not None and not db.execute(
        "SELECT 1 FROM clients WHERE id=?", (client_id,)).fetchone():
        raise HTTPException(400, "Client not found")
    if project_id is not None and not db.execute(
        "SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
        raise HTTPException(400, "Project not found")
    if quotation_id is not None and not db.execute(
        "SELECT 1 FROM quotations WHERE id=?", (quotation_id,)).fetchone():
        raise HTTPException(400, "Quotation not found")
    if service_job_id is not None and not db.execute(
        "SELECT 1 FROM service_jobs WHERE id=?", (service_job_id,)).fetchone():
        raise HTTPException(400, "Service job not found")

    items = items or []
    # Promotions fill an empty line discount BEFORE pricing, so tax lands on the
    # discounted net exactly as it does for a hand-entered discount. The
    # quantity cap is deliberately NOT consumed here - an invoice can be
    # drafted, edited and voided, so metering it would burn units of a promotion
    # the customer may never receive. POS stays the metered channel.
    promo_ids = apply_promotions_to_lines(db, items) if apply_promos else []

    # The prices on the lines are in the currency the deal was struck in —
    # that is what the operator typed and what the customer agreed. Where no
    # currency is given, the customer's own is used, falling back to the
    # company's; either way an all-base invoice behaves exactly as before.
    client_name = None
    if currency is None and client_id is not None:
        row = db.execute("SELECT name, preferred_currency FROM clients WHERE id=?",
                         (client_id,)).fetchone()
        if row:
            currency, client_name = row["preferred_currency"], row["name"]
    try:
        txn_currency, fx_rate = denomination.resolve(
            db, currency, on_date=_today(), rate=exchange_rate)
    except denomination.RateUnavailable as e:
        # Name the customer. Without it this reads as a system fault rather
        # than "this customer is set to a currency you have no rate for", and
        # the operator has no idea which of the two things to go and fix.
        detail = str(e)
        if client_name:
            detail = (f"{client_name} is set to be invoiced in {currency}. "
                      + detail)
        raise HTTPException(400, detail)

    # Priced twice, deliberately. Converting the totals afterwards leaves the
    # base lines not summing to the base total, and the revenue split reads the
    # lines. Pricing each side from its own prices keeps both internally
    # consistent, and for a base-currency invoice the second pass is the first.
    txn_subtotal, txn_tax_total, txn_amount, txn_line_tax = _price_items(
        db, items, amount, client_id)
    if txn_amount <= 0:
        raise HTTPException(400, "Invoice amount must be positive")

    if denomination.is_base(txn_currency):
        subtotal, tax_total, computed_amount, line_tax = (
            txn_subtotal, txn_tax_total, txn_amount, txn_line_tax)
        base_items = items
    else:
        base_items = [_in_base(it, fx_rate) for it in items]
        subtotal, tax_total, computed_amount, line_tax = _price_items(
            db, base_items, denomination.to_base(amount, fx_rate) if amount else amount,
            client_id)
    if computed_amount <= 0:
        raise HTTPException(400, "Invoice amount must be positive")

    now = _now()
    if not due_date:
        terms_row = db.execute(
            "SELECT value FROM settings WHERE key='payment_terms_days'").fetchone()
        days = int(terms_row["value"]) if terms_row else 15
        due_date = (datetime.utcnow() + timedelta(days=days)).strftime("%Y-%m-%d")

    # Reserve the row first (placeholder number), then derive the real number
    # from its id - see the helper notes; this is what makes concurrent creates
    # collision-free.
    branch_id = branch_access.resolve_branch_id(user, db, branch_id)
    cur = db.execute(
        "INSERT INTO invoices "
        "(invoice_number, quotation_id, project_id, service_job_id, client_id, amount, "
        " subtotal, tax_total, due_date, notes, created_at, version, branch_id, "
        " currency, exchange_rate, txn_amount, txn_subtotal, txn_tax_total) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)",
        (_placeholder_invoice_number(), quotation_id, project_id, service_job_id,
         client_id, computed_amount, subtotal, tax_total, due_date, notes, now,
         branch_id,
         # The rate is written down here and never looked up again: a rate
         # entered next month must not restate an invoice issued today.
         txn_currency, fx_rate, txn_amount, txn_subtotal, txn_tax_total),
    )
    invoice_id = cur.lastrowid
    # Which of them raised this. Derived from the link the caller already
    # passed rather than a new argument every call site would have to remember.
    if service_job_id:
        _src = "service"
        _ref = (db.execute("SELECT job_number FROM service_jobs WHERE id=?",
                           (service_job_id,)).fetchone() or {})
        _ref = _ref["job_number"] if _ref else None
    elif quotation_id:
        _src = "quotation"
        _ref = (db.execute("SELECT quote_number FROM quotations WHERE id=?",
                           (quotation_id,)).fetchone() or {})
        _ref = _ref["quote_number"] if _ref else None
    elif project_id:
        _src, _ref = "project", None
    else:
        _src, _ref = "sales", None
    inv_no     = _finalize_invoice_number(db, invoice_id, _invoice_prefix(db), _src, _ref)
    for idx, item in enumerate(items):
        rid, rate, tax_amt = line_tax[idx]
        base_item = base_items[idx]
        _, _, txn_tax_amt = txn_line_tax[idx]
        db.execute(
            "INSERT INTO invoice_items "
            "(invoice_id, name, quantity, unit_price, discount, discount_pct, "
            " tax_rate_id, tax_rate, tax_amount, inventory_id, promotion_id, "
            " revenue_account, txn_unit_price, txn_tax_amount) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (invoice_id, item.name, item.quantity, base_item.unit_price,
             float(getattr(base_item, "discount", 0) or 0),
             getattr(item, "discount_pct", None),
             rid, rate, tax_amt,
             getattr(item, "inventory_id", None),
             promo_ids[idx] if idx < len(promo_ids) else None,
             # NULL means 4000 Sales Revenue. Only a service labour charge sets
             # this, so every other caller keeps today's behaviour exactly.
             getattr(item, "revenue_account", None),
             item.unit_price, txn_tax_amt),
        )

    # An active policy can gate the invoice behind approval. A gated invoice is
    # parked in 'Pending Approval' (it takes no payments and its project advance
    # is deferred to approval - see approval_engine.apply_resolution).
    needs_approval = False
    if gate_approval:
        entity_data = {
            "amount":    float(computed_amount or 0),
            "subtotal":  float(subtotal or 0),
            "tax_total": float(tax_total or 0),
        }
        needs_approval = evaluate_and_apply(
            db, module="invoice", action="create",
            entity_data=entity_data, user_id=user["id"],
            entity_id=invoice_id, entity_label=inv_no,
        )
    if needs_approval:
        db.execute("UPDATE invoices SET approval_status='Pending Approval' WHERE id=?",
                   (invoice_id,))
    else:
        # Auto-advance the linked project's status to Invoiced (forward-only).
        bump_project_status(db, project_id, "Invoiced")
        # Book the claim on the customer. Deferred until approval for a gated
        # invoice: one parked in 'Pending Approval' takes no payments and may
        # yet be rejected (which voids it), so it is not yet a receivable.
        # approval_engine posts it on approval instead.
        accounting.post_receivable(
            db, invoice_id,
            invoice_number=inv_no, amount=computed_amount,
            entry_date=_now()[:10], created_by=user["id"], branch_id=branch_id,
        )

    return {
        "invoice_id": invoice_id, "invoice_number": inv_no,
        "subtotal": subtotal, "tax_total": tax_total, "amount": computed_amount,
        "pending_approval": bool(needs_approval),
    }


@router.post("/")
def create_invoice(
    data: InvoiceCreate,
    user=Depends(require_perm("invoices", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    res = build_invoice(
        db, user=user,
        client_id=data.client_id, items=data.items, amount=data.amount,
        due_date=data.due_date, notes=data.notes,
        quotation_id=data.quotation_id, project_id=data.project_id,
        branch_id=data.branch_id,
        currency=data.currency, exchange_rate=data.exchange_rate,
    )
    log_action(db, user, "create", "invoice", res["invoice_id"],
               res["invoice_number"], {"amount": res["amount"]})
    db.commit()
    return {
        "id": res["invoice_id"], "invoice_number": res["invoice_number"],
        "pending_approval": res["pending_approval"],
        "message": ("Invoice pending approval" if res["pending_approval"]
                    else "Invoice created"),
    }

# ── Update ────────────────────────────────────────────────────────────────
@router.put("/{invoice_id}")
def update_invoice(
    invoice_id: int,
    data: InvoiceCreate,
    user=Depends(require_perm("invoices", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    _ensure_invoice_items_table(db)
    inv = db.execute(
        "SELECT * FROM invoices WHERE id = ? AND archived_at IS NULL", (invoice_id,)
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if inv["voided_at"]:
        raise HTTPException(400, "Voided invoices cannot be edited.")
    # A finalised (locked-month / closed-year) invoice can't be edited.
    _check_period_locked(db, inv["created_at"])

    # ── Optimistic locking ────────────────────────────────────────────────
    if data.version is not None and data.version != inv["version"]:
        raise HTTPException(
            409,
            "This invoice was modified by another user. Please refresh and try again."
        )

    has_payments = _has_payments(db, invoice_id)

    if has_payments:
        # Amounts are LOCKED once payments exist — only metadata may change
        db.execute(
            "UPDATE invoices "
            "SET quotation_id=?, project_id=?, client_id=?, due_date=?, notes=?, "
            "    version=version+1 "
            "WHERE id=? AND version=?",
            (data.quotation_id, data.project_id, data.client_id,
             data.due_date, data.notes,
             invoice_id, inv["version"]),
        )
        if db.execute("SELECT changes()").fetchone()[0] == 0:
            raise HTTPException(409, "This invoice was modified by another user. Please refresh and try again.")
        log_action(db, user, "update", "invoice", invoice_id,
                   inv["invoice_number"], {"note": "metadata only — amounts locked"})
    else:
        items    = data.items or []
        promo_ids = apply_promotions_to_lines(db, items)
        subtotal, tax_total, computed_amount, line_tax = _price_items(
            db, items, data.amount, data.client_id)

        rows_updated = db.execute(
            "UPDATE invoices "
            "SET quotation_id=?, project_id=?, client_id=?, amount=?, subtotal=?, tax_total=?, "
            "    due_date=?, notes=?, version=version+1 "
            "WHERE id=? AND version=?",
            (data.quotation_id, data.project_id, data.client_id,
             computed_amount, subtotal, tax_total, data.due_date, data.notes,
             invoice_id, inv["version"]),
        ).rowcount
        if rows_updated == 0:
            raise HTTPException(409, "This invoice was modified by another user. Please refresh and try again.")

        # Restate the receivable to the new total. Only reachable when the
        # invoice has NO payments (amounts are locked once money arrives), so
        # the old claim can be reversed outright rather than adjusted. Without
        # this, editing a $2,000 invoice down to $500 would leave a $2,000
        # asset on the balance sheet for ever.
        if money(computed_amount or 0) != money(inv["amount"] or 0):
            accounting.reverse_source(
                db, "invoice", invoice_id,
                memo=f"Restated — invoice {inv['invoice_number']} amended",
                created_by=user["id"])
            accounting.post_receivable(
                db, invoice_id,
                invoice_number=inv["invoice_number"], amount=computed_amount,
                entry_date=_now()[:10], created_by=user["id"],
                branch_id=inv["branch_id"])

        db.execute("DELETE FROM invoice_items WHERE invoice_id=?", (invoice_id,))
        for idx, item in enumerate(items):
            rid, rate, tax_amt = line_tax[idx]
            # `discount` must be written here too. It was omitted, so editing an
            # invoice silently reset every per-line discount to 0 while the
            # stored total kept the discounted figure — a document that no
            # longer added up, and a customer quietly losing the discount they
            # were given.
            db.execute(
                "INSERT INTO invoice_items "
                "(invoice_id, name, quantity, unit_price, discount, discount_pct, tax_rate_id, "
                " tax_rate, tax_amount, inventory_id, promotion_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (invoice_id, item.name, item.quantity, item.unit_price,
                 float(getattr(item, "discount", 0) or 0),
                 getattr(item, "discount_pct", None),
                 rid, rate, tax_amt,
                 getattr(item, "inventory_id", None),
                 promo_ids[idx] if idx < len(promo_ids) else None),
            )
        log_action(db, user, "update", "invoice", invoice_id,
                   inv["invoice_number"], {"amount": computed_amount})

    db.commit()
    return {"message": "Invoice updated"}

# ── Void (replaces delete for invoices with payments) ─────────────────────
@router.patch("/{invoice_id}/void")
def void_invoice(
    invoice_id: int,
    data: VoidRequest,
    user=Depends(require_perm("invoices", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    inv = db.execute(
        "SELECT * FROM invoices WHERE id = ? AND archived_at IS NULL", (invoice_id,)
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if inv["voided_at"]:
        raise HTTPException(400, "Invoice is already voided.")
    # Can't void an invoice that belongs to a locked month / closed year —
    # reopen the period (or post a credit note in an open one) instead.
    _check_period_locked(db, inv["created_at"])
    now = _now()
    db.execute(
        "UPDATE invoices SET voided_at=?, void_reason=?, version=version+1 WHERE id=?",
        (now, data.reason or "Voided", invoice_id),
    )
    # NOTE: no projects.actual_cost adjustment here. Invoices are project
    # REVENUE — only expenses feed actual_cost (see routers/finance.py), and
    # invoice creation never increments it, so there is nothing to walk back.
    # Reverse the ledger entry for every payment on the voided invoice so the
    # books no longer recognise the revenue.
    for pay in db.execute(
        "SELECT id FROM invoice_payments WHERE invoice_id=?", (invoice_id,)
    ).fetchall():
        accounting.reverse_source(db, "invoice_payment", pay["id"],
                                  memo=f"Reversal — voided invoice {inv['invoice_number']}",
                                  created_by=user["id"])
    # And the receivable itself. Reversing only the payments would leave the
    # full claim and its deferred revenue standing on a voided invoice, so the
    # balance sheet would keep asserting an asset the business no longer has.
    accounting.reverse_source(db, "invoice", invoice_id,
                              memo=f"Reversal — voided invoice {inv['invoice_number']}",
                              created_by=user["id"])
    log_action(db, user, "void", "invoice", invoice_id,
               inv["invoice_number"], {"reason": data.reason or "Voided"})
    db.commit()
    return {"message": "Invoice voided", "voided_at": now}


@router.patch("/{invoice_id}/unvoid")
def unvoid_invoice(
    invoice_id: int,
    user=Depends(require_perm("invoices", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Reverse a void: the invoice returns to all financial totals and the
    ledger entry for every payment is re-posted (void had reversed them).

    POS-sale invoices are excluded — a POS return already restocked the
    goods and is final; unvoiding here would desync stock and COGS."""
    inv = db.execute(
        "SELECT * FROM invoices WHERE id = ? AND archived_at IS NULL", (invoice_id,)
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if not inv["voided_at"]:
        raise HTTPException(400, "Invoice is not voided.")
    if db.execute("SELECT 1 FROM pos_sales WHERE invoice_id=?", (invoice_id,)).fetchone():
        raise HTTPException(
            400, "POS-sale invoices cannot be unvoided — the POS return already "
                 "restocked the goods. Ring the sale up again instead.")
    # Same period rules as void: the invoice's month and today's (where the
    # re-recognition entries land) must both be open.
    _check_period_locked(db, inv["created_at"])
    _check_period_locked(db, _now())

    db.execute(
        "UPDATE invoices SET voided_at=NULL, void_reason=NULL, version=version+1 WHERE id=?",
        (invoice_id,),
    )
    # Re-recognise every payment in the ledger. The void reversed the live
    # entry per payment, so post_entry's idempotency guard sees no live entry
    # and a fresh posting goes through — the GL history keeps all three
    # movements (original, reversal, re-recognition) for the audit trail.
    today = _now()[:10]
    # The receivable first: payment_lines below asks whether a live one exists,
    # so re-posting the payments before it would give them the legacy shape and
    # leave the restored claim standing unrelieved for ever.
    accounting.post_receivable(
        db, invoice_id,
        invoice_number=inv["invoice_number"], amount=float(inv["amount"] or 0),
        entry_date=today, created_by=user["id"], branch_id=inv["branch_id"],
    )
    for pay in db.execute(
        "SELECT * FROM invoice_payments WHERE invoice_id=?", (invoice_id,)
    ).fetchall():
        accounting.post_entry(
            db,
            entry_date=today,
            memo=f"Unvoid — payment re-recognised — {inv['invoice_number']}",
            # Split the same way the original payment was, or a void followed
            # by an unvoid would quietly move service revenue into the goods
            # account.
            lines=accounting.payment_lines(
                db, invoice_id,
                cash_code=accounting.cash_account_for(db, pay["paid_currency"]),
                amount=float(pay["amount"]),
                method_memo=f"{pay['method']} ({pay['paid_currency'] or 'USD'})",
            ),
            source_type="invoice_payment", source_id=pay["id"], created_by=user["id"],
            branch_id=inv["branch_id"],
        )
    log_action(db, user, "unvoid", "invoice", invoice_id, inv["invoice_number"])
    db.commit()
    return {"message": "Invoice restored"}


# ── Add payment ───────────────────────────────────────────────────────────
@router.post("/{invoice_id}/payments")
def add_payment(
    invoice_id: int,
    data: PaymentCreate,
    user=Depends(require_perm("invoices", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if data.amount <= 0:
        raise HTTPException(400, "Payment amount must be positive")

    # ── Resolve the currency the client paid in ───────────────────────────
    # `amount` is what the client tendered, in `currency`. The invoice balance
    # is always tracked in USD, so an LBP payment is converted at the rate the
    # user supplies; `usd_amount` is what reduces the balance.
    currency = (data.currency or currency_mod.FUNCTIONAL).upper()
    if currency not in currency_mod.SUPPORTED:
        raise HTTPException(
            400, f"Unsupported payment currency '{currency}'. This system "
                 "handles " + ", ".join(currency_mod.SUPPORTED) + ".")
    if currency == currency_mod.FUNCTIONAL:
        rate        = None
        usd_amount  = money(data.amount)
        paid_amount = data.amount
    else:
        # Any currency that is not the functional one needs a rate. The caller's
        # takes precedence and is stored on the payment, so an accountant can
        # override when a contract dictates a different one; otherwise the rate
        # in force for THAT currency is used.
        #
        # It used to read the newest row of any currency, which was correct
        # while pounds were the only foreign currency and silently wrong the
        # moment a second one existed — a euro rate would have been applied to
        # a pound payment.
        if data.exchange_rate and data.exchange_rate > 0:
            rate = float(data.exchange_rate)
        else:
            rate = currency_mod.rate_on(db, currency)
        if not rate or rate <= 0:
            raise HTTPException(
                400,
                f"An exchange rate is required for {currency} payments. No "
                f"{currency} rate is configured — set one in Settings → "
                "Exchange Rate first.")
        usd_amount  = money(data.amount / rate)
        paid_amount = data.amount
    if usd_amount <= 0:
        raise HTTPException(400, "Payment amount must be positive")

    inv = db.execute(
        "SELECT * FROM invoices WHERE id = ? AND archived_at IS NULL", (invoice_id,)
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if inv["voided_at"]:
        raise HTTPException(400, "Cannot add payments to a voided invoice.")
    if inv["approval_status"] == "Pending Approval":
        raise HTTPException(400, "Cannot record payments on an invoice awaiting approval.")

    _check_period_locked(db, _now()[:7] + "-01")

    # ── Idempotency check ─────────────────────────────────────────────────
    if data.idempotency_key:
        existing = db.execute(
            "SELECT id FROM invoice_payments WHERE idempotency_key = ?",
            (data.idempotency_key,),
        ).fetchone()
        if existing:
            raise HTTPException(409, "This payment was already recorded (duplicate submission).")

    total_paid = _payment_total(db, invoice_id)
    remaining  = money(float(inv["amount"]) - total_paid)

    if usd_amount > remaining + 0.001:
        raise HTTPException(
            400,
            f"Payment ${usd_amount:.2f} exceeds remaining balance ${remaining:.2f}",
        )

    # A cash payment may be attributed to a specific cash drawer.
    drawer_id = data.cash_drawer_id if (data.method or "").strip().lower() == "cash" else None
    if drawer_id is not None and not db.execute(
        "SELECT 1 FROM cash_drawers WHERE id=?", (drawer_id,)).fetchone():
        raise HTTPException(400, "Cash drawer not found")

    pay_cur = db.execute(
        "INSERT INTO invoice_payments "
        "(invoice_id, amount, method, note, paid_at, idempotency_key, "
        " paid_currency, paid_amount, exchange_rate, cash_drawer_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (invoice_id, usd_amount, data.method, data.note, _now(), data.idempotency_key,
         currency, paid_amount, rate, drawer_id),
    )
    payment_id = pay_cur.lastrowid

    # Auto-post to the general ledger: cash-basis revenue recognition.
    # The cash account is selected by the tendered currency (F-5 audit fix):
    # USD payments hit "1000 Cash & Bank", LBP payments hit "1010 Cash — LBP".
    # Keeping them on distinct ledger lines is required by IAS 21 so each
    # monetary holding can be revalued at the spot rate at period end.
    accounting.post_entry(
        db,
        entry_date=_now()[:10],
        memo=f"Payment received — {inv['invoice_number']}",
        # On an invoice carrying a receivable this both converts the claim to
        # cash and earns the deferred revenue; on a legacy or POS invoice it
        # stays the original DR Cash / CR Revenue pair. Revenue is still
        # credited across accounts in proportion to the invoice's line mix, so
        # a service job's labour lands in 4100 and its parts in 4000.
        lines=accounting.payment_lines(
            db, invoice_id,
            cash_code=accounting.cash_account_for(db, currency),
            amount=usd_amount,
            method_memo=f"{data.method} ({currency})",
        ),
        source_type="invoice_payment", source_id=payment_id, created_by=user["id"],
        branch_id=inv["branch_id"],
    )
    log_action(db, user, "payment", "invoice", invoice_id, inv["invoice_number"],
               {"amount": usd_amount, "method": data.method,
                "currency": currency, "paid_amount": paid_amount})

    new_paid   = money(total_paid + usd_amount)
    new_remain = money(float(inv["amount"]) - new_paid)
    new_status = _derive_status(float(inv["amount"]), new_paid)

    client_row = db.execute("SELECT name FROM clients WHERE id=?", (inv["client_id"],)).fetchone() if inv["client_id"] else None
    client_name = client_row["name"] if client_row else "Unknown client"

    if new_status == "Paid":
        notify(db, type="invoice_paid",
               title=f"Invoice {inv['invoice_number']} fully paid",
               body=f"{client_name} — ${float(inv['amount']):,.2f} received via {data.method}",
               msg="invoice_paid", params={"number": inv["invoice_number"], "client": client_name,
                                           "amount": float(inv["amount"]), "method": data.method},
               link=f"/invoices/{invoice_id}", entity_type="invoice", entity_id=invoice_id)
    else:
        notify(db, type="payment_received",
               title=f"Payment received on {inv['invoice_number']}",
               body=f"{client_name} — ${usd_amount:,.2f} via {data.method} · ${new_remain:,.2f} remaining",
               msg="payment_received", params={"number": inv["invoice_number"], "client": client_name,
                                               "amount": float(usd_amount), "method": data.method,
                                               "remaining": float(new_remain)},
               link=f"/invoices/{invoice_id}", entity_type="invoice", entity_id=invoice_id)

    db.commit()
    return {
        "message":    "Payment recorded",
        "total_paid": new_paid,
        "remaining":  new_remain,
        "status":     new_status,
    }

# ── List payments ─────────────────────────────────────────────────────────
@router.get("/{invoice_id}/payments")
def list_payments(
    invoice_id: int,
    user=Depends(require_perm("invoices", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    # Load the invoice first purely to branch-check it. Without this the
    # endpoint answered for ANY id, so a manager in one branch could read
    # another branch's payment history — amounts, methods and dates — even
    # though the invoice itself was hidden from them.
    inv = db.execute(
        "SELECT branch_id FROM invoices WHERE id = ? AND archived_at IS NULL",
        (invoice_id,),
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])

    rows = db.execute(
        "SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY paid_at DESC",
        (invoice_id,),
    ).fetchall()
    return [dict(r) for r in rows]

# ── Delete payment ────────────────────────────────────────────────────────
@router.delete("/{invoice_id}/payments/{payment_id}")
def delete_payment(
    invoice_id: int,
    payment_id: int,
    user=Depends(require_perm("invoices", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    inv = db.execute(
        "SELECT * FROM invoices WHERE id = ? AND archived_at IS NULL", (invoice_id,)
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if inv["voided_at"]:
        raise HTTPException(400, "Cannot modify payments on a voided invoice.")

    row = db.execute(
        "SELECT * FROM invoice_payments WHERE id = ? AND invoice_id = ?",
        (payment_id, invoice_id),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Payment not found")
    _check_period_locked(db, str(row["paid_at"])[:7] + "-01")

    # Reverse the ledger entry posted when this payment was recorded.
    accounting.reverse_source(db, "invoice_payment", payment_id,
                              memo=f"Reversal — deleted payment on {inv['invoice_number']}",
                              created_by=user["id"])
    db.execute("DELETE FROM invoice_payments WHERE id = ?", (payment_id,))
    log_action(db, user, "delete_payment", "invoice", invoice_id,
               inv["invoice_number"], {"amount": float(row["amount"])})
    db.commit()
    return {"message": "Payment deleted"}

# ── Receipt voucher (سند قبض) ─────────────────────────────────────────────
class PlanBody(BaseModel):
    count:        int
    start_date:   str
    frequency:    str = "monthly"       # monthly | quarterly | yearly
    first_amount: Optional[float] = None
    note:         Optional[str] = None


@router.post("/{invoice_id}/plan")
def create_plan(
    invoice_id: int,
    data: PlanBody,
    user=Depends(require_perm("invoices", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Agree a payment schedule against this invoice.

    The schedule must sum to the invoice total, which `build_schedule`
    guarantees by putting the rounding residue on the final instalment. A plan
    that does not add up leaves a last instalment nobody can settle.

    Replacing an existing plan is allowed — renegotiation is normal — but not
    once money has arrived against it: the instalments already settled would be
    reinterpreted, and a customer who paid three of twelve would silently become
    a customer who paid one of four. Cancel or re-raise the invoice instead.
    """
    inv = db.execute("SELECT * FROM invoices WHERE id=? AND archived_at IS NULL",
                     (invoice_id,)).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if inv["voided_at"]:
        raise HTTPException(400, "A voided invoice cannot carry a payment plan.")

    # The customer's own terms decide whether they may be put on a plan at all.
    # Unticked is a deliberate credit decision about that customer, not a
    # default — every customer already on the books was set to allowed when the
    # flag became enforceable.
    if inv["client_id"]:
        cli = db.execute(
            "SELECT name, COALESCE(allow_installments, 0) AS allowed "
            "FROM clients WHERE id=?", (inv["client_id"],)).fetchone()
        if cli and not cli["allowed"]:
            raise HTTPException(
                400, f"{cli['name']} is not approved for instalments. "
                     "Enable it on the customer first if that has changed.")

    paid = _payment_total(db, invoice_id)
    if paid > 0.005 and db.execute(
            "SELECT 1 FROM invoice_installments WHERE invoice_id=?",
            (invoice_id,)).fetchone():
        raise HTTPException(
            409, "Payments have already been made against this plan. "
                 "Changing it now would re-interpret what has been settled.")

    try:
        rows = installments.build_schedule(
            inv["amount"], data.count, data.start_date,
            frequency=data.frequency, first_amount=data.first_amount)
    except ValueError as e:
        raise HTTPException(400, str(e))

    now = _now()
    db.execute("DELETE FROM invoice_installments WHERE invoice_id=?", (invoice_id,))
    for seq, due, amount in rows:
        db.execute(
            "INSERT INTO invoice_installments "
            "(invoice_id, seq, due_date, amount, note, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (invoice_id, seq, due, amount, data.note, now))

    # The invoice's own due date becomes the FINAL instalment, so anything still
    # reading a single date (an export, an older report) says the plan ends
    # then rather than claiming the whole balance was due on day one.
    db.execute("UPDATE invoices SET due_date=? WHERE id=?", (rows[-1][1], invoice_id))

    log_action(db, user, "plan", "invoice", invoice_id, inv["invoice_number"],
               {"count": len(rows), "first_due": rows[0][1], "last_due": rows[-1][1]})
    db.commit()
    return {"message": "Payment plan created",
            "installments": installments.plan_for(db, invoice_id, paid)}


@router.get("/{invoice_id}/plan")
def get_plan(
    invoice_id: int,
    user=Depends(require_perm("invoices", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    inv = db.execute("SELECT branch_id FROM invoices WHERE id=?", (invoice_id,)).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    plan = installments.plan_for(db, invoice_id, _payment_total(db, invoice_id))
    return {"installments": plan, "next_due": installments.next_due(plan)}


@router.delete("/{invoice_id}/plan")
def delete_plan(
    invoice_id: int,
    user=Depends(require_perm("invoices", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Drop the schedule. The invoice and its payments are untouched — only the
    agreement about WHEN goes away, so the balance reverts to being due on the
    invoice's own date."""
    inv = db.execute("SELECT invoice_number, branch_id FROM invoices WHERE id=?",
                     (invoice_id,)).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if _payment_total(db, invoice_id) > 0.005:
        raise HTTPException(
            409, "Payments have been made against this plan; removing it would "
                 "leave them unexplained.")
    db.execute("DELETE FROM invoice_installments WHERE invoice_id=?", (invoice_id,))
    log_action(db, user, "plan_removed", "invoice", invoice_id, inv["invoice_number"])
    db.commit()
    return {"message": "Payment plan removed"}


@router.post("/{invoice_id}/receipt-voucher")
def issue_receipt_voucher(
    invoice_id: int,
    user=Depends(require_perm("invoices", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """The number for this invoice's receipt voucher, allocating it on first use.

    The SAME number every time, by design. A voucher states what has been paid
    on its invoice to date, so it is one document that gets reprinted as
    instalments arrive — not a new one per printing. Minting a fresh number each
    time would leave a customer who paid 100 and then 150 holding vouchers
    reading 100 and 250: receipts for 350 against 250 received. UNIQUE(invoice_id)
    makes that unrepresentable; this handler simply returns what is already there.

    `view` rather than a write permission: printing the receipt for an invoice
    you are already allowed to open should not need more, and the UNIQUE bounds
    what the write can do to one row per invoice.
    """
    inv = db.execute(
        "SELECT i.*, c.name AS client_name FROM invoices i "
        "LEFT JOIN clients c ON i.client_id = c.id WHERE i.id = ?",
        (invoice_id,)).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])

    # Both refusals name the reason: "cannot issue" with no cause is the kind of
    # message that turns into a support call.
    if inv["voided_at"]:
        raise HTTPException(
            400, "This invoice is voided — a receipt cannot be issued against it.")
    paid = _payment_total(db, invoice_id)
    if paid <= 0:
        raise HTTPException(
            400, "No payment has been recorded on this invoice yet, so there is "
                 "nothing to receipt.")

    row = db.execute("SELECT number FROM receipt_vouchers WHERE invoice_id = ?",
                     (invoice_id,)).fetchone()
    if row:
        return {"number": row["number"], "issued": False}

    from utils import get_setting
    prefix = get_setting(db, "receipt_voucher_prefix") or "RV-"
    # Derived from the row's own id, exactly as invoice numbers are: unique by
    # construction under AUTOINCREMENT, so two concurrent issues cannot collide
    # on a number the way a MAX()+1 read-then-write would.
    cur = db.execute(
        "INSERT INTO receipt_vouchers (invoice_id, number, created_by, created_at) "
        "VALUES (?, ?, ?, ?)",
        (invoice_id, "__pending__", user["id"], _now()))
    voucher_id = cur.lastrowid
    number = f"{prefix}{datetime.utcnow().year}-{voucher_id:04d}"
    db.execute("UPDATE receipt_vouchers SET number=? WHERE id=?", (number, voucher_id))

    log_action(db, user, "issue_receipt_voucher", "invoice", invoice_id,
               inv["invoice_number"], {"number": number, "amount": money(paid)})
    db.commit()
    return {"number": number, "issued": True}

# ── Archive invoice (only for draft invoices with zero payments) ──────────
@router.patch("/{invoice_id}/archive")
def archive_invoice(
    invoice_id: int,
    user=Depends(require_perm("invoices", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    inv = db.execute(
        "SELECT * FROM invoices WHERE id = ? AND archived_at IS NULL", (invoice_id,)
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    if _has_payments(db, invoice_id):
        raise HTTPException(
            400,
            "Cannot archive an invoice with recorded payments. Use 'Void' instead to preserve the audit trail."
        )
    now = _now()
    db.execute(
        "UPDATE invoices SET archived_at=?, archive_reason='Archived' WHERE id=?",
        (now, invoice_id)
    )
    log_action(db, user, "archive", "invoice", invoice_id, inv["invoice_number"])
    db.commit()
    return {"message": "Invoice archived"}

@router.patch("/{invoice_id}/unarchive")
def unarchive_invoice(
    invoice_id: int,
    user=Depends(require_perm("invoices", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    inv = db.execute(
        "SELECT * FROM invoices WHERE id = ? AND archived_at IS NOT NULL", (invoice_id,)
    ).fetchone()
    if not inv:
        raise HTTPException(404, "Invoice not found in archives")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, inv["branch_id"])
    db.execute("UPDATE invoices SET archived_at=NULL, archive_reason=NULL WHERE id=?", (invoice_id,))
    log_action(db, user, "unarchive", "invoice", invoice_id, inv["invoice_number"])
    db.commit()
    return {"message": "Invoice restored from archive"}
