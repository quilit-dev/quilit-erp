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

# ── Audit-list queries ────────────────────────────────────────────────────────
# Both statements are fixed literal strings. Every filter is optional and turns
# into a no-op when its bound value is NULL, so no user input is ever
# concatenated into the SQL text.
_AUDIT_LIST_SQL = """
    SELECT * FROM audit_log
     WHERE (? IS NULL OR module = ?)
       AND (? IS NULL OR action = ?)
       AND (? IS NULL OR username LIKE ?)
       AND (? IS NULL OR created_at >= ?)
       AND (? IS NULL OR created_at <= ?)
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?
"""

_AUDIT_COUNT_SQL = """
    SELECT COUNT(*) FROM audit_log
     WHERE (? IS NULL OR module = ?)
       AND (? IS NULL OR action = ?)
       AND (? IS NULL OR username LIKE ?)
       AND (? IS NULL OR created_at >= ?)
       AND (? IS NULL OR created_at <= ?)
"""


def _audit_filter_params(module, action, username, from_date, to_date):
    """Positional bind values for the optional-filter clauses, in query order."""
    return [
        module,    module,
        action,    action,
        username,  f"%{username}%" if username else None,
        from_date, from_date,
        to_date,   (to_date + " 23:59:59") if to_date else None,
    ]


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
    params = _audit_filter_params(module, action, username, from_date, to_date)

    rows  = db.execute(_AUDIT_LIST_SQL, params + [min(limit, 500), offset]).fetchall()
    total = db.execute(_AUDIT_COUNT_SQL, params).fetchone()[0]

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
    # Cutoff computed in Python (UTC, matching SQLite's datetime('now')) so the
    # comparison is a portable plain-string compare — identical on SQLite/Postgres.
    from datetime import datetime, timedelta
    cutoff = (datetime.utcnow() - timedelta(days=older_than_days)).strftime("%Y-%m-%d %H:%M:%S")
    deleted = db.execute(
        "DELETE FROM audit_log WHERE created_at < ?",
        (cutoff,)
    ).rowcount
    db.commit()
    log_action(db, user, "purge", "audit", detail={"deleted_rows": deleted, "older_than_days": older_than_days})
    db.commit()
    return {"ok": True, "deleted": deleted, "older_than_days": older_than_days}
