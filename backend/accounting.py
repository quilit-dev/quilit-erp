"""
Double-entry accounting engine.

A real general ledger that sits alongside the existing cash-basis Finance views.
Journal entries are auto-posted from business events so the books reconcile with
the rest of the ERP:

    invoice payment   →  DR Cash & Bank          CR Sales Revenue
    expense recorded  →  DR <expense account>    CR Cash & Bank
    payroll paid      →  DR Salaries & Wages      CR Cash & Bank
    depreciation      →  DR Depreciation Expense  CR Accumulated Depreciation
    purchase paid     →  DR Cost of Goods Sold    CR Cash & Bank

Recognition is **cash-basis** (revenue on payment, expense on record), matching
the Finance dashboard exactly — so the Income Statement built here equals the
dashboard's income/expense. Accountants can also post **manual** journal
entries (e.g. opening balances, accruals, adjustments).

Design notes
------------
* Every entry balances by construction (`post_entry` rejects an unbalanced set),
  so the Trial Balance always ties out and the Balance Sheet always balances
  (Assets = Liabilities + Equity + Net Income).
* Auto-posting is **idempotent** per (source_type, source_id): calling it twice
  for the same event (e.g. a re-run of payroll mark-paid) posts once.
* Corrections are made by **reversing** entries, never by deleting — the audit
  trail is preserved.
* All functions take an open connection and DO NOT commit; the calling endpoint
  owns the transaction.
"""
import sqlite3
from utils import _now, _today, money


def clamp_posting_date(period_end: str) -> str:
    """Pull a period-end posting date back to today if it is in the future.

    Period-charge events (payroll, depreciation) are conceptually dated to the
    END of the period they cover. But when an operator runs them mid-period —
    e.g. pays this month's payroll on the 3rd, or runs the current month's
    depreciation before month-end — dating the journal entry to the (future)
    month-end pushes it outside the default "this month → today" GL / Trial
    Balance views, so the operator thinks "it didn't post".

    `min(period_end, today)` fixes that without distorting history:
      • A back-period run (April paid in June) keeps its own month-end —
        2026-04-30 is already < today, so it is returned unchanged.
      • A current-period run dated to a future month-end is pulled back to
        today, so it appears immediately in the default views.

    Accepts and returns a 'YYYY-MM-DD' string (the first 10 chars are used).
    """
    pe = (period_end or "")[:10]
    today = _today()
    if not pe:
        return today
    return min(pe, today)

# ── Stable system-account codes (seeded in migrations 104 + 120) ────────────
CASH         = "1000"   # Cash & Bank (functional currency — USD)
CASH_LBP     = "1010"   # Cash — LBP (foreign currency monetary item)
AR           = "1100"   # Accounts Receivable
INVENTORY    = "1200"   # Inventory (perpetual)
ACC_DEP      = "1510"   # Accumulated Depreciation (contra-asset)
AP           = "2000"   # Accounts Payable
REVENUE      = "4000"   # Sales Revenue (goods)
# Service revenue is kept apart from goods revenue so the income statement
# can answer "what did maintenance earn us". A part sold on a service job
# still credits 4000 — it is goods revenue whichever module rang it up;
# only the labour/callout charge credits this.
SERVICE_REVENUE = "4100"  # Service Revenue (labour, callouts, fees)
FX_GAIN      = "4910"   # Foreign Exchange Gain (other income)
COGS         = "5000"   # Cost of Goods Sold
SALARIES     = "6000"   # Salaries & Wages
DEPRECIATION = "6300"   # Depreciation Expense
CASH_SHORT_OVER = "6910"  # Cash Short & Over (operating expense)
FX_LOSS      = "6920"   # Foreign Exchange Loss (other expense)
OTHER_EXPENSE = "6900"  # General & Other Expense


def cash_account_for(currency: str) -> str:
    """Return the Chart-of-Accounts code that should hold cash tendered in
    `currency`. Centralised so every module routes LBP to 1010 and USD to 1000
    consistently — otherwise mixing them silently in '1000 Cash & Bank' breaks
    IAS 21 (monetary items in a non-functional currency must be tracked and
    revalued at the spot rate). Unknown currencies fall back to USD."""
    return CASH_LBP if (currency or "").upper() == "LBP" else CASH

