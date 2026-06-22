"""
Warehouses — multi-location stock management.

Two surfaces in one router:

  * **Admin** — CRUD warehouses, manage per-user access. Requires module-level
    `warehouses` permission. Superadmin/admin always passes.
  * **Operations** — stock transfers between warehouses (Draft → In Transit →
    Completed). Each step is permission-checked against BOTH endpoints
    (`require_perm("warehouses", ...)`) AND row-level access on the source
    and destination warehouses (a clerk authorised for the East branch can't
    dispatch a transfer FROM the West branch).

Accounting note: transfers never touch the GL. They are a quantity reallocation
within a single 1200 Inventory account, not a financial event.
"""
import sqlite3
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from database import get_db
from permissions import require_perm, require_auth
from routers.audit import log_action
from utils import _now, notify
import warehouse_access as wha


# ── Notification helpers ─────────────────────────────────────────────────────
# Stock-transfer alerts target the people who actually act on them — clerks
# at the destination warehouse for "incoming" alerts, source clerks for
# "departed/cancelled" alerts. We resolve the recipient set by intersecting
# the explicit user_warehouse_access rows with active users. Admin-tier users
# (no explicit access rows) get the alert automatically via NULL fan-out.

def _warehouse_user_ids(db, warehouse_id: int) -> list:
    """Every active user who can access `warehouse_id`. Returns an empty list
    when only admins (with implicit access) are eligible — those still receive
    the alert through the global user_id=NULL fan-out path."""
    rows = db.execute(
        """SELECT DISTINCT u.id FROM users u
           JOIN user_warehouse_access uwa ON uwa.user_id = u.id
           WHERE u.is_active = 1 AND u.deleted_at IS NULL
             AND uwa.warehouse_id = ?""",
        (warehouse_id,),
    ).fetchall()
    return [r["id"] for r in rows]


def _notify_transfer_endpoint(db, *, warehouse_id: int, exclude_user: "Optional[int]",
                              type: str, title: str, body: str, transfer_id: int) -> None:
    """Fan out a transfer event to every active user with access to one of
    its endpoints. When nobody is explicitly authorised (warehouse open to
    admins only), we still emit one global row so the admin bell rings."""
    recipients = _warehouse_user_ids(db, warehouse_id)
    if not recipients:
        notify(
            db, type=type, title=title, body=body,
            link="/warehouses", entity_type="stock_transfer", entity_id=transfer_id,
        )
        return
    for uid in recipients:
        if uid == exclude_user:
            continue
        notify(
            db, user_id=uid, type=type, title=title, body=body,
            link="/warehouses", entity_type="stock_transfer", entity_id=transfer_id,
        )

router = APIRouter()

VALID_TYPES = ("Main", "Branch", "Production", "Damaged", "Transit", "Returns")


# ── Schemas ────────────────────────────────────────────────────────────────
class WarehouseIn(BaseModel):
    code:       str = Field(..., min_length=1, max_length=32)
    name:       str = Field(..., min_length=1, max_length=120)
    type:       str = "Main"
    address:    Optional[str] = None
    phone:      Optional[str] = None
    manager_id: Optional[int] = None
    is_active:  bool = True
    notes:      Optional[str] = None


class WarehouseUpdate(BaseModel):
    name:       Optional[str] = None
    type:       Optional[str] = None
    address:    Optional[str] = None
    phone:      Optional[str] = None
    manager_id: Optional[int] = None
    is_active:  Optional[bool] = None
    notes:      Optional[str] = None


class AccessGrant(BaseModel):
    user_id: int


class TransferItemIn(BaseModel):
    inventory_id: int
    quantity:     float
    note:         Optional[str] = None


class TransferIn(BaseModel):
    from_warehouse_id: int
    to_warehouse_id:   int
    items:             List[TransferItemIn]
    notes:             Optional[str] = None


class TransferReceiveItem(BaseModel):
    item_id:           int
    received_quantity: float


class TransferReceive(BaseModel):
    items: Optional[List[TransferReceiveItem]] = None  # None = receive full qty
    note:  Optional[str] = None


class TransferCancel(BaseModel):
    reason: Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────
def _wh_row(db, wid: int):
    row = db.execute("SELECT * FROM warehouses WHERE id=?", (wid,)).fetchone()
    if not row:
        raise HTTPException(404, "Warehouse not found")
    return row


