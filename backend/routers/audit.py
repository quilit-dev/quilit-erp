"""
Audit Log — read-only activity history.

Every create/update/delete/payment action across all modules writes a row here
via the log_action() helper imported by each router.
"""
from fastapi import APIRouter, Depends
from typing import Optional
from database import get_db
from permissions import require_admin
from utils import _now
import sqlite3, json

router = APIRouter()

# ── Public helper used by all routers ─────────────────────────────────────────
def log_action(
    db: sqlite3.Connection,
    user: dict,
    action: str,
    module: str,
    record_id: int = None,
    record_ref: str = "",
    detail: dict = None,
):
    """Insert one audit row. Never raises — a logging failure must not crash requests."""
    try:
        db.execute(
            "INSERT INTO audit_log "
            "(user_id, username, action, module, record_id, record_ref, detail, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                user.get("id") or user.get("sub"),
                user.get("username", "unknown"),
                action,
                module,
                record_id,
                record_ref or "",
                json.dumps(detail) if detail else None,
                _now(),
            ),
        )
    except Exception:
        pass  # Never crash the calling request due to audit failure

# ── Shared filter builder ─────────────────────────────────────────────────────
def _build_filters(module, action, username, from_date, to_date):
    where, params = "WHERE 1=1", []
    if module:
        where += " AND module = ?";    params.append(module)
    if action:
        where += " AND action = ?";    params.append(action)
    if username:
        where += " AND username LIKE ?"; params.append(f"%{username}%")
    if from_date:
        where += " AND created_at >= ?"; params.append(from_date)
    if to_date:
        where += " AND created_at <= ?"; params.append(to_date + " 23:59:59")
    return where, params


# ── List endpoint (read-only, admin only) ─────────────────────────────────────
@router.get("/")
def list_audit_log(
    module:    Optional[str] = None,
    action:    Optional[str] = None,
    username:  Optional[str] = None,
    from_date: Optional[str] = None,
    to_date:   Optional[str] = None,
    limit:     int = 200,
    offset:    int = 0,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    where, params = _build_filters(module, action, username, from_date, to_date)

    rows  = db.execute(f"SELECT * FROM audit_log {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                       params + [min(limit, 500), offset]).fetchall()
    total = db.execute(f"SELECT COUNT(*) FROM audit_log {where}", params).fetchone()[0]

    return {"total": total, "offset": offset, "limit": limit, "rows": [dict(r) for r in rows]}


# ── Purge old logs ─────────────────────────────────────────────────────────────
@router.delete("/purge")
def purge_old_logs(
    older_than_days: int = 365,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    """Delete audit rows older than `older_than_days` days. Returns how many were deleted."""
    if older_than_days < 30:
        from fastapi import HTTPException
        raise HTTPException(400, "Minimum retention is 30 days.")
    cutoff = _now()
    # SQLite date arithmetic
    deleted = db.execute(
        "DELETE FROM audit_log WHERE created_at < datetime('now', ?)",
        (f"-{older_than_days} days",)
    ).rowcount
    db.commit()
    log_action(db, user, "purge", "audit", detail={"deleted_rows": deleted, "older_than_days": older_than_days})
    db.commit()
    return {"ok": True, "deleted": deleted, "older_than_days": older_than_days}