# Expense-category → ledger account code. Mirrors finance._VALID_EXPENSE_CATEGORIES.
CATEGORY_ACCOUNTS = {
    "Labour":        "6500",
    "Materials":     "6400",
    "Equipment":     "6600",
    "Transport":     "6700",
    "Subcontractor": "6800",
    "Permits":       "6870",
    "Purchase":      "5000",
    "Rent":          "6100",
    "Utilities":     "6200",
    "Salary":        "6000",
    "Subscription":  "6860",
    "Insurance":     "6850",
    "Depreciation":  "6300",
    "Other":         "6900",
}

ACCOUNT_TYPES   = ("Asset", "Liability", "Equity", "Income", "Expense")
# Statement placement + the sign convention used when summing balances.
_DEBIT_NORMAL   = {"Asset", "Expense"}      # balance = debit − credit
_CREDIT_NORMAL  = {"Liability", "Equity", "Income"}  # balance = credit − debit


# ── Account lookup ───────────────────────────────────────────────────────────
def account_id_for(db: sqlite3.Connection, code: str) -> int:
    row = db.execute("SELECT id FROM chart_of_accounts WHERE code=?", (code,)).fetchone()
    if not row:
        raise ValueError(f"Chart-of-accounts code {code!r} not found")
    return row["id"]


def expense_account_code(category: str, db: sqlite3.Connection = None) -> str:
    """Resolve an expense category to its ledger account.

    Precedence: the owner's per-category mapping (categories.account_code, set in
    Settings → Categories) → the built-in default map → Other Expense. The DB
    lookup is optional and best-effort so callers without a connection — or
    running against a pre-136b schema — fall back to the static map unchanged.
    """
    if db is not None and category:
        try:
            row = db.execute(
                "SELECT account_code FROM categories "
                "WHERE domain='expense' AND name=? AND archived_at IS NULL "
                "AND account_code IS NOT NULL AND account_code <> '' LIMIT 1",
                (category,),
            ).fetchone()
            if row and row["account_code"]:
                return row["account_code"]
        except Exception:
            pass
    return CATEGORY_ACCOUNTS.get(category, OTHER_EXPENSE)


# ── Posting ──────────────────────────────────────────────────────────────────
def source_entry(db: sqlite3.Connection, source_type: str, source_id: int):
    """Return the live (non-reversed) journal entry for a source event, if any."""
    return db.execute(
        "SELECT * FROM journal_entries "
        "WHERE source_type=? AND source_id=? AND status='posted' AND reversed_by IS NULL",
        (source_type, source_id),
    ).fetchone()


def _default_branch_id(db: sqlite3.Connection):
    row = db.execute("SELECT id FROM warehouses WHERE is_default=1 LIMIT 1").fetchone()
    return row["id"] if row else None


