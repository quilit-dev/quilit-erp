"""
Fixed Assets — capital asset register with straight-line depreciation.

Model
-----
* `fixed_assets`      — the asset register. Each asset has an acquisition cost,
                        a salvage value and a useful life in months.
* `asset_depreciation`— one immutable row per asset per posted month.

Integration
-----------
Posting a depreciation period writes a row to the shared `expenses` table
(category 'Depreciation', `fixed_asset_id` set) so it flows into the Finance
P&L, range reports and snapshots exactly like any other expense — there is no
parallel ledger. Posting respects locked accounting periods: it stops an asset
at the first locked month rather than writing into a sealed period.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from typing import Optional
from datetime import datetime
import calendar
import sqlite3

from database import get_db
from permissions import require_perm
from routers.audit import log_action
from utils import _now, _today, notify
from approval_engine import evaluate_and_apply
import accounting

router = APIRouter()

_METHODS  = {'straight_line', 'none'}
_ACTIVE   = 'Active'
_DISPOSED = 'Disposed'
_FULL     = 'Fully Depreciated'


# ── Models ──────────────────────────────────────────────────────────────────
class AssetIn(BaseModel):
    name:                str
    category:            Optional[str] = None
    description:         Optional[str] = None
    acquisition_cost:    float
    acquisition_date:    str
    in_service_date:     Optional[str] = None
    depreciation_method: str = 'straight_line'
    useful_life_months:  int = 0
    salvage_value:       float = 0
    supplier_id:         Optional[int] = None

    @validator('acquisition_cost')
    def _cost_positive(cls, v):
        if v <= 0:
            raise ValueError('Acquisition cost must be greater than zero')
        return v

    @validator('salvage_value')
    def _salvage_ok(cls, v, values):
        if v < 0:
            raise ValueError('Salvage value cannot be negative')
        cost = values.get('acquisition_cost')
        if cost is not None and v >= cost:
            raise ValueError('Salvage value must be less than the acquisition cost')
        return v

    @validator('depreciation_method')
    def _method_ok(cls, v):
        if v not in _METHODS:
            raise ValueError("Method must be 'straight_line' or 'none'")
        return v

    @validator('useful_life_months')
    def _life_ok(cls, v, values):
        if values.get('depreciation_method') == 'straight_line' and v <= 0:
            raise ValueError('Useful life (months) is required for straight-line depreciation')
        if v < 0:
            raise ValueError('Useful life cannot be negative')
        return v


class DisposeIn(BaseModel):
    disposal_date:     Optional[str] = None
    disposal_proceeds: float = 0
    disposal_reason:   Optional[str] = None


class RunIn(BaseModel):
    period: Optional[str] = None    # YYYY-MM — defaults to the current month


# ── Period helpers ──────────────────────────────────────────────────────────
def _current_period() -> str:
    return datetime.utcnow().strftime('%Y-%m')


def _period_add(period: str, n: int) -> str:
    y, m = int(period[:4]), int(period[5:7])
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def _period_last_day(period: str) -> str:
    y, m = int(period[:4]), int(period[5:7])
    return f"{period}-{calendar.monthrange(y, m)[1]:02d}"


def _period_locked(db, period: str) -> bool:
    """True if the accounting period (YYYY-MM) is locked."""
    try:
        year, month = int(period[:4]), int(period[5:7])
    except (ValueError, TypeError):
        return False
    return db.execute(
        "SELECT 1 FROM accounting_periods "
        "WHERE year=? AND month=? AND locked_at IS NOT NULL",
        (year, month),
    ).fetchone() is not None


# ── Depreciation maths ──────────────────────────────────────────────────────
def _monthly_dep(asset: dict) -> float:
    """Straight-line monthly charge: (cost − salvage) / useful life."""
    if asset['depreciation_method'] != 'straight_line' or not asset['useful_life_months']:
        return 0.0
    base = float(asset['acquisition_cost']) - float(asset['salvage_value'])
    if base <= 0:
        return 0.0
    return round(base / int(asset['useful_life_months']), 2)


def _enrich(asset: dict) -> dict:
    """Add computed fields used by the UI."""
    cost     = float(asset['acquisition_cost'])
    salvage  = float(asset['salvage_value'])
    acc      = float(asset['accumulated_depreciation'])
    monthly  = _monthly_dep(asset)
    base     = max(cost - salvage, 0)
    asset['monthly_depreciation'] = monthly
    asset['book_value']           = round(cost - acc, 2)
    asset['depreciable_base']     = round(base, 2)
    asset['depreciation_pct']     = round(acc / base * 100, 1) if base > 0 else 0.0
    asset['fully_depreciated']    = base > 0 and acc >= base - 0.005
    return asset


def _asset_or_404(db, asset_id: int) -> dict:
    row = db.execute("SELECT * FROM fixed_assets WHERE id=?", (asset_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Asset not found")
    return dict(row)


def _next_asset_code(db) -> str:
    mx = db.execute("SELECT COALESCE(MAX(id), 0) AS m FROM fixed_assets").fetchone()
    return f"FA-{datetime.utcnow().year}-{mx['m'] + 1:04d}"


def _post_depreciation(db, asset: dict, target_period: str, user: dict, now: str):
    """Post every un-booked monthly charge up to target_period (inclusive).

    Returns (posted_rows, locked_stop). Each posted period writes one expense
    row and one asset_depreciation row. Stops at the first locked period.
    """
    if asset['status'] != _ACTIVE or asset['depreciation_method'] != 'straight_line':
        return [], None

    cost    = float(asset['acquisition_cost'])
    salvage = float(asset['salvage_value'])
    acc     = float(asset['accumulated_depreciation'])
    monthly = _monthly_dep(asset)
    remaining = round(cost - salvage - acc, 2)
    if monthly <= 0 or remaining <= 0.005:
        return [], None

    # First period to book: the month after the last booked one, or the
    # in-service month for a brand-new asset.
    if asset['last_depreciated_period']:
        cursor = _period_add(asset['last_depreciated_period'], 1)
    else:
        service = asset['in_service_date'] or asset['acquisition_date']
        cursor = str(service)[:7]

    posted, locked_stop = [], None
    last_period = asset['last_depreciated_period']

    while cursor <= target_period and remaining > 0.005:
        if _period_locked(db, cursor):
            locked_stop = cursor
            break
        amount = round(min(monthly, remaining), 2)
        acc       = round(acc + amount, 2)
        remaining = round(remaining - amount, 2)
        book      = round(cost - acc, 2)
        cur = db.execute(
            "INSERT INTO expenses (project_id, category, description, amount, date, "
            " created_at, status, fixed_asset_id) "
            "VALUES (NULL, 'Depreciation', ?, ?, ?, ?, 'Recorded', ?)",
            (f"Depreciation — {asset['name']} ({cursor})", amount,
             _period_last_day(cursor), now, asset['id']),
        )
        expense_id = cur.lastrowid
        db.execute(
            "INSERT INTO asset_depreciation "
            " (asset_id, period, amount, accumulated_after, book_value_after, "
            "  expense_id, posted_at, posted_by) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (asset['id'], cursor, amount, acc, book, expense_id, now, user['id']),
        )
        # Auto-post to the general ledger: DR Depreciation Expense,
        # CR Accumulated Depreciation (a non-cash contra-asset charge).
        accounting.post_entry(
            db,
            entry_date=_period_last_day(cursor),
            memo=f"Depreciation — {asset['name']} ({cursor})",
            lines=[
                {"code": accounting.DEPRECIATION, "debit":  amount},
                {"code": accounting.ACC_DEP,      "credit": amount},
            ],
            source_type="depreciation", source_id=expense_id, created_by=user['id'],
        )
        posted.append({"period": cursor, "amount": amount,
                        "book_value": book, "expense_id": expense_id})
        last_period = cursor
        cursor = _period_add(cursor, 1)

    new_status = _FULL if remaining <= 0.005 else asset['status']
    db.execute(
        "UPDATE fixed_assets SET accumulated_depreciation=?, "
        " last_depreciated_period=?, status=? WHERE id=?",
        (acc, last_period, new_status, asset['id']),
    )
    return posted, locked_stop


# ── Endpoints ───────────────────────────────────────────────────────────────
@router.get("")
@router.get("/")
def list_assets(
    status:   Optional[str] = None,
    category: Optional[str] = None,
    include_archived: bool = False,
    user=Depends(require_perm("assets", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    query = """SELECT a.*, s.name AS supplier_name
               FROM fixed_assets a
               LEFT JOIN suppliers s ON a.supplier_id = s.id
               WHERE 1=1"""
    params = []
    if not include_archived:
        query += " AND a.archived_at IS NULL"
    if status:
        query += " AND a.status = ?"
        params.append(status)
    if category:
        query += " AND a.category = ?"
        params.append(category)
    query += " ORDER BY a.created_at DESC"
    return [_enrich(dict(r)) for r in db.execute(query, params).fetchall()]


@router.get("/summary")
def assets_summary(
    user=Depends(require_perm("assets", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = [dict(r) for r in db.execute(
        "SELECT * FROM fixed_assets WHERE archived_at IS NULL"
    ).fetchall()]
    total_cost = total_acc = monthly_run_rate = 0.0
    counts = {_ACTIVE: 0, _DISPOSED: 0, _FULL: 0}
    for a in rows:
        if a['status'] == _DISPOSED:
            counts[_DISPOSED] += 1
            continue
        total_cost += float(a['acquisition_cost'])
        total_acc  += float(a['accumulated_depreciation'])
        counts[a['status']] = counts.get(a['status'], 0) + 1
        if a['status'] == _ACTIVE:
            base = float(a['acquisition_cost']) - float(a['salvage_value'])
            if float(a['accumulated_depreciation']) < base - 0.005:
                monthly_run_rate += _monthly_dep(a)
    return {
        "asset_count":          len(rows),
        "total_cost":           round(total_cost, 2),
        "accumulated_depreciation": round(total_acc, 2),
        "net_book_value":       round(total_cost - total_acc, 2),
        "monthly_run_rate":     round(monthly_run_rate, 2),
        "count_active":         counts.get(_ACTIVE, 0),
        "count_disposed":       counts.get(_DISPOSED, 0),
        "count_fully_depreciated": counts.get(_FULL, 0),
    }


@router.get("/{asset_id}")
def get_asset(
    asset_id: int,
    user=Depends(require_perm("assets", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    asset = _enrich(_asset_or_404(db, asset_id))
    ledger = db.execute(
        "SELECT * FROM asset_depreciation WHERE asset_id=? ORDER BY period ASC",
        (asset_id,),
    ).fetchall()
    asset['depreciation_ledger'] = [dict(r) for r in ledger]
    return asset


@router.post("")
@router.post("/")
def create_asset(
    data: AssetIn,
    user=Depends(require_perm("assets", "create")),
    db: sqlite3.Connection = Depends(get_db),
):
    now  = _now()
    code = _next_asset_code(db)
    cur = db.execute(
        "INSERT INTO fixed_assets "
        " (asset_code, name, category, description, acquisition_cost, acquisition_date, "
        "  in_service_date, depreciation_method, useful_life_months, salvage_value, "
        "  accumulated_depreciation, status, supplier_id, created_by, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)",
        (code, data.name, data.category, data.description, data.acquisition_cost,
         data.acquisition_date, data.in_service_date or data.acquisition_date,
         data.depreciation_method, data.useful_life_months, data.salvage_value,
         _ACTIVE, data.supplier_id, user['id'], now),
    )
    asset_id = cur.lastrowid

    # Capex governance — an active policy can gate a new asset behind approval.
    entity_data = {
        "acquisition_cost":    float(data.acquisition_cost or 0),
        "category":            data.category or "",
        "depreciation_method": data.depreciation_method or "",
    }
    label = f"{code} — {data.name}"
    needs_approval = evaluate_and_apply(
        db, module="fixed_asset", action="create",
        entity_data=entity_data, user_id=user["id"],
        entity_id=asset_id, entity_label=label,
    )
    if needs_approval:
        db.execute("UPDATE fixed_assets SET status='Pending Approval' WHERE id=?",
                   (asset_id,))

    log_action(db, user, "create", "asset", asset_id, code,
               {"name": data.name, "cost": data.acquisition_cost})
    db.commit()
    return {
        "id":              asset_id,
        "asset_code":      code,
        "pending_approval": bool(needs_approval),
        "message":         "Asset pending approval" if needs_approval else "Asset created",
    }


@router.put("/{asset_id}")
def update_asset(
    asset_id: int,
    data: AssetIn,
    user=Depends(require_perm("assets", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    asset = _asset_or_404(db, asset_id)
    if asset['status'] == _DISPOSED:
        raise HTTPException(400, "A disposed asset cannot be edited")

    # Once depreciation has been booked, the financial basis is frozen — only
    # descriptive fields may change, or the ledger would no longer reconcile.
    booked = db.execute(
        "SELECT COUNT(*) FROM asset_depreciation WHERE asset_id=?", (asset_id,)
    ).fetchone()[0]
    if booked:
        changed = (
            float(data.acquisition_cost) != float(asset['acquisition_cost'])
            or float(data.salvage_value) != float(asset['salvage_value'])
            or int(data.useful_life_months) != int(asset['useful_life_months'])
            or data.depreciation_method != asset['depreciation_method']
            or (data.in_service_date or data.acquisition_date) != asset['in_service_date']
            or data.acquisition_date != asset['acquisition_date']
        )
        if changed:
            raise HTTPException(
                400,
                "Depreciation has already been posted for this asset — its cost, "
                "salvage value, useful life, method and dates can no longer change. "
                "Only the name, category, supplier and description are editable.",
            )

    db.execute(
        "UPDATE fixed_assets SET name=?, category=?, description=?, acquisition_cost=?, "
        " acquisition_date=?, in_service_date=?, depreciation_method=?, "
        " useful_life_months=?, salvage_value=?, supplier_id=? WHERE id=?",
        (data.name, data.category, data.description, data.acquisition_cost,
         data.acquisition_date, data.in_service_date or data.acquisition_date,
         data.depreciation_method, data.useful_life_months, data.salvage_value,
         data.supplier_id, asset_id),
    )
    log_action(db, user, "update", "asset", asset_id, asset['asset_code'])
    db.commit()
    return {"message": "Asset updated"}


@router.post("/{asset_id}/depreciate")
def depreciate_asset(
    asset_id: int,
    data: RunIn,
    user=Depends(require_perm("assets", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    asset = _asset_or_404(db, asset_id)
    if asset['archived_at']:
        raise HTTPException(400, "Cannot depreciate an archived asset")
    if asset['status'] != _ACTIVE:
        raise HTTPException(400, f"Asset is {asset['status']} — no depreciation to post")
    if asset['depreciation_method'] != 'straight_line':
        raise HTTPException(400, "This asset is not set to depreciate")

    target = data.period or _current_period()
    posted, locked_stop = _post_depreciation(db, asset, target, user, _now())
    if posted:
        log_action(db, user, "depreciate", "asset", asset_id, asset['asset_code'],
                   {"periods": len(posted),
                    "amount": round(sum(p['amount'] for p in posted), 2)})
    db.commit()
    return {
        "posted":      posted,
        "period_count": len(posted),
        "total_amount": round(sum(p['amount'] for p in posted), 2),
        "locked_stop":  locked_stop,
        "message": (
            f"Posted {len(posted)} period(s) of depreciation"
            if posted else "Nothing to post — asset is already up to date"
        ),
    }


@router.post("/depreciation/run")
def run_depreciation(
    data: RunIn,
    user=Depends(require_perm("assets", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Catch up depreciation for every eligible asset up to the target period."""
    target = data.period or _current_period()
    now = _now()
    assets = db.execute(
        "SELECT * FROM fixed_assets WHERE archived_at IS NULL "
        " AND status=? AND depreciation_method='straight_line'",
        (_ACTIVE,),
    ).fetchall()

    total_periods = 0
    total_amount  = 0.0
    asset_results = []
    for row in assets:
        posted, locked_stop = _post_depreciation(db, dict(row), target, user, now)
        if posted or locked_stop:
            amt = round(sum(p['amount'] for p in posted), 2)
            total_periods += len(posted)
            total_amount  += amt
            asset_results.append({
                "asset_id": row['id'], "asset_code": row['asset_code'],
                "name": row['name'], "periods": len(posted),
                "amount": amt, "locked_stop": locked_stop,
            })
    if total_periods:
        log_action(db, user, "depreciate", "asset", None, f"run {target}",
                   {"assets": len(asset_results), "periods": total_periods,
                    "amount": round(total_amount, 2)})
        notify(db, type="asset_depreciated",
               title=f"Depreciation posted for {target}",
               body=(f"${round(total_amount, 2):,.2f} across {len(asset_results)} "
                     f"asset(s), {total_periods} period(s) caught up."),
               link="/fixed-assets", entity_type="depreciation_run",
               entity_id=None)
    db.commit()
    return {
        "target_period": target,
        "assets_affected": len(asset_results),
        "total_periods":  total_periods,
        "total_amount":   round(total_amount, 2),
        "results":        asset_results,
        "message": (
            f"Posted {total_periods} period(s) across {len(asset_results)} asset(s)"
            if total_periods else "All assets are already up to date"
        ),
    }


