"""
Recycle Bin — soft-delete hub for all ERP entities.

Every deletable entity (clients, projects, quotations, invoices,
inventory, purchases, expenses) is soft-deleted: a `deleted_at`
timestamp is written and the row is hidden from normal queries.
This router exposes:
  GET    /api/recycle-bin/          – list all soft-deleted items
  POST   /api/recycle-bin/restore/{module}/{id}  – restore one item
  DELETE /api/recycle-bin/{module}/{id}           – permanently delete one
  POST   /api/recycle-bin/bulk-restore            – restore many
  POST   /api/recycle-bin/bulk-purge              – permanently delete many
  DELETE /api/recycle-bin/purge-expired           – cron: remove >30 days
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from permissions import require_perm
import sqlite3
from datetime import datetime, timedelta

router = APIRouter()

# ── Module registry ───────────────────────────────────────────────────────
# Maps URL-safe module name → (table, label_column)
MODULES = {
    "clients":   ("clients",   "name"),
    "projects":  ("projects",  "name"),
    "quotations":("quotations","quote_number"),
    "invoices":  ("invoices",  "invoice_number"),
    "inventory": ("inventory", "name"),
    "purchases": ("purchases", "po_number"),
    "expenses":  ("expenses",  "description"),
}

DISPLAY_NAMES = {
    "clients":    "Clients",
    "projects":   "Projects",
    "quotations": "Quotations",
    "invoices":   "Invoices",
    "inventory":  "Inventory",
    "purchases":  "Purchases",
    "expenses":   "Expenses",
}

def _assert_module(module: str):
    if module not in MODULES:
        raise HTTPException(400, f"Unknown module '{module}'. Valid modules: {', '.join(MODULES)}")
    return MODULES[module]


# ── Pydantic ──────────────────────────────────────────────────────────────
class BulkRequest(BaseModel):
    items: List[dict]   # [{"module": "clients", "id": 1}, ...]


# ── List ──────────────────────────────────────────────────────────────────
@router.get("/")
def list_recycle_bin(
    module:     Optional[str] = Query(None),
    search:     Optional[str] = Query(None),
    date_from:  Optional[str] = Query(None),
    date_to:    Optional[str] = Query(None),
    user=Depends(require_perm("dashboard", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    results = []
    target_modules = {module: MODULES[module]} if module and module in MODULES else MODULES

    for mod_key, (table, label_col) in target_modules.items():
        query = f"SELECT id, {label_col} AS label, deleted_at FROM {table} WHERE deleted_at IS NOT NULL"
        params = []

        if search:
            query += f" AND {label_col} LIKE ?"
            params.append(f"%{search}%")
        if date_from:
            query += " AND deleted_at >= ?"
            params.append(date_from)
        if date_to:
            # include full day
            query += " AND deleted_at <= ?"
            params.append(date_to + " 23:59:59")

        query += " ORDER BY deleted_at DESC"

        try:
            rows = db.execute(query, params).fetchall()
        except sqlite3.OperationalError:
            # Table might not have deleted_at column yet (migration pending)
            continue

        for r in rows:
            deleted_at = r["deleted_at"]
            expires_at = None
            days_remaining = None
            if deleted_at:
                try:
                    dt = datetime.strptime(deleted_at, "%Y-%m-%d %H:%M:%S")
                    exp = dt + timedelta(days=30)
                    expires_at = exp.strftime("%Y-%m-%d %H:%M:%S")
                    days_remaining = max(0, (exp - datetime.utcnow()).days)
                except Exception:
                    pass

            results.append({
                "module":         mod_key,
                "module_label":   DISPLAY_NAMES.get(mod_key, mod_key),
                "id":             r["id"],
                "label":          r["label"] or f"#{r['id']}",
                "deleted_at":     deleted_at,
                "expires_at":     expires_at,
                "days_remaining": days_remaining,
            })

    # Sort by deleted_at descending across all modules
    results.sort(key=lambda x: x["deleted_at"] or "", reverse=True)
    return results


# ── Restore one ───────────────────────────────────────────────────────────
@router.post("/restore/{module}/{item_id}")
def restore_item(
    module:  str,
    item_id: int,
    user=Depends(require_perm("dashboard", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    table, label_col = _assert_module(module)
    row = db.execute(
        f"SELECT id, deleted_at FROM {table} WHERE id = ?", (item_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    if not row["deleted_at"]:
        raise HTTPException(400, "Item is not in the recycle bin")

    db.execute(f"UPDATE {table} SET deleted_at = NULL WHERE id = ?", (item_id,))
    db.commit()
    return {"message": f"Item restored from {DISPLAY_NAMES.get(module, module)}"}


# ── Permanent delete one ──────────────────────────────────────────────────
@router.delete("/{module}/{item_id}")
def purge_item(
    module:  str,
    item_id: int,
    user=Depends(require_perm("dashboard", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    table, _ = _assert_module(module)
    row = db.execute(
        f"SELECT id, deleted_at FROM {table} WHERE id = ?", (item_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    if not row["deleted_at"]:
        raise HTTPException(400, "Item is not in the recycle bin — use the normal delete flow")

    db.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
    db.commit()
    return {"message": "Item permanently deleted"}


# ── Auto-purge expired items (>30 days) ───────────────────────────────────
# NOTE: POST (not DELETE) so this fixed path is never confused with the
# wildcard DELETE /{module}/{item_id} route that follows it.
@router.post("/purge-expired")
def purge_expired(
    user=Depends(require_perm("dashboard", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    cutoff = (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
    total = 0
    for table, _ in MODULES.values():
        try:
            c = db.execute(
                f"DELETE FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < ?",
                (cutoff,)
            )
            total += c.rowcount
        except sqlite3.OperationalError:
            pass
    db.commit()
    return {"purged": total, "cutoff": cutoff}


# ── Bulk restore ──────────────────────────────────────────────────────────
@router.post("/bulk-restore")
def bulk_restore(
    body: BulkRequest,
    user=Depends(require_perm("dashboard", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not body.items:
        raise HTTPException(400, "No items provided")

    restored, errors = 0, []
    for item in body.items:
        mod = item.get("module")
        iid = item.get("id")
        if mod not in MODULES:
            errors.append(f"Unknown module '{mod}'")
            continue
        table, _ = MODULES[mod]
        try:
            row = db.execute(
                f"SELECT deleted_at FROM {table} WHERE id = ?", (iid,)
            ).fetchone()
            if not row or not row["deleted_at"]:
                errors.append(f"{mod}#{iid} not in recycle bin")
                continue
            db.execute(f"UPDATE {table} SET deleted_at = NULL WHERE id = ?", (iid,))
            restored += 1
        except Exception as e:
            errors.append(f"{mod}#{iid}: {str(e)}")

    db.commit()
    return {"restored": restored, "errors": errors}


# ── Bulk purge ────────────────────────────────────────────────────────────
@router.post("/bulk-purge")
def bulk_purge(
    body: BulkRequest,
    user=Depends(require_perm("dashboard", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    if not body.items:
        raise HTTPException(400, "No items provided")

    purged, errors = 0, []
    for item in body.items:
        mod = item.get("module")
        iid = item.get("id")
        if mod not in MODULES:
            errors.append(f"Unknown module '{mod}'")
            continue
        table, _ = MODULES[mod]
        try:
            row = db.execute(
                f"SELECT deleted_at FROM {table} WHERE id = ?", (iid,)
            ).fetchone()
            if not row or not row["deleted_at"]:
                errors.append(f"{mod}#{iid} not in recycle bin")
                continue
            db.execute(f"DELETE FROM {table} WHERE id = ?", (iid,))
            purged += 1
        except Exception as e:
            errors.append(f"{mod}#{iid}: {str(e)}")

    db.commit()
    return {"purged": purged, "errors": errors}