def post_entry(db: sqlite3.Connection, *, entry_date: str, memo: str, lines: list,
               source_type=None, source_id=None, created_by=None, status="posted",
               branch_id=None):
    """Create one balanced journal entry. `lines` is a list of dicts, each with
    an account (`code` or `account_id`), and a `debit` or `credit` amount, plus
    an optional `memo`.

    `branch_id` tags the entry with the branch it belongs to (branch ==
    warehouse) so the GL can be made branch-aware. When omitted it falls back to
    the company default branch, so an entry is never left untagged.

    Idempotent for source-backed events: if a live entry already exists for
    (source_type, source_id) it is returned unchanged. Returns the entry id.
    Raises ValueError if the lines don't balance.
    """
    # Idempotency guard for auto-posted events (manual entries always insert).
    if source_id is not None and source_type not in (None, "manual"):
        existing = source_entry(db, source_type, source_id)
        if existing:
            return existing["id"]

    norm = []
    total_debit = total_credit = 0.0
    for ln in lines:
        acct_id = ln.get("account_id")
        if acct_id is None:
            acct_id = account_id_for(db, ln["code"])
        debit  = money(ln.get("debit") or 0)
        credit = money(ln.get("credit") or 0)
        if debit < 0 or credit < 0:
            raise ValueError("Journal line amounts cannot be negative")
        if debit > 0 and credit > 0:
            raise ValueError("A journal line cannot have both a debit and a credit")
        if debit == 0 and credit == 0:
            continue   # skip empty lines
        norm.append((acct_id, debit, credit, ln.get("memo")))
        total_debit  += debit
        total_credit += credit

    total_debit  = money(total_debit)
    total_credit = money(total_credit)
    if not norm:
        raise ValueError("A journal entry needs at least one non-zero line")
    if abs(total_debit - total_credit) > 0.005:
        raise ValueError(
            f"Journal entry is not balanced: debits {total_debit} ≠ credits {total_credit}"
        )

    now = _now()
    if branch_id is None:
        branch_id = _default_branch_id(db)
    cur = db.execute(
        "INSERT INTO journal_entries "
        "(entry_number, entry_date, memo, source_type, source_id, status, "
        " total_debit, total_credit, created_by, created_at, branch_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (None, entry_date[:10], memo, source_type, source_id, status,
         total_debit, total_credit, created_by, now, branch_id),
    )
    je_id = cur.lastrowid
    db.execute("UPDATE journal_entries SET entry_number=? WHERE id=?",
               (f"JE-{entry_date[:4]}-{je_id:05d}", je_id))
    for i, (acct_id, debit, credit, lmemo) in enumerate(norm, start=1):
        db.execute(
            "INSERT INTO journal_entry_lines "
            "(journal_entry_id, account_id, debit, credit, memo, line_no) "
            "VALUES (?,?,?,?,?,?)",
            (je_id, acct_id, debit, credit, lmemo, i),
        )
    return je_id


def revenue_split(db, invoice_id, amount):
    """Credit lines for `amount` of revenue, split across revenue accounts in
    proportion to the invoice's own line mix.

    Revenue in this system is recognised on PAYMENT, not on invoicing, and a
    payment can be partial. So a $1,000 invoice that is 40% parts and 60%
    labour, paying $500, must credit $200 to goods and $300 to service.
    Allocating "service first" would overstate one account on every part-paid
    invoice and only come right at the end.

    Lines are grouped by `invoice_items.revenue_account`; NULL means the
    default sales revenue account, so an invoice raised anywhere else in the
    system produces exactly one credit line to 4000 and behaves as it always
    has. An itemless invoice does the same.

    Rounding residue is added to the largest bucket, so the credits sum to
    `amount` to the cent and the entry balances. Without that, a 1/3 split of
    an odd figure loses a cent and post_entry rejects the whole entry.
    """
    amount = money(amount or 0)
    try:
        rows = db.execute(
            "SELECT COALESCE(revenue_account, ?) AS acct, "
            "       SUM(COALESCE(quantity,0) * COALESCE(unit_price,0) "
            "           - COALESCE(discount,0) + COALESCE(tax_amount,0)) AS gross "
            "FROM invoice_items WHERE invoice_id = ? GROUP BY 1",
            (REVENUE, invoice_id),
        ).fetchall()
    except Exception:
        # No invoice_items table on a very old install, or a read failure. One
        # line to the default account is the safe answer: the entry still
        # balances and the money is still recognised.
        rows = []

    buckets = [(r["acct"] or REVENUE, float(r["gross"] or 0)) for r in rows]
    buckets = [(a, g) for a, g in buckets if g > 0]
    if len(buckets) <= 1:
        return [{"code": buckets[0][0] if buckets else REVENUE, "credit": amount}]

    total = sum(g for _, g in buckets)
    if total <= 0:
        return [{"code": REVENUE, "credit": amount}]

    lines = [{"code": a, "credit": money(amount * g / total)} for a, g in buckets]
    residue = money(amount - sum(l["credit"] for l in lines))
    if residue:
        biggest = max(range(len(lines)), key=lambda i: lines[i]["credit"])
        lines[biggest]["credit"] = money(lines[biggest]["credit"] + residue)
    return [l for l in lines if l["credit"] > 0]


