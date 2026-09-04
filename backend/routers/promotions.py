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
from permissions import require_perm, require_any_perm
from routers.audit import log_action
from utils import _now, ArchiveMode, archive_clause

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


def promo_discount_for_line(db, inventory_id, quantity, unit_price, today=None):
    """The promotion discount for ONE invoice or quotation line.

    Returns ``(discount_amount, promotion_id)``, or ``(0.0, None)`` when nothing
    applies. The amount is in the document's currency, matching the `discount`
    column the pricing engine already subtracts before tax.

    Two deliberate differences from the POS path:

    * **The quantity cap is not consumed.** POS meters "first N units" by
      bumping `used_quantity` inside the sale transaction. An invoice is not a
      sale — it can be drafted, edited and voided — so metering here would burn
      units of a promotion the customer may never receive. POS stays the metered
      channel; a quotation is indicative only, and may well expire before it is
      accepted.
    * **Every unit is eligible**, precisely because nothing is being metered.

    The caller snapshots the returned values onto the line, so ending or editing
    a promotion later cannot retroactively change a document already issued.
    """
    from utils import _now
    if not inventory_id:
        return 0.0, None
    try:
        qty = float(quantity or 0)
        price = float(unit_price or 0)
    except (TypeError, ValueError):
        return 0.0, None
    if qty <= 0 or price <= 0:
        return 0.0, None

    today = today or _now()[:10]
    row = db.execute("SELECT category FROM inventory WHERE id=?",
                     (inventory_id,)).fetchone()
    category = row["category"] if row else None

    promo = best_promo_for(db, inventory_id, category, today)
    if not promo:
        return 0.0, None
    pct = float(promo["discount_value"] or 0)
    if pct <= 0:
        return 0.0, None
    return round(qty * price * pct / 100.0, 4), promo["id"]


def _f(v, default=0.0) -> float:
    try:
        return float(v if v not in (None, "") else default)
    except (TypeError, ValueError):
        return default


def apply_promotions_to_lines(db, items, today=None):
    """Fill each line's `discount` from the best live promotion, IN PLACE.

    Returns a list of promotion ids parallel to `items` (None where nothing
    applied), so the caller can snapshot which promotion produced the reduction.

    Called BEFORE pricing, so tax is computed on the discounted net exactly as
    it is for a hand-entered discount — the promotion changes what the customer
    owes, and tax follows the actual consideration.

    **An explicitly entered discount is left alone.** Someone typing a number
    into that box has made a decision, and an automatic rule must not overwrite
    it. The promotion only fills a line that has none.
    """
    out = []
    for it in (items or []):
        try:
            existing = float(getattr(it, "discount", 0) or 0)
        except (TypeError, ValueError):
            existing = 0.0
        # `discount_auto=False` means a person touched that field, so their
        # number stands — INCLUDING zero. Falling back to `existing > 0` alone
        # made an explicit zero indistinguishable from an untouched field, so a
        # customer told they get no discount silently received the promotion.
        raw_auto = getattr(it, "discount_auto", True)
        auto = True if raw_auto is None else bool(raw_auto)
        if not auto or existing > 0:
            # A human decided. If they expressed it as a PERCENTAGE, turn that
            # into the money figure the pricing engine and the ledger use — the
            # percentage is what was agreed, the amount is what is owed.
            pct = getattr(it, "discount_pct", None)
            if pct is not None:
                gross = (_f(getattr(it, "quantity", 0))
                         * _f(getattr(it, "unit_price", 0)))
                try:
                    it.discount = round(gross * _f(pct) / 100.0, 2)
                except Exception:
                    pass                       # immutable model — leave it be
            out.append(None)
            continue
        amount, promo_id = promo_discount_for_line(
            db, getattr(it, "inventory_id", None),
            getattr(it, "quantity", 0), getattr(it, "unit_price", 0), today)
        if promo_id and amount > 0:
            try:
                it.discount = amount
                # Record the rate too, so a document can say "20% off" rather
                # than only the money. Promotions ARE percentages; storing only
                # the amount threw that away.
                row = db.execute("SELECT discount_value FROM promotions WHERE id=?",
                                 (promo_id,)).fetchone()
                if row is not None:
                    it.discount_pct = _f(row["discount_value"])
            except Exception:
                out.append(None)               # immutable model — do not guess
                continue
            out.append(promo_id)
        else:
            out.append(None)
    return out


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
def list_promotions(archived: ArchiveMode = "exclude",
                    user=Depends(require_perm("inventory", "view")),
                    db: sqlite3.Connection = Depends(get_db)):
    q = "SELECT * FROM promotions WHERE 1=1"
    q += f" AND {archive_clause(archived)}"
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


