"""
Cash & Daily Reconciliation — track each cash drawer's daily position.

Model
-----
* `cash_drawers`         — named cash points (Main Till, Petty Cash, Safe…).
                           Exactly one drawer may carry `auto_capture`.
* `cash_reconciliations` — one record per drawer per day: opening balance,
                           counted cash, expected cash and variance.
* `cash_movements`       — manual cash in/out entries within a day.

Expected cash = opening balance
              + manual cash-in  − manual cash-out
              + auto cash-in     − auto cash-out         (auto_capture drawer only)

Auto cash-in  = cash-method invoice payments dated that day (this naturally
                includes POS cash sales, which are invoice payments).
Auto cash-out = cash-method expenses dated that day.

Variance = counted cash − expected cash, frozen when the day is closed.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, _today, notify
import branch_access
import sqlite3
import accounting

router = APIRouter()


# ── Models ─────────────────────────────────────────────────────────────────
class DrawerIn(BaseModel):
    name:         str
    is_active:    bool = True
    auto_capture: bool = False
    branch_id:    Optional[int] = None   # branch == warehouse; resolved on create


class ReconOpen(BaseModel):
    drawer_id:           int
    business_date:       Optional[str] = None    # YYYY-MM-DD; defaults to today
    opening_balance:     Optional[float] = None  # USD; defaults to the prior close
    opening_balance_lbp: Optional[float] = None  # LBP; defaults to the prior close


class MovementIn(BaseModel):
    direction:   str                             # 'in' | 'out'
    currency:    str = "USD"                      # 'USD' | 'LBP'
    amount:      float                            # in `currency`
    category:    Optional[str] = None
    description: Optional[str] = None


class ReconClose(BaseModel):
    counted_cash:     float                       # USD notes counted
    counted_cash_lbp: float = 0                   # LBP notes counted
    note:             Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────
def _auto_amounts(db, business_date, drawer_id, is_default):
    """Cash attributed to drawer `drawer_id` on `business_date`, PER CURRENCY.

    A drawer holds USD notes and LBP notes — two separate balances. A cash
    payment / expense counts here when it is tagged to this drawer, or, for
    the default drawer, when it is untagged. Every cash transaction lands on
    exactly one drawer, never double-counted, never converted between
    currencies.

    USD cash-in  — cash invoice payments tendered in USD (`amount`).
    LBP cash-in  — cash invoice payments tendered in LBP (`paid_amount`, the
                   actual LBP notes handed over).
    USD cash-out — cash-method expenses (the expense ledger is USD).
    Returns {"usd": {"in", "out"}, "lbp": {"in", "out"}}.
    """
    flag = 1 if is_default else 0

    def _cash_in(currency, amount_col):
        return float(db.execute(
            f"SELECT COALESCE(SUM(ip.{amount_col}), 0) FROM invoice_payments ip "
            "JOIN invoices i ON ip.invoice_id = i.id "
            "WHERE ip.method='Cash' AND ip.paid_currency=? AND DATE(ip.paid_at)=? "
            "  AND i.voided_at IS NULL AND i.archived_at IS NULL "
            "  AND (ip.cash_drawer_id=? OR (ip.cash_drawer_id IS NULL AND ?=1))",
            (currency, business_date, drawer_id, flag),
        ).fetchone()[0])

    out_usd = float(db.execute(
        "SELECT COALESCE(SUM(amount), 0) FROM expenses "
        "WHERE payment_method='Cash' AND DATE(date)=? "
        "  AND voided_at IS NULL AND archived_at IS NULL "
        "  AND (cash_drawer_id=? OR (cash_drawer_id IS NULL AND ?=1))",
        (business_date, drawer_id, flag),
    ).fetchone()[0])

    return {
        "usd": {"in": round(_cash_in("USD", "amount"), 2),      "out": round(out_usd, 2)},
        # LBP cash-out is always manual — the expense ledger has no LBP side.
        "lbp": {"in": round(_cash_in("LBP", "paid_amount"), 2), "out": 0.0},
    }


def _recon_figures(db, rec):
    """Live per-currency figures for a reconciliation. USD and LBP are kept
    strictly separate and are never summed into one number."""
    drawer = db.execute(
        "SELECT auto_capture FROM cash_drawers WHERE id=?", (rec["drawer_id"],)
    ).fetchone()
    auto = _auto_amounts(db, rec["business_date"], rec["drawer_id"],
                         bool(drawer and drawer["auto_capture"]))

    manual = {"USD": {"in": 0.0, "out": 0.0}, "LBP": {"in": 0.0, "out": 0.0}}
    for r in db.execute(
        "SELECT direction, currency, COALESCE(SUM(amount), 0) AS t "
        "FROM cash_movements WHERE reconciliation_id=? GROUP BY direction, currency",
        (rec["id"],),
    ).fetchall():
        ccy = r["currency"] if r["currency"] in manual else "USD"
        if r["direction"] in ("in", "out"):
            manual[ccy][r["direction"]] = round(float(r["t"]), 2)

    def _figs(ccy_key, opening, auto_ccy):
        m = manual[ccy_key]
        expected = round(opening + m["in"] - m["out"] + auto_ccy["in"] - auto_ccy["out"], 2)
        return {"opening": round(opening, 2),
                "manual_in": m["in"], "manual_out": m["out"],
                "auto_in": auto_ccy["in"], "auto_out": auto_ccy["out"],
                "expected": expected}

    return {
        "usd": _figs("USD", float(rec["opening_balance"] or 0),     auto["usd"]),
        "lbp": _figs("LBP", float(rec["opening_balance_lbp"] or 0), auto["lbp"]),
    }


def _serialize(db, rec, with_movements=False):
    """Build the API representation of a reconciliation row."""
    d = dict(rec)
    drawer = db.execute(
        "SELECT name, auto_capture FROM cash_drawers WHERE id=?", (rec["drawer_id"],)
    ).fetchone()
    d["drawer_name"]  = drawer["name"] if drawer else None
    d["auto_capture"] = bool(drawer["auto_capture"]) if drawer else False
    fig = _recon_figures(db, rec)
    d["figures"] = fig
    closed = rec["status"] == "closed"

    def _expose(suffix, fig_ccy, counted_col, expected_col, variance_col):
        # A closed day keeps figures frozen at close; an open day is live.
        if closed:
            d[f"expected_cash{suffix}"] = rec[expected_col]
            d[f"variance{suffix}"]      = rec[variance_col]
        else:
            d[f"expected_cash{suffix}"] = fig_ccy["expected"]
            counted = rec[counted_col]
            d[f"variance{suffix}"] = (round(float(counted) - fig_ccy["expected"], 2)
                                      if counted is not None else None)

    _expose("",     fig["usd"], "counted_cash",     "expected_cash",     "variance")
    _expose("_lbp", fig["lbp"], "counted_cash_lbp", "expected_cash_lbp", "variance_lbp")

    if with_movements:
        d["movements"] = [dict(m) for m in db.execute(
            "SELECT * FROM cash_movements WHERE reconciliation_id=? ORDER BY id",
            (rec["id"],),
        ).fetchall()]
    return d


def _get_recon(db, rec_id):
    rec = db.execute("SELECT * FROM cash_reconciliations WHERE id=?", (rec_id,)).fetchone()
    if not rec:
        raise HTTPException(404, "Reconciliation not found")
    return rec


# ── Drawers ────────────────────────────────────────────────────────────────
@router.get("/drawers")
def list_drawers(
    branch_id: Optional[int] = None,
    user=Depends(require_perm("cash", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    bf, bp = branch_access.branch_filter(user, db, column="branch_id", selected=branch_id)
    return [dict(r) for r in db.execute(
        f"SELECT * FROM cash_drawers WHERE 1=1{bf} ORDER BY is_active DESC, name", bp
    ).fetchall()]


@router.post("/drawers")
def create_drawer(
    data: DrawerIn,
    user=Depends(require_perm("cash", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "Drawer name is required.")
    if db.execute("SELECT 1 FROM cash_drawers WHERE name=?", (name,)).fetchone():
        raise HTTPException(400, "A cash drawer with that name already exists.")
    # Only one drawer auto-captures the day's business cash.
    if data.auto_capture:
        db.execute("UPDATE cash_drawers SET auto_capture=0")
    branch_id = branch_access.resolve_branch_id(user, db, data.branch_id)
    cur = db.execute(
        "INSERT INTO cash_drawers (name, is_active, auto_capture, created_at, branch_id) "
        "VALUES (?,?,?,?,?)",
        (name, 1 if data.is_active else 0, 1 if data.auto_capture else 0, _now(), branch_id),
    )
    log_action(db, user, "create", "cash", cur.lastrowid, name)
    db.commit()
    return {"id": cur.lastrowid, "message": "Cash drawer created"}


@router.put("/drawers/{drawer_id}")
def update_drawer(
    drawer_id: int,
    data: DrawerIn,
    user=Depends(require_perm("cash", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    dr = db.execute("SELECT * FROM cash_drawers WHERE id=?", (drawer_id,)).fetchone()
    if not dr:
        raise HTTPException(404, "Cash drawer not found")
    # Branch scoping — an id in the URL was not checked, so a user in one
    # branch could edit or void another branch's record even though the
    # list hides it. 404 (not 403) so ids cannot be probed.
    branch_access.assert_can_view_branch(user, db, dr["branch_id"])
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "Drawer name is required.")
    if db.execute("SELECT 1 FROM cash_drawers WHERE name=? AND id<>?",
                  (name, drawer_id)).fetchone():
        raise HTTPException(400, "A cash drawer with that name already exists.")
    if data.auto_capture:
        db.execute("UPDATE cash_drawers SET auto_capture=0")
    db.execute(
        "UPDATE cash_drawers SET name=?, is_active=?, auto_capture=? WHERE id=?",
        (name, 1 if data.is_active else 0, 1 if data.auto_capture else 0, drawer_id),
    )
    log_action(db, user, "update", "cash", drawer_id, name)
    db.commit()
    return {"message": "Cash drawer updated"}


# ── Reconciliations ────────────────────────────────────────────────────────
@router.get("/reconciliations")
def list_reconciliations(
    date:      Optional[str] = None,
    drawer_id: Optional[int] = None,
    status:    Optional[str] = None,
    limit:     int = 100,
    user=Depends(require_perm("cash", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    q, p = "SELECT * FROM cash_reconciliations WHERE 1=1", []
    if date:
        q += " AND business_date=?"; p.append(date[:10])
    if drawer_id is not None:
        q += " AND drawer_id=?"; p.append(drawer_id)
    if status:
        q += " AND status=?"; p.append(status)
    q += " ORDER BY business_date DESC, id DESC LIMIT ?"
    p.append(min(limit, 500))
    return [_serialize(db, r) for r in db.execute(q, p).fetchall()]


@router.get("/reconciliations/{rec_id}")
def get_reconciliation(
    rec_id: int,
    user=Depends(require_perm("cash", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    return _serialize(db, _get_recon(db, rec_id), with_movements=True)


@router.post("/reconciliations")
def open_reconciliation(
    data: ReconOpen,
    user=Depends(require_perm("cash", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    drawer = db.execute("SELECT * FROM cash_drawers WHERE id=?", (data.drawer_id,)).fetchone()
    if not drawer:
        raise HTTPException(400, "Cash drawer not found")
    if not drawer["is_active"]:
        raise HTTPException(400, "This cash drawer is inactive.")
    bdate = (data.business_date or _today())[:10]
    if db.execute(
        "SELECT 1 FROM cash_reconciliations WHERE drawer_id=? AND business_date=?",
        (data.drawer_id, bdate),
    ).fetchone():
        raise HTTPException(409, f"{drawer['name']} already has a reconciliation for {bdate}.")

    # Carry forward the most recent closed count for this drawer (per currency).
    prev = db.execute(
        "SELECT counted_cash, counted_cash_lbp FROM cash_reconciliations "
        "WHERE drawer_id=? AND status='closed' "
        "ORDER BY business_date DESC, id DESC LIMIT 1",
        (data.drawer_id,),
    ).fetchone()

    if data.opening_balance is not None:
        opening = round(float(data.opening_balance), 2)
    else:
        opening = round(float(prev["counted_cash"]), 2) if prev and prev["counted_cash"] is not None else 0.0
    if data.opening_balance_lbp is not None:
        opening_lbp = round(float(data.opening_balance_lbp), 2)
    else:
        opening_lbp = round(float(prev["counted_cash_lbp"]), 2) if prev and prev["counted_cash_lbp"] is not None else 0.0
    if opening < 0 or opening_lbp < 0:
        raise HTTPException(400, "Opening balance cannot be negative.")

    now = _now()
    cur = db.execute(
        "INSERT INTO cash_reconciliations "
        "(drawer_id, business_date, opening_balance, opening_balance_lbp, status, "
        " opened_by, opened_by_name, opened_at) "
        "VALUES (?,?,?,?, 'open', ?,?,?)",
        (data.drawer_id, bdate, opening, opening_lbp,
         user["id"], user.get("username"), now),
    )
    log_action(db, user, "open", "cash", cur.lastrowid, f"{drawer['name']} {bdate}",
               {"opening_balance": opening, "opening_balance_lbp": opening_lbp})
    db.commit()
    return {"id": cur.lastrowid, "message": "Reconciliation opened"}


@router.post("/reconciliations/{rec_id}/movements")
def add_movement(
    rec_id: int,
    data: MovementIn,
    user=Depends(require_perm("cash", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    rec = _get_recon(db, rec_id)
    if rec["status"] != "open":
        raise HTTPException(400, "This reconciliation is closed.")
    direction = (data.direction or "").lower()
    if direction not in ("in", "out"):
        raise HTTPException(400, "Direction must be 'in' or 'out'.")
    currency = (data.currency or "USD").upper()
    if currency not in ("USD", "LBP"):
        raise HTTPException(400, "Currency must be USD or LBP.")
    if data.amount is None or data.amount <= 0:
        raise HTTPException(400, "Movement amount must be positive.")
    now = _now()
    cur = db.execute(
        "INSERT INTO cash_movements "
        "(reconciliation_id, direction, currency, amount, category, description, "
        " created_by, created_by_name, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (rec_id, direction, currency, round(float(data.amount), 2),
         data.category, data.description, user["id"], user.get("username"), now),
    )
    log_action(db, user, "create", "cash", rec_id, f"cash {direction} {currency}",
               {"amount": data.amount, "currency": currency, "category": data.category})
    db.commit()
    return {"id": cur.lastrowid, "message": "Cash movement added"}


@router.delete("/reconciliations/{rec_id}/movements/{movement_id}")
def delete_movement(
    rec_id: int,
    movement_id: int,
    user=Depends(require_perm("cash", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    rec = _get_recon(db, rec_id)
    if rec["status"] != "open":
        raise HTTPException(400, "This reconciliation is closed.")
    mv = db.execute(
        "SELECT * FROM cash_movements WHERE id=? AND reconciliation_id=?",
        (movement_id, rec_id),
    ).fetchone()
    if not mv:
        raise HTTPException(404, "Cash movement not found")
    db.execute("DELETE FROM cash_movements WHERE id=?", (movement_id,))
    log_action(db, user, "delete", "cash", rec_id, "cash movement",
               {"amount": float(mv["amount"])})
    db.commit()
    return {"message": "Cash movement removed"}


@router.post("/reconciliations/{rec_id}/close")
def close_reconciliation(
    rec_id: int,
    data: ReconClose,
    user=Depends(require_perm("cash", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    rec = _get_recon(db, rec_id)
    if rec["status"] == "closed":
        raise HTTPException(400, "This reconciliation is already closed.")
    if data.counted_cash is None or data.counted_cash < 0:
        raise HTTPException(400, "Enter the counted USD cash amount.")
    if (data.counted_cash_lbp or 0) < 0:
        raise HTTPException(400, "Counted LBP cash cannot be negative.")

    fig = _recon_figures(db, rec)
    # USD and LBP are reconciled separately — two counts, two variances.
    counted_usd  = round(float(data.counted_cash), 2)
    counted_lbp  = round(float(data.counted_cash_lbp or 0), 2)
    variance_usd = round(counted_usd - fig["usd"]["expected"], 2)
    variance_lbp = round(counted_lbp - fig["lbp"]["expected"], 2)
    now = _now()
    db.execute(
        "UPDATE cash_reconciliations SET "
        "counted_cash=?, expected_cash=?, variance=?, "
        "counted_cash_lbp=?, expected_cash_lbp=?, variance_lbp=?, "
        "status='closed', note=COALESCE(?, note), closed_by=?, closed_by_name=?, closed_at=? "
        "WHERE id=?",
        (counted_usd, fig["usd"]["expected"], variance_usd,
         counted_lbp, fig["lbp"]["expected"], variance_lbp,
         data.note, user["id"], user.get("username"), now, rec_id),
    )
    log_action(db, user, "close", "cash", rec_id, "reconciliation",
               {"expected_usd": fig["usd"]["expected"], "counted_usd": counted_usd,
                "variance_usd": variance_usd, "expected_lbp": fig["lbp"]["expected"],
                "counted_lbp": counted_lbp, "variance_lbp": variance_lbp})

    # ── Post the variance to the General Ledger (F-3 audit fix) ─────────────
    # When a till is SHORT (variance < 0): cash on the books is too high, so
    #   DR  Cash Short & Over (expense)   |variance|
    #     CR  Cash & Bank / Cash — LBP                |variance|
    # When OVER (variance > 0): the reverse — recognise the windfall as a
    # credit to Cash Short & Over (a contra-expense that offsets prior shorts).
    # Done line-by-line per currency so each cash account stays consistent
    # with the physical drawer. LBP variance is translated to USD at the
    # latest stored exchange rate so the journal balances; a 1:1 LBP-only
    # entry would require an LBP-denominated Short & Over account which is
    # over-engineering for an SME — translation at spot is acceptable per
    # IAS 21 for in-period income statement items.
    rate_row = db.execute(
        "SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1"
    ).fetchone()
    lbp_rate = float(rate_row["rate"]) if rate_row and rate_row["rate"] else None

    def _post_variance(amount_usd: float, cash_code: str, currency_label: str):
        """Post one balanced variance entry. `amount_usd` is signed: negative
        for short, positive for over."""
        if abs(amount_usd) < 0.005:
            return
        magnitude = round(abs(amount_usd), 2)
        if amount_usd < 0:   # till short → loss
            lines = [
                {"code": accounting.CASH_SHORT_OVER, "debit":  magnitude,
                 "memo": f"Till short ({currency_label})"},
                {"code": cash_code,                  "credit": magnitude},
            ]
        else:                # till over → gain
            lines = [
                {"code": cash_code,                  "debit":  magnitude,
                 "memo": f"Till over ({currency_label})"},
                {"code": accounting.CASH_SHORT_OVER, "credit": magnitude},
            ]
        accounting.post_entry(
            db, entry_date=rec["business_date"][:10],
            memo=f"Cash variance — {currency_label} drawer #{rec['drawer_id']} on {rec['business_date']}",
            lines=lines, source_type=f"cash_variance_{currency_label.lower()}",
            source_id=rec_id, created_by=user["id"],
        )

    _post_variance(variance_usd, accounting.CASH, "USD")
    if lbp_rate and lbp_rate > 0:
        _post_variance(round(variance_lbp / lbp_rate, 2), accounting.CASH_LBP, "LBP")
    # If no rate is set we skip the LBP GL post — better than picking a
    # fake rate. The till-side variance is still recorded on the
    # reconciliation row and surfaced in the notification below.
    # Material variance at close → notify finance team. Threshold is set
    # deliberately above the "two-coins-stuck-under-the-tray" range. A drawer
    # may have variance in USD, LBP, or both — surface either.
    _USD_THRESHOLD = 5.0           # USD
    _LBP_THRESHOLD = 100_000.0     # LBP
    flagged = (abs(variance_usd) >= _USD_THRESHOLD
               or abs(variance_lbp) >= _LBP_THRESHOLD)
    if flagged:
        bits = []
        if abs(variance_usd) >= 0.01:
            bits.append(f"USD {variance_usd:+,.2f}")
        if abs(variance_lbp) >= 1:
            bits.append(f"LBP {variance_lbp:+,.0f}")
        notify(db, type="cash_variance",
               title=f"Cash variance on {rec['business_date']}",
               body=" · ".join(bits) or "Variance detected at close.",
               msg="cash_variance", params={"date": rec["business_date"]},
               link="/cash", entity_type="cash_reconciliation",
               entity_id=rec_id, dedup_hours=24)
    db.commit()
    return {"message": "Reconciliation closed",
            "expected_cash": fig["usd"]["expected"], "counted_cash": counted_usd,
            "variance": variance_usd,
            "expected_cash_lbp": fig["lbp"]["expected"], "counted_cash_lbp": counted_lbp,
            "variance_lbp": variance_lbp}


@router.post("/reconciliations/{rec_id}/reopen")
def reopen_reconciliation(
    rec_id: int,
    user=Depends(require_perm("cash", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    rec = _get_recon(db, rec_id)
    if rec["status"] != "closed":
        raise HTTPException(400, "This reconciliation is not closed.")
    db.execute(
        "UPDATE cash_reconciliations SET status='open', closed_by=NULL, "
        "closed_by_name=NULL, closed_at=NULL WHERE id=?",
        (rec_id,),
    )
    log_action(db, user, "reopen", "cash", rec_id, "reconciliation")
    db.commit()
    return {"message": "Reconciliation reopened"}


# ── Daily summary ──────────────────────────────────────────────────────────
@router.get("/summary")
def daily_summary(
    date: Optional[str] = None,
    user=Depends(require_perm("cash", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Every active drawer and its reconciliation status for the given day."""
    bdate = (date or _today())[:10]
    out = []
    for dr in db.execute(
        "SELECT * FROM cash_drawers WHERE is_active=1 ORDER BY name"
    ).fetchall():
        rec = db.execute(
            "SELECT * FROM cash_reconciliations WHERE drawer_id=? AND business_date=?",
            (dr["id"], bdate),
        ).fetchone()
        out.append({
            "drawer":         dict(dr),
            "reconciliation": _serialize(db, rec) if rec else None,
        })
    return {"date": bdate, "drawers": out}
