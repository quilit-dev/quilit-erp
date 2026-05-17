"""
Archives — view and restore all archived ERP entities.

Archiving is the only way to hide records from normal views. No permanent
deletion is possible through this router — all archived data is retained
indefinitely for audit purposes.

  GET   /api/archives/           – list all archived items (filterable by module)
  PATCH /api/archives/{module}/{id}/unarchive  – restore one archived item
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from database import get_db
from permissions import require_perm
import sqlite3

router = APIRouter()

# ── Module registry ───────────────────────────────────────────────────────
MODULES = {
    "clients":        ("clients",        "name"),
    "projects":       ("projects",       "name"),
    "quotations":     ("quotations",     "quote_number"),
    "invoices":       ("invoices",       "invoice_number"),
    "inventory":      ("inventory",      "name"),
    "purchases":      ("purchases",      "po_number"),
    "suppliers":      ("suppliers",      "name"),
    "hr_employees":   ("hr_employees",   "full_name"),
    "hr_departments": ("hr_departments", "name"),
}

DISPLAY_NAMES = {
    "clients":        "Clients",
    "projects":       "Projects",
    "quotations":     "Quotations",
    "invoices":       "Invoices",
    "inventory":      "Inventory",
    "purchases":      "Purchases",
    "suppliers":      "Suppliers",
    "hr_employees":   "HR — Employees",
    "hr_departments": "HR — Departments",
}

UNARCHIVE_ENDPOINTS = {
    "clients":        "/api/clients/{id}/unarchive",
    "projects":       "/api/projects/{id}/unarchive",
    "quotations":     "/api/quotations/{id}/unarchive",
    "invoices":       "/api/invoices/{id}/unarchive",
    "inventory":      "/api/inventory/{id}/unarchive",
    "purchases":      "/api/purchases/{id}/unarchive",
    "suppliers":      "/api/suppliers/{id}/unarchive",
    "hr_employees":   "/api/hr/employees/{id}/unarchive",
    "hr_departments": "/api/hr/departments/{id}/unarchive",
}


# Pre-built statements keyed by module. Table and label-column identifiers come
# only from the MODULES registry above (never from the request); the literal SQL
# is assembled once here at import time, not per call.
_ARCHIVE_SELECT_SQL = {
    mod: f"SELECT id, {label_col} AS label, archived_at FROM {table} WHERE id = ?"
    for mod, (table, label_col) in MODULES.items()
}
_UNARCHIVE_SQL = {
    mod: f"UPDATE {table} SET archived_at = NULL, archive_reason = NULL WHERE id = ?"
    for mod, (table, _label_col) in MODULES.items()
}


def _assert_module(module: str):
    if module not in MODULES:
        raise HTTPException(400, f"Unknown module '{module}'. Valid: {', '.join(MODULES)}")
    return MODULES[module]


# ── List all archived items ───────────────────────────────────────────────
@router.get("/")
def list_archives(
    module:    Optional[str] = Query(None),
    search:    Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    user=Depends(require_perm("dashboard", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    results = []
    target_modules = {module: MODULES[module]} if module and module in MODULES else MODULES

    for mod_key, (table, label_col) in target_modules.items():
        query = (
            f"SELECT id, {label_col} AS label, archived_at, archive_reason "
            f"FROM {table} WHERE archived_at IS NOT NULL"
        )
        params = []

        if search:
            query += f" AND {label_col} LIKE ?"
            params.append(f"%{search}%")
        if date_from:
            query += " AND archived_at >= ?"
            params.append(date_from)
        if date_to:
            query += " AND archived_at <= ?"
            params.append(date_to + " 23:59:59")

        query += " ORDER BY archived_at DESC"

        try:
            rows = db.execute(query, params).fetchall()
        except sqlite3.OperationalError:
            continue

        for r in rows:
            results.append({
                "module":         mod_key,
                "module_label":   DISPLAY_NAMES.get(mod_key, mod_key),
                "id":             r["id"],
                "label":          r["label"] or f"#{r['id']}",
                "archived_at":    r["archived_at"],
                "archive_reason": r["archive_reason"],
            })

    results.sort(key=lambda x: x["archived_at"] or "", reverse=True)
    return results


# ── Unarchive one item ────────────────────────────────────────────────────
@router.patch("/{module}/{item_id}/unarchive")
def unarchive_item(
    module:  str,
    item_id: int,
    user=Depends(require_perm("dashboard", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    _assert_module(module)
    row = db.execute(_ARCHIVE_SELECT_SQL[module], (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    if not row["archived_at"]:
        raise HTTPException(400, "Item is not archived")

    db.execute(_UNARCHIVE_SQL[module], (item_id,))
    db.commit()
    return {
        "message": f"'{row['label']}' restored from {DISPLAY_NAMES.get(module, module)} archives",
    }
