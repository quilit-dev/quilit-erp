from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from typing import Optional
from datetime import datetime
from database import get_db
from permissions import require_perm, can_view
from routers.audit import log_action
from utils import _now, money
import sqlite3

import accounting
import branch_access
import currency as currency_mod
import denomination

router = APIRouter()

VAT_STATUSES = ("subject", "exempt")
INSTALMENT_FREQUENCIES = ("monthly", "quarterly", "yearly")


class ClientCreate(BaseModel):
    name: str
    company: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    type: Optional[str] = "private"
    notes: Optional[str] = None
    # What the tax authority knows them as. Printed on their documents.
    financial_id: Optional[str] = None
    # None means "whatever the company bills in", so changing the company
    # currency does not orphan every customer record.
    preferred_currency: Optional[str] = None
    vat_status: str = "subject"
    # A DEFAULT for their invoices, not a rule those invoices must obey.
    allow_installments: bool = True
    default_installment_count: Optional[int] = None
    default_installment_frequency: Optional[str] = None

    @validator("vat_status")
    def _known_vat_status(cls, v):
        if (v or "subject").lower() not in VAT_STATUSES:
            raise ValueError("VAT status must be one of: " + ", ".join(VAT_STATUSES))
        return (v or "subject").lower()

    @validator("preferred_currency")
    def _known_currency(cls, v):
        if v in (None, ""):
            return None
        import currency as currency_mod
        if not currency_mod.is_supported(v):
            raise ValueError("Currency must be one of: "
                             + ", ".join(currency_mod.SUPPORTED))
        return v.upper()

    @validator("default_installment_frequency")
    def _known_frequency(cls, v):
        if v in (None, ""):
            return None
        if v.lower() not in INSTALMENT_FREQUENCIES:
            raise ValueError("Frequency must be one of: "
                             + ", ".join(INSTALMENT_FREQUENCIES))
        return v.lower()

    @validator("default_installment_count")
    def _sensible_count(cls, v):
        if v is not None and int(v) < 1:
            raise ValueError("An instalment plan needs at least one instalment.")
        return v

class ArchiveRequest(BaseModel):
    reason: Optional[str] = None

@router.get("/")
def list_clients(search: Optional[str] = None, type: Optional[str] = None,
                 include_archived: bool = False,
                 limit: Optional[int] = None, offset: int = 0,
                 sort: Optional[str] = None, dir: str = "asc",
                 user=Depends(require_perm("clients", "view")), db: sqlite3.Connection = Depends(get_db)):
    # Default view hides archived rows. `include_archived=1` returns them too
    # (each carries archived_at) so the list can offer an in-module "Show
    # archived" filter with inline Restore — the primary archive UX (Option A).
    # The WHERE clause is built once and shared by the row query and the COUNT,
    # so the two can never drift apart and disagree about the total.
    where  = ["1=1"]
    params = []
    if not include_archived:
        where.append("archived_at IS NULL")
    if search:
        where.append("(name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?)")
        s = f"%{search}%"
        params.extend([s, s, s, s])
    if type:
        where.append("type = ?")
        params.append(type)
    where_clause = " WHERE " + " AND ".join(where)

    # Sorting from a fixed allow-list: `sort` reaches ORDER BY, which takes no
    # bind parameters, so only a value from this map may be interpolated.
    _SORTABLE = {"name": "name", "company": "company", "type": "type",
                 "phone": "phone", "email": "email", "created_at": "created_at"}
    _direction = "DESC" if str(dir).lower() == "desc" else "ASC"
    order_sql = (f" ORDER BY {_SORTABLE[sort]} {_direction}"
                 if sort in _SORTABLE else " ORDER BY created_at DESC")

    # Pagination, matching the invoices convention: with no `limit` the response
    # is the full array exactly as before, so every existing caller is
    # untouched. Pass `limit` (capped at 500) for a
    # {items, total, limit, offset} envelope.
    if limit is not None:
        cap   = max(1, min(limit, 500))
        total = db.execute(f"SELECT COUNT(*) FROM clients{where_clause}",
                           params).fetchone()[0]
        rows  = db.execute(
            f"SELECT * FROM clients{where_clause}{order_sql}"
            f" LIMIT ? OFFSET ?", params + [cap, offset]).fetchall()
        return {"items": [dict(r) for r in rows], "total": total,
                "limit": cap, "offset": offset}

    rows = db.execute(
        f"SELECT * FROM clients{where_clause}{order_sql}",
        params).fetchall()
    return [dict(r) for r in rows]

