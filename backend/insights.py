"""What the whole business looks like right now, in numbers worth acting on.

The insight panel used to read whatever the Finance page happened to have
fetched, which meant it could only ever talk about income, expenses and the
ledger. Everything a business actually goes wrong at — stock nobody has moved
in three months, a completed repair nobody invoiced, one customer who is 60%
of revenue — lived in tables it never looked at.

So the scanning happens here, in SQL, across every module the caller may see.
Each block is a handful of aggregates: the counts, sums and shares a rule can
be written against, and nothing else. That keeps the payload small enough to
send on every page load and puts the work where the data is — a rule about
dead stock has to look at every item, and the browser cannot.

Two things this deliberately does NOT do.

It writes no prose. Every figure comes back as a number and the wording is
rendered from the message catalogue on the client, so English and Arabic are
one translation of one sentence rather than two strings that drift.

And it decides nothing. Which figures are worth surfacing, in what order, is
the rule engine's job; this only reports. A rule that changes its threshold
must not need a backend deploy.

Every block is permission- AND licence-gated: a user who cannot view a module
gets no key for it, and neither does a tenant that has not licensed it. A
missing key means "not visible to you", which the client renders as nothing at
all — never as a zero, which would read as a fact about the business.
"""
import sqlite3
from datetime import date, timedelta
from typing import Optional

import vendor_config
from permissions import can_view

# An item that has not sold in this long, while still holding stock, is money
# sitting on a shelf. A quarter is the shortest window that does not simply
# rediscover seasonality.
DEAD_STOCK_DAYS = 90
# A purchase order still "Ordered" after this long is either goods that never
# arrived or a receipt nobody recorded. Both leave the books wrong.
PO_STUCK_DAYS = 30
# A deal nobody has touched in this long is not a pipeline, it is a list.
DEAL_STALE_DAYS = 45
# A production order in progress this long has stopped being in progress.
WIP_STALLED_DAYS = 14


def _one(db, sql, params=(), default=0):
    """A single scalar, or `default` if the table is not there yet."""
    try:
        row = db.execute(sql, params).fetchone()
    except sqlite3.Error:
        # A tenant provisioned before a table existed degrades to "no signal",
        # never to a wrong number and never to a 500 on a read-only panel.
        return default
    if row is None:
        return default
    v = row[0]
    return default if v is None else v


def _rows(db, sql, params=()):
    try:
        return [dict(r) for r in db.execute(sql, params).fetchall()]
    except sqlite3.Error:
        return []


def _pct(part, whole):
    part, whole = float(part or 0), float(whole or 0)
    return round(part / whole * 100, 1) if whole > 0.005 else None


def _visible(db, user, module) -> bool:
    return bool(can_view(user, db, module) and vendor_config.module_allowed(module))


# ── The blocks ───────────────────────────────────────────────────────────────

