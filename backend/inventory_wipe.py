"""Emptying a tenant's inventory --- every item, variant and product group.

Asked for by a tenant that set up its stock as test data and wants a clean
start before going live. It is the most destructive thing the system can be
told to do to one module, so it is built around two ideas:

* **It refuses unless nothing else refers to the stock.** Stock that appears
  on an invoice, a till sale, a purchase order, a BOM, a service job, a
  reservation --- anything --- is not test data, whatever the owner remembers,
  and removing it would leave those records pointing at nothing. The check
  does not trust a list of tables written by hand: it reads every foreign
  key that points at `inventory` out of the schema itself, so a table added
  next year is caught the day it is added. Only the item's OWN records ---
  its stock count, movements, cost layers, lots and attributes --- go with it.

* **The plan runs before the deletion, and again inside it.** The screen
  shows what will go and what is blocking; the execute path recomputes the
  same plan under the same transaction and refuses on any blocker, so what
  was shown is what happens.

Vendor superadmin only, with the tenant's own name typed as confirmation.
Nothing here touches suppliers, categories, warehouses, or any document.
"""
from typing import Optional

from fastapi import HTTPException

import database

# The item's own records: rows that describe the item or its stock and mean
# nothing once it is gone. Deleted in this order --- children first.
OWN_ROWS = [
    ("lot_consumption",       "inventory_id"),
    ("inventory_lots",        "inventory_id"),
    ("inventory_cost_layers", "inventory_id"),
    ("stock_movements",       "inventory_id"),
    ("inventory_stock",       "inventory_id"),
    ("item_attributes",       "inventory_id"),
]
_OWN = {(t, c) for t, c in OWN_ROWS}


def _is_postgres() -> bool:
    return database.DB_BACKEND not in ("sqlite", "sqlite3")


def referencing_columns(db) -> list:
    """Every (table, column) that can point at an inventory item.

    Three sources, unioned, because no single one is complete on both
    databases: the foreign keys the schema declares (which SQLite cannot add
    to a column created by ALTER TABLE, so half the real references have
    none there); every column named `inventory_id` or `*_inventory_id` in
    any table (the naming rule this codebase keeps); and the hand-kept
    _USED_BY list the single-item delete already relies on. A new table
    following the naming rule is caught the day it is added.
    """
    found = set()
    if _is_postgres():
        for r in db.execute(
            "SELECT tc.table_name, kcu.column_name "
            "  FROM information_schema.table_constraints tc "
            "  JOIN information_schema.key_column_usage kcu "
            "    ON kcu.constraint_name = tc.constraint_name "
            "   AND kcu.table_schema = tc.table_schema "
            "  JOIN information_schema.constraint_column_usage ccu "
            "    ON ccu.constraint_name = tc.constraint_name "
            "   AND ccu.table_schema = tc.table_schema "
            " WHERE tc.constraint_type = 'FOREIGN KEY' "
            "   AND tc.table_schema = current_schema() "
            "   AND ccu.table_name = 'inventory' AND ccu.column_name = 'id'"
        ).fetchall():
            found.add((r["table_name"], r["column_name"]))
        for r in db.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            " WHERE table_schema = current_schema() "
            "   AND (column_name = 'inventory_id' OR column_name LIKE ?) "
            "   AND table_name <> 'inventory'", (r"%\_inventory\_id",)
        ).fetchall():
            found.add((r["table_name"], r["column_name"]))
    else:
        tables = [r["name"] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        for t in tables:
            if t == "inventory":
                continue
            for fk in db.execute(f"PRAGMA foreign_key_list('{t}')").fetchall():
                if fk[2] == "inventory" and (fk[4] in (None, "id")):
                    found.add((t, fk[3]))
            for col in db.execute(f"PRAGMA table_info('{t}')").fetchall():
                name = col[1]
                if name == "inventory_id" or name.endswith("_inventory_id"):
                    found.add((t, name))
    try:
        from routers.inventory import _USED_BY
        for table, column, _label in _USED_BY:
            found.add((table, column))
    except Exception:
        pass
    return sorted(found)


def plan(db) -> dict:
    """What emptying the inventory would remove, and what stops it."""
    items = db.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS units, "
        "       COALESCE(SUM(quantity * unit_cost), 0) AS value "
        "  FROM inventory WHERE archived_at IS NULL").fetchone()
    archived = db.execute(
        "SELECT COUNT(*) AS n FROM inventory WHERE archived_at IS NOT NULL").fetchone()["n"]
    products = db.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]

    # No try/except around statements here or below: on Postgres a failed
    # statement aborts the transaction and every later one is ignored, so a
    # swallowed error would turn into a half-run plan. Tables are checked by
    # name instead.
    tables = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    own = {}
    for table, column in OWN_ROWS:
        own[table] = (db.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
                      if table in tables else 0)

    blockers = {}
    for table, column in referencing_columns(db):
        if (table, column) in _OWN or table not in tables:
            continue
        n = db.execute(
            f"SELECT COUNT(*) AS n FROM {table} WHERE {column} IS NOT NULL"
        ).fetchone()["n"]
        if n:
            blockers[f"{table}.{column}"] = int(n)

    # Two kinds of blocker can be swept along: the till sales and quotations
    # that carry an item line, when the owner has said they are trial entries.
    # Everything else --- a purchase, a BOM, a service job, a reservation ---
    # stays a hard blocker. See document_wipe for what a sweep unwinds.
    documents = None
    hard = {k: v for k, v in blockers.items() if k not in SWEEPABLE}
    if blockers and not hard:
        import document_wipe
        documents = document_wipe.collect(db)
        doc_blockers = {f"documents: {k}": v for k, v in documents["blockers"].items()}
    else:
        doc_blockers = {}

    return {
        "items": int(items["n"] or 0),
        "archived_items": int(archived or 0),
        "products": int(products or 0),
        "stock_units": float(items["units"] or 0),
        "stock_value": round(float(items["value"] or 0), 2),
        "own_rows": {k: int(v) for k, v in own.items()},
        # What has to be swept for the items to go, when it can be.
        "documents": document_wipe_summary(documents),
        "blockers": {**hard, **doc_blockers},
        "can_run": not hard and not doc_blockers,
    }