@router.get("/{client_id}")
def get_client(client_id: int, user=Depends(require_perm("clients", "view")), db: sqlite3.Connection = Depends(get_db)):
    # Archived clients are still viewable (the list's "Show archived" opens the
    # detail) — only writes are blocked elsewhere. So no archived_at filter here.
    row = db.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found")

    projects = db.execute(
        """SELECT id, name, status, estimated_cost, actual_cost, start_date, end_date, location
           FROM projects WHERE client_id = ? AND archived_at IS NULL ORDER BY created_at DESC""",
        (client_id,)
    ).fetchall()

    quotations = db.execute(
        """SELECT q.id, q.quote_number, q.status, q.total, q.created_at, q.project_id,
                  p.name AS project_name
           FROM quotations q
           LEFT JOIN projects p ON p.id = q.project_id
           WHERE q.client_id = ? AND q.archived_at IS NULL ORDER BY q.created_at DESC""",
        (client_id,)
    ).fetchall()

    invoices = db.execute(
        """SELECT i.id, i.invoice_number, i.amount, i.due_date, i.created_at, i.project_id,
                  p.name AS project_name,
                  COALESCE(SUM(ip.amount), 0) AS paid_amount,
                  CASE
                    WHEN COALESCE(SUM(ip.amount), 0) = 0 THEN 'Unpaid'
                    WHEN COALESCE(SUM(ip.amount), 0) >= i.amount THEN 'Paid'
                    ELSE 'Partial'
                  END AS status
           FROM invoices i
           LEFT JOIN projects p ON p.id = i.project_id
           LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
           WHERE i.client_id = ? AND i.archived_at IS NULL
           GROUP BY i.id, p.name ORDER BY i.created_at DESC""",
        (client_id,)
    ).fetchall()

    # The customer's machines and the work done on them. Guarded by the module
    # permission rather than the clients one: a salesperson who may read a client
    # has no business reading their service history, and a tenant that has not
    # licensed service has no such tables to read.
    equipment, service_jobs = [], []
    if can_view(user, db, "service"):
        equipment = db.execute(
            """SELECT id, name, manufacturer, model, serial_number, install_date,
                      location
               FROM service_equipment
               WHERE client_id = ? AND archived_at IS NULL ORDER BY name""",
            (client_id,)
        ).fetchall()
        service_jobs = db.execute(
            """SELECT j.id, j.job_number, j.job_type, j.status, j.scheduled_date,
                      j.completed_at, j.total, e.name AS equipment_name
               FROM service_jobs j
               LEFT JOIN service_equipment e ON e.id = j.equipment_id
               WHERE j.client_id = ? AND j.archived_at IS NULL
               ORDER BY COALESCE(j.completed_at, j.scheduled_date, j.created_at) DESC""",
            (client_id,)
        ).fetchall()

    # Documents attached to this client
    documents = db.execute(
        """SELECT id, record_type, record_id, title, created_at
           FROM documents WHERE client_id = ? ORDER BY created_at DESC""",
        (client_id,)
    ).fetchall()

    total_invoiced = sum(i["amount"] or 0 for i in invoices)
    total_paid     = sum(i["paid_amount"] or 0 for i in invoices)
    total_quoted   = sum(q["total"] or 0 for q in quotations)

    result = dict(row)
    result["projects"]   = [dict(p) for p in projects]
    result["quotations"] = [dict(q) for q in quotations]
    result["invoices"]   = [dict(i) for i in invoices]
    result["documents"]  = [dict(d) for d in documents]
    result["equipment"]    = [dict(e) for e in equipment]
    result["service_jobs"] = [dict(j) for j in service_jobs]
    result["stats"] = {
        "project_count":   len(projects),
        "quotation_count": len(quotations),
        "invoice_count":   len(invoices),
        "total_quoted":    total_quoted,
        "total_invoiced":  total_invoiced,
        "total_paid":      total_paid,
        "outstanding":     total_invoiced - total_paid,
    }
    return result