def _inventory(db, since_dead):
    """Stock that is not earning: empty, low, stale, or priced under cost."""
    tracked = _one(db, "SELECT COUNT(*) FROM inventory "
                       "WHERE deleted_at IS NULL AND archived_at IS NULL")
    value = _one(db, "SELECT COALESCE(SUM(quantity * COALESCE(unit_cost,0)),0) "
                     "FROM inventory WHERE deleted_at IS NULL "
                     "AND archived_at IS NULL AND quantity > 0")

    # Out of stock, but sold recently — the only stockout that costs anything.
    stockout = _rows(db, """
        SELECT i.name FROM inventory i
         WHERE i.deleted_at IS NULL AND i.archived_at IS NULL
           AND i.quantity <= 0
           AND EXISTS (SELECT 1 FROM invoice_items it
                        JOIN invoices inv ON inv.id = it.invoice_id
                       WHERE it.inventory_id = i.id
                         AND inv.voided_at IS NULL
                         AND inv.created_at >= ?)
         ORDER BY i.name LIMIT 5""", (since_dead,))

    low = _rows(db, """
        SELECT name, quantity, min_stock FROM inventory
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND COALESCE(min_stock,0) > 0 AND quantity > 0
           AND quantity <= min_stock
         ORDER BY (quantity * 1.0 / min_stock) LIMIT 5""")
    low_n = _one(db, """
        SELECT COUNT(*) FROM inventory
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND COALESCE(min_stock,0) > 0 AND quantity > 0
           AND quantity <= min_stock""")

    # Holding stock, nothing sold in the window: cash on a shelf.
    dead_sql = """
        FROM inventory i
        WHERE i.deleted_at IS NULL AND i.archived_at IS NULL
          AND i.quantity > 0 AND COALESCE(i.unit_cost,0) > 0
          AND NOT EXISTS (SELECT 1 FROM invoice_items it
                           JOIN invoices inv ON inv.id = it.invoice_id
                          WHERE it.inventory_id = i.id
                            AND inv.voided_at IS NULL
                            AND inv.created_at >= ?)"""
    dead_value = _one(db, "SELECT COALESCE(SUM(i.quantity * i.unit_cost),0) "
                          + dead_sql, (since_dead,))
    dead_n = _one(db, "SELECT COUNT(*) " + dead_sql, (since_dead,))

    # Priced below what it cost to buy. Every sale of one loses money.
    under = _rows(db, """
        SELECT name, sale_price, unit_cost FROM inventory
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND COALESCE(sale_price,0) > 0 AND COALESCE(unit_cost,0) > 0
           AND sale_price < unit_cost
         ORDER BY (unit_cost - sale_price) DESC LIMIT 5""")

    reserved = _one(db, "SELECT COALESCE(SUM(reserved_quantity),0) FROM inventory "
                        "WHERE deleted_at IS NULL AND archived_at IS NULL")
    on_hand = _one(db, "SELECT COALESCE(SUM(quantity),0) FROM inventory "
                       "WHERE deleted_at IS NULL AND archived_at IS NULL")

    return {
        "tracked": tracked,
        "stock_value": round(float(value), 2),
        "stockout_selling": len(stockout),
        "stockout_top": stockout[0]["name"] if stockout else None,
        "below_reorder": low_n,
        "below_reorder_top": low[0]["name"] if low else None,
        "dead_value": round(float(dead_value), 2),
        "dead_count": dead_n,
        "dead_share": _pct(dead_value, value),
        "under_cost": len(under),
        "under_cost_top": under[0]["name"] if under else None,
        "reserved_share": _pct(reserved, on_hand),
    }


def _sales(db, start, end):
    """Where the revenue came from, and what was given away to get it."""
    gross = _one(db, """
        SELECT COALESCE(SUM(amount),0) FROM invoices
         WHERE voided_at IS NULL AND archived_at IS NULL
           AND COALESCE(approval_status,'') != 'Pending Approval'
           AND created_at >= ? AND created_at <= ?""", (start, end + " 23:59:59"))
    invoices_n = _one(db, """
        SELECT COUNT(*) FROM invoices
         WHERE voided_at IS NULL AND archived_at IS NULL
           AND created_at >= ? AND created_at <= ?""", (start, end + " 23:59:59"))

    discount = _one(db, """
        SELECT COALESCE(SUM(it.discount),0)
          FROM invoice_items it JOIN invoices inv ON inv.id = it.invoice_id
         WHERE inv.voided_at IS NULL AND inv.archived_at IS NULL
           AND inv.created_at >= ? AND inv.created_at <= ?""",
                     (start, end + " 23:59:59"))

    top_item = _rows(db, """
        SELECT it.name AS name,
               COALESCE(SUM(it.quantity * it.unit_price),0) AS total
          FROM invoice_items it JOIN invoices inv ON inv.id = it.invoice_id
         WHERE inv.voided_at IS NULL AND inv.archived_at IS NULL
           AND inv.created_at >= ? AND inv.created_at <= ?
         GROUP BY it.name ORDER BY total DESC LIMIT 1""",
                     (start, end + " 23:59:59"))

    top_client = _rows(db, """
        SELECT c.name AS name, COALESCE(SUM(i.amount),0) AS total
          FROM invoices i JOIN clients c ON c.id = i.client_id
         WHERE i.voided_at IS NULL AND i.archived_at IS NULL
           AND i.created_at >= ? AND i.created_at <= ?
         GROUP BY c.id ORDER BY total DESC LIMIT 1""",
                       (start, end + " 23:59:59"))

    return {
        "revenue": round(float(gross), 2),
        "invoices": invoices_n,
        "discount": round(float(discount), 2),
        "discount_share": _pct(discount, gross),
        "top_item": top_item[0]["name"] if top_item else None,
        "top_item_share": _pct(top_item[0]["total"], gross) if top_item else None,
        "top_client": top_client[0]["name"] if top_client else None,
        "top_client_share": _pct(top_client[0]["total"], gross) if top_client else None,
    }