def _adjust_stock(db: sqlite3.Connection, inventory_id: int, warehouse_id: int,
                  delta: float, *, mvmt_type: str, reference: str, note: str,
                  now: str):
    """Move `delta` units of an item into/out of a warehouse, maintaining
    BOTH the per-warehouse `inventory_stock.quantity` AND the company-wide
    `inventory.quantity` so legacy SELECTs keep working. Records the movement
    in `stock_movements` (the audit log of every quantity change).

    Caller is responsible for committing. Validates non-negative end-state
    on the per-warehouse balance, since transfers MUST NOT overdraw a source.
    """
    db.execute(
        "INSERT OR IGNORE INTO inventory_stock "
        "(inventory_id, warehouse_id, quantity, reserved_quantity, quarantine_quantity) "
        "VALUES (?, ?, 0, 0, 0)",
        (inventory_id, warehouse_id),
    )
    row = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (inventory_id, warehouse_id),
    ).fetchone()
    qty_before = float(row["quantity"])
    qty_after  = round(qty_before + delta, 6)
    if qty_after < 0:
        raise HTTPException(
            400,
            f"Insufficient stock in warehouse: requested {-delta} but only "
            f"{qty_before} available."
        )
    db.execute(
        "UPDATE inventory_stock SET quantity=? "
        "WHERE inventory_id=? AND warehouse_id=?",
        (qty_after, inventory_id, warehouse_id),
    )
    # Maintain the company-wide total denormalised on `inventory`.
    db.execute(
        "UPDATE inventory SET quantity = COALESCE(quantity,0) + ? WHERE id=?",
        (delta, inventory_id),
    )
    db.execute(
        "INSERT INTO stock_movements "
        "(inventory_id, type, delta, qty_before, qty_after, reference, note, "
        " warehouse_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (inventory_id, mvmt_type, delta, qty_before, qty_after,
         reference, note, warehouse_id, now),
    )


# ─────────────────────────────────────────────────────────────────────────
# WAREHOUSE ADMIN
# ─────────────────────────────────────────────────────────────────────────