def reverse_entry(db: sqlite3.Connection, je_id: int, *, entry_date=None,
                  memo=None, created_by=None):
    """Post a mirror entry that cancels `je_id` (debits↔credits) and links the
    two together. No-op (returns None) if already reversed or not posted."""
    je = db.execute("SELECT * FROM journal_entries WHERE id=?", (je_id,)).fetchone()
    if not je or je["status"] != "posted" or je["reversed_by"]:
        return None
    lines = db.execute(
        "SELECT account_id, debit, credit, memo FROM journal_entry_lines "
        "WHERE journal_entry_id=? ORDER BY line_no", (je_id,)
    ).fetchall()
    rev_lines = [
        {"account_id": l["account_id"], "debit": l["credit"], "credit": l["debit"],
         "memo": l["memo"]}
        for l in lines
    ]
    rev_id = post_entry(
        db,
        entry_date=(entry_date or _now())[:10],
        memo=memo or f"Reversal of {je['entry_number'] or je_id}",
        lines=rev_lines,
        source_type="reversal",
        source_id=je_id,
        created_by=created_by,
    )
    db.execute("UPDATE journal_entries SET reverses_id=? WHERE id=?", (je_id, rev_id))
    db.execute("UPDATE journal_entries SET status='reversed', reversed_by=? WHERE id=?",
               (rev_id, je_id))
    return rev_id


def reverse_source(db: sqlite3.Connection, source_type: str, source_id: int, **kw):
    """Reverse the live entry for a business event (e.g. a voided expense or a
    deleted payment). Returns the reversal id, or None when nothing was posted."""
    je = source_entry(db, source_type, source_id)
    return reverse_entry(db, je["id"], **kw) if je else None


# ── Reports ────────────────────────────────────────────────────────────────
def _signed_balance(acct_type: str, debit: float, credit: float) -> float:
    """Net balance in the account's natural sign (positive = normal side)."""
    if acct_type in _DEBIT_NORMAL:
        return round(debit - credit, 2)
    return round(credit - debit, 2)


def trial_balance(db: sqlite3.Connection, as_of: str = None, branch_id=None):
    """Debit/credit totals per account up to `as_of` (inclusive). Only posted
    entries count. Returns rows + grand totals (which always tie out).

    `branch_id` scopes the TB to one branch — it still balances because every
    journal entry is balanced AND tagged to a single branch."""
    cond = ["je.status != 'draft'"]
    params = []
    if as_of:
        cond.append("je.entry_date <= ?"); params.append(as_of[:10])
    if branch_id is not None:
        cond.append("je.branch_id = ?"); params.append(branch_id)
    where = " AND ".join(cond)
    # Filter lines INSIDE the join so excluded entries don't contribute to the
    # sums; the outer LEFT JOIN still keeps zero-activity accounts out via HAVING.
    rows = db.execute(
        f"""SELECT a.id, a.code, a.name, a.type, a.normal_balance,
                   COALESCE(SUM(x.debit),0)  AS debit,
                   COALESCE(SUM(x.credit),0) AS credit
            FROM chart_of_accounts a
            LEFT JOIN (
                SELECT l.account_id, l.debit, l.credit
                FROM journal_entry_lines l
                JOIN journal_entries je ON je.id = l.journal_entry_id
                WHERE {where}
            ) x ON x.account_id = a.id
            GROUP BY a.id
            HAVING COALESCE(SUM(x.debit),0) <> 0 OR COALESCE(SUM(x.credit),0) <> 0
            ORDER BY a.code""",
        params,
    ).fetchall()
    out, td, tc = [], 0.0, 0.0
    for r in rows:
        debit, credit = round(float(r["debit"]), 2), round(float(r["credit"]), 2)
        # In a trial balance each account shows its balance on its NORMAL side,
        # so the net must be computed in the normal-balance sign — not the type
        # sign. For a contra account the two disagree (1510 Accumulated
        # Depreciation: type Asset, normal credit); using the type sign put its
        # balance in the wrong column and broke the TB tie-out.
        if r["normal_balance"] == "debit":
            bal = round(debit - credit, 2)
        else:
            bal = round(credit - debit, 2)
        dr = bal if r["normal_balance"] == "debit" else 0.0
        cr = bal if r["normal_balance"] == "credit" else 0.0
        # A negative natural balance flips sides.
        if bal < 0:
            dr, cr = (0.0, -bal) if r["normal_balance"] == "debit" else (-bal, 0.0)
        td += max(dr, 0); tc += max(cr, 0)
        out.append({"code": r["code"], "name": r["name"], "type": r["type"],
                    "debit": round(max(dr, 0), 2), "credit": round(max(cr, 0), 2)})
    return {"rows": out, "total_debit": round(td, 2), "total_credit": round(tc, 2),
            "balanced": abs(td - tc) < 0.01, "as_of": as_of}