def _receivables(db, start, end):
    """What is owed, and how long it takes to arrive."""
    outstanding = _one(db, """
        SELECT COALESCE(SUM(i.amount - COALESCE((
                 SELECT SUM(p.amount) FROM invoice_payments p
                  WHERE p.invoice_id = i.id), 0)), 0)
          FROM invoices i
         WHERE i.voided_at IS NULL AND i.archived_at IS NULL
           AND COALESCE(i.approval_status,'') != 'Pending Approval'""")
    billed = _one(db, """
        SELECT COALESCE(SUM(amount),0) FROM invoices
         WHERE voided_at IS NULL AND archived_at IS NULL
           AND created_at >= ? AND created_at <= ?""", (start, end + " 23:59:59"))

    days = max(1, (date.fromisoformat(end[:10]) - date.fromisoformat(start[:10])).days + 1)
    # Days sales outstanding: at this billing rate, how long the open book
    # represents. The one receivables number that is comparable month to month.
    dso = round(float(outstanding) / (float(billed) / days), 1) if billed > 0.005 else None

    today = str(date.today())
    past = _rows(db, """
        SELECT COUNT(*) AS n,
               COALESCE(SUM(i.amount - COALESCE((
                   SELECT SUM(p.amount) FROM invoice_payments p
                    WHERE p.invoice_id = i.id), 0)), 0) AS value,
               MIN(i.due_date) AS oldest
          FROM invoices i
         WHERE i.voided_at IS NULL AND i.archived_at IS NULL
           AND COALESCE(i.approval_status,'') != 'Pending Approval'
           AND i.due_date IS NOT NULL AND i.due_date < ?
           AND i.amount > COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                                     WHERE p.invoice_id = i.id), 0)""", (today,))

    return {
        "outstanding": round(float(outstanding), 2),
        "billed": round(float(billed), 2),
        "dso": dso,
        "past_due": past[0]["n"] if past else 0,
        "past_due_value": round(float(past[0]["value"]), 2) if past else 0,
        "oldest_due": (past[0]["oldest"][:10]
                       if past and past[0]["oldest"] else None),
    }


def _quotations(db, start, end):
    """How much of what was quoted turned into work."""
    span = (start, end + " 23:59:59")
    total = _one(db, "SELECT COUNT(*) FROM quotations WHERE deleted_at IS NULL "
                     "AND archived_at IS NULL AND created_at >= ? AND created_at <= ?", span)
    accepted = _one(db, "SELECT COUNT(*) FROM quotations WHERE deleted_at IS NULL "
                        "AND archived_at IS NULL AND status = 'Accepted' "
                        "AND created_at >= ? AND created_at <= ?", span)
    pending = _rows(db, """
        SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS value
          FROM quotations
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND status IN ('Draft','Sent')""")
    return {
        "quoted": total,
        "accepted": accepted,
        "win_rate": _pct(accepted, total),
        "pending": pending[0]["n"] if pending else 0,
        "pending_value": round(float(pending[0]["value"]), 2) if pending else 0,
    }


def _purchases(db, start, end):
    """Who the money goes to, and what was ordered and never received."""
    span = (start, end + " 23:59:59")
    spend = _one(db, "SELECT COALESCE(SUM(quantity * unit_cost + "
                     "COALESCE(additional_costs,0)),0) FROM purchases "
                     "WHERE deleted_at IS NULL AND archived_at IS NULL "
                     "AND ordered_at >= ? AND ordered_at <= ?", span)
    top = _rows(db, """
        SELECT supplier AS name,
               COALESCE(SUM(quantity * unit_cost + COALESCE(additional_costs,0)),0) AS total
          FROM purchases
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND ordered_at >= ? AND ordered_at <= ? AND supplier IS NOT NULL
         GROUP BY supplier ORDER BY total DESC LIMIT 1""", span)

    cutoff = (date.today() - timedelta(days=PO_STUCK_DAYS)).isoformat()
    stuck = _rows(db, """
        SELECT COUNT(*) AS n,
               COALESCE(SUM(quantity * unit_cost + COALESCE(additional_costs,0)),0) AS value
          FROM purchases
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND status = 'Ordered' AND ordered_at < ?""", (cutoff,))
    return {
        "spend": round(float(spend), 2),
        "top_supplier": top[0]["name"] if top else None,
        "top_supplier_share": _pct(top[0]["total"], spend) if top else None,
        "stuck_orders": stuck[0]["n"] if stuck else 0,
        "stuck_value": round(float(stuck[0]["value"]), 2) if stuck else 0,
        "stuck_days": PO_STUCK_DAYS,
    }


