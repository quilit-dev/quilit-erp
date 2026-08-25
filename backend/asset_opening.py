"""Putting assets the business already owned onto the balance sheet.

Every asset registered before buying became an accounting event posted no
acquisition entry, and depreciation has been charged against them ever since.
So the ledger carries a contra-asset — accumulated depreciation — standing
against a cost that was never debited, and the non-current asset section reads
as a negative number.

This posts ONE entry, and it puts back only what is actually missing — the
COST:

    DR  fixed_asset          the cost of every unposted asset
      CR retained_earnings     the same figure

Accumulated depreciation is deliberately NOT touched. Every depreciation charge
was posted as it happened, so it is already in the ledger; crediting it again
here would count it twice and leave the contra-asset at double what has been
charged.

Retained earnings is the right credit because that is what an opening balance
IS: value the business already had when these books started, not income it
earned this year. Crediting anything in the P&L would invent a profit. The
depreciation charged since remains this period's expense, so equity ends up
moved by the net book value — which is the truth.

It is a RECLASSIFICATION of what the register already says, not a revaluation.
No asset's cost changes, no depreciation is recalculated, and nothing already
posted moves. Run once; the entry is idempotent on its source and refuses a
second run outright.

Modelled on chart_cutover.py, which does the same job for a business that
changes chart: a preview anybody can read, then one entry, with refusals that
name what is wrong rather than guessing.
"""
import sqlite3
from typing import Optional

import accounting
from utils import money

SOURCE_TYPE = "asset_opening"


def _unposted(db: sqlite3.Connection) -> list:
    """Assets whose cost never reached the ledger.

    An asset is unposted when it has no acquisition entry — which is every
    asset registered before that was a thing, and every one entered since as
    an opening balance. Disposed assets are excluded: whatever they owed the
    balance sheet, they no longer sit on it.
    """
    try:
        rows = db.execute(
            """SELECT id, asset_code, name, acquisition_cost,
                      accumulated_depreciation, status, acquisition_date
                 FROM fixed_assets
                WHERE acquisition_entry_id IS NULL
                  AND archived_at IS NULL
                  AND status NOT IN ('Disposed', 'Rejected', 'Pending Approval')
                ORDER BY acquisition_date, id""").fetchall()
    except sqlite3.Error:
        # A tenant whose 167 migration has not run yet has no column to read.
        return []
    return [dict(r) for r in rows if float(r["acquisition_cost"] or 0) > 0.005]


def already_done(db: sqlite3.Connection):
    """The opening entry, if one has been posted and not reversed."""
    return db.execute(
        "SELECT id, entry_number, entry_date FROM journal_entries "
        "WHERE source_type = ? AND status = 'posted' "
        "ORDER BY id DESC LIMIT 1", (SOURCE_TYPE,)).fetchone()


def preview(db: sqlite3.Connection) -> dict:
    """What would be posted, before anything is written."""
    rows = _unposted(db)
    cost = money(sum(float(r["acquisition_cost"] or 0) for r in rows))
    depreciated = money(sum(float(r["accumulated_depreciation"] or 0) for r in rows))

    done = already_done(db)
    return {
        "assets": [{
            "id": r["id"], "asset_code": r["asset_code"], "name": r["name"],
            "cost": money(r["acquisition_cost"]),
            "depreciated": money(r["accumulated_depreciation"]),
            "book_value": money(float(r["acquisition_cost"] or 0)
                                - float(r["accumulated_depreciation"] or 0)),
        } for r in rows],
        "count": len(rows),
        "cost": cost,
        "depreciated": depreciated,
        "book_value": money(cost - depreciated),
        "already_posted": (dict(done) if done else None),
    }


def post(db: sqlite3.Connection, *, as_of: Optional[str] = None,
         note: Optional[str] = None, created_by=None) -> dict:
    """Bring every unposted asset onto the books in one entry."""
    from utils import _today

    on = (as_of or _today())[:10]
    if on > _today()[:10]:
        raise ValueError(
            "An opening balance cannot be dated in the future: the entry would "
            "exist and no statement would show it until that date arrived.")

    if already_done(db):
        raise ValueError(
            "The opening balances have already been brought in. Reverse that "
            "entry first if it needs redoing — posting twice would put every "
            "asset on the books a second time.")

    rows = _unposted(db)
    if not rows:
        raise ValueError(
            "Every asset on the register already has its cost in the ledger, "
            "so there is nothing to bring in.")

    cost = money(sum(float(r["acquisition_cost"] or 0) for r in rows))
    depreciated = money(sum(float(r["accumulated_depreciation"] or 0) for r in rows))
    book_value = money(cost - depreciated)

    # Cost only. The depreciation charged against these assets was posted when
    # it was charged and is already sitting in the contra-asset — crediting it
    # again here would leave it at twice what has actually been written off.
    lines = [
        {"code": accounting.code(db, "fixed_asset"), "debit": cost,
         "memo": f"{len(rows)} asset(s) already owned"},
        {"code": accounting.code(db, "retained_earnings"), "credit": cost,
         "memo": "Cost of assets owned before these books"},
    ]

    memo = f"Fixed assets brought onto the books — {len(rows)} asset(s)"
    if note:
        memo += f" — {note}"

    entry_id = accounting.post_entry(
        db, entry_date=on, memo=memo, lines=lines,
        source_type=SOURCE_TYPE, source_id=None, created_by=created_by)

    # Each asset now points at the entry that carried it, so it is no longer
    # unposted and a second run has nothing to find.
    for r in rows:
        db.execute("UPDATE fixed_assets SET acquisition_entry_id=? WHERE id=?",
                   (entry_id, r["id"]))

    return {"journal_entry_id": entry_id, "assets": len(rows),
            "cost": cost, "depreciated": depreciated, "book_value": book_value}