@router.post("/")
def create_client(data: ClientCreate, user=Depends(require_perm("clients", "create")), db: sqlite3.Connection = Depends(get_db)):
    now = _now()
    c = db.execute(
        "INSERT INTO clients (name, company, phone, email, address, type, notes, "
        "financial_id, preferred_currency, vat_status, allow_installments, default_installment_count, default_installment_frequency, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (data.name, data.company, data.phone, data.email, data.address, data.type,
         data.notes, data.financial_id, data.preferred_currency, data.vat_status,
         1 if data.allow_installments else 0,
         data.default_installment_count, data.default_installment_frequency, now)
    )
    log_action(db, user, "create", "client", c.lastrowid, data.name)
    db.commit()
    return {"id": c.lastrowid, "message": "Client created"}

@router.put("/{client_id}")
def update_client(client_id: int, data: ClientCreate, user=Depends(require_perm("clients", "edit")), db: sqlite3.Connection = Depends(get_db)):
    # A soft-deleted (or non-existent) client must not be updatable.
    if not db.execute(
        "SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL", (client_id,)
    ).fetchone():
        raise HTTPException(404, "Client not found")
    db.execute(
        "UPDATE clients SET name=?, company=?, phone=?, email=?, address=?, type=?, "
        " notes=?, financial_id=?, preferred_currency=?, vat_status=?, "
        " allow_installments=?, default_installment_count=?, "
        " default_installment_frequency=? WHERE id=?",
        (data.name, data.company, data.phone, data.email, data.address, data.type,
         data.notes, data.financial_id, data.preferred_currency, data.vat_status,
         1 if data.allow_installments else 0,
         data.default_installment_count, data.default_installment_frequency, client_id)
    )
    log_action(db, user, "update", "client", client_id, data.name)
    db.commit()
    return {"message": "Client updated"}