def _type_totals(db: sqlite3.Connection, start: str = None, end: str = None,
                 exclude_closing: bool = False, branch_id=None):
    """Per-account signed balances grouped for the financial statements.

    `exclude_closing` drops year-end closing entries — used by the Income
    Statement so a closed year still shows its real revenue/expenses (the
    closing entry only reclassifies them into Retained Earnings)."""
    # Include posted AND reversed entries (a reversed entry + its reversal net to
    # zero, so both must count); only drafts are dropped.
    cond = ["je.status != 'draft'"]
    params = []
    if exclude_closing:
        # Drop the year-end closing entry AND any entry that reverses one, so a
        # closed (or reopened) year's P&L still shows its real operating result.
        cond.append("je.source_type IS NOT 'closing'")
        cond.append("(je.reverses_id IS NULL OR je.reverses_id NOT IN "
                    "(SELECT id FROM journal_entries WHERE source_type='closing'))")
    if start:
        cond.append("je.entry_date >= ?"); params.append(start[:10])
    if end:
        cond.append("je.entry_date <= ?"); params.append(end[:10])
    if branch_id is not None:
        cond.append("je.branch_id = ?"); params.append(branch_id)
    where = " AND ".join(cond)
    # Filter lines INSIDE the join so excluded entries (out of range / closing)
    # don't contribute to the sums; the outer LEFT JOIN keeps zero accounts.
    rows = db.execute(
        f"""SELECT a.code, a.name, a.type, a.subtype, a.normal_balance,
                   COALESCE(SUM(x.debit),0)  AS debit,
                   COALESCE(SUM(x.credit),0) AS credit
            FROM chart_of_accounts a
            LEFT JOIN (
                SELECT l.account_id, l.debit, l.credit
                FROM journal_entry_lines l
                JOIN journal_entries je ON je.id = l.journal_entry_id
                WHERE {where}
            ) x ON x.account_id = a.id
            GROUP BY a.id
            ORDER BY a.code""",
        params,
    ).fetchall()
    result = []
    for r in rows:
        bal = _signed_balance(r["type"], float(r["debit"]), float(r["credit"]))
        result.append({"code": r["code"], "name": r["name"], "type": r["type"],
                       "subtype": r["subtype"], "balance": bal})
    return result


def income_statement(db: sqlite3.Connection, start: str, end: str, branch_id=None):
    """Revenue − expenses over a period (P&L). Excludes year-end closing
    entries so the operating result is shown even after the year is closed."""
    rows = _type_totals(db, start, end, exclude_closing=True, branch_id=branch_id)
    income   = [r for r in rows if r["type"] == "Income"  and r["balance"] != 0]
    expense  = [r for r in rows if r["type"] == "Expense" and r["balance"] != 0]
    total_income  = round(sum(r["balance"] for r in income), 2)
    total_expense = round(sum(r["balance"] for r in expense), 2)
    return {
        "start": start, "end": end,
        "income": income, "expense": expense,
        "total_income": total_income,
        "total_expense": total_expense,
        "net_income": round(total_income - total_expense, 2),
    }


