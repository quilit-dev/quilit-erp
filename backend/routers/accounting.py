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
    start: Optional[str] = None,
    end: Optional[str] = None,
    source_type: Optional[str] = None,
    limit: int = 200,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q = ("SELECT je.*, u.full_name AS created_by_name "
         "FROM journal_entries je LEFT JOIN users u ON je.created_by = u.id WHERE 1=1")
    params: list = []
    if start:
        q += " AND je.entry_date >= ?"; params.append(start[:10])
    if end:
        q += " AND je.entry_date <= ?"; params.append(end[:10])
    if source_type:
        q += " AND je.source_type = ?"; params.append(source_type)
    q += " ORDER BY je.entry_date DESC, je.id DESC LIMIT ?"
    params.append(max(1, min(int(limit or 200), 1000)))
    return [dict(r) for r in db.execute(q, params).fetchall()]


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
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Light dashboard: counts + this-month P&L + balance-sheet check."""
    today = _today()
    month_start = today[:7] + "-01"
    accounts = db.execute(
        "SELECT COUNT(*) FROM chart_of_accounts WHERE is_active=1"
    ).fetchone()[0]
    entries = db.execute(
        "SELECT COUNT(*) FROM journal_entries WHERE status='posted'"
    ).fetchone()[0]
    pnl = accounting.income_statement(db, month_start, today)
    bs  = accounting.balance_sheet(db, today)
    return {
        "accounts":      accounts,
        "posted_entries": entries,
        "month_income":  pnl["total_income"],
        "month_expense": pnl["total_expense"],
        "month_net":     pnl["net_income"],
        "total_assets":  bs["total_assets"],
        "balanced":      bs["balanced"],
    }
