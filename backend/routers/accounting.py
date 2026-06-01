"""
Accounting — Chart of Accounts, Journal Entries, General Ledger, Trial Balance,
Balance Sheet and Income Statement.

Most journal entries are posted automatically by business events (see
`accounting.py` and the hooks in invoices / finance / hr / assets / purchases).
This router exposes the books for viewing, plus manual journal entries and
chart-of-accounts management for accountants.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from routers.finance import _check_period_locked
from utils import _now
import accounting
import sqlite3

router = APIRouter()


def _today() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


# ══════════════════════════════════════════════════════════════════════════
# CHART OF ACCOUNTS
# ══════════════════════════════════════════════════════════════════════════
class AccountCreate(BaseModel):
    code:           str
    name:           str
    type:           str
    subtype:        Optional[str] = None
    normal_balance: Optional[str] = None     # defaults from type when omitted
    description:    Optional[str] = None


class AccountUpdate(BaseModel):
    name:        Optional[str] = None
    subtype:     Optional[str] = None
    description: Optional[str] = None
    is_active:   Optional[bool] = None


@router.get("/accounts")
def list_accounts(
    type: Optional[str] = None,
    active: Optional[bool] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = "SELECT * FROM chart_of_accounts WHERE 1=1"
    params: list = []
    if type:
        q += " AND type=?"; params.append(type)
    if active is not None:
        q += " AND is_active=?"; params.append(1 if active else 0)
    q += " ORDER BY code"
    return [dict(r) for r in db.execute(q, params).fetchall()]


@router.post("/accounts")
def create_account(
    data: AccountCreate,
    user=Depends(require_perm("accounting", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    code = (data.code or "").strip()
    name = (data.name or "").strip()
    if not code or not name:
        raise HTTPException(400, "Account code and name are required.")
    if data.type not in accounting.ACCOUNT_TYPES:
        raise HTTPException(400, f"type must be one of: {', '.join(accounting.ACCOUNT_TYPES)}")
    normal = (data.normal_balance
              or ("debit" if data.type in accounting._DEBIT_NORMAL else "credit"))
    if normal not in ("debit", "credit"):
        raise HTTPException(400, "normal_balance must be 'debit' or 'credit'.")
    if db.execute("SELECT 1 FROM chart_of_accounts WHERE code=?", (code,)).fetchone():
        raise HTTPException(400, f"An account with code {code} already exists.")
    cur = db.execute(
        "INSERT INTO chart_of_accounts "
        "(code, name, type, subtype, normal_balance, is_system, is_active, description, created_at) "
        "VALUES (?,?,?,?,?,0,1,?,?)",
        (code, name, data.type, data.subtype, normal, data.description, _now()),
    )
    log_action(db, user, "create", "account", cur.lastrowid, f"{code} {name}")
    db.commit()
    return {"id": cur.lastrowid, "message": "Account created"}


@router.put("/accounts/{account_id}")
def update_account(
    account_id: int,
    data: AccountUpdate,
    user=Depends(require_perm("accounting", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    acct = db.execute("SELECT * FROM chart_of_accounts WHERE id=?", (account_id,)).fetchone()
    if not acct:
        raise HTTPException(404, "Account not found")
    name = acct["name"] if data.name is None else data.name.strip()
    if not name:
        raise HTTPException(400, "Account name cannot be empty.")
    subtype     = acct["subtype"]     if data.subtype     is None else data.subtype
    description = acct["description"]  if data.description is None else data.description
    is_active   = acct["is_active"]    if data.is_active   is None else (1 if data.is_active else 0)
    # System accounts are referenced by the auto-posting engine — keep them live.
    if acct["is_system"] and not is_active:
        raise HTTPException(400, "System accounts cannot be deactivated.")
    db.execute(
        "UPDATE chart_of_accounts SET name=?, subtype=?, description=?, is_active=? WHERE id=?",
        (name, subtype, description, is_active, account_id),
    )
    log_action(db, user, "update", "account", account_id, acct["code"])
    db.commit()
    return {"message": "Account updated"}


@router.delete("/accounts/{account_id}")
def delete_account(
    account_id: int,
    user=Depends(require_perm("accounting", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    acct = db.execute("SELECT * FROM chart_of_accounts WHERE id=?", (account_id,)).fetchone()
    if not acct:
        raise HTTPException(404, "Account not found")
    if acct["is_system"]:
        raise HTTPException(400, "System accounts cannot be deleted. Deactivate a custom account instead.")
    used = db.execute(
        "SELECT 1 FROM journal_entry_lines WHERE account_id=? LIMIT 1", (account_id,)
    ).fetchone()
    if used:
        raise HTTPException(400, "This account has journal entries and cannot be deleted. Deactivate it instead.")
    db.execute("DELETE FROM chart_of_accounts WHERE id=?", (account_id,))
    log_action(db, user, "delete", "account", account_id, acct["code"])
    db.commit()
    return {"message": "Account deleted"}


# ══════════════════════════════════════════════════════════════════════════
# JOURNAL ENTRIES
# ══════════════════════════════════════════════════════════════════════════
class JournalLineIn(BaseModel):
    account_id: int
    debit:      float = 0
    credit:     float = 0
    memo:       Optional[str] = None


class JournalEntryIn(BaseModel):
    entry_date: str
    memo:       Optional[str] = None
    lines:      List[JournalLineIn]


@router.get("/journal-entries")
def list_journal_entries(
    start:       Optional[str] = None,
    end:         Optional[str] = None,
    source_type: Optional[str] = None,
    status:      Optional[str] = None,
    q_text:      Optional[str] = None,
    sort:        str = "entry_date",     # entry_date | entry_number | total_debit | source_type | status
    direction:   str = "desc",           # asc | desc
    limit:       int = 50,
    offset:      int = 0,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Return a page of journal entries plus a `total` count so the caller
    can render real pagination instead of a fake "loaded N rows" indicator.

    Filtering / sorting / paging is all done server-side so a customer with
    50k journal entries (large historical archive) doesn't pay the cost of
    streaming the whole result set down the wire on every navigation.
    """
    # Column whitelist — any other value silently falls back to entry_date so
    # a malformed query never reaches the underlying SQL as raw column name.
    _allowed = {"entry_date", "entry_number", "total_debit", "source_type", "status", "id"}
    sort_col = sort if sort in _allowed else "entry_date"
    sort_dir = "ASC" if (direction or "desc").lower() == "asc" else "DESC"

    where, params = ["1=1"], []
    if start:
        where.append("je.entry_date >= ?"); params.append(start[:10])
    if end:
        where.append("je.entry_date <= ?"); params.append(end[:10])
    if source_type:
        where.append("je.source_type = ?"); params.append(source_type)
    if status:
        where.append("je.status = ?"); params.append(status)
    if q_text:
        # Match on entry_number OR memo. Both are operator-visible and the
        # most common things a user types into the search box.
        like = f"%{q_text.strip()}%"
        where.append("(je.entry_number LIKE ? OR je.memo LIKE ?)")
        params += [like, like]

    where_sql = " AND ".join(where)
    total = db.execute(
        f"SELECT COUNT(*) FROM journal_entries je WHERE {where_sql}",
        params,
    ).fetchone()[0]

    # Stable secondary sort on id keeps the order deterministic when the
    # primary sort key has ties (same date, same total, etc.).
    rows = db.execute(
        f"SELECT je.*, u.full_name AS created_by_name "
        f"FROM journal_entries je LEFT JOIN users u ON je.created_by = u.id "
        f"WHERE {where_sql} "
        f"ORDER BY je.{sort_col} {sort_dir}, je.id DESC "
        f"LIMIT ? OFFSET ?",
        [*params, max(1, min(int(limit or 50), 500)), max(0, int(offset or 0))],
    ).fetchall()

    # Distinct source types are stable across pages — exposed alongside the
    # rows so the UI's filter dropdown stays accurate without an extra call.
    source_types = [r["source_type"] for r in db.execute(
        "SELECT DISTINCT source_type FROM journal_entries "
        "WHERE source_type IS NOT NULL ORDER BY source_type"
    ).fetchall()]

    return {
        "rows":         [dict(r) for r in rows],
        "total":        total,
        "limit":        max(1, min(int(limit or 50), 500)),
        "offset":       max(0, int(offset or 0)),
        "source_types": source_types,
    }


