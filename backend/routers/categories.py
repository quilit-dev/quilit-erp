"""
Owner-defined category registry.

Categories used to be hardcoded per module; now the owner manages them in
Settings, grouped by DOMAIN, and every relevant dropdown reads from here. The
stored category VALUE on a record is just its name (canonical) — this table
only feeds the pickers, so editing/archiving a category never rewrites data.

Domains:
  inventory · expense · asset · project
"""
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import get_db
from permissions import require_auth, require_admin
from routers.audit import log_action
from utils import _now

router = APIRouter()

DOMAINS = {"inventory", "expense", "asset", "project"}


class CategoryBody(BaseModel):
    domain:     Optional[str] = None
    name:       str
    sort_order: Optional[int] = 0
    active:     Optional[bool] = True


def _row(r):
    d = dict(r)
    d["active"] = bool(d.get("active"))
    return d


@router.get("")
@router.get("/")
def list_categories(domain: Optional[str] = None, include_inactive: bool = False,
                    user=Depends(require_auth), db: sqlite3.Connection = Depends(get_db)):
    """Categories for a domain (or all). Any logged-in user may read — the
    pickers across modules depend on it."""
    q = "SELECT * FROM categories WHERE archived_at IS NULL"
    params: list = []
    if domain:
        if domain not in DOMAINS:
            raise HTTPException(400, f"Unknown domain. Use one of: {', '.join(sorted(DOMAINS))}")
        q += " AND domain = ?"; params.append(domain)
    if not include_inactive:
        q += " AND active = 1"
    q += " ORDER BY domain, sort_order, name"
    return [_row(r) for r in db.execute(q, params).fetchall()]


@router.post("")
@router.post("/")
def create_category(data: CategoryBody, user=Depends(require_admin),
                    db: sqlite3.Connection = Depends(get_db)):
    domain = (data.domain or "").strip().lower()
    if domain not in DOMAINS:
        raise HTTPException(400, f"Unknown domain. Use one of: {', '.join(sorted(DOMAINS))}")
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "Category name is required.")
    try:
        c = db.execute(
            "INSERT INTO categories (domain, name, sort_order, active, created_at) VALUES (?,?,?,?,?)",
            (domain, name, data.sort_order or 0, 1 if (data.active is None or data.active) else 0, _now()),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(400, "That category already exists in this domain.")
    log_action(db, user, "create", "category", c.lastrowid, f"{domain}:{name}")
    db.commit()
    return {"id": c.lastrowid, "message": "Category added"}


@router.put("/{cat_id}")
def update_category(cat_id: int, data: CategoryBody, user=Depends(require_admin),
                    db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM categories WHERE id=?", (cat_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Category not found")
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "Category name is required.")
    try:
        db.execute(
            "UPDATE categories SET name=?, sort_order=?, active=? WHERE id=?",
            (name, data.sort_order if data.sort_order is not None else row["sort_order"],
             1 if (data.active is None or data.active) else 0, cat_id),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(400, "Another category in this domain already uses that name.")
    log_action(db, user, "update", "category", cat_id, f"{row['domain']}:{name}")
    db.commit()
    return {"message": "Category updated"}


@router.patch("/{cat_id}/archive")
def archive_category(cat_id: int, user=Depends(require_admin),
                     db: sqlite3.Connection = Depends(get_db)):
    """Remove a category from the pickers. Existing records keep their value."""
    row = db.execute("SELECT domain, name FROM categories WHERE id=?", (cat_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Category not found")
    db.execute("UPDATE categories SET archived_at=? WHERE id=?", (_now(), cat_id))
    log_action(db, user, "archive", "category", cat_id, f"{row['domain']}:{row['name']}")
    db.commit()
    return {"message": "Category removed"}