# ── preview ──────────────────────────────────────────────────────────────────

class _PreviewLine(BaseModel):
    inventory_id: Optional[int] = None
    quantity: float = 0
    unit_price: float = 0
    discount: Optional[float] = 0


class PreviewRequest(BaseModel):
    lines: list[_PreviewLine] = []


@router.post("/preview")
def preview_promotions(data: PreviewRequest,
                       user=Depends(require_any_perm("invoices", "quotations", "pos")),
                       db: sqlite3.Connection = Depends(get_db)):
    """Price draft lines against live promotions, without saving anything.

    The invoice and quotation forms compute their own running totals, so without
    this they showed a discount of zero while the server was about to apply one —
    the operator agreed a figure with the customer that the saved document then
    contradicted.

    It deliberately calls the SAME `promo_discount_for_line` the save path uses.
    Re-implementing the rule in JavaScript would drift, and the failure mode of
    drift here is quoting a price the invoice does not honour.

    Nothing is metered: this reads promotions, and even the save path leaves the
    quantity cap to POS.
    """
    today = _now()[:10]
    out = []
    for ln in (data.lines or []):
        # A typed discount wins, exactly as it does on save.
        if (ln.discount or 0) > 0:
            out.append({"discount": float(ln.discount or 0), "discount_pct": None,
                        "promotion_id": None, "promotion_name": None,
                        "source": "manual"})
            continue
        amount, promo_id = promo_discount_for_line(
            db, ln.inventory_id, ln.quantity, ln.unit_price, today)
        name = None
        if promo_id:
            row = db.execute("SELECT name FROM promotions WHERE id=?", (promo_id,)).fetchone()
            name = row["name"] if row else None
        # The RATE as well as the money: the form's discount field is a
        # percentage, so returning only an amount left it with nothing to show.
        pct = None
        if promo_id:
            prow = db.execute("SELECT discount_value FROM promotions WHERE id=?",
                              (promo_id,)).fetchone()
            if prow is not None:
                pct = float(prow["discount_value"] or 0)
        out.append({"discount": round(float(amount or 0), 2), "discount_pct": pct,
                    "promotion_id": promo_id, "promotion_name": name,
                    "source": "promotion" if promo_id else None})
    return {"lines": out}


# ── diagnosis ────────────────────────────────────────────────────────────────