@router.get("/journal-entries/{je_id}")
def get_journal_entry(
    je_id: int,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    je = db.execute(
        "SELECT je.*, u.full_name AS created_by_name "
        "FROM journal_entries je LEFT JOIN users u ON je.created_by = u.id WHERE je.id=?",
        (je_id,),
    ).fetchone()
    if not je:
        raise HTTPException(404, "Journal entry not found")
    lines = db.execute(
        "SELECT l.*, a.code AS account_code, a.name AS account_name, a.type AS account_type "
        "FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id "
        "WHERE l.journal_entry_id=? ORDER BY l.line_no, l.id",
        (je_id,),
    ).fetchall()
    result = dict(je)
    result["lines"] = [dict(r) for r in lines]
    return result


@router.post("/journal-entries")
def create_journal_entry(
    data: JournalEntryIn,
    user=Depends(require_perm("accounting", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Post a manual, balanced journal entry (opening balances, accruals, adjustments)."""
    if not data.entry_date:
        raise HTTPException(400, "entry_date is required.")
    _check_period_locked(db, data.entry_date)
    valid = [l for l in data.lines if (l.debit or 0) > 0 or (l.credit or 0) > 0]
    if len(valid) < 2:
        raise HTTPException(400, "A journal entry needs at least two lines.")
    # Validate the referenced accounts exist and are active.
    for l in valid:
        a = db.execute("SELECT is_active FROM chart_of_accounts WHERE id=?", (l.account_id,)).fetchone()
        if not a:
            raise HTTPException(400, f"Account #{l.account_id} does not exist.")
        if not a["is_active"]:
            raise HTTPException(400, f"Account #{l.account_id} is inactive.")
    try:
        je_id = accounting.post_entry(
            db,
            entry_date=data.entry_date,
            memo=data.memo or "Manual journal entry",
            lines=[{"account_id": l.account_id, "debit": l.debit or 0,
                    "credit": l.credit or 0, "memo": l.memo} for l in valid],
            source_type="manual",
            created_by=user["id"],
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    log_action(db, user, "create", "journal_entry", je_id, data.memo or "Manual entry")
    db.commit()
    return {"id": je_id, "message": "Journal entry posted"}


@router.post("/journal-entries/{je_id}/reverse")
def reverse_journal_entry(
    je_id: int,
    user=Depends(require_perm("accounting", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    je = db.execute("SELECT * FROM journal_entries WHERE id=?", (je_id,)).fetchone()
    if not je:
        raise HTTPException(404, "Journal entry not found")
    if je["status"] != "posted" or je["reversed_by"]:
        raise HTTPException(400, "Only a live posted entry can be reversed.")
    _check_period_locked(db, je["entry_date"])
    rev_id = accounting.reverse_entry(db, je_id, created_by=user["id"])
    log_action(db, user, "reverse", "journal_entry", je_id, je["entry_number"] or str(je_id))
    db.commit()
    return {"id": rev_id, "message": "Journal entry reversed"}


# ══════════════════════════════════════════════════════════════════════════
# REPORTS
# ══════════════════════════════════════════════════════════════════════════
@router.get("/general-ledger")
def get_general_ledger(
    account_id: int,
    start: Optional[str] = None,
    end: Optional[str] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    result = accounting.general_ledger(db, account_id, start, end)
    if result is None:
        raise HTTPException(404, "Account not found")
    return result


@router.get("/trial-balance")
def get_trial_balance(
    as_of: Optional[str] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    return accounting.trial_balance(db, as_of or _today())


@router.get("/balance-sheet")
def get_balance_sheet(
    as_of: Optional[str] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    return accounting.balance_sheet(db, as_of or _today())


@router.get("/income-statement")
def get_income_statement(
    start: str,
    end: str,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    return accounting.income_statement(db, start, end)


@router.get("/summary")
def accounting_summary(
    start: Optional[str] = None,
    end:   Optional[str] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Light dashboard: counts + P&L over the requested window + a
    balance-sheet check as of the window's end date.

    Defaults to the running month (1st → today) when no range is supplied —
    matches the prior contract so existing callers keep working unchanged.
    The response keeps the `month_*` field names so the frontend doesn't
    have to be flipped in lockstep; semantically they now mean "the chosen
    window" but the type stays identical for legacy compatibility.
    """
    today = _today()
    end_d   = (end or today)[:10]
    start_d = (start or (end_d[:7] + "-01"))[:10]
    accounts = db.execute(
        "SELECT COUNT(*) FROM chart_of_accounts WHERE is_active=1"
    ).fetchone()[0]
    entries = db.execute(
        "SELECT COUNT(*) FROM journal_entries WHERE status='posted'"
    ).fetchone()[0]
    pnl = accounting.income_statement(db, start_d, end_d)
    bs  = accounting.balance_sheet(db, end_d)
    return {
        "accounts":       accounts,
        "posted_entries": entries,
        # Range echoes back so the client can confirm the server-applied bounds.
        "start":          start_d,
        "end":            end_d,
        # P&L over the requested window (legacy name kept for compatibility).
        "month_income":   pnl["total_income"],
        "month_expense":  pnl["total_expense"],
        "month_net":      pnl["net_income"],
        # Balance sheet snapshot at the window's end date.
        "total_assets":   bs["total_assets"],
        "balanced":       bs["balanced"],
    }


# ══════════════════════════════════════════════════════════════════════════
# FINANCIAL-YEAR CLOSING
# ══════════════════════════════════════════════════════════════════════════
@router.get("/fiscal-years")
def list_fiscal_years(
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Each year with its status + P&L. Closed years use the frozen snapshot;
    open years show their live year-to-date result."""
    cur_year = datetime.utcnow().year
    row = db.execute(
        "SELECT MIN(substr(entry_date,1,4)) AS y FROM journal_entries WHERE status='posted'"
    ).fetchone()
    try:
        start_year = min(int(row["y"]), cur_year) if row and row["y"] else cur_year
    except (TypeError, ValueError):
        start_year = cur_year
    closed = {r["year"]: dict(r) for r in db.execute("SELECT * FROM fiscal_years").fetchall()}
    out = []
    for y in range(cur_year, start_year - 1, -1):
        fy = closed.get(y)
        if fy and fy["status"] == "closed":
            out.append({"year": y, "status": "closed",
                        "total_income": fy["total_income"], "total_expense": fy["total_expense"],
                        "net_income": fy["net_income"], "closed_at": fy["closed_at"],
                        "closing_entry_id": fy["closing_entry_id"]})
        else:
            pnl = accounting.income_statement(db, f"{y}-01-01", f"{y}-12-31")
            out.append({"year": y, "status": "open",
                        "total_income": pnl["total_income"], "total_expense": pnl["total_expense"],
                        "net_income": pnl["net_income"], "closed_at": None, "closing_entry_id": None})
    return out


@router.post("/fiscal-years/{year}/close")
def close_fiscal_year(
    year: int,
    user=Depends(require_perm("accounting", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Close a financial year: posts the year-end closing entry into Retained
    Earnings and locks every dated-in-year modification."""
    try:
        result = accounting.close_fiscal_year(db, year, created_by=user["id"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    log_action(db, user, "close_year", "accounting", year, str(year),
               {"net_income": result["net_income"]})
    db.commit()
    return {"message": f"Financial year {year} closed", **result}


@router.post("/fiscal-years/{year}/reopen")
def reopen_fiscal_year(
    year: int,
    user=Depends(require_perm("accounting", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Reopen a closed year — reverses the closing entry and unlocks the year."""
    try:
        result = accounting.reopen_fiscal_year(db, year, created_by=user["id"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    log_action(db, user, "reopen_year", "accounting", year, str(year))
    db.commit()
    return {"message": f"Financial year {year} reopened", **result}


# ── F-8 audit fix: period-end FX revaluation ───────────────────────────────
# IAS 21 — monetary items denominated in a foreign currency must be revalued
# at the closing spot rate; the difference is recognised in P&L as FX gain
# or loss. This endpoint re-marks the LBP cash balance to its current USD
# equivalent and posts the resulting gain or loss.
#
#   LBP cash on books (USD-equivalent at historical rates)  =  L_book
#   LBP cash physically on hand (counted at LBP × current rate) = L_now
#
#       L_now > L_book   →  unrealised GAIN
#           DR  1010 Cash — LBP       (L_now − L_book)
#             CR  4910 FX Gain
#       L_now < L_book   →  unrealised LOSS
#           DR  6920 FX Loss          (L_book − L_now)
#             CR  1010 Cash — LBP
#
# The actual LBP balance is whatever the system thinks is in the 1010 account
# (which equals USD-equivalent at the rates paid in); the operator supplies the
# current physical LBP count (total LBP across drawers) and we translate to USD.

class RevalueIn(BaseModel):
    counted_lbp: float       # total LBP physically held across all drawers
    as_of:        Optional[str] = None    # posting date; defaults to today
    note:         Optional[str] = None


@router.post("/fx-revaluation")
def post_fx_revaluation(
    data: RevalueIn,
    user=Depends(require_perm("accounting", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Mark the LBP cash account to the current spot rate and book the
    difference as FX gain/loss. Run this at period close (monthly is typical)."""
    if data.counted_lbp < 0:
        raise HTTPException(400, "Counted LBP cannot be negative.")
    rate_row = db.execute(
        "SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not rate_row or not rate_row["rate"] or rate_row["rate"] <= 0:
        raise HTTPException(
            400,
            "No exchange rate configured. Set the LBP→USD rate in Settings → "
            "Exchange Rate before running FX revaluation."
        )
    spot = float(rate_row["rate"])
    posting_date = (data.as_of or accounting._now())[:10]
    _check_period_locked(db, posting_date)

    # USD-equivalent of the LBP cash actually counted
    counted_usd = round(float(data.counted_lbp) / spot, 2)
    # USD-equivalent currently on the books (signed balance of 1010 Cash — LBP)
    lbp_acct_id = accounting.account_id_for(db, accounting.CASH_LBP)
    book_row = db.execute(
        "SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS bal "
        "FROM journal_entry_lines l "
        "JOIN journal_entries je ON je.id = l.journal_entry_id "
        "WHERE l.account_id = ? AND je.status='posted'",
        (lbp_acct_id,),
    ).fetchone()
    book_usd = round(float(book_row["bal"] or 0), 2)
    delta = round(counted_usd - book_usd, 2)
    if abs(delta) < 0.01:
        return {"message": "No FX adjustment needed.",
                "counted_usd": counted_usd, "book_usd": book_usd, "delta": 0,
                "rate": spot}

    memo = f"FX revaluation — LBP cash @ {spot:,.0f} on {posting_date}"
    if data.note:
        memo += f" — {data.note}"
    if delta > 0:
        # Gain: LBP became worth more USD
        lines = [
            {"code": accounting.CASH_LBP, "debit":  delta,
             "memo": f"Counted {data.counted_lbp:,.0f} LBP"},
            {"code": accounting.FX_GAIN,  "credit": delta},
        ]
    else:
        # Loss
        lines = [
            {"code": accounting.FX_LOSS,  "debit":  abs(delta),
             "memo": f"Counted {data.counted_lbp:,.0f} LBP"},
            {"code": accounting.CASH_LBP, "credit": abs(delta)},
        ]
    je_id = accounting.post_entry(
        db, entry_date=posting_date, memo=memo, lines=lines,
        source_type="fx_revaluation", source_id=None, created_by=user["id"],
    )
    log_action(db, user, "fx_revalue", "accounting", je_id, memo,
               {"counted_lbp": data.counted_lbp, "rate": spot,
                "book_usd": book_usd, "counted_usd": counted_usd, "delta": delta})
    db.commit()
    return {"message": "FX revaluation posted.",
            "journal_entry_id": je_id, "rate": spot,
            "book_usd": book_usd, "counted_usd": counted_usd, "delta": delta}
