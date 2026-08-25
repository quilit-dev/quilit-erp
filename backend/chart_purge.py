"""Taking the old chart out of the books for good.

Installing a statutory chart RETIRES the previous one rather than removing it,
because an account is what historical entries point at and a retired one keeps
an old ledger readable. That is right while the old chart has history. It is
just clutter when it does not — and on a business that switched charts before
it ever posted, every one of those accounts is clutter: forty-odd rows of a
chart nobody uses, sitting in the account list next to the real one.

So this removes the ones that can be removed, and is explicit about the ones
that cannot:

  * an account with NO journal line has never been part of anything. Deleting
    it loses nothing and there is nothing left to point at it.
  * an account WITH lines stays, deactivated, for as long as those lines do.
    Removing it would leave entries referencing an account that no longer
    exists, and the trial balance would stop explaining itself.

It refuses entirely unless a statutory chart is installed and its roles point
at it. Without that check "remove the accounts not on the current chart" would
happily delete the chart the business is actually using.

The counterpart of chart_cutover.py: that one moves the BALANCES across, this
one clears away what is left once they have gone.
"""
import sqlite3
from typing import Optional

import chart_lebanon


def _installed_chart(db: sqlite3.Connection):
    """The statutory chart in use, or None if the tenant is on the default."""
    lb = chart_lebanon.status(db)
    return chart_lebanon if lb["installed"] else None


def _protected_codes(db: sqlite3.Connection) -> set:
    """Codes that belong to the chart in use, one way or another."""
    codes = {a[0] for a in chart_lebanon.all_accounts()}
    # A bank account opens its own leaf beneath whatever the `bank` role points
    # at, so it is a child of this chart, not a stranger to it.
    try:
        codes |= {r["account_code"] for r in db.execute(
            "SELECT account_code FROM bank_accounts "
            "WHERE account_code IS NOT NULL").fetchall()}
    except sqlite3.Error:
        pass
    # Whatever the roles point at, whether or not it is on the published plan.
    # Deleting an account a posting is about to be routed to would break the
    # next transaction rather than an old one.
    try:
        codes |= {r["code"] for r in db.execute(
            "SELECT code FROM account_roles").fetchall()}
    except sqlite3.Error:
        pass
    return {c for c in codes if c}


def _lines_for(db: sqlite3.Connection, account_id: int) -> int:
    row = db.execute(
        "SELECT COUNT(*) AS n FROM journal_entry_lines WHERE account_id = ?",
        (account_id,)).fetchone()
    return int(row["n"] or 0)


def survey(db: sqlite3.Connection) -> dict:
    """Every account that is not part of the chart in use, and its history."""
    if _installed_chart(db) is None:
        return {"eligible": False, "removable": [], "kept": [], "reason": "default"}

    keep = _protected_codes(db)
    removable, kept = [], []
    for row in db.execute(
            "SELECT id, code, name, type, is_active FROM chart_of_accounts "
            "ORDER BY code").fetchall():
        if row["code"] in keep:
            continue
        used = _lines_for(db, row["id"])
        entry = {"id": row["id"], "code": row["code"], "name": row["name"],
                 "type": row["type"], "lines": used}
        (kept if used else removable).append(entry)
    return {"eligible": True, "removable": removable, "kept": kept,
            "reason": None}


def preview(db: sqlite3.Connection) -> dict:
    """What removing the old chart would and would not take away."""
    s = survey(db)
    return {
        "eligible": s["eligible"],
        "reason": s["reason"],
        "removable": s["removable"],
        "removable_count": len(s["removable"]),
        # Named individually: "3 accounts must stay" invites the question
        # "which ones", and the answer decides whether somebody goes and does
        # a cutover first.
        "kept": s["kept"],
        "kept_count": len(s["kept"]),
    }


def purge(db: sqlite3.Connection, *, created_by=None) -> dict:
    """Delete the accounts of the old chart that carry no history."""
    if _installed_chart(db) is None:
        raise ValueError(
            "This tenant is on the default chart, so the accounts not on "
            "'another chart' are the ones it is using. Install the statutory "
            "chart first.")

    s = survey(db)
    if not s["removable"] and not s["kept"]:
        raise ValueError(
            "There is nothing here that does not belong to the chart in use.")
    if not s["removable"]:
        raise ValueError(
            f"All {len(s['kept'])} account(s) from the old chart carry posted "
            "entries, so none can be removed — an entry pointing at an account "
            "that no longer exists is a trial balance that cannot explain "
            "itself. Move the balances across first (Accounting → chart "
            "cutover); the accounts stay retired either way.")

    removed = []
    for a in s["removable"]:
        db.execute("DELETE FROM chart_of_accounts WHERE id = ?", (a["id"],))
        removed.append(a["code"])

    # Anything left is retired, not offered, and stays only because history
    # points at it.
    for a in s["kept"]:
        db.execute("UPDATE chart_of_accounts SET is_active = 0 WHERE id = ?",
                   (a["id"],))

    return {"removed": len(removed), "codes": removed,
            "kept": len(s["kept"]),
            "kept_codes": [a["code"] for a in s["kept"]]}