def balance_sheet(db: sqlite3.Connection, as_of: str, branch_id=None):
    """Assets = Liabilities + Equity (incl. net income to date). Balances by
    construction because every journal entry balances — and stays balanced when
    scoped to one branch, since each entry is tagged to a single branch."""
    rows = _type_totals(db, None, as_of, branch_id=branch_id)
    assets      = [r for r in rows if r["type"] == "Asset"     and r["balance"] != 0]
    liabilities = [r for r in rows if r["type"] == "Liability" and r["balance"] != 0]
    equity      = [r for r in rows if r["type"] == "Equity"    and r["balance"] != 0]
    # Net income (all activity up to as_of) rolls into equity — we don't post
    # year-end closing entries, so surface it as a live equity line.
    net_income = round(
        sum(r["balance"] for r in rows if r["type"] == "Income")
        - sum(r["balance"] for r in rows if r["type"] == "Expense"), 2)

    total_assets      = round(sum(r["balance"] for r in assets), 2)
    total_liabilities = round(sum(r["balance"] for r in liabilities), 2)
    total_equity      = round(sum(r["balance"] for r in equity) + net_income, 2)
    return {
        "as_of": as_of,
        "assets": assets, "liabilities": liabilities, "equity": equity,
        "net_income": net_income,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "total_equity": total_equity,
        "total_liabilities_equity": round(total_liabilities + total_equity, 2),
        "balanced": abs(total_assets - (total_liabilities + total_equity)) < 0.01,
    }


# ── Cash Flow Statement (GL-derived, direct method) ──────────────────────────
# Codes 1000–1099 are reserved for Cash & Bank in the seeded Chart of Accounts
# (1000 Cash & Bank, 1010 Cash — LBP). A user-added bank account placed in that
# range is treated as cash too. The statement explains the change in those
# accounts over a period and ALWAYS ties out: operating + investing + financing
# == closing − opening, because every journal entry balances, so the non-cash
# side of any cash-touching entry exactly equals −Δcash for that entry.

def _cash_account_ids(db: sqlite3.Connection) -> list:
    rows = db.execute(
        "SELECT id FROM chart_of_accounts "
        "WHERE type='Asset' AND LENGTH(code)=4 AND code >= '1000' AND code < '1100'"
    ).fetchall()
    return [r["id"] for r in rows]


def _cf_activity(acct_type: str, subtype: str) -> str:
    """Classify the NON-cash side of a cash-touching entry into one IAS-7
    activity. Account type/subtype is fixed, so each account maps to exactly
    one bucket."""
    sub = (subtype or "").lower()
    if acct_type == "Asset":
        # Fixed / long-term assets and their contra (accumulated depreciation,
        # which only surfaces here on a disposal) are investing; AR, inventory
        # and other current assets are operating working-capital movements.
        if "non-current" in sub or "fixed" in sub or "contra asset" in sub:
            return "investing"
        return "operating"
    if acct_type == "Equity":
        return "financing"
    if acct_type == "Liability":
        # Long-term borrowings are financing; payables / accruals are operating.
        if "non-current" in sub or "long" in sub or "loan" in sub:
            return "financing"
        return "operating"
    return "operating"   # Income / Expense


def _cash_balance(db: sqlite3.Connection, cash_ids: list, as_of: str, op: str,
                  branch_id=None) -> float:
    if not cash_ids:
        return 0.0
    ph = ",".join("?" for _ in cash_ids)
    bc = " AND je.branch_id = ?" if branch_id is not None else ""
    bp = [branch_id] if branch_id is not None else []
    r = db.execute(
        f"SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c "
        f"FROM journal_entry_lines l JOIN journal_entries je ON je.id=l.journal_entry_id "
        f"WHERE je.status != 'draft' AND l.account_id IN ({ph}) AND je.entry_date {op} ?{bc}",
        (*cash_ids, as_of[:10], *bp),
    ).fetchone()
    return round(float(r["d"]) - float(r["c"]), 2)


