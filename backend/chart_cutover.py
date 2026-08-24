"""Moving the balances across when a business changes chart of accounts.

Switching charts leaves every historical entry pointing at the accounts it was
posted to, which is right — an account is what makes an old ledger readable,
and this system never deletes one. But it also means the balances stay there.
Until they are moved, the trial balance carries two charts at once and no
statement reads correctly.

So this posts one entry that takes each retired account to zero and puts the
same amount on its counterpart in the chart now in use. It is a
RECLASSIFICATION and nothing else: no amount changes, no revenue is
recognised, no asset is revalued. Every figure lands somewhere new and nowhere
different.

Balanced by construction. Each balance is moved with one debit and one credit
of the same size, so the entry cannot come out lopsided however many accounts
are involved.

What it will not do is guess. An account the roles cover — receivables to
receivables, cash to cash — maps itself. Anything else is somebody's judgement
about their own books, and this asks rather than deciding: rent could go to
"other external charges" or somewhere more specific, and only the business
knows which.
"""
import sqlite3
from typing import Optional

import accounting
from utils import money


SOURCE_TYPE = "chart_cutover"


def _balances(db: sqlite3.Connection, as_of: str) -> list:
    """Every retired account still carrying a balance on `as_of`.

    Retired means inactive: the chart the business left. Anything still active
    belongs to the chart in use and stays exactly where it is.
    """
    rows = db.execute(
        """SELECT a.id, a.code, a.name, a.name_ar, a.type, a.subtype,
                  a.normal_balance,
                  COALESCE(SUM(l.debit), 0)  AS debit,
                  COALESCE(SUM(l.credit), 0) AS credit
             FROM chart_of_accounts a
             JOIN journal_entry_lines l ON l.account_id = a.id
             JOIN journal_entries je    ON je.id = l.journal_entry_id
            WHERE a.is_active = 0
              AND je.status = 'posted'
              AND je.entry_date <= ?
         GROUP BY a.id
         ORDER BY a.code""",
        (as_of[:10],)).fetchall()

    out = []
    for r in rows:
        debit, credit = round(float(r["debit"]), 2), round(float(r["credit"]), 2)
        net = round(debit - credit, 2)
        if abs(net) < 0.005:
            continue          # already square; nothing to move
        d = dict(r)
        d["balance"] = net    # positive = sits on the debit side
        out.append(d)
    return out


def _suggestions(db: sqlite3.Connection, rows: list) -> dict:
    """Where each retired account probably belongs now.

    Two sources, and the difference matters to whoever is checking. An account
    that played a ROLE maps to whatever plays that role today, which is not a
    guess — it is the same part in a different cast. Anything else gets the
    first active account of the same type and subtype, which IS a guess and is
    labelled as one.
    """
    # The role each default-chart code used to play.
    by_code = {}
    for role, code in database_default_roles():
        by_code.setdefault(code, role)

    active = db.execute(
        "SELECT code, name, type, subtype FROM chart_of_accounts "
        "WHERE is_active = 1 ORDER BY code").fetchall()

    out = {}
    for r in rows:
        role = by_code.get(r["code"])
        if role:
            try:
                out[r["code"]] = {"code": accounting.code(db, role),
                                  "why": "role", "role": role}
                continue
            except Exception:
                pass
        same = next((a for a in active
                     if a["type"] == r["type"] and a["subtype"] == r["subtype"]), None)
        if same is None:
            same = next((a for a in active if a["type"] == r["type"]), None)
        out[r["code"]] = ({"code": same["code"], "why": "similar"} if same
                          else {"code": None, "why": "none"})
    return out


def database_default_roles():
    """The default chart's role mapping, as pairs.

    Imported lazily because `database` imports a good deal at module scope and
    this is only needed while a cutover is being planned.
    """
    from database import _DEFAULT_ACCOUNT_ROLES
    return list(_DEFAULT_ACCOUNT_ROLES)


def already_done(db: sqlite3.Connection):
    """The cutover entry, if one has been posted and not reversed."""
    return db.execute(
        "SELECT id, entry_number, entry_date FROM journal_entries "
        "WHERE source_type = ? AND status = 'posted' "
        "ORDER BY id DESC LIMIT 1", (SOURCE_TYPE,)).fetchone()


