"""
Quotations — commercial proposals only.

Workflow:
  Draft → Sent → Accepted → [Convert to Invoice]
                 Rejected / Voided (reversible via Unvoid)

Payments are NOT recorded on quotations. When a quotation is accepted
the user converts it to an Invoice, and payments are recorded there.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from routers.promotions import apply_promotions_to_lines
from utils import _now, get_tax_context, resolve_line_tax, money, notify
from routers.projects import bump_project_status
from approval_engine import evaluate_and_apply
import branch_access
import sqlite3
from datetime import datetime, timedelta

router = APIRouter()

class VoidRequest(BaseModel):
    reason: Optional[str] = None

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

class QuoteItem(BaseModel):
    name: str
    quantity: float
    unit_price: float
    # Per-line discount in functional currency. Defaults to 0 so callers that
    # never use discounts (and the existing API contract) keep working
    # unchanged. The pricing roll-up subtracts it from the net before tax,
    # matching how invoices and POS handle the same field.
    discount: float = 0
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


def _price_quote_items(db, items):
    """Roll up quotation line totals with per-line tax AND per-line discount.

    Net per line is `qty * unit_price - discount`, floored at 0 so a typo
    can't produce a negative net. Tax is computed on the discounted net so
    the customer is taxed on what they actually pay. Lines are cent-rounded
    so SUM(line.tax_amount) == header.tax_total.

    Returns (subtotal, tax_total, line_tax) — line_tax parallel to `items`.
    """
    ctx = get_tax_context(db)
    subtotal = tax_total = 0.0
    line_tax = []
    for it in items:
        qty   = float(it.quantity or 0)
        price = float(it.unit_price or 0)
        disc  = float(getattr(it, "discount", 0) or 0)
        net = money(max(0.0, qty * price - disc))
        rid, rate, tax_amt = resolve_line_tax(ctx, it.tax_rate_id, net)
        subtotal  += net
        tax_total += tax_amt
        line_tax.append((rid, rate, tax_amt))
    return money(subtotal), money(tax_total), line_tax

class QuotationCreate(BaseModel):
    project_id:   Optional[int] = None
    project_name: Optional[str] = None   # free-text name when no project exists yet
    client_id:    Optional[int] = None
    # Quotations may be addressed to a CRM lead instead of (or alongside) an
    # existing client. Conversion to invoice/project still requires a real
    # client_id — the lead must be converted first.
    lead_id:      Optional[int] = None
    status:       Optional[str] = "Draft"
    notes:        Optional[str] = None
    items:        List[QuoteItem] = []
    branch_id:    Optional[int] = None   # branch == warehouse; resolved on create

def _next_quote_number(db):
    from utils import get_setting
    # Preserve prior behavior: a row with an empty value yields "", only an absent
    # key falls back to "QTN-".
    val = get_setting(db, "quotation_prefix")
    prefix = val if val is not None else "QTN-"
    row  = db.execute("SELECT COALESCE(MAX(id), 0) as m FROM quotations").fetchone()
    year = datetime.utcnow().year
    return f"{prefix}{year}-{row['m'] + 1:04d}"

# ── List ──────────────────────────────────────────────────────────────────
@router.get("/")
def list_quotations(
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
    user=Depends(require_perm("quotations", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """List quotations.

    Backward-compatible pagination, matching invoices: with no `limit` the
    response is the full array exactly as before. Pass `limit` (capped at 500)
    for a {items, total, limit, offset} envelope. `search` matches the same
    fields the list screen used to filter in the browser.
    """
    _JOINS = """
        FROM quotations q
        LEFT JOIN projects  p ON q.project_id = p.id
        LEFT JOIN clients   c ON q.client_id  = c.id
        LEFT JOIN crm_leads l ON q.lead_id    = l.id
    """
    query = """
        SELECT q.*,
               p.name  AS project_name,
               c.name  AS client_name, c.phone AS client_phone,
               l.name  AS lead_name,   l.phone AS lead_phone,
               l.company AS lead_company,
               -- show whether an invoice has already been raised
               (SELECT COUNT(*) FROM invoices i WHERE i.quotation_id = q.id) AS invoice_count
        FROM quotations q
        LEFT JOIN projects  p ON q.project_id = p.id
        LEFT JOIN clients   c ON q.client_id  = c.id
        LEFT JOIN crm_leads l ON q.lead_id    = l.id
        WHERE 1=1
    """
    # Predicates are collected once and shared by the row query and the COUNT,
    # so the two cannot drift apart and disagree about the total.
    where, params = [], []
    if not include_archived:
        where.append("q.archived_at IS NULL")
    if status:
        where.append("q.status = ?")
        params.append(status)
    bf, bp = branch_access.branch_filter(user, db, column="q.branch_id", selected=branch_id)
    if bf:
        where.append(bf[len(" AND "):])      # branch_filter returns a leading " AND "
        params += bp
    if search and search.strip():
        like = f"%{search.strip()}%"
        where.append("(q.quote_number LIKE ? OR c.name LIKE ? OR l.name LIKE ?"
                     " OR p.name LIKE ? OR q.project_name LIKE ? OR q.notes LIKE ?)")
        params += [like] * 6
    if client_id is not None:
        where.append("q.client_id = ?")
        params.append(client_id)
    if project_id is not None:
        where.append("q.project_id = ?")
        params.append(project_id)
    if where:
        query += " AND " + " AND ".join(where)

    # Sorting from a fixed allow-list: `sort` reaches ORDER BY, which takes no
    # bind parameters, so only a value from this map may be interpolated.
    _SORTABLE = {
        "quote_number":   "q.quote_number",
        "client_name":    "c.name",
        "project_name":   "p.name",
        "status":         "q.status",
        "total":          "q.total",
        "total_with_tax": "(COALESCE(q.total,0) + COALESCE(q.tax_total,0))",
        "created_at":     "q.created_at",
    }
    _direction = "DESC" if str(dir).lower() == "desc" else "ASC"
    order_sql = (f" ORDER BY {_SORTABLE[sort]} {_direction}"
                 if sort in _SORTABLE else " ORDER BY q.created_at DESC")

    def _shape(r):
        d = dict(r)
        d["total_with_tax"] = round(float(d["total"] or 0) + float(d["tax_total"] or 0), 2)
        return d

    if limit is not None:
        cap = max(1, min(limit, 500))
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        total = db.execute(f"SELECT COUNT(*) {_JOINS} {where_sql}", params).fetchone()[0]
        rows = db.execute(query + order_sql + " LIMIT ? OFFSET ?",
                          params + [cap, offset]).fetchall()
        return {"items": [_shape(r) for r in rows], "total": total,
                "limit": cap, "offset": offset}

    rows = db.execute(query + order_sql, params).fetchall()
    return [_shape(r) for r in rows]

# ── Single ────────────────────────────────────────────────────────────────
@router.get("/{quote_id}")
def get_quotation(
    quote_id: int,
    user=Depends(require_perm("quotations", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        """SELECT q.*, p.name AS project_name,
                  c.name AS client_name, c.phone AS client_phone, c.email AS client_email,
                  l.name AS lead_name,   l.phone AS lead_phone,   l.email AS lead_email,
                  l.company AS lead_company, l.client_id AS lead_client_id
           FROM quotations q
           LEFT JOIN projects  p ON q.project_id = p.id
           LEFT JOIN clients   c ON q.client_id  = c.id
           LEFT JOIN crm_leads l ON q.lead_id    = l.id
           WHERE q.id = ?""",
        (quote_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Quotation not found")
    branch_access.assert_can_view_branch(user, db, row["branch_id"])

    items = db.execute(
        "SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY id",
        (quote_id,),
    ).fetchall()

    result = dict(row)
    result["items"] = [dict(i) for i in items]
    result["total_with_tax"] = round(float(result["total"] or 0) + float(result["tax_total"] or 0), 2)
    return result

# ── Create ────────────────────────────────────────────────────────────────
@router.post("/")
def create_quotation(
    data: QuotationCreate,
    user=Depends(require_perm("quotations", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    # Indicative only. A quotation is not a sale, so the promotion is shown at
    # today's terms and the quantity cap is never consumed — the quote may
    # expire unaccepted, and burning units for it would deny them to a real
    # sale. The discount is snapshotted onto the line, so ending the promotion
    # later cannot silently reprice a quote already sent to a client.
    promo_ids = apply_promotions_to_lines(db, data.items)
    total, tax_total, line_tax = _price_quote_items(db, data.items)
    qn    = _next_quote_number(db)
    now   = _now()

    # Validate the lead exists if supplied (silently dropping invalid IDs hides
    # data-entry bugs from the UI).
    if data.lead_id is not None and not db.execute(
        "SELECT 1 FROM crm_leads WHERE id = ? AND archived_at IS NULL", (data.lead_id,)
    ).fetchone():
        raise HTTPException(400, "Lead not found.")

    branch_id = branch_access.resolve_branch_id(user, db, data.branch_id)
    cur = db.execute(
        "INSERT INTO quotations "
        "(quote_number, project_id, client_id, lead_id, project_name, status, notes, "
        " total, tax_total, created_at, branch_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (qn, data.project_id, data.client_id, data.lead_id, data.project_name,
         data.status, data.notes, total, tax_total, now, branch_id),
    )
    qid = cur.lastrowid
    for idx, item in enumerate(data.items):
        rid, rate, tax_amt = line_tax[idx]
        db.execute(
            "INSERT INTO quotation_items "
            "(quotation_id, name, quantity, unit_price, discount, discount_pct, total, tax_rate_id, "
            " tax_rate, tax_amount, inventory_id, promotion_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (qid, item.name, item.quantity, item.unit_price,
             float(getattr(item, "discount", 0) or 0),
             getattr(item, "discount_pct", None),
             # `total` mirrors the line net after discount so historical
             # reports tie to the modern pricing math.
             round(max(0.0, item.quantity * item.unit_price
                            - float(getattr(item, "discount", 0) or 0)), 4),
             rid, rate, tax_amt,
             getattr(item, "inventory_id", None),
             promo_ids[idx] if idx < len(promo_ids) else None),
        )
    # An active policy can gate a new quotation behind approval. The snapshot
    # keeps the requested status so an approval can release it back to it.
    entity_data = {
        "total":     float(total or 0),
        "tax_total": float(tax_total or 0),
        "status":    data.status,
    }
    needs_approval = evaluate_and_apply(
        db, module="quotation", action="create",
        entity_data=entity_data, user_id=user["id"],
        entity_id=qid, entity_label=f"{qn} — {data.project_name or ''}".strip(" —"),
    )
    if needs_approval:
        db.execute("UPDATE quotations SET status='Pending Approval' WHERE id=?", (qid,))
    else:
        # Auto-advance the linked project's status — a quotation existing means
        # we're at least past "Inquiry" / "Quotation Sent". Held back until the
        # quotation clears approval so the project doesn't jump ahead of a draft.
        bump_project_status(db, data.project_id, "Quotation Sent")

    log_action(db, user, "create", "quotation", qid, qn)
    db.commit()
    return {
        "id": qid, "quote_number": qn,
        "pending_approval": bool(needs_approval),
        "message": "Quotation pending approval" if needs_approval else "Quotation created",
    }

# ── Update ────────────────────────────────────────────────────────────────
@router.put("/{quote_id}")
def update_quotation(
    quote_id: int,
    data: QuotationCreate,
    user=Depends(require_perm("quotations", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    existing = db.execute(
        "SELECT id, status, quote_number, branch_id FROM quotations WHERE id = ?",
        (quote_id,)
    ).fetchone()
    if not existing:
        raise HTTPException(404, "Quotation not found")
    # Branch scoping — see the note in invoices.update_invoice. `branch_id` is
    # selected above solely so this check has something to read.
    branch_access.assert_can_view_branch(user, db, existing["branch_id"])
    # A voided quotation is read-only until it is unvoided, and the Voided
    # status can only be entered through PATCH /void (which records the
    # previous status for restore) — never by a plain update.
    if existing["status"] in ("Voided", "Cancelled"):
        raise HTTPException(400, "Voided quotations cannot be edited. Unvoid it first.")
    if data.status in ("Voided", "Cancelled"):
        raise HTTPException(400, "Use the Void action to void a quotation.")

    promo_ids = apply_promotions_to_lines(db, data.items)
    total, tax_total, line_tax = _price_quote_items(db, data.items)
    invoice_amount = round(total + tax_total, 4)

    # Check if this quotation has already been converted to an invoice.
    # If the total has changed, update the invoice amount — but only when
    # no payments have been recorded yet (editing a paid/partial invoice
    # would break accounting, so we block it with a clear error).
    linked_invoices = db.execute(
        "SELECT id, invoice_number, amount FROM invoices WHERE quotation_id = ? AND deleted_at IS NULL",
        (quote_id,),
    ).fetchall()
    for inv in linked_invoices:
        if abs(float(inv["amount"]) - invoice_amount) > 0.001:
            total_paid = db.execute(
                "SELECT COALESCE(SUM(amount), 0) AS s FROM invoice_payments WHERE invoice_id = ?",
                (inv["id"],),
            ).fetchone()["s"]
            if float(total_paid) > 0:
                raise HTTPException(
                    400,
                    f"Cannot change quotation total: invoice {inv['invoice_number']} "
                    f"already has payments recorded (${float(total_paid):.2f} paid). "
                    "Delete the payments first, or create a new quotation."
                )
            # Safe to sync — no payments yet
            db.execute(
                "UPDATE invoices SET amount=?, subtotal=?, tax_total=? WHERE id=?",
                (invoice_amount, total, tax_total, inv["id"]),
            )
            # Replace invoice line items to stay in sync
            db.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (inv["id"],))
            for idx, item in enumerate(data.items):
                rid, rate, tax_amt = line_tax[idx]
                db.execute(
                    "INSERT INTO invoice_items "
                    "(invoice_id, name, quantity, unit_price, tax_rate_id, tax_rate, tax_amount) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (inv["id"], item.name, item.quantity, item.unit_price, rid, rate, tax_amt),
                )

    if data.lead_id is not None and not db.execute(
        "SELECT 1 FROM crm_leads WHERE id = ? AND archived_at IS NULL", (data.lead_id,)
    ).fetchone():
        raise HTTPException(400, "Lead not found.")
    db.execute(
        "UPDATE quotations "
        "SET project_id=?, client_id=?, lead_id=?, project_name=?, status=?, notes=?, "
        "    total=?, tax_total=? "
        "WHERE id=?",
        (data.project_id, data.client_id, data.lead_id, data.project_name, data.status,
         data.notes, total, tax_total, quote_id),
    )
    db.execute(
        "DELETE FROM quotation_items WHERE quotation_id = ?", (quote_id,)
    )
    for idx, item in enumerate(data.items):
        rid, rate, tax_amt = line_tax[idx]
        db.execute(
            # Mirrors the create path: `discount` is stored, and `total` is the
            # line NET of it. Editing a quotation used to drop the discount and
            # write a gross total, so a revised quote quietly cost the customer
            # their agreed reduction.
            "INSERT INTO quotation_items "
            "(quotation_id, name, quantity, unit_price, discount, discount_pct, total, tax_rate_id, "
            " tax_rate, tax_amount, inventory_id, promotion_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (quote_id, item.name, item.quantity, item.unit_price,
             float(getattr(item, "discount", 0) or 0),
             getattr(item, "discount_pct", None),
             round(max(0.0, item.quantity * item.unit_price
                            - float(getattr(item, "discount", 0) or 0)), 4),
             rid, rate, tax_amt,
             getattr(item, "inventory_id", None),
             promo_ids[idx] if idx < len(promo_ids) else None),
        )
    qref = db.execute("SELECT quote_number FROM quotations WHERE id = ?", (quote_id,)).fetchone()
    log_action(db, user, "update", "quotation", quote_id,
               qref["quote_number"] if qref else "")
    # First transition into the Accepted state — notify the team so a sales
    # rep can promptly raise the invoice / kick off delivery.
    if data.status == "Accepted" and existing["status"] != "Accepted":
        notify(db, type="quotation_accepted",
               title=f"Quotation accepted: {existing['quote_number']}",
               body=f"Total ${invoice_amount:,.2f} — ready to invoice.",
               msg="quotation_accepted", params={"number": existing["quote_number"],
                                                 "amount": float(invoice_amount)},
               link="/quotations", entity_type="quotation", entity_id=quote_id)
    db.commit()
    return {"message": "Quotation updated"}

# ── Convert to Invoice ────────────────────────────────────────────────────
@router.post("/{quote_id}/convert-to-invoice")
def convert_to_invoice(
    quote_id: int,
    user=Depends(require_perm("quotations", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Creates an Invoice from an accepted Quotation.
    The invoice amount equals the quotation total.
    Payments are then recorded on the invoice, not the quotation.
    """
    q = db.execute(
        "SELECT * FROM quotations WHERE id = ?", (quote_id,)
    ).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, q["branch_id"])

    # A voided / rejected quotation is a terminal state — no invoice may be
    # raised from it (the UI promises this; enforce it on the server too).
    # 'Cancelled' covers legacy rows from before void/unvoid existed.
    if q["status"] in ("Voided", "Cancelled", "Rejected"):
        raise HTTPException(
            400, f"Cannot create an invoice from a {q['status'].lower()} quotation."
        )

    # Invoices require a real client_id. If the quotation is addressed to a
    # lead only, try the lead's already-converted client; otherwise tell the
    # user to convert the lead first (CRM has a one-click action for this).
    client_id = q["client_id"]
    if not client_id and q["lead_id"]:
        lead = db.execute(
            "SELECT client_id, name FROM crm_leads WHERE id = ?", (q["lead_id"],)
        ).fetchone()
        if lead and lead["client_id"]:
            client_id = lead["client_id"]
            # Backfill the quotation so future reads don't have to re-resolve.
            db.execute("UPDATE quotations SET client_id = ? WHERE id = ?",
                       (client_id, quote_id))
        else:
            raise HTTPException(
                400,
                "This quotation is addressed to a lead. Convert the lead to a "
                "client first (CRM → open the lead → Convert to client), then "
                "try again."
            )
    if not client_id:
        raise HTTPException(400, "Quotation has no client or lead — cannot invoice.")

    # Check if an invoice already exists for this quotation
    existing_inv = db.execute(
        "SELECT id, invoice_number FROM invoices WHERE quotation_id = ?",
        (quote_id,),
    ).fetchone()
    if existing_inv:
        return {
            "message":        "Invoice already exists for this quotation",
            "invoice_id":     existing_inv["id"],
            "invoice_number": existing_inv["invoice_number"],
        }

    # Invoice number is derived from the new row's id (collision-free under
    # concurrency) — see routers/invoices.py helpers. We insert with a
    # placeholder first, then finalize once we have the id.
    from routers.invoices import (_placeholder_invoice_number, _invoice_prefix,
                                  _finalize_invoice_number)
    prefix = _invoice_prefix(db)
    now    = _now()

    # Auto-calculate due_date from payment_terms_days setting
    terms_row = db.execute("SELECT value FROM settings WHERE key='payment_terms_days'").fetchone()
    days = int(terms_row["value"]) if terms_row else 15
    due_date = (datetime.utcnow() + timedelta(days=days)).strftime("%Y-%m-%d")

    # Ensure invoice_items table exists
    db.execute("""
        CREATE TABLE IF NOT EXISTS invoice_items (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            name       TEXT    NOT NULL,
            quantity   REAL    NOT NULL DEFAULT 1,
            unit_price REAL    NOT NULL DEFAULT 0
        )
    """)

    quote_subtotal = float(q["total"] or 0)
    quote_tax      = float(q["tax_total"] or 0)
    invoice_amount = round(quote_subtotal + quote_tax, 4)
    cur = db.execute(
        "INSERT INTO invoices "
        "(invoice_number, quotation_id, project_id, client_id, amount, subtotal, tax_total, "
        " due_date, notes, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (_placeholder_invoice_number(), quote_id, q["project_id"], client_id,
         invoice_amount, quote_subtotal, quote_tax, due_date,
         f"From {q['quote_number']}", now),
    )
    inv_id = cur.lastrowid
    inv_no = _finalize_invoice_number(db, inv_id, prefix)

    # Copy all line items (with their tax snapshot) from quotation -> invoice
    quote_items = db.execute(
        "SELECT name, quantity, unit_price, tax_rate_id, tax_rate, tax_amount "
        "FROM quotation_items WHERE quotation_id = ? ORDER BY id",
        (quote_id,),
    ).fetchall()
    for item in quote_items:
        db.execute(
            "INSERT INTO invoice_items "
            "(invoice_id, name, quantity, unit_price, tax_rate_id, tax_rate, tax_amount) "
            "VALUES (?,?,?,?,?,?,?)",
            (inv_id, item["name"], item["quantity"], item["unit_price"],
             item["tax_rate_id"], item["tax_rate"], item["tax_amount"]),
        )

    # Mark quotation as Accepted (if not already)
    db.execute(
        "UPDATE quotations SET status = 'Accepted' WHERE id = ? AND status != 'Accepted'",
        (quote_id,),
    )
    # An invoice has been raised — the project (if any) moves to Invoiced.
    bump_project_status(db, q["project_id"], "Invoiced")
    log_action(db, user, "convert_to_invoice", "quotation", quote_id,
               q["quote_number"], {"invoice_number": inv_no})
    db.commit()
    return {
        "message":        "Invoice created from quotation",
        "invoice_id":     inv_id,
        "invoice_number": inv_no,
    }

