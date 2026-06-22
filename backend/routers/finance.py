"""
Finance router — income from invoice_payments, expenses from expenses table.
Enhanced with date-range filtering and period comparison for the Finance dashboard.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from typing import Optional
from database import get_db
from permissions import require_perm, require_admin
from routers.audit import log_action
from utils import _now, get_tax_context, resolve_expense_tax, money
from approval_engine import evaluate_and_apply
import accounting
import sqlite3
from datetime import datetime

router = APIRouter()


# ── Period-lock guard ───────────────────────────────────────────────────────
def _check_period_locked(db, date_str: str):
    """Raises 400 if the accounting period for date_str is locked."""
    if not date_str:
        return
    try:
        ym = str(date_str)[:7]          # YYYY-MM
        year, month = int(ym[:4]), int(ym[5:7])
    except Exception:
        return
    row = db.execute(
        "SELECT locked_at FROM accounting_periods "
        "WHERE year=? AND month=? AND locked_at IS NOT NULL",
        (year, month),
    ).fetchone()
    if row:
        raise HTTPException(
            400,
            f"The accounting period {ym} is locked. "
            "Unlock it in Finance → Periods before making changes.",
        )
    # Financial-year closing: a closed year blocks every dated-in-year change.
    try:
        closed = db.execute(
            "SELECT 1 FROM fiscal_years WHERE year=? AND status='closed'", (year,)
        ).fetchone()
    except sqlite3.OperationalError:
        closed = None      # table absent on a not-yet-migrated DB
    if closed:
        raise HTTPException(
            400,
            f"The financial year {year} is closed. "
            "Reopen it in Accounting → Year-End before making changes.",
        )


_VALID_EXPENSE_CATEGORIES = {
    'Labour', 'Materials', 'Equipment', 'Transport',
    'Subcontractor', 'Permits', 'Purchase', 'Other',
    # Fixed-cost categories — used by recurring expenses and asset depreciation.
    'Rent', 'Utilities', 'Salary', 'Subscription', 'Insurance', 'Depreciation',
}

class ExpenseCreate(BaseModel):
    project_id:     Optional[int] = None
    category:       str
    description:    Optional[str] = None
    amount:         float
    date:           Optional[str] = None
    tax_rate_id:    Optional[int] = None
    payment_method: Optional[str] = None
    cash_drawer_id: Optional[int] = None

    @validator('amount')
    def amount_positive(cls, v):
        if v <= 0:
            raise ValueError('Amount must be greater than zero')
        return v

    @validator('category')
    def category_valid(cls, v):
        # Custom categories are allowed: the ledger maps any unknown category to
        # the Other Expense account (accounting.expense_account_code), so the GL
        # always balances. _VALID_EXPENSE_CATEGORIES stays the seed/known set for
        # the pickers; here we only require a non-empty value.
        v = (v or '').strip()
        if not v:
            raise ValueError('Category is required')
        return v


# ── Helpers ────────────────────────────────────────────────────────────────
def _income_in_range(db, start: str, end: str) -> float:
    return db.execute(
        """SELECT COALESCE(SUM(ip.amount), 0)
           FROM invoice_payments ip
           JOIN invoices i ON ip.invoice_id = i.id
           WHERE DATE(ip.paid_at) >= ? AND DATE(ip.paid_at) <= ?
             AND i.voided_at IS NULL AND i.archived_at IS NULL""",
        (start, end),
    ).fetchone()[0]


def _expenses_in_range(db, start: str, end: str) -> float:
    return db.execute(
        """SELECT COALESCE(SUM(amount), 0) FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) >= ? AND DATE(date) <= ?""",
        (start, end),
    ).fetchone()[0]


def _categories_in_range(db, start: str, end: str):
    return db.execute(
        """SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) >= ? AND DATE(date) <= ?
           GROUP BY category ORDER BY total DESC""",
        (start, end),
    ).fetchall()


# ── Original summary (kept for backward compat) ────────────────────────────
@router.get("/summary")
def finance_summary(
    month: Optional[str] = None,
    user=Depends(require_perm("finance", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    if month:
        income = db.execute(
            """SELECT COALESCE(SUM(ip.amount), 0) AS total
               FROM invoice_payments ip
               WHERE strftime('%Y-%m', ip.paid_at) = ?""",
            (month,),
        ).fetchone()[0]
        expenses = db.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses "
            "WHERE archived_at IS NULL AND voided_at IS NULL AND strftime('%Y-%m', date) = ?",
            (month,),
        ).fetchone()[0]
        by_cat = db.execute(
            "SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses "
            "WHERE archived_at IS NULL AND voided_at IS NULL AND strftime('%Y-%m', date) = ? GROUP BY category",
            (month,),
        ).fetchall()
    else:
        income = db.execute(
            """SELECT COALESCE(SUM(ip.amount), 0) AS total
               FROM invoice_payments ip
               WHERE strftime('%Y-%m', ip.paid_at) = strftime('%Y-%m', 'now')"""
        ).fetchone()[0]
        expenses = db.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses "
            "WHERE archived_at IS NULL AND voided_at IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now')"
        ).fetchone()[0]
        by_cat = db.execute(
            "SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses "
            "WHERE archived_at IS NULL AND voided_at IS NULL AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now') GROUP BY category"
        ).fetchall()

    return {
        "income":      float(income),
        "expenses":    float(expenses),
        "profit":      float(income) - float(expenses),
        "by_category": [dict(r) for r in by_cat],
    }


# ── Range-based KPI summary with period comparison ─────────────────────────
@router.get("/range-summary")
def range_summary(
    start: str,
    end: str,
    prev_start: Optional[str] = None,
    prev_end: Optional[str] = None,
    user=Depends(require_perm("finance", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    income   = float(_income_in_range(db, start, end))
    expenses = float(_expenses_in_range(db, start, end))
    profit   = income - expenses
    margin   = (profit / income * 100) if income > 0 else 0

    by_cat = [dict(r) for r in _categories_in_range(db, start, end)]

    prev = {}
    if prev_start and prev_end:
        p_income   = float(_income_in_range(db, prev_start, prev_end))
        p_expenses = float(_expenses_in_range(db, prev_start, prev_end))
        p_profit   = p_income - p_expenses
        p_margin   = (p_profit / p_income * 100) if p_income > 0 else 0

        def pct_change(curr, prev_v):
            if prev_v == 0:
                return None
            return round((curr - prev_v) / prev_v * 100, 1)

        prev = {
            "income":   p_income,
            "expenses": p_expenses,
            "profit":   p_profit,
            "margin":   round(p_margin, 1),
            "income_change":   pct_change(income,   p_income),
            "expenses_change": pct_change(expenses, p_expenses),
            "profit_change":   pct_change(profit,   p_profit),
            "margin_change":   pct_change(margin,   p_margin),
        }

    return {
        "income":      income,
        "expenses":    expenses,
        "profit":      profit,
        "margin":      round(margin, 1),
        "by_category": by_cat,
        "prev":        prev,
    }


# ── Monthly breakdown for a date range (for charts) ───────────────────────
@router.get("/range-monthly")
def range_monthly(
    start: str,
    end: str,
    user=Depends(require_perm("finance", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        """SELECT month, SUM(income) AS income, SUM(expenses) AS expenses
           FROM (
             SELECT strftime('%Y-%m', ip.paid_at) AS month,
                    SUM(ip.amount) AS income, 0 AS expenses
             FROM invoice_payments ip
             JOIN invoices i ON ip.invoice_id = i.id
             WHERE DATE(ip.paid_at) >= ? AND DATE(ip.paid_at) <= ?
               AND i.voided_at IS NULL AND i.archived_at IS NULL
             GROUP BY month
             UNION ALL
             SELECT strftime('%Y-%m', date) AS month,
                    0 AS income, SUM(amount) AS expenses
             FROM expenses
             WHERE archived_at IS NULL
               AND DATE(date) >= ? AND DATE(date) <= ?
             GROUP BY month
           ) combined
           GROUP BY month
           ORDER BY month ASC""",
        (start, end, start, end),
    ).fetchall()

    result = []
    for r in rows:
        inc = float(r["income"] or 0)
        exp = float(r["expenses"] or 0)
        result.append({
            "month":         r["month"],
            "income":        inc,
            "expenses":      exp,
            "profit":        inc - exp,
            "from_snapshot": False,
        })

    # Overlay immutable snapshot values for any locked months in the result
    snap_rows = db.execute("SELECT * FROM period_snapshots").fetchall()
    snapshots = {f"{r['year']}-{r['month']:02d}": dict(r) for r in snap_rows}
    locked_rows = db.execute(
        "SELECT year, month FROM accounting_periods WHERE locked_at IS NOT NULL"
    ).fetchall()
    locked_keys = {f"{r['year']}-{r['month']:02d}" for r in locked_rows}

    for row in result:
        m = row["month"]
        if m in locked_keys and m in snapshots:
            snap = snapshots[m]
            row["income"]        = snap["income"]
            row["expenses"]      = snap["expenses"]
            row["profit"]        = snap["profit"]
            row["from_snapshot"] = True
            row["snapshot_locked_at"] = snap["locked_at"]

    return result


# ── Detailed raw data for export ───────────────────────────────────────────
@router.get("/range-detail")
def range_detail(
    start: str,
    end: str,
    user=Depends(require_perm("finance", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    payments = db.execute(
        """SELECT ip.paid_at AS date, ip.amount, ip.method,
                  i.invoice_number, ip.note,
                  c.name AS client_name,
                  p.name AS project_name
           FROM invoice_payments ip
           JOIN invoices i ON ip.invoice_id = i.id
           LEFT JOIN clients c ON i.client_id = c.id
           LEFT JOIN projects p ON i.project_id = p.id
           WHERE DATE(ip.paid_at) >= ? AND DATE(ip.paid_at) <= ?
           ORDER BY ip.paid_at DESC""",
        (start, end),
    ).fetchall()

    expenses = db.execute(
        """SELECT e.date, e.amount, e.category, e.description,
                  p.name AS project_name
           FROM expenses e
           LEFT JOIN projects p ON e.project_id = p.id
           WHERE e.archived_at IS NULL AND e.voided_at IS NULL
             AND DATE(e.date) >= ? AND DATE(e.date) <= ?
           ORDER BY e.date DESC""",
        (start, end),
    ).fetchall()

    return {
        "income_records":  [dict(r) for r in payments],
        "expense_records": [dict(r) for r in expenses],
    }


# ── Original monthly report (kept for backward compat) ────────────────────
@router.get("/monthly")
def monthly_report(
    user=Depends(require_perm("finance", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        """SELECT month, SUM(income) AS income, SUM(expenses) AS expenses
           FROM (
             SELECT strftime('%Y-%m', ip.paid_at) AS month,
                    SUM(ip.amount) AS income, 0 AS expenses
             FROM invoice_payments ip
             GROUP BY month
             UNION ALL
             SELECT strftime('%Y-%m', date) AS month,
                    0 AS income, SUM(amount) AS expenses
             FROM expenses
             WHERE archived_at IS NULL AND voided_at IS NULL
             GROUP BY month
           ) combined
           GROUP BY month
           ORDER BY month DESC
           LIMIT 12"""
    ).fetchall()

    result = []
    for r in rows:
        inc = float(r["income"] or 0)
        exp = float(r["expenses"] or 0)
        result.append({"month": r["month"], "income": inc, "expenses": exp, "profit": inc - exp})
    return result


# ── Expenses list ─────────────────────────────────────────────────────────
@router.get("/expenses")
def list_expenses(
    project_id: Optional[int] = None,
    category:   Optional[str] = None,
    user=Depends(require_perm("expenses", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    query  = """SELECT e.*, p.name AS project_name FROM expenses e
                LEFT JOIN projects p ON e.project_id = p.id WHERE e.archived_at IS NULL"""
    params = []
    if project_id:
        query += " AND e.project_id = ?"
        params.append(project_id)
    if category:
        query += " AND e.category = ?"
        params.append(category)
    query += " ORDER BY e.date DESC"
    rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]


class VoidExpenseRequest(BaseModel):
    reason: Optional[str] = None


# ── Void expense ──────────────────────────────────────────────────────────
@router.patch("/expenses/{expense_id}/void")
def void_expense(
    expense_id: int,
    data: VoidExpenseRequest,
    user=Depends(require_perm("expenses", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    exp = db.execute(
        "SELECT * FROM expenses WHERE id = ? AND archived_at IS NULL", (expense_id,)
    ).fetchone()
    if not exp:
        raise HTTPException(404, "Expense not found")
    if exp["voided_at"]:
        raise HTTPException(400, "Expense is already voided")
    if exp["fixed_asset_id"]:
        raise HTTPException(
            400, "This is a depreciation entry generated by Fixed Assets. "
            "Manage it from the Fixed Assets module.")
    _check_period_locked(db, exp["date"])

    # Reverse the project actual_cost contribution
    if exp["project_id"]:
        db.execute(
            "UPDATE projects SET actual_cost = MAX(0, actual_cost - ?) WHERE id = ?",
            (exp["amount"], exp["project_id"]),
        )

    db.execute(
        "UPDATE expenses SET voided_at = datetime('now'), void_reason = ? WHERE id = ?",
        (data.reason or None, expense_id),
    )
    # Reverse the ledger entry posted when the expense was recorded.
    accounting.reverse_source(db, "expense", expense_id,
                              memo=f"Reversal — voided expense ({exp['category']})",
                              created_by=user["id"])
    log_action(db, user, "void", "expense", expense_id,
               exp["category"], {"amount": float(exp["amount"]), "reason": data.reason})
    db.commit()
    return {"message": "Expense voided"}


class ExpenseUpdate(BaseModel):
    project_id:     Optional[int] = None
    category:       str
    description:    Optional[str] = None
    amount:         float
    date:           Optional[str] = None
    tax_rate_id:    Optional[int] = None
    payment_method: Optional[str] = None
    cash_drawer_id: Optional[int] = None


def _resolve_cash_drawer(db, payment_method, cash_drawer_id):
    """A drawer is recorded only for cash-paid expenses; validate it exists."""
    if (payment_method or "").strip().lower() != "cash":
        return None
    if cash_drawer_id is not None and not db.execute(
        "SELECT 1 FROM cash_drawers WHERE id=?", (cash_drawer_id,)).fetchone():
        raise HTTPException(400, "Cash drawer not found")
    return cash_drawer_id


# ── Create expense ────────────────────────────────────────────────────────
@router.post("/expenses")
def create_expense(
    data: ExpenseCreate,
    user=Depends(require_perm("expenses", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    _check_period_locked(db, data.date or datetime.utcnow().strftime("%Y-%m-%d"))
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    # `amount` is the gross cost; tax is the VAT portion extracted from it.
    gross = money(data.amount)
    t_rid, t_rate, t_amt = resolve_expense_tax(get_tax_context(db), data.tax_rate_id, gross)
    drawer_id = _resolve_cash_drawer(db, data.payment_method, data.cash_drawer_id)
    cur = db.execute(
        "INSERT INTO expenses (project_id, category, description, amount, date, created_at, status, "
        " tax_rate_id, tax_rate, tax_amount, payment_method, cash_drawer_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (data.project_id, data.category, data.description,
         gross, data.date or datetime.utcnow().strftime("%Y-%m-%d"), now, "Recorded",
         t_rid, t_rate, t_amt, (data.payment_method or None), drawer_id),
    )
    expense_id = cur.lastrowid

    entity_data = {
        "amount": data.amount,
        "category": data.category or "",
        "status": "Recorded",
    }
    label = f"{data.category or 'Expense'} — {data.amount}"
    needs_approval = evaluate_and_apply(
        db, module="expense", action="create",
        entity_data=entity_data, user_id=user["id"],
        entity_id=expense_id, entity_label=label,
    )
    if needs_approval:
        db.execute("UPDATE expenses SET status='Pending Approval' WHERE id=?", (expense_id,))

    if data.project_id and not needs_approval:
        db.execute(
            "UPDATE projects SET actual_cost = actual_cost + ? WHERE id = ?",
            (data.amount, data.project_id),
        )

    # Auto-post to the general ledger once the expense is actually recorded
    # (a pending-approval expense isn't recognised until it clears approval).
    if not needs_approval:
        accounting.post_entry(
            db,
            entry_date=(data.date or datetime.utcnow().strftime("%Y-%m-%d"))[:10],
            memo=f"{data.category}" + (f" — {data.description}" if data.description else ""),
            lines=[
                {"code": accounting.expense_account_code(data.category), "debit": gross},
                {"code": accounting.CASH, "credit": gross},
            ],
            source_type="expense", source_id=expense_id, created_by=user["id"],
        )

    log_action(db, user, "create", "expense", expense_id,
               data.category, {"amount": data.amount})
    db.commit()
    return {"id": expense_id, "message": "Expense recorded"}


# ── Update expense ────────────────────────────────────────────────────────
@router.put("/expenses/{expense_id}")
def update_expense(
    expense_id: int,
    data: ExpenseUpdate,
    user=Depends(require_perm("expenses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    exp = db.execute(
        "SELECT * FROM expenses WHERE id = ? AND archived_at IS NULL", (expense_id,)
    ).fetchone()
    if not exp:
        raise HTTPException(404, "Expense not found")
    if exp["voided_at"]:
        raise HTTPException(400, "Cannot edit a voided expense")
    if exp["fixed_asset_id"]:
        raise HTTPException(
            400, "This is a depreciation entry generated by Fixed Assets. "
            "Manage it from the Fixed Assets module.")

    _check_period_locked(db, exp["date"])
    _check_period_locked(db, data.date or exp["date"])
    old_amount     = float(exp["amount"])
    old_project_id = exp["project_id"]
    new_amount     = money(data.amount)
    new_project_id = data.project_id

    # Reverse old project actual_cost contribution
    if old_project_id:
        db.execute(
            "UPDATE projects SET actual_cost = MAX(0, actual_cost - ?) WHERE id = ?",
            (old_amount, old_project_id),
        )

    # Apply new project actual_cost contribution
    if new_project_id:
        db.execute(
            "UPDATE projects SET actual_cost = actual_cost + ? WHERE id = ?",
            (new_amount, new_project_id),
        )

    t_rid, t_rate, t_amt = resolve_expense_tax(
        get_tax_context(db), data.tax_rate_id, new_amount)
    drawer_id = _resolve_cash_drawer(db, data.payment_method, data.cash_drawer_id)
    db.execute(
        "UPDATE expenses SET project_id=?, category=?, description=?, amount=?, date=?, "
        " tax_rate_id=?, tax_rate=?, tax_amount=?, payment_method=?, cash_drawer_id=? WHERE id=?",
        (new_project_id, data.category, data.description,
         new_amount, data.date or exp["date"], t_rid, t_rate, t_amt,
         (data.payment_method or None), drawer_id, expense_id),
    )
    log_action(db, user, "update", "expense", expense_id,
               data.category, {"amount": new_amount})
    db.commit()
    return {"message": "Expense updated"}


# ── Archive expense ───────────────────────────────────────────────────────
@router.patch("/expenses/{expense_id}/archive")
def archive_expense(
    expense_id: int,
    user=Depends(require_perm("expenses", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    exp = db.execute(
        "SELECT * FROM expenses WHERE id = ? AND archived_at IS NULL", (expense_id,)
    ).fetchone()
    if not exp:
        raise HTTPException(404, "Expense not found")
    if exp["fixed_asset_id"]:
        raise HTTPException(
            400, "This is a depreciation entry generated by Fixed Assets. "
            "Manage it from the Fixed Assets module.")
    _check_period_locked(db, exp["date"])
    if exp["project_id"]:
        db.execute(
            "UPDATE projects SET actual_cost = MAX(0, actual_cost - ?) WHERE id = ?",
            (exp["amount"], exp["project_id"]),
        )
    now = _now()
    db.execute("UPDATE expenses SET archived_at = ? WHERE id = ?", (now, expense_id))
    log_action(db, user, "archive", "expense", expense_id,
               exp["category"], {"amount": float(exp["amount"])})
    db.commit()
    return {"message": "Expense archived"}


# ── Unarchive expense ──────────────────────────────────────────────────────
@router.patch("/expenses/{expense_id}/unarchive")
def unarchive_expense(
    expense_id: int,
    user=Depends(require_perm("expenses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    exp = db.execute(
        "SELECT * FROM expenses WHERE id = ? AND archived_at IS NOT NULL", (expense_id,)
    ).fetchone()
    if not exp:
        raise HTTPException(404, "Expense not found in archives")
    _check_period_locked(db, exp["date"])
    if exp["project_id"]:
        db.execute(
            "UPDATE projects SET actual_cost = actual_cost + ? WHERE id = ?",
            (exp["amount"], exp["project_id"]),
        )
    db.execute("UPDATE expenses SET archived_at = NULL WHERE id = ?", (expense_id,))
    log_action(db, user, "unarchive", "expense", expense_id, exp["category"])
    db.commit()
    return {"message": "Expense restored from archive"}


# ═══════════════════════════════════════════════════════════════════════════
# ACCOUNTING PERIOD MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/periods")
def list_periods(
    user=Depends(require_perm("finance", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Return lock status + snapshot for the last 24 months."""
    rows = db.execute(
        "SELECT * FROM accounting_periods ORDER BY year DESC, month DESC"
    ).fetchall()
    locked = {(r["year"], r["month"]): dict(r) for r in rows}

    snap_rows = db.execute("SELECT * FROM period_snapshots").fetchall()
    snapshots = {(r["year"], r["month"]): dict(r) for r in snap_rows}

    result = []
    now = datetime.utcnow()
    for i in range(24):
        m = now.month - i
        y = now.year
        while m <= 0:
            m += 12; y -= 1
        key  = (y, m)
        info = locked.get(key)
        snap = snapshots.get(key)
        result.append({
            "year":      y,
            "month":     m,
            "label":     f"{y}-{m:02d}",
            "locked":    bool(info and info["locked_at"]),
            "locked_at": info["locked_at"] if info else None,
            "locked_by": info["locked_by"] if info else None,
            "snapshot":  snap,   # None if not yet locked, dict with income/expenses/profit if locked
        })
    return result