def _service(db):
    """Work that was done and never billed, and visits that never happened."""
    uninvoiced = _rows(db, """
        SELECT COUNT(*) AS n, COALESCE(SUM(j.total),0) AS value
          FROM service_jobs j
         WHERE j.archived_at IS NULL AND j.status = 'Done'
           AND COALESCE(j.total,0) > 0
           AND NOT EXISTS (SELECT 1 FROM invoices i
                            WHERE i.service_job_id = j.id AND i.voided_at IS NULL)""")
    overdue = _one(db, """
        SELECT COUNT(*) FROM service_jobs
         WHERE archived_at IS NULL AND status = 'Open'
           AND scheduled_date IS NOT NULL AND scheduled_date < ?""",
                   (str(date.today()),))
    return {
        "uninvoiced": uninvoiced[0]["n"] if uninvoiced else 0,
        "uninvoiced_value": round(float(uninvoiced[0]["value"]), 2) if uninvoiced else 0,
        "past_due": overdue,
    }


def _projects(db):
    """Jobs that have eaten their budget, and jobs nobody has billed."""
    over = _rows(db, """
        SELECT name, COALESCE(actual_cost,0) - COALESCE(estimated_cost,0) AS by_amount
          FROM projects
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND status NOT IN ('Cancelled','Completed','Invoiced')
           AND COALESCE(estimated_cost,0) > 0
           AND COALESCE(actual_cost,0) > COALESCE(estimated_cost,0)
         ORDER BY by_amount DESC LIMIT 5""")
    over_n = _one(db, """
        SELECT COUNT(*) FROM projects
         WHERE deleted_at IS NULL AND archived_at IS NULL
           AND status NOT IN ('Cancelled','Completed','Invoiced')
           AND COALESCE(estimated_cost,0) > 0
           AND COALESCE(actual_cost,0) > COALESCE(estimated_cost,0)""")
    unbilled = _rows(db, """
        SELECT COUNT(*) AS n, COALESCE(SUM(p.actual_cost),0) AS value
          FROM projects p
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
           AND p.status = 'Completed' AND COALESCE(p.actual_cost,0) > 0
           AND NOT EXISTS (SELECT 1 FROM invoices i
                            WHERE i.project_id = p.id AND i.voided_at IS NULL)""")
    return {
        "over_budget": over_n,
        "over_budget_top": over[0]["name"] if over else None,
        "over_budget_by": round(float(over[0]["by_amount"]), 2) if over else 0,
        "unbilled": unbilled[0]["n"] if unbilled else 0,
        "unbilled_value": round(float(unbilled[0]["value"]), 2) if unbilled else 0,
    }


def _crm(db):
    """What is in the pipeline, and what has gone quiet in it."""
    open_rows = _rows(db, """
        SELECT COUNT(*) AS n, COALESCE(SUM(value),0) AS value
          FROM crm_deals
         WHERE archived_at IS NULL AND stage NOT IN ('Won','Lost')""")
    stale_cut = (date.today() - timedelta(days=DEAL_STALE_DAYS)).isoformat()
    stale = _one(db, """
        SELECT COUNT(*) FROM crm_deals
         WHERE archived_at IS NULL AND stage NOT IN ('Won','Lost')
           AND COALESCE(expected_close, created_at) < ?""", (stale_cut,))
    won = _one(db, "SELECT COUNT(*) FROM crm_deals WHERE archived_at IS NULL AND stage='Won'")
    lost = _one(db, "SELECT COUNT(*) FROM crm_deals WHERE archived_at IS NULL AND stage='Lost'")
    return {
        "open": open_rows[0]["n"] if open_rows else 0,
        "open_value": round(float(open_rows[0]["value"]), 2) if open_rows else 0,
        "stale": stale,
        "stale_days": DEAL_STALE_DAYS,
        "win_rate": _pct(won, won + lost),
    }


