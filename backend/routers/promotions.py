"""
Promotions — automatic POS discounts.

A promotion applies a percentage off to a specific item, a whole category, or
the entire store, while it is *live*: within its optional date window and under
its optional quantity cap. The cap ("first N units") is enforced at checkout
(see routers/pos.py) by bumping `used_quantity` inside the sale transaction, so
the discount can't be over-spent. Management is gated on the inventory
permission; the cashier-facing /active feed needs only POS view.
"""
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now

router = APIRouter()

_SCOPES = {"item", "category", "all"}


def best_promo_for(db: sqlite3.Connection, inventory_id, category, today: str):
    """Return the live promotion giving the largest % for this line, or None.

    Live = active, not archived, within the date window, and with cap remaining.
    Scope match: 'all' always; 'item' by inventory_id; 'category' by name. When
    several match, the biggest discount wins (no stacking)."""
    rows = db.execute(
        "SELECT * FROM promotions "
        "WHERE active=1 AND archived_at IS NULL AND discount_value > 0 "
        "  AND (start_date IS NULL OR start_date <= ?) "
        "  AND (end_date   IS NULL OR end_date   >= ?) "
        "  AND (max_quantity IS NULL OR used_quantity < max_quantity)",
        (today, today),
    ).fetchall()
    best = None
    for p in rows:
        st = p["scope_type"]
        matches = (
            st == "all"
            or (st == "item" and inventory_id is not None and str(p["scope_value"]) == str(inventory_id))
            or (st == "category" and category and p["scope_value"] == category)
        )
        if matches and (best is None or p["discount_value"] > best["discount_value"]):
            best = p
    return best


def _row(p) -> dict:
    d = dict(p)
    cap = d.get("max_quantity")
    d["remaining"] = (None if cap is None else max(0, int(cap) - int(d.get("used_quantity") or 0)))
    today = _now()[:10]
    if not d.get("active") or d.get("archived_at"):
        status = "paused"
    elif d.get("end_date") and d["end_date"] < today:
        status = "expired"
    elif cap is not None and (d.get("used_quantity") or 0) >= cap:
        status = "used_up"
    elif d.get("start_date") and d["start_date"] > today:
        status = "scheduled"
    else:
        status = "live"
    d["status"] = status
    return d


class PromotionBody(BaseModel):
    name:           str
    scope_type:     str = "all"            # 'item' | 'category' | 'all'
    scope_value:    Optional[str] = None   # inventory_id | category name | None
    discount_value: float = 0              # percent off, 0–100
    start_date:     Optional[str] = None
    end_date:       Optional[str] = None
    max_quantity:   Optional[int] = None
    active:         bool = True


def _validate(data: PromotionBody):
    if not data.name.strip():
        raise HTTPException(400, "Promotion name is required.")
    if data.scope_type not in _SCOPES:
        raise HTTPException(400, "scope_type must be item, category or all.")
    if data.scope_type in ("item", "category") and not (data.scope_value or "").strip():
        raise HTTPException(400, "Pick the item or category this promotion applies to.")
    if not (0 < data.discount_value <= 100):
        raise HTTPException(400, "Discount must be between 0 and 100 percent.")
    if data.max_quantity is not None and data.max_quantity < 0:
        raise HTTPException(400, "Quantity cap cannot be negative.")
    if data.start_date and data.end_date and data.end_date < data.start_date:
        raise HTTPException(400, "End date is before the start date.")


@router.get("/")
def list_promotions(include_archived: bool = False,
                    user=Depends(require_perm("inventory", "view")),
                    db: sqlite3.Connection = Depends(get_db)):
    q = "SELECT * FROM promotions WHERE 1=1"
    if not include_archived:
        q += " AND archived_at IS NULL"
    q += " ORDER BY active DESC, id DESC"
    return [_row(p) for p in db.execute(q).fetchall()]


@router.get("/active")
def active_promotions(user=Depends(require_perm("pos", "view")),
                      db: sqlite3.Connection = Depends(get_db)):
    """Compact live-promo feed the register matches cart lines against (display
    only — checkout re-checks and is the authority on the quantity cap)."""
    today = _now()[:10]
    rows = db.execute(
        "SELECT id, name, scope_type, scope_value, discount_value, max_quantity, used_quantity "
        "FROM promotions WHERE active=1 AND archived_at IS NULL AND discount_value > 0 "
        "  AND (start_date IS NULL OR start_date <= ?) "
        "  AND (end_date   IS NULL OR end_date   >= ?) "
        "  AND (max_quantity IS NULL OR used_quantity < max_quantity)",
        (today, today),
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/")
def create_promotion(data: PromotionBody, user=Depends(require_perm("inventory", "create")),
                     db: sqlite3.Connection = Depends(get_db)):
    _validate(data)
    c = db.execute(
        "INSERT INTO promotions (name, scope_type, scope_value, discount_type, discount_value, "
        " start_date, end_date, max_quantity, used_quantity, active, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,0,?,?)",
        (data.name.strip(), data.scope_type,
         (data.scope_value or None) if data.scope_type != "all" else None,
         "percent", data.discount_value, data.start_date or None, data.end_date or None,
         data.max_quantity, 1 if data.active else 0, _now()),
    )
    log_action(db, user, "create", "promotion", c.lastrowid, data.name)
    db.commit()
    return {"id": c.lastrowid, "message": "Promotion created"}


@router.put("/{promo_id}")
def update_promotion(promo_id: int, data: PromotionBody,
                     user=Depends(require_perm("inventory", "edit")),
                     db: sqlite3.Connection = Depends(get_db)):
    if not db.execute("SELECT 1 FROM promotions WHERE id=?", (promo_id,)).fetchone():
        raise HTTPException(404, "Promotion not found")
    _validate(data)
    db.execute(
        "UPDATE promotions SET name=?, scope_type=?, scope_value=?, discount_value=?, "
        " start_date=?, end_date=?, max_quantity=?, active=? WHERE id=?",
        (data.name.strip(), data.scope_type,
         (data.scope_value or None) if data.scope_type != "all" else None,
         data.discount_value, data.start_date or None, data.end_date or None,
         data.max_quantity, 1 if data.active else 0, promo_id),
    )
    log_action(db, user, "update", "promotion", promo_id, data.name)
    db.commit()
    return {"message": "Promotion updated"}


@router.patch("/{promo_id}/toggle")
def toggle_promotion(promo_id: int, user=Depends(require_perm("inventory", "edit")),
                     db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT name, active FROM promotions WHERE id=?", (promo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Promotion not found")
    new = 0 if row["active"] else 1
    db.execute("UPDATE promotions SET active=? WHERE id=?", (new, promo_id))
    log_action(db, user, "update", "promotion", promo_id, row["name"], {"active": new})
    db.commit()
    return {"active": bool(new)}


@router.patch("/{promo_id}/archive")
def archive_promotion(promo_id: int, user=Depends(require_perm("inventory", "delete")),
                      db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT name FROM promotions WHERE id=?", (promo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Promotion not found")
    db.execute("UPDATE promotions SET archived_at=?, active=0 WHERE id=?", (_now(), promo_id))
    log_action(db, user, "archive", "promotion", promo_id, row["name"])
    db.commit()
    return {"message": "Promotion archived"}