def cash_flow_statement(db: sqlite3.Connection, start: str, end: str, branch_id=None):
    """Statement of cash flows over [start, end] (inclusive), derived directly
    from the GL. Cash movements are bucketed by the type of the account on the
    OTHER side of each cash-touching entry. Ties out by construction."""
    cash_ids = _cash_account_ids(db)
    opening = _cash_balance(db, cash_ids, start, "<", branch_id)
    closing = _cash_balance(db, cash_ids, end, "<=", branch_id)

    bc = " AND je.branch_id = ?" if branch_id is not None else ""
    bp = [branch_id] if branch_id is not None else []
    buckets = {"operating": [], "investing": [], "financing": []}
    if cash_ids:
        ph = ",".join("?" for _ in cash_ids)
        rows = db.execute(
            f"""SELECT a.code, a.name, a.type, a.subtype,
                       COALESCE(SUM(l.debit),0)  AS debit,
                       COALESCE(SUM(l.credit),0) AS credit
                FROM journal_entry_lines l
                JOIN journal_entries je ON je.id = l.journal_entry_id
                JOIN chart_of_accounts a ON a.id = l.account_id
                WHERE je.status != 'draft'
                  AND je.entry_date >= ? AND je.entry_date <= ?{bc}
                  AND l.account_id NOT IN ({ph})
                  AND l.journal_entry_id IN (
                      SELECT journal_entry_id FROM journal_entry_lines
                      WHERE account_id IN ({ph})
                  )
                GROUP BY a.id
                ORDER BY a.code""",
            (start[:10], end[:10], *bp, *cash_ids, *cash_ids),
        ).fetchall()
        for r in rows:
            # Cash effect of this account = −(debit − credit) on its non-cash
            # lines, because the entry balances against cash.
            amount = round(-(float(r["debit"]) - float(r["credit"])), 2)
            if amount == 0:
                continue
            buckets[_cf_activity(r["type"], r["subtype"])].append(
                {"code": r["code"], "name": r["name"], "amount": amount})

    def _section(name):
        items = buckets[name]
        return items, round(sum(i["amount"] for i in items), 2)

    operating, total_operating = _section("operating")
    investing, total_investing = _section("investing")
    financing, total_financing = _section("financing")
    net_change = round(total_operating + total_investing + total_financing, 2)

    return {
        "start": start, "end": end,
        "operating": operating, "total_operating": total_operating,
        "investing": investing, "total_investing": total_investing,
        "financing": financing, "total_financing": total_financing,
        "net_change": net_change,
        "opening_cash": opening,
        "closing_cash": closing,
        # Δcash from activities must reconcile opening→closing. Holds by
        # construction; surfaced so the UI can show a "balanced" check.
        "balanced": abs(net_change - round(closing - opening, 2)) < 0.01,
    }


def general_ledger(db: sqlite3.Connection, account_id: int, start: str = None,
                   end: str = None, branch_id=None):
    """Transactions for one account with a running balance, plus the opening
    balance carried in from before `start`. `branch_id` scopes to one branch."""
    acct = db.execute("SELECT * FROM chart_of_accounts WHERE id=?", (account_id,)).fetchone()
    if not acct:
        return None
    sign = 1 if acct["type"] in _DEBIT_NORMAL else -1
    bc = " AND je.branch_id = ?" if branch_id is not None else ""

    opening = 0.0
    if start:
        o = db.execute(
            "SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c "
            "FROM journal_entry_lines l JOIN journal_entries je ON je.id=l.journal_entry_id "
            "WHERE l.account_id=? AND je.status != 'draft' AND je.entry_date < ?" + bc,
            (account_id, start[:10], *( [branch_id] if branch_id is not None else [] )),
        ).fetchone()
        opening = round((float(o["d"]) - float(o["c"])) * sign, 2)

    where = "l.account_id=? AND je.status != 'draft'" + bc
    params = [account_id] + ([branch_id] if branch_id is not None else [])
    if start:
        where += " AND je.entry_date >= ?"; params.append(start[:10])
    if end:
        where += " AND je.entry_date <= ?"; params.append(end[:10])
    lines = db.execute(
        f"""SELECT je.id AS je_id, je.entry_number, je.entry_date, je.memo,
                   je.source_type, l.debit, l.credit, l.memo AS line_memo
            FROM journal_entry_lines l
            JOIN journal_entries je ON je.id = l.journal_entry_id
            WHERE {where}
            ORDER BY je.entry_date, je.id, l.id""",
        params,
    ).fetchall()

    running = opening
    txns = []
    for l in lines:
        running = round(running + (float(l["debit"]) - float(l["credit"])) * sign, 2)
        txns.append({
            "journal_entry_id": l["je_id"], "entry_number": l["entry_number"],
            "date": l["entry_date"], "memo": l["line_memo"] or l["memo"],
            "source_type": l["source_type"],
            "debit": round(float(l["debit"]), 2), "credit": round(float(l["credit"]), 2),
            "balance": running,
        })
    return {
        "account": {"id": acct["id"], "code": acct["code"], "name": acct["name"],
                    "type": acct["type"], "normal_balance": acct["normal_balance"]},
        "opening_balance": opening,
        "transactions": txns,
        "closing_balance": running,
    }