def _hr(db, start, end):
    """What the payroll costs, against what the business earned."""
    headcount = _one(db, "SELECT COUNT(*) FROM hr_employees "
                         "WHERE archived_at IS NULL AND status = 'Active'")
    payroll = _one(db, """
        SELECT COALESCE(SUM(total_gross),0) FROM hr_payroll_runs
         WHERE archived_at IS NULL AND status IN ('Approved','Paid')
           AND period_start >= ? AND period_end <= ?""", (start, end))
    return {
        "headcount": headcount,
        "payroll": round(float(payroll), 2),
    }


def _manufacturing(db):
    """Production that started and stopped."""
    cutoff = (date.today() - timedelta(days=WIP_STALLED_DAYS)).isoformat()
    stalled = _rows(db, """
        SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(materials_cost,0)),0) AS value
          FROM production_orders
         WHERE archived_at IS NULL AND status = 'In Progress'
           AND COALESCE(started_at, created_at) < ?""", (cutoff,))
    in_progress = _one(db, "SELECT COUNT(*) FROM production_orders "
                           "WHERE archived_at IS NULL AND status = 'In Progress'")
    return {
        "in_progress": in_progress,
        "stalled": stalled[0]["n"] if stalled else 0,
        "stalled_value": round(float(stalled[0]["value"]), 2) if stalled else 0,
        "stalled_days": WIP_STALLED_DAYS,
    }


def _controls(db):
    """The bookkeeping housekeeping nobody is reminded about.

    A finished month left unlocked is a backdating hole: anyone with edit
    rights can still post into it, and the figures somebody already reported
    quietly change underneath them.
    """
    today = date.today()
    this_ym = "%04d-%02d" % (today.year, today.month)
    rows = _rows(db, "SELECT year, month, locked_at FROM accounting_periods "
                     "ORDER BY year DESC, month DESC LIMIT 24")
    stale = []
    for r in rows:
        if r.get("locked_at"):
            continue
        label = "%04d-%02d" % (int(r["year"]), int(r["month"]))
        if label == this_ym:
            continue          # the month still being traded in
        # Closed within about ten days of month end is the ordinary rhythm.
        end_of_month = date(int(r["year"]) + (int(r["month"]) == 12),
                            (int(r["month"]) % 12) + 1, 1) - timedelta(days=1)
        if (today - end_of_month).days > 10:
            stale.append(label)

    prior = _rows(db, "SELECT year, net_income FROM fiscal_years "
                      "WHERE status = 'open' AND year < ? ORDER BY year LIMIT 1",
                  (today.year,))
    return {
        "unlocked_periods": len(stale),
        "unlocked_latest": stale[0] if stale else None,
        "open_prior_year": prior[0]["year"] if prior else None,
        "open_prior_income": (round(float(prior[0]["net_income"] or 0), 2)
                              if prior else 0),
        # Only worth nagging about a prior year once the ordinary close
        # window — the first quarter of the new year — has passed.
        "past_close_window": today.month > 3,
    }


def _cash(db):
    """Till closes that did not balance. One is a bad night; a pattern is not."""
    recent = _rows(db, "SELECT variance FROM cash_reconciliations "
                       "WHERE status IS NULL OR status != 'void' "
                       "ORDER BY id DESC LIMIT 10")
    off = [r for r in recent if abs(float(r["variance"] or 0)) > 0.01]
    short = sum(min(0.0, float(r["variance"] or 0)) for r in off)
    return {
        "checked": len(recent),
        "off": len(off),
        "short": round(abs(short), 2),
    }


def _fx(db):
    """How old the rate every dual-currency posting is booking at."""
    row = _rows(db, "SELECT rate, created_at FROM exchange_rates "
                    "ORDER BY id DESC LIMIT 1")
    if not row or not row[0].get("created_at"):
        return {"age_days": None, "rate": None}
    try:
        age = (date.today()
               - date.fromisoformat(str(row[0]["created_at"])[:10])).days
    except ValueError:
        return {"age_days": None, "rate": None}
    return {"age_days": age, "rate": float(row[0]["rate"] or 0)}


# A month's worth of each frequency, so weekly, quarterly and annual costs all
# collapse to one comparable figure.
_PER_MONTH = {"weekly": 1 / 4.33, "monthly": 1.0, "quarterly": 3.0, "annual": 12.0}