@router.patch("/{client_id}/archive")
def archive_client(client_id: int, data: ArchiveRequest = ArchiveRequest(),
                   user=Depends(require_perm("clients", "delete")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM clients WHERE id = ? AND archived_at IS NULL", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found")
    active_projects = db.execute(
        "SELECT COUNT(*) FROM projects WHERE client_id = ? AND archived_at IS NULL AND status NOT IN ('Cancelled','Voided','Completed','Invoiced')",
        (client_id,)
    ).fetchone()[0]
    if active_projects:
        raise HTTPException(400, f"Cannot archive: this client has {active_projects} active project(s). Void or complete them first.")
    now = _now()
    db.execute(
        "UPDATE clients SET archived_at=?, archive_reason=? WHERE id=?",
        (now, data.reason or "Archived", client_id)
    )
    log_action(db, user, "archive", "client", client_id, row["name"], {"reason": data.reason})
    db.commit()
    return {"message": "Client archived"}

@router.patch("/{client_id}/unarchive")
def unarchive_client(client_id: int, user=Depends(require_perm("clients", "edit")), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM clients WHERE id = ? AND archived_at IS NOT NULL", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found in archives")
    db.execute("UPDATE clients SET archived_at=NULL, archive_reason=NULL WHERE id=?", (client_id,))
    log_action(db, user, "unarchive", "client", client_id, row["name"])
    db.commit()
    return {"message": "Client restored from archive"}


@router.get("/{client_id}/statement")
def client_statement(client_id: int,
                     start: Optional[str] = None, end: Optional[str] = None,
                     user=Depends(require_perm("clients", "view")),
                     db: sqlite3.Connection = Depends(get_db)):
    """A statement of account: what was invoiced, what was paid, what is left.

    One chronological run of movements with a running balance, which is the
    document a customer asks for when they want to know why they owe what they
    owe. Built from invoices and their payments rather than from the ledger:
    the ledger knows the totals but not which invoice a payment settled, and
    that is the whole question a statement answers.

    An opening balance carries in everything before `start`, so a period
    statement still adds up rather than beginning mid-story.
    """
    row = db.execute(
        "SELECT id, name, company, financial_id, preferred_currency, vat_status "
        "FROM clients WHERE id=? AND deleted_at IS NULL", (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found")

    invoices = db.execute(
        "SELECT id, invoice_number, created_at, amount, voided_at, "
        "       currency, exchange_rate, txn_amount "
        "FROM invoices WHERE client_id=? AND archived_at IS NULL "
        "ORDER BY created_at, id", (client_id,)).fetchall()
    live = [i for i in invoices if not i["voided_at"]]
    ids = [i["id"] for i in live]

    # A statement is a document the customer reads, so it is written in the
    # currency they were billed in — but only when that can be done exactly.
    # Where their invoices span currencies, a single running balance in one of
    # them would need rate assumptions the statement cannot justify, so it
    # falls back to the company's own currency and says which it used.
    seen = {(i["currency"] or denomination.base_currency()).upper() for i in live}
    mixed = len(seen) > 1
    stmt_currency = (next(iter(seen)) if len(seen) == 1
                     else denomination.base_currency())
    in_txn = stmt_currency != denomination.base_currency()

    payments = []
    if ids:
        ph = ",".join("?" * len(ids))
        payments = db.execute(
            f"SELECT p.id, p.invoice_id, p.amount, p.method, p.paid_at, "
            f"       p.paid_currency, p.paid_amount, p.txn_amount, i.invoice_number "
            f"FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id "
            f"WHERE p.invoice_id IN ({ph}) ORDER BY p.paid_at, p.id", ids).fetchall()

    # One list of movements: an invoice adds to what is owed, a payment reduces
    # it. Sorted together so the running balance reads the way it happened.
    movements = []
    for i in live:
        movements.append({
            "date": (i["created_at"] or "")[:10], "_ts": i["created_at"] or "",
            "type": "invoice",
            "reference": i["invoice_number"], "invoice_id": i["id"],
            "description": f"Invoice {i['invoice_number']}",
            # The figure the customer agreed, when the statement is in their
            # currency; the company's figure otherwise. Both travel, so a
            # reader that wants the other one has it.
            "charged": money(i["txn_amount"] if in_txn and i["txn_amount"] is not None
                             else i["amount"]),
            "paid": 0.0,
            "base_charged": money(i["amount"]), "base_paid": 0.0,
        })
    for p in payments:
        movements.append({
            "date": (p["paid_at"] or "")[:10], "_ts": p["paid_at"] or "",
            "type": "payment",
            "reference": p["invoice_number"], "invoice_id": p["invoice_id"],
            "description": f"Payment — {p['method'] or 'Cash'}"
                           + (f" ({p['paid_currency']})" if p["paid_currency"] not in (None, "USD") else ""),
            "charged": 0.0,
            "paid": money(p["txn_amount"] if in_txn and p["txn_amount"] is not None
                          else p["amount"]),
            "base_charged": 0.0, "base_paid": money(p["amount"]),
        })
    # Ordered by when it actually happened, not merely by day: several
    # movements on one date must read in sequence or the running balance tells
    # a story that did not occur. The type only breaks a tie between two
    # identical timestamps, where an invoice necessarily precedes its payment.
    movements.sort(key=lambda m: (m["_ts"], 0 if m["type"] == "invoice" else 1))

    opening = 0.0
    if start:
        before = [m for m in movements if m["date"] < start[:10]]
        opening = money(sum(m["charged"] - m["paid"] for m in before))
        movements = [m for m in movements if m["date"] >= start[:10]]
    if end:
        movements = [m for m in movements if m["date"] <= end[:10]]

    balance = opening
    for m in movements:
        m.pop("_ts", None)
        balance = money(balance + m["charged"] - m["paid"])
        m["balance"] = balance

    charged = money(sum(m["charged"] for m in movements))
    paid = money(sum(m["paid"] for m in movements))
    return {
        "client": {"id": row["id"], "name": row["name"], "company": row["company"],
                   "financial_id": row["financial_id"],
                   "preferred_currency": row["preferred_currency"],
                   "vat_status": row["vat_status"]},
        "start": start, "end": end,
        # What the figures on this statement are denominated in, so the reader
        # formats them as what they are rather than assuming dollars.
        "currency": stmt_currency,
        "base_currency": denomination.base_currency(),
        # True when this customer has been billed in more than one currency,
        # which is why the statement fell back to the company's own.
        "mixed_currencies": mixed,
        "opening_balance": opening,
        "movements": movements,
        "total_charged": charged,
        "total_paid": paid,
        "closing_balance": money(opening + charged - paid),
    }


# ══════════════════════════════════════════════════════════════════════════════
# SETTLING SEVERAL INVOICES AT ONCE
# ══════════════════════════════════════════════════════════════════════════════
class CustomerPayment(BaseModel):
    amount:          float
    method:          str = "Cash"
    currency:        str = "USD"
    exchange_rate:   Optional[float] = None
    note:            Optional[str] = None
    cash_drawer_id:  Optional[int] = None
    bank_account_id: Optional[int] = None
    idempotency_key: Optional[str] = None

    @validator("amount")
    def _positive(cls, v):
        if float(v or 0) <= 0:
            raise ValueError("A payment must be for more than nothing.")
        return v


@router.get("/{client_id}/payments")
def list_customer_payments(
    client_id: int,
    user=Depends(require_perm("invoices", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Payments this customer has made against their account, newest first.

    One row per payment as the customer made it, with the invoices it reached
    — not one row per allocation, which is how the ledger stores it and not
    how anybody remembers paying.
    """
    if not db.execute("SELECT 1 FROM clients WHERE id=? AND deleted_at IS NULL",
                      (client_id,)).fetchone():
        raise HTTPException(404, "Client not found")

    rows = []
    for p in db.execute(
        "SELECT * FROM customer_payments WHERE client_id=? ORDER BY id DESC",
        (client_id,),
    ).fetchall():
        d = dict(p)
        d["allocated"] = [dict(a) for a in db.execute(
            "SELECT ip.invoice_id, ip.amount AS applied, i.invoice_number "
            "FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id "
            "WHERE ip.customer_payment_id=? ORDER BY ip.id", (p["id"],))]
        rows.append(d)
    return rows


@router.post("/payments/{payment_id}/voucher")
def issue_payment_voucher(
    payment_id: int,
    user=Depends(require_perm("invoices", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """The voucher number for one customer payment, allocating it on first use.

    The SAME number every time, exactly as the per-invoice voucher works: a
    receipt is one document that gets reprinted, and minting a fresh number per
    printing would leave a customer holding two receipts for money handed over
    once. The unique index on the column makes that unrepresentable.

    `view` rather than a write permission: printing the receipt for a payment
    you are already allowed to see should not need more, and the uniqueness
    bounds what the write can do to one row.
    """
    pay = db.execute(
        "SELECT p.*, c.name AS client_name FROM customer_payments p "
        "LEFT JOIN clients c ON c.id = p.client_id WHERE p.id=?",
        (payment_id,)).fetchone()
    if not pay:
        raise HTTPException(404, "Payment not found")

    allocated = [dict(a) for a in db.execute(
        "SELECT ip.invoice_id, ip.amount AS applied, i.invoice_number, i.branch_id "
        "FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id "
        "WHERE ip.customer_payment_id=? ORDER BY ip.id", (payment_id,))]

    # Branch scoping, as everywhere else: a scoped user must not read another
    # branch's receipts by guessing a payment id.
    for a in allocated:
        branch_access.assert_can_view_branch(user, db, a["branch_id"])

    body = {
        "id": pay["id"],
        "client": {"id": pay["client_id"], "name": pay["client_name"]},
        "amount": pay["amount"],
        "currency": pay["currency"],
        "paid_amount": pay["paid_amount"],
        "exchange_rate": pay["exchange_rate"],
        "method": pay["method"],
        "note": pay["note"],
        "created_at": pay["created_at"],
        "allocated": [{k: a[k] for k in ("invoice_id", "invoice_number", "applied")}
                      for a in allocated],
    }

    if pay["voucher_number"]:
        return {**body, "number": pay["voucher_number"], "issued": False}

    from utils import get_setting
    prefix = get_setting(db, "receipt_voucher_prefix") or "RV-"
    # Derived from the row's own id, as invoice and invoice-voucher numbers are:
    # unique by construction, so two concurrent issues cannot collide the way a
    # MAX()+1 read-then-write would.
    number = f"{prefix}{datetime.utcnow().year}-C{payment_id:04d}"
    db.execute("UPDATE customer_payments SET voucher_number=? WHERE id=?",
               (number, payment_id))
    log_action(db, user, "issue_payment_voucher", "client", pay["client_id"],
               pay["client_name"], {"number": number, "amount": pay["amount"],
                                    "invoices": len(allocated)})
    db.commit()
    return {**body, "number": number, "issued": True}


@router.post("/{client_id}/payments")
def record_customer_payment(
    client_id: int,
    data: CustomerPayment,
    user=Depends(require_perm("invoices", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Take one payment against a customer and settle their oldest bills first.

    A customer hands over money for "the account", not for invoice #114. Making
    the operator split it themselves is how the wrong invoice gets marked paid
    and an old one sits open for months.

    Allocation is oldest-first, which is the ordinary rule and the one that
    keeps a ledger tidy: it clears the debt most likely to be chased. The
    payment is broken into one `invoice_payments` row per invoice it touches,
    so every balance, statement and ledger posting in the system keeps working
    exactly as it did — nothing downstream learns a new concept.

    Overpayment is refused rather than parked. A credit balance is a real
    accounting object with its own rules, and inventing one here as a side
    effect of a rounding difference would be worse than asking.
    """
    row = db.execute("SELECT id, name FROM clients WHERE id=? AND deleted_at IS NULL",
                     (client_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Client not found")

    if data.idempotency_key and db.execute(
            "SELECT 1 FROM invoice_payments WHERE idempotency_key=?",
            (data.idempotency_key,)).fetchone():
        raise HTTPException(409, "This payment was already recorded (duplicate submission).")

    usd = currency_mod.to_usd(data.amount, data.currency, db, data.exchange_rate)
    rate = (currency_mod.resolve_rate(db, data.exchange_rate, data.currency)
            if (data.currency or "USD").upper() != "USD" else None)

    # Oldest first. An invoice awaiting approval is a draft and takes no money;
    # a voided one is not owed.
    open_invoices = db.execute(
        """SELECT i.id, i.invoice_number, i.amount, i.branch_id,
                  i.currency, i.exchange_rate,
                  COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                            WHERE p.invoice_id = i.id), 0) AS paid
             FROM invoices i
            WHERE i.client_id = ? AND i.voided_at IS NULL AND i.archived_at IS NULL
              AND COALESCE(i.approval_status,'') != 'Pending Approval'
         ORDER BY COALESCE(i.due_date, i.created_at), i.id""",
        (client_id,)).fetchall()

    owing = [(r, money(float(r["amount"]) - float(r["paid"]))) for r in open_invoices]
    owing = [(r, d) for r, d in owing if d > 0.005]

    # What is owed, expressed in the money the customer is handing over. An
    # invoice raised in euro is owed in euro: what clears it is 5,000 euro, not
    # whatever 5,000 euro happens to be worth in dollars today. Allocating in
    # base would leave a foreign invoice a few dollars short of settled every
    # time the rate had moved since it was raised.
    def _needed(row, due_base):
        """What is owed on this invoice, counted in the money being handed over.

        Both branches convert INTO the tender currency. Returning the base
        figure when the currencies differ compares pounds against dollars: a
        million pounds against a hundred-dollar invoice reads as an
        overpayment when it is ten dollars of it.
        """
        inv_cur = (row["currency"] or denomination.base_currency()).upper()
        tender = (data.currency or "USD").upper()
        if inv_cur == tender:
            # The debt is denominated in what they are paying, so it is
            # cleared at the rate it was raised at.
            return money(due_base * float(row["exchange_rate"] or 1))
        # Paid in something else: the debt is cleared at what the money is
        # worth today, so the base figure converts at the tender's own rate.
        return money(due_base * float(rate or 1))

    owed_in_tender = money(sum(_needed(r, d) for r, d in owing))
    total_owed = money(sum(d for _, d in owing))

    if not owing:
        raise HTTPException(400, f"{row['name']} has nothing outstanding.")
    # Measured in what they are handing over, for the same reason.
    if money(data.amount) > owed_in_tender + 0.005:
        raise HTTPException(
            400,
            f"{money(data.amount):,.2f} is more than the "
            f"{owed_in_tender:,.2f} outstanding. "
            "Reduce the amount, or raise an invoice for the difference first.")

    # The payment itself, before its allocations. A customer handed over one
    # sum; the split into per-invoice rows is bookkeeping, and the receipt they
    # are given has to describe the sum.
    batch_cur = db.execute(
        "INSERT INTO customer_payments "
        "(client_id, amount, currency, paid_amount, exchange_rate, method, note, "
        " created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
        (client_id, usd, (data.currency or "USD").upper(),
         currency_mod.from_usd(usd, data.currency, db, data.exchange_rate)
         if (data.currency or "USD").upper() != "USD" else usd,
         rate, data.method, data.note, _now(), user["id"]))
    batch_id = batch_cur.lastrowid

    # Walked in the currency the customer is handing over, oldest first.
    left_tender, allocated = money(data.amount), []
    for inv, due in owing:
        if left_tender <= 0.005:
            break
        take_tender = money(min(left_tender, _needed(inv, due)))
        left_tender = money(left_tender - take_tender)

        # What that slice settles, and what it costs in exchange. On an invoice
        # in the company's own currency every figure is the number this code
        # always used.
        try:
            s = denomination.settle(
                db,
                invoice_currency=inv["currency"],
                invoice_rate=inv["exchange_rate"],
                tender_currency=(data.currency or "USD").upper(),
                tender_amount=take_tender, tender_rate=rate, on_date=_now()[:10])
        except denomination.RateUnavailable as e:
            raise HTTPException(400, str(e))

        # Per-invoice rows, so every balance and statement in the system keeps
        # reading the same way it always has.
        pay_cur = db.execute(
            "INSERT INTO invoice_payments "
            "(invoice_id, amount, method, note, paid_at, idempotency_key, "
            " paid_currency, paid_amount, exchange_rate, cash_drawer_id, "
            " bank_account_id, customer_payment_id, txn_amount, fx_difference) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (inv["id"], s["obligation_base"], data.method, data.note, _now(),
             # Only the first row carries the key: it identifies the operator's
             # single submission, and the column is unique.
             data.idempotency_key if not allocated else None,
             (data.currency or "USD").upper(),
             take_tender,
             rate, data.cash_drawer_id, data.bank_account_id, batch_id,
             s["txn_settled"], s["fx_difference"]))
        accounting.post_entry(
            db,
            entry_date=_now()[:10],
            memo=f"Payment received — {inv['invoice_number']}",
            lines=accounting.payment_lines(
                db, inv["id"],
                cash_code=accounting.money_account_for(
                    db, method=data.method, currency=data.currency,
                    bank_account_id=data.bank_account_id),
                amount=s["cash_base"],
                obligation=s["obligation_base"],
                method_memo=f"{data.method} ({(data.currency or 'USD').upper()})"),
            source_type="invoice_payment", source_id=pay_cur.lastrowid,
            created_by=user["id"], branch_id=inv["branch_id"])
        take = s["obligation_base"]
        allocated.append({
            "invoice_id": inv["id"], "invoice_number": inv["invoice_number"],
            "applied": take, "was_owing": due,
            "now_owing": money(due - take), "settled": (due - take) <= 0.005,
        })

    log_action(db, user, "payment", "client", client_id, row["name"],
               {"amount": money(usd), "invoices": len(allocated),
                "currency": (data.currency or "USD").upper()})
    db.commit()
    return {
        "message": f"{money(usd):,.2f} applied across {len(allocated)} invoice(s)",
        "client": {"id": client_id, "name": row["name"]},
        # The id the receipt is written against.
        "payment_id": batch_id,
        "amount": money(usd),
        "allocated": allocated,
        "still_outstanding": money(total_owed - usd),
    }