@router.get("/diagnose")
def diagnose_promotions(inventory_id: Optional[int] = None,
                        name: Optional[str] = None,
                        quantity: float = 1,
                        unit_price: float = 0,
                        user=Depends(require_any_perm("invoices", "quotations", "pos")),
                        db: sqlite3.Connection = Depends(get_db)):
    """Explain, for ONE inventory item, why a promotion did or did not apply.

    "The discount isn't showing" has half a dozen possible causes — wrong scope,
    inactive, outside the date window, cap exhausted, or the line simply having
    no stock link — and answering it by elimination means guessing at data only
    the customer can see. This reports the verdict for every promotion in the
    tenant, with the reason attached.

    It does NOT re-implement the rule. Each promotion is checked against the same
    conditions best_promo_for uses, and then the real functions are called and
    their answers reported alongside — so if this ever disagreed with production
    behaviour, the disagreement itself would be visible rather than hidden.

    Read-only: nothing is metered, nothing is written.
    """
    # Accept a name as well as an id. Asking someone to find a database id
    # before they can ask why a discount is missing is a poor trade, and the
    # first thing they will do is guess one that does not exist.
    item = None
    if inventory_id is not None:
        item = db.execute(
            "SELECT id, name, category FROM inventory WHERE id = ?", (inventory_id,)
        ).fetchone()
    elif name:
        item = db.execute(
            "SELECT id, name, category FROM inventory "
            "WHERE lower(name) = lower(?) ORDER BY id LIMIT 1", (name.strip(),)
        ).fetchone()
        if not item:
            item = db.execute(
                "SELECT id, name, category FROM inventory "
                "WHERE lower(name) LIKE lower(?) ORDER BY id LIMIT 1",
                (f"%{name.strip()}%",)
            ).fetchone()

    if not item:
        # Say what IS available rather than only what was not found — otherwise
        # the next request is another guess.
        available = [dict(r) for r in db.execute(
            "SELECT id, name FROM inventory ORDER BY id LIMIT 25").fetchall()]
        asked = (f"id {inventory_id}" if inventory_id is not None
                 else f"name {name!r}" if name
                 else "nothing")
        raise HTTPException(404, {
            "message": f"No inventory item matched {asked}.",
            "hint": "Pass ?inventory_id= or ?name=. These are the first items in "
                    "this workspace:",
            "available_items": available,
            "total_items": db.execute(
                "SELECT COUNT(*) AS n FROM inventory").fetchone()["n"],
        })

    # Everything below matches on the RESOLVED item, not the raw query
    # parameter. Looking up by name left inventory_id as None, so every
    # promotion was reported "scope does not match" — a diagnostic confidently
    # blaming a promotion that was in fact correct, which is worse than no
    # diagnostic at all.
    inventory_id = item["id"]

    today = _now()[:10]
    rows = db.execute(
        "SELECT * FROM promotions ORDER BY id"
    ).fetchall()

    considered = []
    for p in rows:
        d = dict(p)
        reasons = []
        if not d.get("active"):
            reasons.append("not active")
        if d.get("archived_at"):
            reasons.append("archived")
        if not (d.get("discount_value") or 0) > 0:
            reasons.append("discount is zero")
        if d.get("start_date") and str(d["start_date"]) > today:
            reasons.append(f"starts {d['start_date']}, server date is {today}")
        if d.get("end_date") and str(d["end_date"]) < today:
            reasons.append(f"ended {d['end_date']}, server date is {today}")
        cap, used = d.get("max_quantity"), d.get("used_quantity") or 0
        if cap is not None and used >= cap:
            reasons.append(f"quantity cap reached ({used}/{cap})")

        st = d.get("scope_type")
        if st == "all":
            scope_ok = True
            scope_note = "applies to everything"
        elif st == "item":
            scope_ok = str(d.get("scope_value")) == str(inventory_id)
            scope_note = (f"targets item #{d.get('scope_value')}, "
                          f"this is item #{inventory_id}")
        elif st == "category":
            scope_ok = bool(item["category"]) and d.get("scope_value") == item["category"]
            scope_note = (f"targets category {d.get('scope_value')!r}, "
                          f"this item is in {item['category']!r}")
        else:
            scope_ok = False
            scope_note = f"unknown scope type {st!r}"
        if not scope_ok:
            reasons.append("scope does not match")

        considered.append({
            "id": d["id"], "name": d.get("name"),
            "scope_type": st, "scope_value": d.get("scope_value"),
            "discount_value": d.get("discount_value"),
            "active": bool(d.get("active")), "archived": bool(d.get("archived_at")),
            "start_date": d.get("start_date"), "end_date": d.get("end_date"),
            "max_quantity": cap, "used_quantity": used,
            "scope_note": scope_note,
            "eligible": not reasons,
            "rejected_because": reasons,
        })

    # What production actually does, reported rather than inferred.
    chosen = best_promo_for(db, inventory_id, item["category"], today)
    amount, promo_id = promo_discount_for_line(db, inventory_id, quantity, unit_price, today)

    eligible = [c for c in considered if c["eligible"]]
    if promo_id:
        verdict = (f"{amount:.2f} off — promotion #{promo_id} applies to "
                   f"{quantity} x {unit_price}.")
    elif not considered:
        verdict = "No promotions exist in this workspace yet."
    elif not eligible:
        verdict = ("No promotion is eligible for this item. See "
                   "rejected_because on each one below.")
    else:
        verdict = ("A promotion is eligible but produced no discount — check the "
                   "line quantity and unit price are above zero.")

    return {
        "item": {"id": item["id"], "name": item["name"], "category": item["category"]},
        "server_date_utc": today,
        "line": {"quantity": quantity, "unit_price": unit_price},
        "verdict": verdict,
        "discount": round(float(amount or 0), 2),
        "chosen_promotion_id": promo_id,
        "chosen_promotion_name": (dict(chosen).get("name") if chosen else None),
        "eligible_count": len(eligible),
        "promotions": considered,
    }