# ── Financial-year closing ───────────────────────────────────────────────────
RETAINED_EARNINGS = "3900"


def is_year_closed(db: sqlite3.Connection, year) -> bool:
    try:
        return bool(db.execute(
            "SELECT 1 FROM fiscal_years WHERE year=? AND status='closed'",
            (int(year),)).fetchone())
    except (sqlite3.OperationalError, TypeError, ValueError):
        return False


def closed_year_for_date(db: sqlite3.Connection, date_str):
    """Return the year if `date_str` falls in a closed financial year, else None."""
    try:
        year = int(str(date_str)[:4])
    except (TypeError, ValueError):
        return None
    return year if is_year_closed(db, year) else None


def close_fiscal_year(db: sqlite3.Connection, year, created_by=None):
    """Close a financial year: post a year-end closing entry that moves the
    year's net result into Retained Earnings, then mark the year closed (which
    locks all dated-in-year modifications). Returns the P&L summary."""
    year = int(year)
    if is_year_closed(db, year):
        raise ValueError(f"Financial year {year} is already closed.")
    start, end = f"{year:04d}-01-01", f"{year:04d}-12-31"
    rows = [r for r in _type_totals(db, start, end, exclude_closing=True)
            if r["type"] in ("Income", "Expense") and abs(r["balance"]) > 0.005]
    total_income  = round(sum(r["balance"] for r in rows if r["type"] == "Income"), 2)
    total_expense = round(sum(r["balance"] for r in rows if r["type"] == "Expense"), 2)
    net_income    = round(total_income - total_expense, 2)

    closing_id = None
    if rows:
        # Zero each income (credit-balance) and expense (debit-balance) account,
        # balancing the difference into Retained Earnings.
        lines = []
        for r in rows:
            if r["type"] == "Income":
                lines.append({"code": r["code"], "debit": r["balance"], "memo": "Year-end close"})
            else:
                lines.append({"code": r["code"], "credit": r["balance"], "memo": "Year-end close"})
        if net_income > 0:
            lines.append({"code": RETAINED_EARNINGS, "credit": net_income, "memo": f"Net income {year}"})
        elif net_income < 0:
            lines.append({"code": RETAINED_EARNINGS, "debit": -net_income, "memo": f"Net loss {year}"})
        closing_id = post_entry(
            db, entry_date=end, memo=f"Year-end closing — {year}", lines=lines,
            source_type="closing", source_id=year, created_by=created_by)

    db.execute(
        "INSERT INTO fiscal_years "
        "(year, status, total_income, total_expense, net_income, closing_entry_id, closed_at, closed_by) "
        "VALUES (?, 'closed', ?,?,?,?,?,?) "
        "ON CONFLICT(year) DO UPDATE SET status='closed', total_income=excluded.total_income, "
        " total_expense=excluded.total_expense, net_income=excluded.net_income, "
        " closing_entry_id=excluded.closing_entry_id, closed_at=excluded.closed_at, closed_by=excluded.closed_by",
        (year, total_income, total_expense, net_income, closing_id, _now(), created_by))
    return {"year": year, "total_income": total_income, "total_expense": total_expense,
            "net_income": net_income, "closing_entry_id": closing_id}


def reopen_fiscal_year(db: sqlite3.Connection, year, created_by=None):
    """Reopen a closed year — reverses its closing entry and unlocks the year."""
    year = int(year)
    row = db.execute("SELECT * FROM fiscal_years WHERE year=? AND status='closed'",
                     (year,)).fetchone()
    if not row:
        raise ValueError(f"Financial year {year} is not closed.")
    if row["closing_entry_id"]:
        reverse_entry(db, row["closing_entry_id"],
                      memo=f"Reopen {year} — reverse year-end closing", created_by=created_by)
    db.execute(
        "UPDATE fiscal_years SET status='open', closed_at=NULL, closed_by=NULL, "
        " closing_entry_id=NULL WHERE year=?", (year,))
    return {"year": year, "status": "open"}
