"""
Row-level access control for warehouses.

Two layers of permissions cooperate:

  * **Module RBAC** — `permissions.require_perm("warehouses", ...)` gates the
    Warehouses admin page (who can CRUD warehouses or grant access).
  * **Row-level access** — `user_warehouse_access` gates which warehouses a
    user may transact in (open a register, receive a purchase, run a transfer,
    adjust stock). Enforced through the helpers in this file.

Default policy (admin-friendly):
  * Superadmin and admin-tier roles bypass everything.
  * A user with **zero rows** in `user_warehouse_access` is treated as having
    access to all warehouses. This makes the migration safe for existing
    installs (nobody loses access overnight) and lets admins opt-in users to
    a restricted subset only when they want to fence someone off.
  * A user with **any rows** is restricted to exactly that list — switching
    from "open to all" to "explicit allow-list" is just adding the first row.
"""
import sqlite3
from fastapi import HTTPException


def _is_admin(user: dict) -> bool:
    return bool(user.get("is_superadmin") or user.get("admin_access"))


def has_explicit_grants(user: dict, db: sqlite3.Connection) -> bool:
    """True if the user has any explicit warehouse grants — i.e. their access
    is restricted to a specific subset."""
    if _is_admin(user) or not user.get("id"):
        return False
    return bool(db.execute(
        "SELECT 1 FROM user_warehouse_access WHERE user_id=? LIMIT 1",
        (user["id"],),
    ).fetchone())


def can_access(user: dict, db: sqlite3.Connection, warehouse_id: int) -> bool:
    """True if the user may transact in this warehouse."""
    if _is_admin(user):
        return True
    if not user.get("id"):
        return False
    # No explicit grants → access to all (safe default for existing installs).
    if not has_explicit_grants(user, db):
        return True
    return bool(db.execute(
        "SELECT 1 FROM user_warehouse_access WHERE user_id=? AND warehouse_id=?",
        (user["id"], warehouse_id),
    ).fetchone())


def require_access(user: dict, db: sqlite3.Connection, warehouse_id: int):
    """Raise 403 if the caller can't transact in this warehouse. Use this in
    every endpoint that writes to inventory_stock / posts a stock_movement
    against a specific warehouse."""
    if not can_access(user, db, warehouse_id):
        raise HTTPException(
            403,
            "You don't have access to this warehouse. Contact your administrator."
        )


def accessible_ids(user: dict, db: sqlite3.Connection):
    """Return the warehouse IDs the user can transact in.

    Returns `None` to mean "no restriction" (admin or no explicit grants) —
    callers should branch on `None` rather than fetching every id, so listing
    queries can skip the WHERE filter entirely. Returns `set[int]` otherwise.
    """
    if _is_admin(user):
        return None
    if not user.get("id"):
        return set()
    if not has_explicit_grants(user, db):
        return None
    return {
        r["warehouse_id"] for r in db.execute(
            "SELECT warehouse_id FROM user_warehouse_access WHERE user_id=?",
            (user["id"],),
        ).fetchall()
    }