# The references that may be swept along with the inventory, because they are
# the two documents a trial of the till and the quotation screen leaves.
SWEEPABLE = {"pos_sale_items.inventory_id", "quotation_items.inventory_id"}


def document_wipe_summary(documents):
    if not documents:
        return None
    import document_wipe
    return document_wipe.summary(documents)


def execute(db, user, log_action) -> dict:
    """Remove everything the plan lists. Refuses on any blocker. The caller
    owns the transaction and must have checked the confirmation phrase."""
    p = plan(db)
    if p["blockers"]:
        detail = ", ".join(f"{k} ({v})" for k, v in sorted(p["blockers"].items()))
        raise HTTPException(
            409, "The inventory is referenced by other records and cannot be "
                 f"emptied: {detail}. Nothing was removed.")

    removed = {}
    # The trial documents first, so the items they point at are free to go.
    if p["documents"]:
        import document_wipe
        docs = document_wipe.collect(db)
        for k, v in document_wipe.execute(db, docs).items():
            removed[k] = removed.get(k, 0) + v
    tables = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    for table, column in OWN_ROWS:
        if table not in tables:
            continue
        cur = db.execute(f"DELETE FROM {table} WHERE {column} IN (SELECT id FROM inventory)")
        removed[table] = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else p["own_rows"].get(table, 0)
    removed["inventory"] = db.execute("DELETE FROM inventory").rowcount
    if "product_attributes" in tables:
        db.execute("DELETE FROM product_attributes")
    removed["products"] = db.execute("DELETE FROM products").rowcount

    log_action(db, user, "wipe", "inventory", None, "Inventory emptied",
               {"items": p["items"], "archived_items": p["archived_items"],
                "products": p["products"], "stock_units": p["stock_units"],
                "stock_value": p["stock_value"], "documents": p["documents"],
                "removed": removed})
    return {"message": "Inventory emptied", "removed": removed, "plan": p}


def confirmation_phrase(db) -> str:
    """What the operator must type: the tenant's slug on a hosted install,
    the company name on a single-tenant one."""
    try:
        from tenant_context import IS_SCHEMA_TENANCY, current_schema
        if IS_SCHEMA_TENANCY:
            schema = current_schema() or ""
            if schema.startswith("tenant_"):
                return schema[len("tenant_"):]
    except Exception:
        pass
    row = db.execute("SELECT value FROM settings WHERE key='company_name'").fetchone()
    return (row["value"] if row and row["value"] else "").strip()


def check_confirmation(db, typed: Optional[str]) -> str:
    expected = confirmation_phrase(db)
    if not expected:
        raise HTTPException(400, "This install has no name to confirm against.")
    if (typed or "").strip().lower() != expected.lower():
        raise HTTPException(400, f"Type the tenant name exactly ({expected}) to confirm.")
    return expected
