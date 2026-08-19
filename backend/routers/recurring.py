"""
Recurring Expenses — templates for fixed costs (rent, salaries, subscriptions).

A `recurring_expenses` row is a template, not a cost. Running it generates real
rows in the shared `expenses` table (with `recurring_expense_id` set), so the
Finance P&L, reports and project `actual_cost` see them exactly like a manually
entered expense — the template itself is never counted.

Generation is driven by `next_run_date`, a cursor advanced one frequency step
at a time. It only ever moves forward, so running a template twice cannot
double-post. A template paused on a locked accounting period stops cleanly at
that month and reports it.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from typing import Optional
from datetime import datetime, timedelta
import calendar
import sqlite3

import accounting
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, _today, get_tax_context, resolve_expense_tax, money, notify

router = APIRouter()

_FREQUENCIES = {'weekly', 'monthly', 'quarterly', 'annual'}
_STEP = {'weekly': None, 'monthly': 1, 'quarterly': 3, 'annual': 12}

# How many MONTHS of cost one occurrence actually buys. A quarterly rent payment
# covers three months of occupancy; charging all of it to the month it was paid
# makes that month look bad and the next two look good, for no business reason,
# and leaves the occupancy already paid for off the balance sheet entirely.
#
# Weekly is deliberately 1: a week is not worth amortising, and splitting it
# across a month boundary would produce fractions nobody asked for.
_COVERS = {'weekly': 1, 'monthly': 1, 'quarterly': 3, 'annual': 12}


# ── Models ──────────────────────────────────────────────────────────────────
class RecurringIn(BaseModel):
    name:           str
    category:       str
    description:    Optional[str] = None
    amount:         float
    frequency:      str = 'monthly'
    start_date:     str
    end_date:       Optional[str] = None
    project_id:     Optional[int] = None
    payment_method: Optional[str] = None
    tax_rate_id:    Optional[int] = None

    @validator('amount')
    def _amount_positive(cls, v):
        if v <= 0:
            raise ValueError('Amount must be greater than zero')
        return v

    @validator('frequency')
    def _frequency_ok(cls, v):
        if v not in _FREQUENCIES:
            raise ValueError(f"Frequency must be one of: {', '.join(sorted(_FREQUENCIES))}")
        return v

    @validator('end_date')
    def _end_after_start(cls, v, values):
        start = values.get('start_date')
        if v and start and v < start:
            raise ValueError('End date cannot be before the start date')
        return v


# ── Date helpers ────────────────────────────────────────────────────────────
def _add_months(d: datetime, n: int) -> datetime:
    idx = d.year * 12 + (d.month - 1) + n
    y, m = idx // 12, idx % 12 + 1
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


def _freq_next(date_str: str, frequency: str) -> str:
    d = datetime.strptime(date_str, '%Y-%m-%d')
    if frequency == 'weekly':
        nd = d + timedelta(days=7)
    else:
        nd = _add_months(d, _STEP.get(frequency, 1))
    return nd.strftime('%Y-%m-%d')


def _period_locked(db, date_str: str) -> bool:
    """True if the accounting period for date_str (YYYY-MM-DD) is locked."""
    try:
        year, month = int(str(date_str)[:4]), int(str(date_str)[5:7])
    except (ValueError, TypeError):
        return False
    return db.execute(
        "SELECT 1 FROM accounting_periods "
        "WHERE year=? AND month=? AND locked_at IS NOT NULL",
        (year, month),
    ).fetchone() is not None


def _due_count(tpl: dict, today: str) -> int:
    """How many occurrences are currently due (cursor … today, within end_date)."""
    cursor = tpl['next_run_date']
    end    = tpl['end_date']
    count, guard = 0, 0
    while cursor <= today and guard < 600:
        if end and cursor > end:
            break
        count += 1
        guard += 1
        cursor = _freq_next(cursor, tpl['frequency'])
    return count


def _enrich(tpl: dict, today: str) -> dict:
    tpl['due_count']  = _due_count(tpl, today) if tpl['is_active'] else 0
    tpl['is_overdue'] = tpl['due_count'] > 0
    return tpl


def _tpl_or_404(db, tpl_id: int) -> dict:
    row = db.execute("SELECT * FROM recurring_expenses WHERE id=?", (tpl_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Recurring expense not found")
    return dict(row)


def _spread(net: float, months: int) -> list:
    """`net` split across `months`, the residue landing on the LAST share.

    The parts must sum to the whole exactly. $1,000 over three is 333.33,
    333.33, 333.34 — spreading the rounding instead would leave the prepaid
    account holding a cent for ever on every single template.
    """
    if months <= 1:
        return [money(net)]
    each = money(net / months)
    shares = [each] * months
    shares[-1] = money(net - each * (months - 1))
    return shares


def _post_occurrence(db, tpl, user, rows, gross, t_amt, entry_date, branch_id):
    """Put one occurrence into the general ledger.

    Recurring expenses previously reached the `expenses` table and stopped
    there — no journal entry at all — so they showed in the cash-basis Finance
    views and were invisible to the P&L, the trial balance and the balance
    sheet. Manually entered expenses posted correctly; only the generated ones
    did not.

    A single-month occurrence posts exactly what the manual expense endpoint
    posts, so nothing about monthly templates changes shape:

        DR <expense account>   net
        DR 2100 VAT control    input VAT
          CR 1000 Cash                gross

    A multi-month occurrence is paid in advance, so the cash buys an ASSET
    first and the cost is released as each month is used up:

        DR 1300 Prepaid        net          (on the payment date)
        DR 2100 VAT control    input VAT     - reclaimable when paid, not spread
          CR 1000 Cash                gross
        DR <expense account>   net/N        (once per covered month)
          CR 1300 Prepaid             net/N

    Prepaid runs down to nil over the period, cash leaves once, and each month
    carries its own share.
    """
    code = accounting.expense_account_code(tpl['category'], db)
    memo = tpl['description'] or tpl['name']

    if len(rows) == 1:
        expense_id, _date, amount, share = rows[0]
        lines = [{"code": code, "debit": share}]
        if t_amt > 0:
            lines.append({"code": accounting.VAT_CONTROL, "debit": t_amt,
                          "memo": "Input VAT"})
        lines.append({"code": accounting.CASH, "credit": gross})
        accounting.post_entry(
            db, entry_date=entry_date, memo=memo, lines=lines,
            source_type="expense", source_id=expense_id,
            created_by=user["id"], branch_id=branch_id)
        return

    net = money(sum(r[3] for r in rows))
    pay_lines = [{"code": accounting.PREPAID, "debit": net,
                  "memo": f"Paid in advance — {len(rows)} months"}]
    if t_amt > 0:
        pay_lines.append({"code": accounting.VAT_CONTROL, "debit": t_amt,
                          "memo": "Input VAT"})
    pay_lines.append({"code": accounting.CASH, "credit": gross})
    # Keyed on the first expense row, which is unique per occurrence and is the
    # row a reader would follow back from the ledger.
    accounting.post_entry(
        db, entry_date=entry_date, memo=f"{memo} — paid in advance",
        lines=pay_lines,
        source_type="prepaid_payment", source_id=rows[0][0],
        created_by=user["id"], branch_id=branch_id)

    for expense_id, row_date, _amount, share in rows:
        accounting.post_entry(
            db, entry_date=row_date,
            memo=f"{memo} — {row_date[:7]}",
            lines=[{"code": code, "debit": share},
                   {"code": accounting.PREPAID, "credit": share}],
            source_type="expense", source_id=expense_id,
            created_by=user["id"], branch_id=branch_id)


def _generate(db, tpl: dict, user: dict, now: str, today: str):
    """Post every due occurrence of a template. Returns (generated, locked_stop).

    An occurrence covering several months produces one expense row PER MONTH,
    each dated in the month it belongs to. Every Finance view already buckets
    expenses by their own date, so they report the monthly share without a
    single change to their queries — and the expense list shows the real
    monthly cost rather than one lump in the month the bill arrived.
    """
    ctx        = get_tax_context(db)
    cursor     = tpl['next_run_date']
    end        = tpl['end_date']
    generated  = []
    locked_stop = None
    guard = 0

    branch_id = tpl['branch_id'] if 'branch_id' in tpl.keys() else None
    gross = money(tpl['amount'])
    months = _COVERS.get(tpl['frequency'], 1)

    while cursor <= today and guard < 600:
        if end and cursor > end:
            break
        if _period_locked(db, cursor):
            locked_stop = cursor
            break
        guard += 1
        # Re-resolve tax each iteration: a rate's `is_active` flag or its
        # value could change between runs, and the engine snapshots the
        # rate that was effective on the day this occurrence is posted.
        t_rid, t_rate, t_amt = resolve_expense_tax(ctx, tpl['tax_rate_id'], gross)
        shares = _spread(money(gross - t_amt), months)

        rows = []
        base = datetime.strptime(cursor, '%Y-%m-%d')
        for idx, share in enumerate(shares):
            row_date = _add_months(base, idx).strftime('%Y-%m-%d')
            # The whole input VAT sits on the FIRST row, because it is
            # reclaimable when the bill is paid rather than as the cost is
            # used up. Spreading it would understate the reclaim for months.
            row_tax_id   = t_rid  if idx == 0 else None
            row_tax_rate = t_rate if idx == 0 else 0
            row_tax_amt  = t_amt  if idx == 0 else 0
            amount = money(share + (t_amt if idx == 0 else 0))
            cur = db.execute(
                "INSERT INTO expenses (project_id, category, description, amount, date, "
                " created_at, status, tax_rate_id, tax_rate, tax_amount, payment_method, "
                " recurring_expense_id) "
                "VALUES (?,?,?,?,?,?,'Recorded',?,?,?,?,?)",
                (tpl['project_id'], tpl['category'],
                 tpl['description'] or tpl['name'], amount, row_date, now,
                 row_tax_id, row_tax_rate, row_tax_amt, tpl['payment_method'], tpl['id']),
            )
            rows.append((cur.lastrowid, row_date, amount, share))

        # Tie the rows together under the FIRST one's id, which is also what
        # the prepaid payment entry is keyed on. Voiding any row can then find
        # its siblings and the payment that created them.
        occurrence_id = rows[0][0]
        db.execute(
            "UPDATE expenses SET recurring_occurrence_id=? WHERE id IN (%s)"
            % ",".join("?" * len(rows)),
            [occurrence_id] + [r[0] for r in rows],
        )

        if tpl['project_id']:
            # The same total as before: the shares plus the tax add back to the
            # gross, so a project's actual_cost is unchanged by the spreading.
            db.execute(
                "UPDATE projects SET actual_cost = actual_cost + ? WHERE id=?",
                (gross, tpl['project_id']),
            )

        _post_occurrence(db, tpl, user, rows, gross, t_amt, cursor, branch_id)

        generated.append({"date": cursor, "expense_id": rows[0][0],
                          "amount": float(gross), "rows": len(rows)})
        cursor = _freq_next(cursor, tpl['frequency'])

    # Persist the advanced cursor. A template whose schedule has run past its
    # end date is exhausted and deactivates itself.
    exhausted = bool(end and cursor > end)
    db.execute(
        "UPDATE recurring_expenses SET next_run_date=?, last_generated_date=?, "
        " is_active=? WHERE id=?",
        (cursor,
         generated[-1]['date'] if generated else tpl['last_generated_date'],
         0 if exhausted else tpl['is_active'], tpl['id']),
    )
    return generated, locked_stop


# ── Endpoints ───────────────────────────────────────────────────────────────
@router.get("")
@router.get("/")
def list_recurring(
    include_archived: bool = False,
    user=Depends(require_perm("expenses", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    today = _today()
    query = """SELECT r.*, p.name AS project_name
               FROM recurring_expenses r
               LEFT JOIN projects p ON r.project_id = p.id
               WHERE 1=1"""
    if not include_archived:
        query += " AND r.archived_at IS NULL"
    query += " ORDER BY r.is_active DESC, r.next_run_date ASC"
    return [_enrich(dict(r), today) for r in db.execute(query).fetchall()]


@router.get("/{tpl_id}")
def get_recurring(
    tpl_id: int,
    user=Depends(require_perm("expenses", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    tpl = _enrich(_tpl_or_404(db, tpl_id), _today())
    posted = db.execute(
        "SELECT id, amount, date, status, voided_at FROM expenses "
        "WHERE recurring_expense_id=? ORDER BY date DESC",
        (tpl_id,),
    ).fetchall()
    tpl['generated_expenses'] = [dict(r) for r in posted]
    return tpl


@router.post("")
@router.post("/")
def create_recurring(
    data: RecurringIn,
    user=Depends(require_perm("expenses", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    cur = db.execute(
        "INSERT INTO recurring_expenses "
        " (name, category, description, amount, frequency, start_date, end_date, "
        "  next_run_date, project_id, payment_method, tax_rate_id, is_active, "
        "  created_by, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
        (data.name, data.category, data.description, data.amount, data.frequency,
         data.start_date, data.end_date, data.start_date, data.project_id,
         data.payment_method, data.tax_rate_id, user['id'], now),
    )
    tpl_id = cur.lastrowid
    log_action(db, user, "create", "recurring_expense", tpl_id, data.name,
               {"amount": data.amount, "frequency": data.frequency})
    db.commit()
    return {"id": tpl_id, "message": "Recurring expense created"}


@router.put("/{tpl_id}")
def update_recurring(
    tpl_id: int,
    data: RecurringIn,
    user=Depends(require_perm("expenses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    tpl = _tpl_or_404(db, tpl_id)
    # The schedule cursor is only realigned to start_date while nothing has
    # been generated yet; otherwise it stays put so history is never re-posted.
    next_run = tpl['next_run_date']
    if not tpl['last_generated_date']:
        next_run = data.start_date
    db.execute(
        "UPDATE recurring_expenses SET name=?, category=?, description=?, amount=?, "
        " frequency=?, start_date=?, end_date=?, next_run_date=?, project_id=?, "
        " payment_method=?, tax_rate_id=? WHERE id=?",
        (data.name, data.category, data.description, data.amount, data.frequency,
         data.start_date, data.end_date, next_run, data.project_id,
         data.payment_method, data.tax_rate_id, tpl_id),
    )
    log_action(db, user, "update", "recurring_expense", tpl_id, data.name)
    db.commit()
    return {"message": "Recurring expense updated"}


@router.patch("/{tpl_id}/toggle")
def toggle_recurring(
    tpl_id: int,
    user=Depends(require_perm("expenses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    tpl = _tpl_or_404(db, tpl_id)
    new_state = 0 if tpl['is_active'] else 1
    db.execute("UPDATE recurring_expenses SET is_active=? WHERE id=?", (new_state, tpl_id))
    log_action(db, user, "update", "recurring_expense", tpl_id, tpl['name'],
               {"is_active": bool(new_state)})
    db.commit()
    return {"message": "Activated" if new_state else "Paused", "is_active": bool(new_state)}


@router.post("/{tpl_id}/run")
def run_recurring(
    tpl_id: int,
    user=Depends(require_perm("expenses", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    tpl = _tpl_or_404(db, tpl_id)
    if tpl['archived_at']:
        raise HTTPException(400, "Cannot run an archived recurring expense")
    if not tpl['is_active']:
        raise HTTPException(400, "This recurring expense is paused")

    generated, locked_stop = _generate(db, tpl, user, _now(), _today())
    if generated:
        # Sum what was actually posted. One occurrence can now be several
        # expense rows, so multiplying the count by the template amount
        # would overstate a quarterly template threefold.
        total = round(sum(g['amount'] for g in generated), 2)
        log_action(db, user, "generate", "recurring_expense", tpl_id, tpl['name'],
                   {"count": len(generated), "amount": total})
        # Global, expenses-gated alert — finance users see new costs hit the
        # books without having to refresh the list. Dedup by (template, hour)
        # to absorb double-clicks on the Run button.
        notify(
            db, type="recurring_generated",
            title=f"Recurring expense generated: {tpl['name']}",
            body=f"{len(generated)} occurrence{'s' if len(generated) != 1 else ''} "
                 f"· ${total:,.2f} posted to Expenses",
            msg="recurring_generated_one",
            params={"name": tpl["name"], "count": len(generated), "total": float(total)},
            link="/expenses",
            entity_type="recurring_expense", entity_id=tpl_id, dedup_hours=1,
        )
    db.commit()
    return {
        "generated_count": len(generated),
        "generated":       generated,
        "locked_stop":     locked_stop,
        "message": (
            f"Generated {len(generated)} expense(s)"
            if generated else "Nothing due — already up to date"
        ),
    }


@router.post("/run-due")
def run_due(
    user=Depends(require_perm("expenses", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Generate due expenses for every active, non-archived template."""
    now, today = _now(), _today()
    templates = db.execute(
        "SELECT * FROM recurring_expenses WHERE archived_at IS NULL AND is_active=1"
    ).fetchall()
    total = 0
    results = []
    for row in templates:
        generated, locked_stop = _generate(db, dict(row), user, now, today)
        if generated or locked_stop:
            total += len(generated)
            results.append({
                "id": row['id'], "name": row['name'],
                "count": len(generated), "locked_stop": locked_stop,
            })
    if total:
        log_action(db, user, "generate", "recurring_expense", None, "run-due",
                   {"templates": len(results), "count": total})
        # One umbrella notification for the batch — finer-grained alerts would
        # bury the bell when month-end processing fires 30 templates at once.
        notify(
            db, type="recurring_generated",
            title=f"Recurring expenses posted ({total} occurrence{'s' if total != 1 else ''})",
            body=f"{len(results)} template{'s' if len(results) != 1 else ''} processed for due dates ≤ {today}.",
            msg="recurring_generated_batch",
            params={"count": total, "templates": len(results), "date": today},
            link="/expenses",
            entity_type="recurring_expense", entity_id=None, dedup_hours=1,
        )
    db.commit()
    return {
        "total_generated": total,
        "templates_affected": len(results),
        "results": results,
        "message": (
            f"Generated {total} expense(s) from {len(results)} template(s)"
            if total else "Nothing due across any recurring expense"
        ),
    }


@router.patch("/{tpl_id}/archive")
def archive_recurring(
    tpl_id: int,
    user=Depends(require_perm("expenses", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    tpl = _tpl_or_404(db, tpl_id)
    if tpl['archived_at']:
        raise HTTPException(400, "Already archived")
    db.execute(
        "UPDATE recurring_expenses SET archived_at=?, is_active=0 WHERE id=?",
        (_now(), tpl_id),
    )
    log_action(db, user, "archive", "recurring_expense", tpl_id, tpl['name'])
    db.commit()
    return {"message": "Recurring expense archived"}


@router.patch("/{tpl_id}/unarchive")
def unarchive_recurring(
    tpl_id: int,
    user=Depends(require_perm("expenses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    tpl = _tpl_or_404(db, tpl_id)
    if not tpl['archived_at']:
        raise HTTPException(400, "Not archived")
    db.execute("UPDATE recurring_expenses SET archived_at=NULL WHERE id=?", (tpl_id,))
    log_action(db, user, "unarchive", "recurring_expense", tpl_id, tpl['name'])
    db.commit()
    return {"message": "Recurring expense restored"}