def default_warehouse_id(user: dict, db: sqlite3.Connection) -> int:
    """Resolve the warehouse to use when an endpoint receives no explicit
    `warehouse_id`. Order of preference:

      1. `users.default_warehouse_id` if set AND the user can access it AND
         the warehouse is active and not archived.
      2. The company's `is_default=1` warehouse if the user can access it.
      3. The first warehouse the user has access to (deterministic by id).
      4. 400 if the user has access to nothing — they shouldn't be performing
         stock operations at all.

    Every stock-touching endpoint should call this when its `warehouse_id`
    parameter is omitted, so callers can keep their existing API contracts.
    """
    uid = user.get("id")

    # 1. Personal default
    if uid:
        row = db.execute(
            "SELECT w.id FROM users u "
            "JOIN warehouses w ON w.id = u.default_warehouse_id "
            "WHERE u.id=? AND w.is_active=1 AND w.archived_at IS NULL",
            (uid,),
        ).fetchone()
        if row and can_access(user, db, row["id"]):
            return row["id"]

    # 2. Company default
    row = db.execute(
        "SELECT id FROM warehouses "
        "WHERE is_default=1 AND is_active=1 AND archived_at IS NULL"
    ).fetchone()
    if row and can_access(user, db, row["id"]):
        return row["id"]

    # 3. First accessible warehouse
    ids = accessible_ids(user, db)
    if ids is None:
        # No restriction → fall back to lowest active warehouse id
        row = db.execute(
            "SELECT id FROM warehouses "
            "WHERE is_active=1 AND archived_at IS NULL ORDER BY id LIMIT 1"
        ).fetchone()
        if row:
            return row["id"]
    elif ids:
        # Pick the lowest id from the explicit grant set that is still active
        rows = db.execute(
            f"SELECT id FROM warehouses WHERE id IN ({','.join('?' for _ in ids)}) "
            f"AND is_active=1 AND archived_at IS NULL ORDER BY id LIMIT 1",
            tuple(ids),
        ).fetchone()
        if rows:
            return rows["id"]

    # 4. Nothing the caller can use
    raise HTTPException(
        400,
        "No warehouse is available for this operation. Ask your administrator "
        "to grant you access to at least one warehouse."
    )


def credit_warehouse_stock(db: sqlite3.Connection, *, inventory_id: int,
                            warehouse_id: int, delta: float):
    """Bump `inventory_stock.quantity` for one (item, warehouse) pair.

    Used by the existing stock-touching code paths (purchases receipt, POS
    checkout, manufacturing consumption…) that already update the company-wide
    `inventory.quantity` directly. The two stay in sync because every legacy
    path now calls this helper alongside its existing UPDATE.

    Idempotently creates the stock row on first touch. Does NOT validate
    non-negative — callers are responsible (they already check on the
    company-wide quantity before deducting)."""
    db.execute(
        "INSERT OR IGNORE INTO inventory_stock "
        "(inventory_id, warehouse_id, quantity, reserved_quantity, quarantine_quantity) "
        "VALUES (?, ?, 0, 0, 0)",
        (inventory_id, warehouse_id),
    )
    db.execute(
        "UPDATE inventory_stock SET quantity = quantity + ? "
        "WHERE inventory_id=? AND warehouse_id=?",
        (delta, inventory_id, warehouse_id),
    )


def default_warehouse_id_for_row(db: sqlite3.Connection,
                                  existing_id=None) -> int:
    """For backfill paths (purchase / POS session / production order) where a
    `warehouse_id` column was added but the row may have been created before
    the operator was prompted to pick one. Returns the row's existing id if
    set, else the company default ('MAIN')."""
    if existing_id is not None:
        return int(existing_id)
    row = db.execute(
        "SELECT id FROM warehouses "
        "WHERE is_default=1 AND is_active=1 AND archived_at IS NULL"
    ).fetchone()
    if not row:
        raise sqlite3.IntegrityError(
            "No default warehouse configured — this should be impossible after migration 122."
        )
    return int(row["id"])


def resolve_warehouse_id(user: dict, db: sqlite3.Connection,
                         warehouse_id=None) -> int:
    """The standard resolver for stock-touching endpoints: take the supplied
    id (if any), validate it exists + is active + the caller can access it,
    or fall back to the user's resolved default. Returns the chosen id."""
    if warehouse_id is None:
        return default_warehouse_id(user, db)
    row = db.execute(
        "SELECT id, is_active, archived_at FROM warehouses WHERE id=?",
        (warehouse_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Warehouse not found")
    if not row["is_active"] or row["archived_at"]:
        raise HTTPException(400, "Warehouse is inactive or archived.")
    require_access(user, db, warehouse_id)
    return int(warehouse_id)
