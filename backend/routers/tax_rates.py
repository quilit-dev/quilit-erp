"""
Tax rates — the admin-managed list of named tax rates used across the ERP.

`tax_enabled` (in settings) is the master on/off switch; this table holds the
individual rates. Exactly one rate is the default, applied to new document
lines unless another is chosen. Rates are deactivated rather than hard-deleted
so historical documents that reference them stay intact.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_auth, require_admin
from routers.audit import log_action
from utils import _now
import sqlite3

router = APIRouter()

TAX_TYPES = ("standard", "zero", "exempt")


class TaxRateIn(BaseModel):
    name:       str
    rate:       float = 0
    tax_type:   str   = "standard"
    is_default: bool  = False
    is_active:  bool  = True


def _validate(data: TaxRateIn):
    if not (data.name or "").strip():
        raise HTTPException(400, "Tax rate name is required.")
    if data.rate < 0 or data.rate > 100:
        raise HTTPException(400, "Tax rate must be between 0 and 100.")
    if data.tax_type not in TAX_TYPES:
        raise HTTPException(400, f"Tax type must be one of: {', '.join(TAX_TYPES)}")


@router.get("/")
def list_tax_rates(user=Depends(require_auth), db: sqlite3.Connection = Depends(get_db)):
    """Every signed-in user may read the rates — document forms need them."""
    rows = db.execute(
        "SELECT * FROM tax_rates ORDER BY is_active DESC, is_default DESC, name"
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/")
def create_tax_rate(
    data: TaxRateIn,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    _validate(data)
    # The first rate created is forced to be the default and active.
    has_any = db.execute("SELECT 1 FROM tax_rates LIMIT 1").fetchone()
    is_default = data.is_default or not has_any
    if is_default:
        db.execute("UPDATE tax_rates SET is_default=0")
    cur = db.execute(
        "INSERT INTO tax_rates (name, rate, tax_type, is_default, is_active, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (data.name.strip(), data.rate, data.tax_type,
         1 if is_default else 0, 1 if (data.is_active or is_default) else 0, _now()),
    )
    log_action(db, user, "create", "tax_rate", cur.lastrowid, data.name.strip())
    db.commit()
    return {"id": cur.lastrowid, "message": "Tax rate created"}


@router.put("/{rate_id}")
def update_tax_rate(
    rate_id: int,
    data: TaxRateIn,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    _validate(data)
    existing = db.execute("SELECT * FROM tax_rates WHERE id=?", (rate_id,)).fetchone()
    if not existing:
        raise HTTPException(404, "Tax rate not found")
    # The default rate must always remain default and active until another
    # rate is promoted in its place.
    if existing["is_default"] and not data.is_default:
        raise HTTPException(400, "Set another rate as the default before changing this one.")
    if existing["is_default"] and not data.is_active:
        raise HTTPException(400, "The default tax rate cannot be deactivated.")
    if data.is_default:
        db.execute("UPDATE tax_rates SET is_default=0")
    db.execute(
        "UPDATE tax_rates SET name=?, rate=?, tax_type=?, is_default=?, is_active=? WHERE id=?",
        (data.name.strip(), data.rate, data.tax_type,
         1 if data.is_default else 0,
         1 if (data.is_active or data.is_default) else 0, rate_id),
    )
    log_action(db, user, "update", "tax_rate", rate_id, data.name.strip())
    db.commit()
    return {"message": "Tax rate updated"}


@router.delete("/{rate_id}")
def delete_tax_rate(
    rate_id: int,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    """Deactivate a rate. It stays in the table so documents that already use
    it keep a valid reference; it just no longer appears in new-document forms."""
    row = db.execute("SELECT * FROM tax_rates WHERE id=?", (rate_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Tax rate not found")
    if row["is_default"]:
        raise HTTPException(400, "Set another rate as the default before removing this one.")
    db.execute("UPDATE tax_rates SET is_active=0 WHERE id=?", (rate_id,))
    log_action(db, user, "delete", "tax_rate", rate_id, row["name"])
    db.commit()
    return {"message": "Tax rate deactivated"}