def _generate_snapshot(db, year: int, month: int, now: str, username: str):
    """Calculate and store an immutable financial snapshot for the given month."""
    import calendar
    last_day  = calendar.monthrange(year, month)[1]
    start_dt  = f"{year:04d}-{month:02d}-01"
    end_dt    = f"{year:04d}-{month:02d}-{last_day:02d}"

    # Income = payments on non-voided invoices in this calendar month
    inc_row = db.execute(
        """SELECT COALESCE(SUM(ip.amount), 0) AS total, COUNT(ip.id) AS cnt
           FROM invoice_payments ip
           JOIN invoices i ON ip.invoice_id = i.id
           WHERE DATE(ip.paid_at) >= ? AND DATE(ip.paid_at) <= ?
             AND i.voided_at IS NULL AND i.archived_at IS NULL""",
        (start_dt, end_dt),
    ).fetchone()

    # Expenses in this calendar month (exclude voided and pending-approval)
    exp_row = db.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total, COUNT(id) AS cnt
           FROM expenses
           WHERE archived_at IS NULL
             AND voided_at IS NULL
             AND (status IS NULL OR status NOT IN ('Pending Approval','Rejected'))
             AND date >= ? AND date <= ?""",
        (start_dt, end_dt),
    ).fetchone()

    income   = round(float(inc_row["total"]), 2)
    expenses = round(float(exp_row["total"]), 2)
    profit   = round(income - expenses, 2)

    db.execute("""
        INSERT INTO period_snapshots
            (year, month, income, expenses, profit, payment_count, expense_count, locked_at, locked_by)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(year, month) DO UPDATE SET
            income=excluded.income, expenses=excluded.expenses, profit=excluded.profit,
            payment_count=excluded.payment_count, expense_count=excluded.expense_count,
            locked_at=excluded.locked_at, locked_by=excluded.locked_by
    """, (year, month, income, expenses, profit,
          inc_row["cnt"], exp_row["cnt"], now, username))
    return {"income": income, "expenses": expenses, "profit": profit}


@router.post("/periods/{year}/{month}/lock")
def lock_period(
    year: int, month: int,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    db.execute("""
        INSERT INTO accounting_periods (year, month, locked_at, locked_by)
        VALUES (?,?,?,?)
        ON CONFLICT(year, month) DO UPDATE
            SET locked_at=excluded.locked_at, locked_by=excluded.locked_by
    """, (year, month, now, user.get("username")))

    # Generate immutable financial snapshot at the moment of locking
    snapshot = _generate_snapshot(db, year, month, now, user.get("username", ""))

    log_action(db, user, "lock_period", "finance", None, f"{year}-{month:02d}",
               {"income": snapshot["income"], "expenses": snapshot["expenses"],
                "profit": snapshot["profit"]})
    db.commit()
    return {
        "message":  f"Period {year}-{month:02d} is now locked.",
        "snapshot": snapshot,
    }


@router.post("/periods/{year}/{month}/unlock")
def unlock_period(
    year: int, month: int,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    db.execute(
        "UPDATE accounting_periods SET locked_at=NULL, locked_by=NULL "
        "WHERE year=? AND month=?",
        (year, month),
    )
    log_action(db, user, "unlock_period", "finance", None, f"{year}-{month:02d}")
    db.commit()
    return {"message": f"Period {year}-{month:02d} is now unlocked."}


# ═══════════════════════════════════════════════════════════════════════════
# RECONCILIATION ENGINE
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/reconciliation")
def reconciliation(
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    """Run consistency checks across invoices, payments, and expenses."""
    issues = []

    # ── 1. Invoice amount vs line-items sum (per-line tax snapshot) ────────
    # Each line carries its own (tax_rate_id, tax_rate, tax_amount). The
    # header total must equal SUM(quantity*unit_price) + SUM(tax_amount) — to
    # the cent. We do NOT recompute tax from the global rate setting: that
    # would mis-flag any invoice that legitimately uses mixed or exempt
    # rates (which the line-snapshot system supports by design).
    rows = db.execute("""
        SELECT i.id, i.invoice_number, i.amount, i.subtotal, i.tax_total,
               COALESCE(SUM(ii.quantity * ii.unit_price), 0) AS items_subtotal,
               COALESCE(SUM(ii.tax_amount), 0)               AS items_tax,
               COUNT(ii.id) AS item_count
        FROM invoices i
        LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE i.archived_at IS NULL AND i.voided_at IS NULL
        GROUP BY i.id
        HAVING COUNT(ii.id) > 0
           AND ABS(i.amount - (COALESCE(SUM(ii.quantity * ii.unit_price), 0)
                               + COALESCE(SUM(ii.tax_amount), 0))) > 0.02
    """).fetchall()
    for r in rows:
        expected = round(float(r["items_subtotal"]) + float(r["items_tax"]), 2)
        issues.append({
            "type": "vat_mismatch", "severity": "error",
            "invoice_number": r["invoice_number"], "invoice_id": r["id"],
            # Structured params let the client render a localized message; `message`
            # stays as an English fallback.
            "params": {"invoice_number": r["invoice_number"],
                       "stored": round(float(r["amount"]), 2), "expected": expected},
            "message": (
                f"{r['invoice_number']}: stored ${r['amount']:.2f} ≠ "
                f"lines net+tax ${expected:.2f}"
            ),
        })

    # ── 2. Overpayments (payments exceed invoice amount) ──────────────────
    rows = db.execute("""
        SELECT i.id, i.invoice_number, i.amount,
               COALESCE(SUM(ip.amount), 0) AS total_paid
        FROM invoices i
        LEFT JOIN invoice_payments ip ON ip.invoice_id = i.id
        WHERE i.archived_at IS NULL AND i.voided_at IS NULL
        GROUP BY i.id
        HAVING COALESCE(SUM(ip.amount), 0) > i.amount + 0.01
    """).fetchall()
    for r in rows:
        over = float(r["total_paid"]) - float(r["amount"])
        issues.append({
            "type": "overpayment", "severity": "error",
            "invoice_number": r["invoice_number"], "invoice_id": r["id"],
            "params": {"invoice_number": r["invoice_number"],
                       "over": round(over, 2),
                       "paid": round(float(r["total_paid"]), 2),
                       "amount": round(float(r["amount"]), 2)},
            "message": f"{r['invoice_number']}: overpaid by ${over:.2f} (paid ${r['total_paid']:.2f}, invoice ${r['amount']:.2f})",
        })

    # ── 3. Payments on archived or voided invoices ─────────────────────────
    rows = db.execute("""
        SELECT ip.id, ip.amount, ip.paid_at, i.invoice_number,
               i.voided_at, i.archived_at
        FROM invoice_payments ip
        JOIN invoices i ON ip.invoice_id = i.id
        WHERE i.archived_at IS NOT NULL OR i.voided_at IS NOT NULL
    """).fetchall()
    for r in rows:
        state = "voided" if r["voided_at"] else "archived"
        issues.append({
            "type": "orphaned_payment", "severity": "warning",
            "invoice_number": r["invoice_number"],
            "params": {"amount": round(float(r["amount"]), 2),
                       "date": str(r["paid_at"])[:10],
                       "state": state,
                       "invoice_number": r["invoice_number"]},
            "message": f"Payment ${float(r['amount']):.2f} on {str(r['paid_at'])[:10]} belongs to {state} invoice {r['invoice_number']}",
        })

    # ── 4. Future-dated expenses ───────────────────────────────────────────
    rows = db.execute(
        "SELECT id, category, amount, date FROM expenses "
        "WHERE archived_at IS NULL AND date > date('now', '+1 day')"
    ).fetchall()
    for r in rows:
        issues.append({
            "type": "future_expense", "severity": "warning",
            "params": {"category": r["category"],
                       "amount": round(float(r["amount"]), 2),
                       "date": str(r["date"])[:10]},
            "message": f"Expense '{r['category']}' ${float(r['amount']):.2f} is dated in the future: {r['date']}",
        })

    # ── 5. Ledger ↔ sub-ledger integrity ───────────────────────────────────
    # This ERP recognises revenue/cost on CASH movement (a payment posts
    # Dr Cash / Cr Revenue; a purchase posts Dr Inventory / Cr Cash). There is
    # no accrual AR/AP control account, so the correct tie-out is NOT
    # "GL AR == outstanding invoices" — it's that the ledger no longer
    # recognises a transaction that has been cancelled. Voiding an invoice is
    # supposed to reverse its payment entries (see routers/invoices.py); this
    # catches any reversal that didn't happen — a live (posted, not-reversed)
    # ledger entry still booking revenue for a voided invoice. Archived
    # invoices are intentionally NOT flagged: archiving only hides a record, the
    # cash really was received, so the revenue legitimately stays on the books.
    rows = db.execute("""
        SELECT je.id, je.entry_number, je.total_debit, i.invoice_number
        FROM journal_entries je
        JOIN invoice_payments ip ON ip.id = je.source_id
        JOIN invoices i ON i.id = ip.invoice_id
        WHERE je.source_type = 'invoice_payment'
          AND je.status = 'posted' AND je.reversed_by IS NULL
          AND i.voided_at IS NOT NULL
    """).fetchall()
    for r in rows:
        issues.append({
            "type": "unreversed_void", "severity": "error",
            "invoice_number": r["invoice_number"],
            "params": {"entry": r["entry_number"] or r["id"],
                       "amount": round(float(r["total_debit"]), 2),
                       "invoice_number": r["invoice_number"]},
            "message": (f"Ledger entry {r['entry_number'] or r['id']} still books "
                        f"${float(r['total_debit']):.2f} for voided invoice "
                        f"{r['invoice_number']} — it should have been reversed."),
        })

    # Trial balance must always tie out (entries are balanced by construction;
    # a failure here means data was written around the ledger API).
    tb = accounting.trial_balance(db)
    if not tb["balanced"]:
        issues.append({
            "type": "gl_unbalanced", "severity": "error",
            "params": {"debit": round(float(tb["total_debit"]), 2),
                       "credit": round(float(tb["total_credit"]), 2)},
            "message": (f"General ledger is out of balance: debits "
                        f"${tb['total_debit']:.2f} ≠ credits ${tb['total_credit']:.2f}."),
        })

    # ── Summary totals ─────────────────────────────────────────────────────
    # Voided invoices are excluded — a void removes the invoice from financial
    # totals, so it must not inflate invoiced/outstanding here either.
    total_invoiced = float(db.execute(
        "SELECT COALESCE(SUM(amount),0) FROM invoices "
        "WHERE archived_at IS NULL AND voided_at IS NULL"
    ).fetchone()[0])
    total_collected = float(db.execute(
        "SELECT COALESCE(SUM(ip.amount),0) FROM invoice_payments ip "
        "JOIN invoices i ON ip.invoice_id=i.id "
        "WHERE i.archived_at IS NULL AND i.voided_at IS NULL"
    ).fetchone()[0])
    total_expenses = float(db.execute(
        "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE archived_at IS NULL AND voided_at IS NULL"
    ).fetchone()[0])

    return {
        "issues":      issues,
        "issue_count": len(issues),
        "clean":       len(issues) == 0,
        "summary": {
            "total_invoiced":   total_invoiced,
            "total_collected":  total_collected,
            "outstanding":      round(total_invoiced - total_collected, 2),
            "total_expenses":   total_expenses,
            "net":              round(total_collected - total_expenses, 2),
        },
    }