@router.post("/{asset_id}/dispose")
def dispose_asset(
    asset_id: int,
    data: DisposeIn,
    user=Depends(require_perm("assets", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    asset = _asset_or_404(db, asset_id)
    if asset['status'] == _DISPOSED:
        raise HTTPException(400, "Asset is already disposed")

    book_value = round(float(asset['acquisition_cost'])
                       - float(asset['accumulated_depreciation']), 2)
    proceeds   = float(data.disposal_proceeds or 0)
    gain_loss  = round(proceeds - book_value, 2)
    db.execute(
        "UPDATE fixed_assets SET status=?, disposal_date=?, disposal_proceeds=?, "
        " disposal_reason=? WHERE id=?",
        (_DISPOSED, data.disposal_date or _today(), proceeds,
         data.disposal_reason, asset_id),
    )
    log_action(db, user, "dispose", "asset", asset_id, asset['asset_code'],
               {"book_value": book_value, "proceeds": proceeds,
                "gain_loss": gain_loss})
    db.commit()
    return {
        "message": "Asset disposed",
        "book_value": book_value,
        "proceeds": proceeds,
        "gain_loss": gain_loss,
    }


@router.patch("/{asset_id}/archive")
def archive_asset(
    asset_id: int,
    user=Depends(require_perm("assets", "delete")),
    db: sqlite3.Connection = Depends(get_db),
):
    asset = _asset_or_404(db, asset_id)
    if asset['archived_at']:
        raise HTTPException(400, "Asset is already archived")
    db.execute("UPDATE fixed_assets SET archived_at=? WHERE id=?", (_now(), asset_id))
    log_action(db, user, "archive", "asset", asset_id, asset['asset_code'])
    db.commit()
    return {"message": "Asset archived"}


@router.patch("/{asset_id}/unarchive")
def unarchive_asset(
    asset_id: int,
    user=Depends(require_perm("assets", "edit")),
    db: sqlite3.Connection = Depends(get_db),
):
    asset = _asset_or_404(db, asset_id)
    if not asset['archived_at']:
        raise HTTPException(400, "Asset is not archived")
    db.execute("UPDATE fixed_assets SET archived_at=NULL WHERE id=?", (asset_id,))
    log_action(db, user, "unarchive", "asset", asset_id, asset['asset_code'])
    db.commit()
    return {"message": "Asset restored"}
