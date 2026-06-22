"""
Branch-level visibility control (the branch hierarchy).

A *branch* is a location in the ``warehouses`` table (type='Branch'/'Main') —
there is no separate branches table. This module enforces WHO CAN SEE WHAT:

  * **Global** users — the vendor superadmin and the Business Owner / admin-tier
    role (``admin_access``) — see every branch and may focus one via the sidebar
    switcher (``?branch_id=``).
  * **Everyone else** is locked to their single HOME branch (``users.branch_id``).
    They cannot widen their view, and writes are forced into their home branch.

Strict separation of concerns:

  * ``branch_id`` (here) == what a user can SEE.
  * ``user_warehouse_access`` / ``warehouse_access.py`` == which warehouses a user
    may TRANSACT stock in. The two are independent layers.

Every existing user is backfilled to the default branch by migration 131, so the
switch to per-user isolation never produces an empty screen or a lockout.
"""
import sqlite3
from fastapi import HTTPException


def is_global(user: dict) -> bool:
    """True for users who see all branches: the vendor superadmin or any
    admin-tier role (Business Owner). Everyone else is branch-scoped."""
    return bool(user.get("is_superadmin") or user.get("admin_access"))


def _default_branch_id(db: sqlite3.Connection):
    row = db.execute(
        "SELECT id FROM warehouses WHERE is_default=1 LIMIT 1"
    ).fetchone()
    return row["id"] if row else None


def home_branch_id(user: dict, db: sqlite3.Connection):
    """The caller's home branch id. Prefers the value already resolved onto the
    user dict (permissions._resolve_user), else reads ``users.branch_id``, and
    falls back to the company default branch so a freshly-seeded account is never
    stranded with no branch."""
    bid = user.get("branch_id")
    if bid:
        return bid
    uid = user.get("id")
    if uid:
        row = db.execute("SELECT branch_id FROM users WHERE id=?", (uid,)).fetchone()
        if row and row["branch_id"]:
            return row["branch_id"]
    return _default_branch_id(db)


def accessible_branch_ids(user: dict, db: sqlite3.Connection):
    """Branch ids the caller may see: ``None`` (no restriction) for global users,
    otherwise the single-element set of their home branch."""
    if is_global(user):
        return None
    bid = home_branch_id(user, db)
    return {bid} if bid is not None else set()


def resolve_branch_id(user: dict, db: sqlite3.Connection, branch_id=None) -> int:
    """Resolve the branch a write lands in.

    * Global users may target any active branch (the supplied id, validated), or
      fall back to the focused/default branch when none is given.
    * Non-global users are always forced into their home branch; a supplied id
      that isn't their home branch is rejected (403) rather than silently moved.
    """
    if not is_global(user):
        home = home_branch_id(user, db)
        if home is None:
            raise HTTPException(
                400, "Your account has no branch assigned. Contact your administrator."
            )
        if branch_id is not None and int(branch_id) != int(home):
            raise HTTPException(403, "You can only create records in your own branch.")
        return int(home)

    # Global caller.
    if branch_id is None:
        bid = _default_branch_id(db)
        if bid is None:
            raise HTTPException(400, "No branch is configured.")
        return int(bid)
    row = db.execute(
        "SELECT id, is_active, archived_at FROM warehouses WHERE id=?", (branch_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Branch not found")
    if not row["is_active"] or row["archived_at"]:
        raise HTTPException(400, "Branch is inactive or archived.")
    return int(branch_id)


def branch_filter(user: dict, db: sqlite3.Connection, *, column: str = "branch_id",
                  selected=None):
    """Return ``(sql_fragment, params)`` to AND into a list/aggregate query so
    rows are scoped to the branches the caller may see.

    * Global users get an empty filter (all branches), or a single-branch filter
      when they pass ``selected`` (the switcher) — validated against access.
    * Non-global users are always pinned to their home branch; ``selected`` is
      ignored for them (they cannot widen or change their scope).
    * ``column`` lets callers point the filter at an aliased column
      (e.g. ``"e.branch_id"`` or ``"p.warehouse_id"``).
    """
    if not is_global(user):
        home = home_branch_id(user, db)
        if home is None:
            return " AND 1=0", []          # no branch → see nothing (safety)
        return f" AND {column} = ?", [home]

    # Global caller.
    if selected is not None and str(selected) != "":
        try:
            sel = int(selected)
        except (TypeError, ValueError):
            raise HTTPException(400, "Invalid branch filter.")
        return f" AND {column} = ?", [sel]
    return "", []


def assert_can_view_branch(user: dict, db: sqlite3.Connection, row_branch_id) -> None:
    """Row-level guard for detail-by-id endpoints: raise 404 if the caller may
    not see a record belonging to ``row_branch_id``. 404 (not 403) so a scoped
    user cannot probe which ids exist in other branches."""
    if is_global(user):
        return
    if row_branch_id is None:
        return  # legacy/global record — backfill assigns one, so this is rare
    if int(row_branch_id) != int(home_branch_id(user, db) or -1):
        raise HTTPException(404, "Not found")
