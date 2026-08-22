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
import branch_access
import currency as currency_mod
import chart_lebanon
import fx_differences
import gl_source
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


@router.get("/chart")
def chart_status(
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Which chart of accounts this tenant is on, and whether it can move.

    The default chart is the one every tenant starts on. The Lebanese plan is
    the statutory one — class 1 is capital there and 4 is third parties, so it
    is not a renaming of the default but a different tree.
    """
    lb = chart_lebanon.status(db)
    return {
        "current": "lebanon" if lb["installed"] else "default",
        "charts": [
            {"key": "default", "name": "Default chart",
             "name_ar": "دليل الحسابات الافتراضي",
             "installed": not lb["installed"]},
            lb,
        ],
    }


class ChartInstall(BaseModel):
    # Typing the phrase is the ceremony. A tenant with posted entries is being
    # asked to confirm something an accountant should have decided.
    confirm: Optional[str] = None


@router.post("/chart/lebanon/install")
def install_lebanese_chart(
    data: ChartInstall,
    user=Depends(require_perm("accounting", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Put this tenant on the Lebanese General Accounting Plan.

    Seeds the statutory accounts, re-points every posting role at them, and
    deactivates the accounts of the chart being left. Nothing is deleted: an
    account is what historical entries point at, so retiring one keeps the old
    ledger readable while stopping the tenant being offered two charts at once.

    On a tenant that has already posted this needs the confirmation phrase.
    Switching mid-life does not corrupt anything — old entries keep pointing
    where they were posted — but the tenant then has balances spread across two
    charts and no statement that reads correctly until the balances are brought
    across as an opening entry. That is a decision with an accountant in the
    room; the phrase is there so it cannot be a stray click.
    """
    st = chart_lebanon.status(db)
    if st["installed"]:
        return {"message": "Already on the Lebanese chart.", **st}

    force = False
    if not st["clean"]:
        if (data.confirm or "").strip().upper() != "SWITCH CHART":
            raise HTTPException(
                400,
                f"This tenant has {st['posted_lines']} posted journal lines. "
                "Switching now leaves its balances split across two charts "
                "until they are brought across as an opening entry — do that "
                "with your accountant. To proceed anyway, type SWITCH CHART "
                "to confirm.")
        force = True

    try:
        seeded = chart_lebanon.install(db, force=force)
    except ValueError as e:
        raise HTTPException(400, str(e))

    log_action(db, user, "install_chart", "accounting", 0,
               "Lebanese General Accounting Plan",
               {"accounts": seeded, "forced": force,
                "posted_lines_at_switch": st["posted_lines"]})
    db.commit()
    return {"message": f"Installed {seeded} accounts.", **chart_lebanon.status(db)}


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
    branch_id:  Optional[int] = None   # branch == warehouse; resolved on post


@router.get("/journal-entries")
def list_journal_entries(
    start:       Optional[str] = None,
    end:         Optional[str] = None,
    source_type: Optional[str] = None,
    status:      Optional[str] = None,
    q_text:      Optional[str] = None,
    account_id:  Optional[int] = None,
    min_amount:  Optional[float] = None,
    max_amount:  Optional[float] = None,
    branch_id:   Optional[int] = None,
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
    _allowed = {"entry_date", "entry_number", "total_debit", "total_credit", "source_type", "status", "id"}
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
        # An accountant searching the journal is rarely looking for an entry
        # number. They are looking for a name — an account, a supplier written
        # into a line memo — or for the document the posting came from. All of
        # those live on the lines or on the source, not on the header, so the
        # search reaches into them.
        like = f"%{q_text.strip()}%"
        where.append(
            "(je.entry_number LIKE ? OR je.memo LIKE ? OR je.source_type LIKE ?"
            " OR EXISTS (SELECT 1 FROM journal_entry_lines l"
            "            JOIN chart_of_accounts a ON a.id = l.account_id"
            "            WHERE l.journal_entry_id = je.id"
            "              AND (a.code LIKE ? OR a.name LIKE ? OR l.memo LIKE ?)))")
        params += [like] * 6
    if account_id:
        # "Everything that touched 4111" — the question the ledger answers one
        # account at a time, asked from the journal instead.
        where.append("EXISTS (SELECT 1 FROM journal_entry_lines l "
                     "WHERE l.journal_entry_id = je.id AND l.account_id = ?)")
        params.append(int(account_id))
    # Amount bounds run against the entry total, which equals its debit side.
    if min_amount is not None:
        where.append("je.total_debit >= ?"); params.append(float(min_amount))
    if max_amount is not None:
        where.append("je.total_debit <= ?"); params.append(float(max_amount))
    # Branch scoping: scoped users see only their branch's entries.
    bf, bp = branch_access.branch_filter(user, db, column="je.branch_id", selected=branch_id)
    if bf:
        where.append(bf[len(" AND "):]); params += bp

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

    # Each row resolves its own origin, so the list can name the document
    # rather than only its source type. One page of rows, so the extra reads
    # are bounded by the page size and not by the size of the ledger.
    out = []
    for r in rows:
        d = dict(r)
        d["source"] = gl_source.describe(db, r["source_type"], r["source_id"])
        out.append(d)

    # Distinct source types are stable across pages — exposed alongside the
    # rows so the UI's filter dropdown stays accurate without an extra call.
    source_types = [r["source_type"] for r in db.execute(
        "SELECT DISTINCT source_type FROM journal_entries "
        "WHERE source_type IS NOT NULL ORDER BY source_type"
    ).fetchall()]

    return {
        "rows":         out,
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
    branch_access.assert_can_view_branch(user, db, je["branch_id"])
    lines = db.execute(
        "SELECT l.*, a.code AS account_code, a.name AS account_name, a.type AS account_type "
        "FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id "
        "WHERE l.journal_entry_id=? ORDER BY l.line_no, l.id",
        (je_id,),
    ).fetchall()
    result = dict(je)
    result["lines"] = [dict(r) for r in lines]
    # Where this posting came from, and where to go to look at it.
    result["source"] = gl_source.describe(db, je["source_type"], je["source_id"])
    return result


@router.get("/for/{document}/{doc_id}")
def entries_for_document(
    document: str,
    doc_id:   int,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Every journal entry one document produced, newest first.

    The question an operator asks of an invoice is "what did this do to the
    books?", and the answer is rarely one entry: an invoice raises revenue,
    relieves cost of goods when it came from the till, and gains another entry
    for every payment against it. Reversals are included and marked rather than
    hidden — an entry that was reversed is part of the story.
    """
    if document not in gl_source.DOCUMENTS:
        raise HTTPException(404, "Unknown document type")

    pairs = gl_source.postings_for(db, document, doc_id)
    if not pairs:
        return {"document": document, "id": doc_id, "entries": []}

    clause = " OR ".join(["(je.source_type=? AND je.source_id=?)"] * len(pairs))
    params = [v for pair in pairs for v in pair]

    rows = db.execute(
        f"SELECT je.*, u.full_name AS created_by_name FROM journal_entries je "
        f"LEFT JOIN users u ON je.created_by = u.id "
        f"WHERE {clause} ORDER BY je.entry_date DESC, je.id DESC",
        params,
    ).fetchall()

    # Branch scoping applies here exactly as it does to the journal list: a
    # scoped user must not read another branch's postings through a document.
    entries = []
    for r in rows:
        try:
            branch_access.assert_can_view_branch(user, db, r["branch_id"])
        except HTTPException:
            continue
        e = dict(r)
        e["lines"] = [dict(l) for l in db.execute(
            "SELECT l.*, a.code AS account_code, a.name AS account_name, "
            "a.type AS account_type FROM journal_entry_lines l "
            "JOIN chart_of_accounts a ON a.id = l.account_id "
            "WHERE l.journal_entry_id=? ORDER BY l.line_no, l.id", (r["id"],))]
        entries.append(e)

    return {"document": document, "id": doc_id, "entries": entries}


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
    # Tag the entry with the caller's branch (scoped users → forced home branch;
    # global users → their focused/default branch).
    branch_id = branch_access.resolve_branch_id(user, db, getattr(data, "branch_id", None))
    try:
        je_id = accounting.post_entry(
            db,
            entry_date=data.entry_date,
            memo=data.memo or "Manual journal entry",
            lines=[{"account_id": l.account_id, "debit": l.debit or 0,
                    "credit": l.credit or 0, "memo": l.memo} for l in valid],
            source_type="manual",
            created_by=user["id"],
            branch_id=branch_id,
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
    branch_id: Optional[int] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    scope = branch_access.scope_branch_id(user, db, branch_id)
    result = accounting.general_ledger(db, account_id, start, end, branch_id=scope)
    if result is None:
        raise HTTPException(404, "Account not found")
    return result


@router.get("/trial-balance")
def get_trial_balance(
    as_of: Optional[str] = None,
    branch_id: Optional[int] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    scope = branch_access.scope_branch_id(user, db, branch_id)
    return accounting.trial_balance(db, as_of or _today(), branch_id=scope)


@router.get("/balance-sheet")
def get_balance_sheet(
    as_of: Optional[str] = None,
    branch_id: Optional[int] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    scope = branch_access.scope_branch_id(user, db, branch_id)
    return accounting.balance_sheet(db, as_of or _today(), branch_id=scope)


@router.get("/income-statement")
def get_income_statement(
    start: str,
    end: str,
    branch_id: Optional[int] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    scope = branch_access.scope_branch_id(user, db, branch_id)
    return accounting.income_statement(db, start, end, branch_id=scope)


@router.get("/cash-flow")
def get_cash_flow(
    start: str,
    end: str,
    branch_id: Optional[int] = None,
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    scope = branch_access.scope_branch_id(user, db, branch_id)
    return accounting.cash_flow_statement(db, start, end, branch_id=scope)


@router.get("/summary")
def accounting_summary(
    start: Optional[str] = None,
    end:   Optional[str] = None,
    branch_id: Optional[int] = None,
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
    scope = branch_access.scope_branch_id(user, db, branch_id)
    bf, bp = branch_access.branch_filter(user, db, column="branch_id", selected=branch_id)
    accounts = db.execute(
        "SELECT COUNT(*) FROM chart_of_accounts WHERE is_active=1"
    ).fetchone()[0]
    entries = db.execute(
        "SELECT COUNT(*) FROM journal_entries WHERE status='posted'" + bf, bp
    ).fetchone()[0]
    pnl = accounting.income_statement(db, start_d, end_d, branch_id=scope)
    bs  = accounting.balance_sheet(db, end_d, branch_id=scope)
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
    # One count per foreign currency held as notes. Both optional: a shop that
    # holds only pounds sends only pounds, and the request that worked before
    # euro existed still works.
    counted_lbp: Optional[float] = None
    counted_eur: Optional[float] = None
    as_of:        Optional[str] = None    # posting date; defaults to today
    note:         Optional[str] = None


def _revalue_one(db, *, currency, counted, posting_date, note, user):
    """Mark one foreign cash account to the spot rate. Returns the outcome.

    The same arithmetic for every currency: what the notes are worth today
    against what the books say they were worth when they arrived.
    """
    spot = currency_mod.rate_on(db, currency, posting_date)
    if not spot or spot <= 0:
        raise HTTPException(
            400,
            f"No {currency} exchange rate configured. Set it in Settings → "
            f"Exchange Rate before running FX revaluation.")

    counted_usd = round(float(counted) / spot, 2)
    acct = accounting.cash_account_for(db, currency)
    acct_id = accounting.account_id_for(db, acct)
    book_row = db.execute(
        "SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS bal "
        "FROM journal_entry_lines l "
        "JOIN journal_entries je ON je.id = l.journal_entry_id "
        "WHERE l.account_id = ? AND je.status='posted'",
        (acct_id,),
    ).fetchone()
    book_usd = round(float(book_row["bal"] or 0), 2)
    delta = round(counted_usd - book_usd, 2)

    result = {"currency": currency, "rate": spot, "book_usd": book_usd,
              "counted_usd": counted_usd, "delta": delta,
              "journal_entry_id": None, "run_id": None}
    if abs(delta) < 0.01:
        return result

    memo = f"FX revaluation — {currency} cash @ {spot:,.4g} on {posting_date}"
    if note:
        memo += f" — {note}"
    counted_memo = f"Counted {float(counted):,.0f} {currency}"
    if delta > 0:
        # Gain: the notes became worth more dollars.
        lines = [{"code": acct, "debit": delta, "memo": counted_memo},
                 {"code": accounting.FX_GAIN, "credit": delta}]
    else:
        lines = [{"code": accounting.FX_LOSS, "debit": abs(delta),
                  "memo": counted_memo},
                 {"code": acct, "credit": abs(delta)}]

    # The run is recorded first so the entry can point at it. Without a source
    # id the only trace of why the books moved was a memo string, which cannot
    # be reconciled, reversed by reference, or explained at year end.
    run = db.execute(
        "INSERT INTO fx_revaluation_runs "
        "(currency, account_code, counted_amount, exchange_rate, book_base, "
        " counted_base, difference, as_of, note, created_at, created_by) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (currency, acct, float(counted), spot, book_usd, counted_usd, delta,
         posting_date, note, accounting._now(), user["id"]))
    run_id = run.lastrowid

    # Each currency posts its own entry, so a reader sees which currency moved
    # rather than one netted figure covering two.
    je_id = accounting.post_entry(
        db, entry_date=posting_date, memo=memo, lines=lines,
        source_type="fx_revaluation", source_id=run_id, created_by=user["id"])
    db.execute("UPDATE fx_revaluation_runs SET journal_entry_id=? WHERE id=?",
               (je_id, run_id))
    result["journal_entry_id"] = je_id
    result["run_id"] = run_id
    return result


@router.get("/fx-differences")
def list_fx_differences(
    start:           Optional[str] = None,
    end:             Optional[str] = None,
    currency:        Optional[str] = None,
    kind:            Optional[str] = None,    # realized | unrealized
    direction:       Optional[str] = None,    # gain | loss
    client_id:       Optional[int] = None,
    project_id:      Optional[int] = None,
    account_code:    Optional[str] = None,
    bank_account_id: Optional[int] = None,
    status:          Optional[str] = None,    # reconciled | open | posted | reversed
    user=Depends(require_perm("accounting", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Every currency difference in the books, with what produced it.

    Each row carries the whole chain: the document, the currency and amount it
    was agreed in, the rate it was recognised at, what that was worth in the
    company's currency, the rate at settlement or revaluation, what it was
    worth then, the difference, and the entry that carried it.
    """
    return fx_differences.collect(
        db, start=start, end=end, currency=currency, kind=kind,
        direction=direction, client_id=client_id, project_id=project_id,
        account_code=account_code, bank_account_id=bank_account_id,
        status=status)


class ReconcileBody(BaseModel):
    note: Optional[str] = None
    undo: bool = False


@router.post("/fx-differences/{kind}/{ref_id}/reconcile")
def reconcile_fx_difference(
    kind: str,
    ref_id: int,
    data: ReconcileBody,
    user=Depends(require_perm("accounting", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Mark that an accountant has read this difference, or unmark it.

    Deliberately NOT an accounting action. The difference was posted when it
    arose and this does not touch it: signing one off records that a person
    looked, which is what a period-end review produces. Nothing is written to
    the transaction that created it.
    """
    if kind not in (fx_differences.REALIZED, fx_differences.UNREALIZED):
        raise HTTPException(404, "Unknown difference type")

    if data.undo:
        db.execute("DELETE FROM fx_reconciliations WHERE kind=? AND ref_id=?",
                   (kind, ref_id))
        log_action(db, user, "fx_unreconcile", "accounting", ref_id, kind)
        db.commit()
        return {"reconciled": False}

    existing = db.execute(
        "SELECT id FROM fx_reconciliations WHERE kind=? AND ref_id=?",
        (kind, ref_id)).fetchone()
    if existing:
        db.execute("UPDATE fx_reconciliations SET note=?, reconciled_at=?, "
                   "reconciled_by=? WHERE id=?",
                   (data.note, _now(), user["id"], existing["id"]))
    else:
        db.execute(
            "INSERT INTO fx_reconciliations "
            "(kind, ref_id, status, note, reconciled_at, reconciled_by) "
            "VALUES (?,?,'reconciled',?,?,?)",
            (kind, ref_id, data.note, _now(), user["id"]))
    log_action(db, user, "fx_reconcile", "accounting", ref_id, kind,
               {"note": data.note})
    db.commit()
    return {"reconciled": True}


@router.post("/fx-revaluation")
def post_fx_revaluation(
    data: RevalueIn,
    user=Depends(require_perm("accounting", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Mark foreign cash to the current spot rate and book the difference as FX
    gain/loss. Run this at period close (monthly is typical).

    Every currency that is not the functional one is revalued the same way, and
    each has its own cash account precisely so its balance can be marked
    without unpicking it from the dollars.
    """
    counts = [("LBP", data.counted_lbp), ("EUR", data.counted_eur)]
    supplied = [(c, v) for c, v in counts if v is not None]
    if not supplied:
        raise HTTPException(400, "Give the amount counted in at least one "
                                 "foreign currency.")
    for cur, val in supplied:
        if val < 0:
            raise HTTPException(400, f"Counted {cur} cannot be negative.")

    posting_date = (data.as_of or accounting._now())[:10]
    _check_period_locked(db, posting_date)

    results = [_revalue_one(db, currency=cur, counted=val,
                            posting_date=posting_date, note=data.note, user=user)
               for cur, val in supplied]

    posted = [r for r in results if r["journal_entry_id"]]
    for r in posted:
        log_action(db, user, "fx_revalue", "accounting", r["journal_entry_id"],
                   f"{r['currency']} revaluation",
                   {"currency": r["currency"], "rate": r["rate"],
                    "book_usd": r["book_usd"], "counted_usd": r["counted_usd"],
                    "delta": r["delta"]})
    db.commit()

    body = {
        "message": ("No FX adjustment needed." if not posted
                    else "FX revaluation posted."),
        "results": results,
    }
    # The original callers asked about pounds and read these at the top level.
    # Kept so nothing that already works has to change.
    lbp = next((r for r in results if r["currency"] == "LBP"), None)
    if lbp:
        body.update({"journal_entry_id": lbp["journal_entry_id"],
                     "rate": lbp["rate"], "book_usd": lbp["book_usd"],
                     "counted_usd": lbp["counted_usd"], "delta": lbp["delta"]})
    return body
