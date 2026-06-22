"""
Branch-level access control.

A *branch* is a location in the existing ``warehouses`` table (type='Branch' or
'Main') — there is no separate branches table. Branch membership and isolation
therefore reuse the warehouse machinery wholesale:

  * ``user_warehouse_access`` is the per-user branch allow-list.
  * Admins / superadmins bypass everything (all branches).
  * A user with **zero rows** has access to all branches — the safe default that
    keeps existing single-branch installs working unchanged.

These helpers add the read-side filter and the write-side resolver that the
operational routers (expenses, invoices, quotations, cash, hr) use to scope a
``branch_id`` column to the caller's accessible branches. ``branch_id`` is a FK
to ``warehouses(id)``; "branch" and "warehouse" are the same row.
"""
import sqlite3
from fastapi import HTTPException
import warehouse_access


def resolve_branch_id(user: dict, db: sqlite3.Connection, branch_id=None) -> int:
    """Resolve the branch for a write.

    A supplied id is validated for existence, active state and caller access; an
    omitted id falls back to the user's default branch. Delegates to the
    warehouse resolver because branch == warehouse.
    """
    return warehouse_access.resolve_warehouse_id(user, db, branch_id)


def accessible_branch_ids(user: dict, db: sqlite3.Connection):
    """Branch ids the caller may see, or ``None`` for "no restriction" (an admin,
    or a user with no explicit grants). Mirrors ``warehouse_access.accessible_ids``."""
    return warehouse_access.accessible_ids(user, db)


def branch_filter(user: dict, db: sqlite3.Connection, *, column: str = "branch_id",
                  selected=None):
    """Return ``(sql_fragment, params)`` to AND into a list query so rows are
    scoped to the branches the caller may see.

    * ``selected`` — an optional branch_id the caller asked to view (the branch
      switcher). It is intersected with the caller's accessible set, so a
      restricted user can never widen their view by passing another branch's id.
    * Admins / unrestricted users with no ``selected`` get an empty filter
      (all branches). Passing ``selected`` narrows even an admin to one branch.
    * ``column`` lets callers point the filter at an aliased column
      (e.g. ``"e.branch_id"``).

    The backfill migration guarantees existing rows carry a non-NULL branch_id,
    so the ``IN (...)`` form used for restricted callers needs no NULL handling.
    """
    allowed = warehouse_access.accessible_ids(user, db)  # None == unrestricted

    if selected is not None and str(selected) != "":
        try:
            sel = int(selected)
        except (TypeError, ValueError):
            raise HTTPException(400, "Invalid branch filter.")
        if allowed is not None and sel not in allowed:
            raise HTTPException(403, "You don't have access to that branch.")
        return f" AND {column} = ?", [sel]

    if allowed is None:
        return "", []
    if not allowed:
        # Authenticated but granted nothing accessible — return no rows.
        return " AND 1=0", []
    placeholders = ",".join("?" for _ in allowed)
    return f" AND {column} IN ({placeholders})", list(allowed)