def _recurring(db):
    """What the business is committed to before it sells anything."""
    rows = _rows(db, "SELECT name, amount, frequency, next_run_date "
                     "FROM recurring_expenses "
                     "WHERE is_active = 1 AND archived_at IS NULL")
    monthly = sum(float(r["amount"] or 0) / _PER_MONTH.get(r["frequency"], 1.0)
                  for r in rows)
    today = str(date.today())
    overdue = [r for r in rows
               if r.get("next_run_date") and str(r["next_run_date"])[:10] < today]
    return {
        "active": len(rows),
        "monthly": round(monthly, 2),
        "overdue": len(overdue),
        "overdue_top": overdue[0]["name"] if overdue else None,
    }


# ── The scan ─────────────────────────────────────────────────────────────────

_BLOCKS = (
    # key            module          builder
    ("inventory",     "inventory",     lambda db, s, e, d: _inventory(db, d)),
    ("sales",         "invoices",      lambda db, s, e, d: _sales(db, s, e)),
    ("receivables",   "invoices",      lambda db, s, e, d: _receivables(db, s, e)),
    ("quotations",    "quotations",    lambda db, s, e, d: _quotations(db, s, e)),
    ("purchases",     "purchases",     lambda db, s, e, d: _purchases(db, s, e)),
    ("service",       "service",       lambda db, s, e, d: _service(db)),
    ("projects",      "projects",      lambda db, s, e, d: _projects(db)),
    ("crm",           "crm",           lambda db, s, e, d: _crm(db)),
    ("hr",            "hr",            lambda db, s, e, d: _hr(db, s, e)),
    ("manufacturing", "manufacturing", lambda db, s, e, d: _manufacturing(db)),
    ("controls",      "accounting",    lambda db, s, e, d: _controls(db)),
    ("cash",          "cash",          lambda db, s, e, d: _cash(db)),
    ("fx",            "settings",      lambda db, s, e, d: _fx(db)),
    ("recurring",     "expenses",      lambda db, s, e, d: _recurring(db)),
)

# What "records examined" counts. Reported so the panel can say what it read
# rather than implying it read everything — a claim about the size of the scan
# has to be true or it is worth less than saying nothing.
_VOLUME = (
    ("invoices",      "invoices",      "SELECT COUNT(*) FROM invoices WHERE deleted_at IS NULL"),
    ("invoices",      "invoice_items", "SELECT COUNT(*) FROM invoice_items"),
    ("invoices",      "payments",      "SELECT COUNT(*) FROM invoice_payments"),
    ("inventory",     "inventory",     "SELECT COUNT(*) FROM inventory WHERE deleted_at IS NULL"),
    ("purchases",     "purchases",     "SELECT COUNT(*) FROM purchases WHERE deleted_at IS NULL"),
    ("quotations",    "quotations",    "SELECT COUNT(*) FROM quotations WHERE deleted_at IS NULL"),
    ("service",       "service_jobs",  "SELECT COUNT(*) FROM service_jobs"),
    ("projects",      "projects",      "SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL"),
    ("crm",           "crm_deals",     "SELECT COUNT(*) FROM crm_deals"),
    ("hr",            "hr_employees",  "SELECT COUNT(*) FROM hr_employees"),
    ("manufacturing", "production",    "SELECT COUNT(*) FROM production_orders"),
    ("expenses",      "expenses",      "SELECT COUNT(*) FROM expenses WHERE deleted_at IS NULL"),
    ("accounting",    "journal_lines", "SELECT COUNT(*) FROM journal_entry_lines"),
)


def build(db: sqlite3.Connection, user: dict, start: str,
          end: Optional[str] = None) -> dict:
    """Every module's signals, for the modules this caller may see."""
    end = end or str(date.today())
    since_dead = (date.today() - timedelta(days=DEAD_STOCK_DAYS)).isoformat()

    out = {}
    for key, module, fn in _BLOCKS:
        if not _visible(db, user, module):
            continue
        out[key] = fn(db, start, end, since_dead)

    records = 0
    for module, _label, sql in _VOLUME:
        if _visible(db, user, module):
            records += int(_one(db, sql) or 0)

    out["scanned"] = {
        "modules": len({m for _k, m, _f in _BLOCKS if _visible(db, user, m)}),
        "records": records,
        "from": start[:10],
        "to": end[:10],
        "dead_stock_days": DEAD_STOCK_DAYS,
    }
    return out