def preview(db: sqlite3.Connection, as_of: str) -> dict:
    """What the cutover would move, before anything is written."""
    rows = _balances(db, as_of)
    hints = _suggestions(db, rows)
    names = {r["code"]: r["name"] for r in db.execute(
        "SELECT code, name FROM chart_of_accounts").fetchall()}

    lines = []
    for r in rows:
        s = hints.get(r["code"], {})
        lines.append({
            "from_code": r["code"], "from_name": r["name"],
            "from_name_ar": r["name_ar"], "type": r["type"],
            "subtype": r["subtype"], "balance": r["balance"],
            "side": "debit" if r["balance"] > 0 else "credit",
            "to_code": s.get("code"),
            "to_name": names.get(s.get("code")),
            "suggested_by": s.get("why"),
            "role": s.get("role"),
        })

    done = already_done(db)
    return {
        "as_of": as_of[:10],
        "lines": lines,
        "total": money(sum(abs(l["balance"]) for l in lines)),
        "unmapped": [l["from_code"] for l in lines if not l["to_code"]],
        "already_posted": (dict(done) if done else None),
    }


def post(db: sqlite3.Connection, *, as_of: str, mappings: dict,
         note: Optional[str] = None, created_by=None) -> dict:
    """Move every retired balance onto the chart in use. Returns the entry.

    `mappings` is from-code → to-code and must cover every account with a
    balance. A partial cutover is worse than none: it leaves the business
    reading a trial balance spread over two charts and believing the move is
    finished.
    """
    from utils import _today
    if as_of[:10] > _today()[:10]:
        raise ValueError(
            "A cutover cannot be dated in the future: the entry would exist "
            "but no statement would show it until that date arrived, and the "
            "books would look untouched.")

    if already_done(db):
        raise ValueError(
            "A cutover has already been posted. Reverse that entry first if "
            "it needs redoing — two of them would move the balances twice.")

    rows = _balances(db, as_of)
    if not rows:
        raise ValueError("No retired account is carrying a balance on this "
                         "date, so there is nothing to move.")

    active = {r["code"] for r in db.execute(
        "SELECT code FROM chart_of_accounts WHERE is_active = 1").fetchall()}

    lines = []
    for r in rows:
        target = (mappings or {}).get(r["code"])
        if not target:
            raise ValueError(
                f"{r['code']} {r['name']} is carrying "
                f"{abs(r['balance']):,.2f} and has nowhere to go. Every "
                "account with a balance needs a destination.")
        if target not in active:
            raise ValueError(
                f"{target} is not an account on the chart in use, so moving "
                f"{r['code']} there would leave the balance retired again.")

        dest = db.execute(
            "SELECT type FROM chart_of_accounts WHERE code = ?", (target,)).fetchone()
        if dest and dest["type"] != r["type"]:
            # An asset moved onto an income account is not a reclassification,
            # it is a restatement — and it would change the profit for the year
            # without anybody intending to.
            raise ValueError(
                f"{r['code']} is {r['type']} and {target} is {dest['type']}. "
                "Moving a balance between account types changes the accounts "
                "rather than relocating them.")

        amount = abs(r["balance"])
        memo = f"Carried from {r['code']} {r['name']}"
        if r["balance"] > 0:
            # Sat on the debit side: credit it away, debit its counterpart.
            lines.append({"code": r["code"], "credit": amount, "memo": memo})
            lines.append({"code": target, "debit": amount, "memo": memo})
        else:
            lines.append({"code": r["code"], "debit": amount, "memo": memo})
            lines.append({"code": target, "credit": amount, "memo": memo})

    memo = f"Chart cutover — balances carried across on {as_of[:10]}"
    if note:
        memo += f" — {note}"

    je_id = accounting.post_entry(
        db, entry_date=as_of[:10], memo=memo, lines=lines,
        source_type=SOURCE_TYPE, source_id=None, created_by=created_by)

    return {"journal_entry_id": je_id, "accounts": len(rows),
            "moved": money(sum(abs(r["balance"]) for r in rows))}