@router.get("/")
def list_warehouses(
    include_archived: bool = False,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """List warehouses the caller can transact in. Admin sees all. Module-
    level `warehouses` view permission is NOT required to list — most
    operational endpoints (POS, Purchases, etc.) need to pick from the list."""
    where = []
    params: list = []
    if not include_archived:
        where.append("archived_at IS NULL")
    ids = wha.accessible_ids(user, db)
    if ids is not None:
        if not ids:
            return []
        where.append(f"id IN ({','.join('?' for _ in ids)})")
        params.extend(ids)
    sql = "SELECT * FROM warehouses"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY is_default DESC, code"
    return [dict(r) for r in db.execute(sql, params).fetchall()]


@router.post("/")
def create_warehouse(
    data: WarehouseIn,
    user=Depends(require_perm("warehouses", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if data.type not in VALID_TYPES:
        raise HTTPException(
            400, f"Warehouse type must be one of: {', '.join(VALID_TYPES)}"
        )
    if db.execute("SELECT 1 FROM warehouses WHERE code=?", (data.code,)).fetchone():
        raise HTTPException(400, f"A warehouse with code '{data.code}' already exists.")
    if data.manager_id and not db.execute(
        "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL", (data.manager_id,)
    ).fetchone():
        raise HTTPException(400, "Manager user not found.")
    now = _now()
    cur = db.execute(
        "INSERT INTO warehouses "
        "(code, name, type, address, phone, manager_id, is_active, is_default, notes, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
        (data.code, data.name, data.type, data.address, data.phone, data.manager_id,
         1 if data.is_active else 0, data.notes, now),
    )
    log_action(db, user, "create", "warehouse", cur.lastrowid, data.code,
               {"name": data.name, "type": data.type})
    db.commit()
    return {"id": cur.lastrowid, "message": "Warehouse created"}


@router.get("/{wid}")
def get_warehouse(
    wid: int,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    row = _wh_row(db, wid)
    if not wha.can_access(user, db, wid):
        raise HTTPException(403, "You don't have access to this warehouse.")
    return dict(row)


@router.put("/{wid}")
def update_warehouse(
    wid: int,
    data: WarehouseUpdate,
    user=Depends(require_perm("warehouses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = _wh_row(db, wid)
    if data.type is not None and data.type not in VALID_TYPES:
        raise HTTPException(
            400, f"Warehouse type must be one of: {', '.join(VALID_TYPES)}"
        )
    fields, params = [], []
    for k in ("name", "type", "address", "phone", "manager_id", "notes"):
        v = getattr(data, k)
        if v is not None:
            fields.append(f"{k}=?"); params.append(v)
    if data.is_active is not None:
        fields.append("is_active=?"); params.append(1 if data.is_active else 0)
    if not fields:
        return {"message": "No changes"}
    params.append(wid)
    db.execute(f"UPDATE warehouses SET {','.join(fields)} WHERE id=?", params)
    log_action(db, user, "update", "warehouse", wid, row["code"],
               {k: getattr(data, k) for k in data.dict(exclude_unset=True)})
    db.commit()
    return {"message": "Warehouse updated"}


@router.post("/{wid}/set-default")
def set_default(
    wid: int,
    user=Depends(require_perm("warehouses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Promote a warehouse to be the company-wide default. At most one
    warehouse can be the default at any time (enforced by a unique partial
    index)."""
    row = _wh_row(db, wid)
    if row["archived_at"] or not row["is_active"]:
        raise HTTPException(400, "Cannot set an archived or inactive warehouse as default.")
    db.execute("UPDATE warehouses SET is_default=0 WHERE is_default=1")
    db.execute("UPDATE warehouses SET is_default=1 WHERE id=?", (wid,))
    log_action(db, user, "set_default", "warehouse", wid, row["code"])
    db.commit()
    return {"message": f"'{row['code']}' is now the default warehouse"}


@router.patch("/{wid}/archive")
def archive_warehouse(
    wid: int,
    user=Depends(require_perm("warehouses", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = _wh_row(db, wid)
    if row["is_default"]:
        raise HTTPException(
            400,
            "Cannot archive the default warehouse. Promote a different "
            "warehouse to default first."
        )
    # Refuse to archive a warehouse that still holds non-zero stock — that's
    # almost certainly an operational mistake, not housekeeping.
    held = db.execute(
        "SELECT COALESCE(SUM(quantity), 0) FROM inventory_stock WHERE warehouse_id=?",
        (wid,),
    ).fetchone()[0]
    if held and held > 0:
        raise HTTPException(
            400,
            f"Cannot archive: warehouse still holds {held} units. Transfer "
            "stock out first."
        )
    db.execute(
        "UPDATE warehouses SET archived_at=?, is_active=0 WHERE id=?",
        (_now(), wid),
    )
    log_action(db, user, "archive", "warehouse", wid, row["code"])
    db.commit()
    return {"message": "Warehouse archived"}


@router.patch("/{wid}/unarchive")
def unarchive_warehouse(
    wid: int,
    user=Depends(require_perm("warehouses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    row = _wh_row(db, wid)
    if not row["archived_at"]:
        raise HTTPException(400, "Warehouse is not archived")
    # Archiving sets is_active=0; restoring brings it back as an active warehouse.
    db.execute(
        "UPDATE warehouses SET archived_at=NULL, is_active=1 WHERE id=?",
        (wid,),
    )
    log_action(db, user, "unarchive", "warehouse", wid, row["code"])
    db.commit()
    return {"message": "Warehouse restored"}


# ─────────────────────────────────────────────────────────────────────────
# PER-USER ACCESS CONTROL
# ─────────────────────────────────────────────────────────────────────────

@router.get("/{wid}/access")
def list_access(
    wid: int,
    user=Depends(require_perm("warehouses", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Users with explicit access to this warehouse. Empty list means
    everyone has access (the default)."""
    _wh_row(db, wid)
    rows = db.execute(
        "SELECT a.user_id, a.granted_at, u.username, u.full_name "
        "FROM user_warehouse_access a "
        "JOIN users u ON u.id = a.user_id "
        "WHERE a.warehouse_id=? AND u.deleted_at IS NULL "
        "ORDER BY u.username",
        (wid,),
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/{wid}/access")
def grant_access(
    wid: int,
    data: AccessGrant,
    user=Depends(require_perm("warehouses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    _wh_row(db, wid)
    if not db.execute(
        "SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL", (data.user_id,)
    ).fetchone():
        raise HTTPException(404, "User not found")
    db.execute(
        "INSERT OR IGNORE INTO user_warehouse_access "
        "(user_id, warehouse_id, granted_at, granted_by) VALUES (?, ?, ?, ?)",
        (data.user_id, wid, _now(), user["id"]),
    )
    log_action(db, user, "grant", "warehouse_access", wid, str(data.user_id))
    db.commit()
    return {"message": "Access granted"}


@router.delete("/{wid}/access/{user_id}")
def revoke_access(
    wid: int,
    user_id: int,
    user=Depends(require_perm("warehouses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    _wh_row(db, wid)
    db.execute(
        "DELETE FROM user_warehouse_access WHERE user_id=? AND warehouse_id=?",
        (user_id, wid),
    )
    log_action(db, user, "revoke", "warehouse_access", wid, str(user_id))
    db.commit()
    return {"message": "Access revoked"}


@router.get("/me/accessible")
def my_warehouses(
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """The list of warehouses the calling user can transact in, plus their
    resolved default — what the frontend needs to populate selectors."""
    ids = wha.accessible_ids(user, db)
    if ids is None:
        rows = db.execute(
            "SELECT * FROM warehouses WHERE is_active=1 AND archived_at IS NULL "
            "ORDER BY is_default DESC, code"
        ).fetchall()
    else:
        if not ids:
            return {"warehouses": [], "default_id": None}
        rows = db.execute(
            f"SELECT * FROM warehouses WHERE id IN ({','.join('?' for _ in ids)}) "
            f"AND is_active=1 AND archived_at IS NULL "
            f"ORDER BY is_default DESC, code",
            tuple(ids),
        ).fetchall()
    default_id = None
    try:
        default_id = wha.default_warehouse_id(user, db)
    except HTTPException:
        pass
    return {"warehouses": [dict(r) for r in rows], "default_id": default_id}


# ─────────────────────────────────────────────────────────────────────────
# STOCK TRANSFERS
# ─────────────────────────────────────────────────────────────────────────

def _next_transfer_number(db) -> str:
    """Date-prefixed sequential number: TR-YYYYMMDD-NNNN."""
    today = datetime.utcnow().strftime("%Y%m%d")
    last = db.execute(
        "SELECT transfer_number FROM stock_transfers "
        "WHERE transfer_number LIKE ? ORDER BY id DESC LIMIT 1",
        (f"TR-{today}-%",),
    ).fetchone()
    seq = 1
    if last:
        try:
            seq = int(last["transfer_number"].split("-")[-1]) + 1
        except (ValueError, IndexError):
            pass
    return f"TR-{today}-{seq:04d}"


@router.get("/transfers/")
def list_transfers(
    status: Optional[str] = None,
    warehouse_id: Optional[int] = None,
    limit: int = 100,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """List transfers visible to the caller (where they have access to EITHER
    endpoint of the transfer). Admins see everything."""
    where, params = ["1=1"], []
    if status:
        where.append("t.status=?"); params.append(status)
    if warehouse_id:
        where.append("(t.from_warehouse_id=? OR t.to_warehouse_id=?)")
        params.extend([warehouse_id, warehouse_id])
    ids = wha.accessible_ids(user, db)
    if ids is not None:
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        where.append(
            f"(t.from_warehouse_id IN ({placeholders}) OR t.to_warehouse_id IN ({placeholders}))"
        )
        params.extend(list(ids) + list(ids))
    sql = (
        "SELECT t.*, "
        "       fw.code AS from_code, fw.name AS from_name, "
        "       tw.code AS to_code,   tw.name AS to_name "
        "FROM stock_transfers t "
        "LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id "
        "LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id "
        f"WHERE {' AND '.join(where)} "
        "ORDER BY t.id DESC LIMIT ?"
    )
    params.append(max(1, min(int(limit or 100), 500)))
    return [dict(r) for r in db.execute(sql, params).fetchall()]


@router.get("/transfers/{tid}")
def get_transfer(
    tid: int,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    head = db.execute(
        "SELECT t.*, fw.code AS from_code, fw.name AS from_name, "
        "       tw.code AS to_code, tw.name AS to_name "
        "FROM stock_transfers t "
        "LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id "
        "LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id "
        "WHERE t.id=?",
        (tid,),
    ).fetchone()
    if not head:
        raise HTTPException(404, "Transfer not found")
    if not (wha.can_access(user, db, head["from_warehouse_id"])
            or wha.can_access(user, db, head["to_warehouse_id"])):
        raise HTTPException(403, "You don't have access to either endpoint of this transfer.")
    items = db.execute(
        "SELECT ti.*, i.name AS inventory_name, i.unit "
        "FROM stock_transfer_items ti "
        "LEFT JOIN inventory i ON i.id = ti.inventory_id "
        "WHERE ti.transfer_id=? ORDER BY ti.id",
        (tid,),
    ).fetchall()
    return {**dict(head), "items": [dict(i) for i in items]}


@router.post("/transfers/")
def create_transfer(
    data: TransferIn,
    user=Depends(require_perm("warehouses", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Open a Draft transfer. No stock moves yet — that happens at dispatch."""
    if data.from_warehouse_id == data.to_warehouse_id:
        raise HTTPException(400, "Source and destination warehouses must differ.")
    if not data.items:
        raise HTTPException(400, "Transfer needs at least one line item.")
    # Caller must have access to BOTH endpoints — both as a security check and
    # because a real transfer initiator typically coordinates both sides.
    wha.require_access(user, db, data.from_warehouse_id)
    wha.require_access(user, db, data.to_warehouse_id)
    src = _wh_row(db, data.from_warehouse_id)
    dst = _wh_row(db, data.to_warehouse_id)
    if src["archived_at"] or not src["is_active"]:
        raise HTTPException(400, "Source warehouse is inactive or archived.")
    if dst["archived_at"] or not dst["is_active"]:
        raise HTTPException(400, "Destination warehouse is inactive or archived.")
    for it in data.items:
        if it.quantity <= 0:
            raise HTTPException(400, "Item quantities must be positive.")
        if not db.execute(
            "SELECT 1 FROM inventory WHERE id=? AND deleted_at IS NULL",
            (it.inventory_id,),
        ).fetchone():
            raise HTTPException(400, f"Inventory id {it.inventory_id} not found.")

    now = _now()
    number = _next_transfer_number(db)
    cur = db.execute(
        "INSERT INTO stock_transfers "
        "(transfer_number, from_warehouse_id, to_warehouse_id, status, notes, "
        " created_by, created_at) "
        "VALUES (?, ?, ?, 'Draft', ?, ?, ?)",
        (number, data.from_warehouse_id, data.to_warehouse_id, data.notes,
         user["id"], now),
    )
    tid = cur.lastrowid
    for it in data.items:
        db.execute(
            "INSERT INTO stock_transfer_items "
            "(transfer_id, inventory_id, quantity, note) VALUES (?, ?, ?, ?)",
            (tid, it.inventory_id, it.quantity, it.note),
        )
    log_action(db, user, "create", "stock_transfer", tid, number,
               {"from": src["code"], "to": dst["code"], "items": len(data.items)})
    db.commit()
    return {"id": tid, "transfer_number": number, "message": "Draft transfer created"}


@router.post("/transfers/{tid}/dispatch")
def dispatch_transfer(
    tid: int,
    user=Depends(require_perm("warehouses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Move stock OUT of the source warehouse. Status: Draft → In Transit.
    Stock is decremented immediately so the source ledger reflects the truck
    leaving — receipt at the destination is a separate step."""
    head = db.execute(
        "SELECT * FROM stock_transfers WHERE id=?", (tid,)
    ).fetchone()
    if not head:
        raise HTTPException(404, "Transfer not found")
    if head["status"] != "Draft":
        raise HTTPException(
            400, f"Only Draft transfers can be dispatched (currently {head['status']})."
        )
    wha.require_access(user, db, head["from_warehouse_id"])
    items = db.execute(
        "SELECT * FROM stock_transfer_items WHERE transfer_id=?", (tid,)
    ).fetchall()
    now = _now()
    for it in items:
        _adjust_stock(
            db, it["inventory_id"], head["from_warehouse_id"],
            -float(it["quantity"]),
            mvmt_type="transfer_out",
            reference=head["transfer_number"],
            note=it["note"] or "",
            now=now,
        )
    db.execute(
        "UPDATE stock_transfers SET status='In Transit', dispatched_at=?, "
        "dispatched_by=? WHERE id=?",
        (now, user["id"], tid),
    )
    log_action(db, user, "dispatch", "stock_transfer", tid, head["transfer_number"])

    # Alert the destination — they're now expecting goods. Look up the codes
    # once so the notification body reads naturally without another round-trip
    # to the warehouses table per recipient.
    ends = db.execute(
        "SELECT fw.code AS from_code, tw.code AS to_code "
        "FROM stock_transfers t "
        "LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id "
        "LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id WHERE t.id=?",
        (tid,),
    ).fetchone()
    _notify_transfer_endpoint(
        db, warehouse_id=head["to_warehouse_id"], exclude_user=user["id"],
        type="transfer_dispatched",
        title=f"Incoming transfer {head['transfer_number']}",
        body=f"{ends['from_code']} → {ends['to_code']} · {len(items)} item(s) in transit",
        transfer_id=tid,
    )

    db.commit()
    return {"message": "Transfer dispatched — stock removed from source."}


@router.post("/transfers/{tid}/receive")
def receive_transfer(
    tid: int,
    data: TransferReceive = None,
    user=Depends(require_perm("warehouses", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Receive stock INTO the destination warehouse. Status: In Transit →
    Completed. The receiver may record per-item received quantities (less
    than dispatched if something was lost in transit); when omitted, the full
    quantity is treated as received.

    Loss-in-transit (received < dispatched) does not auto-post anywhere; the
    discrepancy is captured on the transfer line so an admin can record an
    inventory adjustment to recognise the loss."""
    head = db.execute(
        "SELECT * FROM stock_transfers WHERE id=?", (tid,)
    ).fetchone()
    if not head:
        raise HTTPException(404, "Transfer not found")
    if head["status"] != "In Transit":
        raise HTTPException(
            400, f"Only In Transit transfers can be received (currently {head['status']})."
        )
    wha.require_access(user, db, head["to_warehouse_id"])
    items = db.execute(
        "SELECT * FROM stock_transfer_items WHERE transfer_id=?", (tid,)
    ).fetchall()
    overrides = {x.item_id: x.received_quantity for x in (data.items if data else None) or []}
    now = _now()
    for it in items:
        recv = overrides.get(it["id"], float(it["quantity"]))
        if recv < 0 or recv > float(it["quantity"]):
            raise HTTPException(
                400,
                f"Received quantity for item {it['id']} must be between 0 "
                f"and the dispatched quantity ({it['quantity']})."
            )
        db.execute(
            "UPDATE stock_transfer_items SET received_quantity=? WHERE id=?",
            (recv, it["id"]),
        )
        if recv > 0:
            _adjust_stock(
                db, it["inventory_id"], head["to_warehouse_id"], recv,
                mvmt_type="transfer_in",
                reference=head["transfer_number"],
                note=it["note"] or "",
                now=now,
            )
    db.execute(
        "UPDATE stock_transfers SET status='Completed', received_at=?, "
        "received_by=?, notes = CASE WHEN ? IS NULL THEN notes ELSE COALESCE(notes,'') || char(10) || ? END "
        "WHERE id=?",
        (now, user["id"],
         data.note if data else None,
         data.note if data else None, tid),
    )
    log_action(db, user, "receive", "stock_transfer", tid, head["transfer_number"])

    # Close the loop for the source — they need to know the goods landed (and
    # whether anything was lost in transit). Quantity discrepancy is surfaced
    # in the body so the source clerk can chase it without opening the record.
    dispatched = sum(float(i["quantity"]) for i in items)
    received   = sum(overrides.get(i["id"], float(i["quantity"])) for i in items)
    loss_note  = ""
    if received < dispatched:
        loss_note = f" · {dispatched - received:g} unit(s) short in transit"
    ends = db.execute(
        "SELECT fw.code AS from_code, tw.code AS to_code "
        "FROM stock_transfers t "
        "LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id "
        "LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id WHERE t.id=?",
        (tid,),
    ).fetchone()
    _notify_transfer_endpoint(
        db, warehouse_id=head["from_warehouse_id"], exclude_user=user["id"],
        type="transfer_received",
        title=f"Transfer {head['transfer_number']} received",
        body=f"{ends['from_code']} → {ends['to_code']} · arrived at destination{loss_note}",
        transfer_id=tid,
    )

    db.commit()
    return {"message": "Transfer completed — stock added to destination."}


@router.post("/transfers/{tid}/cancel")
def cancel_transfer(
    tid: int,
    data: TransferCancel = None,
    user=Depends(require_perm("warehouses", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Cancel a Draft transfer (no stock moved) or roll back an In Transit
    transfer (re-credit the source). Completed transfers are immutable —
    reverse them with a fresh transfer in the opposite direction."""
    head = db.execute(
        "SELECT * FROM stock_transfers WHERE id=?", (tid,)
    ).fetchone()
    if not head:
        raise HTTPException(404, "Transfer not found")
    if head["status"] not in ("Draft", "In Transit"):
        raise HTTPException(
            400,
            f"Cannot cancel a {head['status']} transfer. To reverse a "
            "Completed transfer create a new transfer in the opposite direction."
        )
    wha.require_access(user, db, head["from_warehouse_id"])
    reason = (data.reason if data else None) or "Cancelled"
    now = _now()
    if head["status"] == "In Transit":
        # Re-credit the source warehouse with whatever was dispatched.
        items = db.execute(
            "SELECT * FROM stock_transfer_items WHERE transfer_id=?", (tid,)
        ).fetchall()
        for it in items:
            _adjust_stock(
                db, it["inventory_id"], head["from_warehouse_id"],
                float(it["quantity"]),
                mvmt_type="transfer_cancel",
                reference=head["transfer_number"],
                note=f"Cancelled: {reason}",
                now=now,
            )
    db.execute(
        "UPDATE stock_transfers SET status='Cancelled', cancelled_at=?, "
        "cancelled_by=?, cancel_reason=? WHERE id=?",
        (now, user["id"], reason, tid),
    )
    log_action(db, user, "cancel", "stock_transfer", tid, head["transfer_number"],
               {"reason": reason})

    # Both endpoints need to know — destination so they stop waiting, source
    # because the rollback may have re-credited stock they had already accounted
    # for as gone. Sent as TWO notifications so each side gets a payload tuned
    # to their perspective (source sees "rolled back", dest sees "cancelled").
    ends = db.execute(
        "SELECT fw.code AS from_code, tw.code AS to_code "
        "FROM stock_transfers t "
        "LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id "
        "LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id WHERE t.id=?",
        (tid,),
    ).fetchone()
    rolled_back = head["status"] == "In Transit"
    _notify_transfer_endpoint(
        db, warehouse_id=head["to_warehouse_id"], exclude_user=user["id"],
        type="transfer_cancelled",
        title=f"Transfer {head['transfer_number']} cancelled",
        body=f"{ends['from_code']} → {ends['to_code']} · {reason}",
        transfer_id=tid,
    )
    if rolled_back:
        _notify_transfer_endpoint(
            db, warehouse_id=head["from_warehouse_id"], exclude_user=user["id"],
            type="transfer_cancelled",
            title=f"Transfer {head['transfer_number']} rolled back",
            body=f"Stock re-credited to {ends['from_code']} · {reason}",
            transfer_id=tid,
        )

    db.commit()
    return {"message": "Transfer cancelled"}


# ─────────────────────────────────────────────────────────────────────────
# STOCK BREAKDOWN PER WAREHOUSE
# ─────────────────────────────────────────────────────────────────────────

@router.get("/{wid}/stock")
def warehouse_stock(
    wid: int,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """All inventory items currently held at this warehouse, with quantity
    + valuation at the company-wide unit cost (per the "postpone warehouse-
    specific valuation" decision — same unit cost across all warehouses)."""
    _wh_row(db, wid)
    if not wha.can_access(user, db, wid):
        raise HTTPException(403, "You don't have access to this warehouse.")
    rows = db.execute(
        "SELECT i.id, i.name, i.unit, i.category, i.unit_cost, "
        "       s.quantity, s.reserved_quantity, s.quarantine_quantity, "
        "       ROUND(s.quantity * COALESCE(i.unit_cost,0), 2) AS value "
        "FROM inventory_stock s "
        "JOIN inventory i ON i.id = s.inventory_id "
        "WHERE s.warehouse_id=? AND i.deleted_at IS NULL AND i.archived_at IS NULL "
        "ORDER BY i.name",
        (wid,),
    ).fetchall()
    return [dict(r) for r in rows]