# ── Convert to Project (project-based workflow) ───────────────────────────
@router.post("/{quote_id}/convert-to-project")
def convert_to_project(
    quote_id: int,
    user=Depends(require_perm("quotations", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    Creates a Project from an accepted Quotation.
    - expected_revenue  = quotation total (what the client will pay us)
    - estimated_cost    = 0 initially (updated as expenses/costs are tracked)
    - source_quotation_id links the project back to the originating quote
    """
    q = db.execute(
        "SELECT * FROM quotations WHERE id = ?", (quote_id,)
    ).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, q["branch_id"])
    if q["status"] in ("Voided", "Cancelled", "Rejected"):
        raise HTTPException(
            400, f"Cannot start a project from a {q['status'].lower()} quotation."
        )
    if q["project_id"]:
        return {"message": "Already linked to project", "project_id": q["project_id"]}

    # Projects, like invoices, need a real client. Resolve through the lead if
    # the quotation isn't addressed to a client yet.
    client_id = q["client_id"]
    if not client_id and q["lead_id"]:
        lead = db.execute(
            "SELECT client_id FROM crm_leads WHERE id = ?", (q["lead_id"],)
        ).fetchone()
        if lead and lead["client_id"]:
            client_id = lead["client_id"]
            db.execute("UPDATE quotations SET client_id = ? WHERE id = ?",
                       (client_id, quote_id))
        else:
            raise HTTPException(
                400,
                "This quotation is addressed to a lead. Convert the lead to a "
                "client first, then try again."
            )
    if not client_id:
        raise HTTPException(400, "Quotation has no client or lead — cannot start a project.")

    cur = db.execute(
        "INSERT INTO projects "
        "(name, client_id, status, estimated_cost, expected_revenue, source_quotation_id, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (
            q["project_name"] or f"Project from {q['quote_number']}",
            client_id,
            "Approved",
            0,            # estimated_cost starts at 0; updated as costs are tracked
            q["total"],   # expected_revenue = quotation total (client's commitment)
            quote_id,     # link back to originating quotation
            _now(),
        ),
    )
    pid = cur.lastrowid
    db.execute(
        "UPDATE quotations SET project_id = ?, status = 'Accepted' WHERE id = ?",
        (pid, quote_id),
    )
    log_action(db, user, "convert_to_project", "quotation", quote_id,
               q["quote_number"], {"project_id": pid})
    db.commit()
    return {"message": "Project created from accepted quotation", "project_id": pid}

# ── Void / Unvoid ─────────────────────────────────────────────────────────
# Quotations are never hard-deleted and no longer 'Cancelled': voiding is the
# one terminal action, and it is reversible. Void remembers the status the
# quotation had (void_prev_status) so Unvoid restores it exactly. Legacy
# 'Cancelled' rows (pre-127) stay terminal and are treated like voided ones.
@router.patch("/{quote_id}/void")
def void_quotation(
    quote_id: int,
    data: VoidRequest = VoidRequest(),
    user=Depends(require_perm("quotations", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = db.execute("SELECT * FROM quotations WHERE id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, q["branch_id"])
    if q["status"] in ("Voided", "Cancelled"):
        raise HTTPException(400, "Quotation is already voided.")
    inv = db.execute("SELECT id FROM invoices WHERE quotation_id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if inv:
        raise HTTPException(400, "Cannot void a quotation that has an active invoice. Archive the invoice first.")
    db.execute(
        "UPDATE quotations SET status='Voided', void_prev_status=?, archive_reason=? WHERE id=?",
        (q["status"], data.reason or "Voided", quote_id)
    )
    log_action(db, user, "void", "quotation", quote_id,
               q["quote_number"], {"reason": data.reason, "previous_status": q["status"]})
    db.commit()
    return {"message": "Quotation voided"}


@router.patch("/{quote_id}/unvoid")
def unvoid_quotation(
    quote_id: int,
    user=Depends(require_perm("quotations", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = db.execute("SELECT * FROM quotations WHERE id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, q["branch_id"])
    if q["status"] not in ("Voided", "Cancelled"):
        raise HTTPException(400, "Quotation is not voided.")
    # Restore the exact pre-void status; legacy 'Cancelled' rows (which never
    # recorded one) reopen as Draft.
    restored = q["void_prev_status"] or "Draft"
    db.execute(
        "UPDATE quotations SET status=?, void_prev_status=NULL, archive_reason=NULL WHERE id=?",
        (restored, quote_id)
    )
    log_action(db, user, "unvoid", "quotation", quote_id,
               q["quote_number"], {"restored_status": restored})
    db.commit()
    return {"message": "Quotation restored", "status": restored}

# ── Archive ───────────────────────────────────────────────────────────────
@router.patch("/{quote_id}/archive")
def archive_quotation(
    quote_id: int,
    data: ArchiveRequest = ArchiveRequest(),
    user=Depends(require_perm("quotations", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = db.execute("SELECT * FROM quotations WHERE id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found")
    # Branch scoping. Without this a manager in one branch could reach a
    # record belonging to another: the list is filtered, but an id in the
    # URL was not checked. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, q["branch_id"])
    inv = db.execute("SELECT id FROM invoices WHERE quotation_id = ? AND archived_at IS NULL", (quote_id,)).fetchone()
    if inv:
        raise HTTPException(400, "Cannot archive a quotation that has an active invoice. Archive the invoice first.")
    now = _now()
    db.execute(
        "UPDATE quotations SET archived_at=?, archive_reason=? WHERE id=?",
        (now, data.reason or "Archived", quote_id)
    )
    log_action(db, user, "archive", "quotation", quote_id, q["quote_number"], {"reason": data.reason})
    db.commit()
    return {"message": "Quotation archived"}

# ── Unarchive ─────────────────────────────────────────────────────────────
@router.patch("/{quote_id}/unarchive")
def unarchive_quotation(
    quote_id: int,
    user=Depends(require_perm("quotations", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = db.execute("SELECT * FROM quotations WHERE id = ? AND archived_at IS NOT NULL", (quote_id,)).fetchone()
    if not q:
        raise HTTPException(404, "Quotation not found in archives")
    db.execute("UPDATE quotations SET archived_at=NULL, archive_reason=NULL WHERE id=?", (quote_id,))
    log_action(db, user, "unarchive", "quotation", quote_id, q["quote_number"])
    db.commit()
    return {"message": "Quotation restored from archive"}
