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
import sqlite3, json, hashlib

router = APIRouter()

# ── Tamper-evident hash chain ─────────────────────────────────────────────────
# Each row stores row_hash = SHA-256(prev_hash + canonical-content). Because every
# row commits to its predecessor's hash, editing or deleting any row breaks the
# chain from that point onward — which GET /api/audit/verify detects and locates.
# It doesn't PREVENT tampering (the row lives in the same DB), but it makes silent
# tampering impossible to hide. Rows written before this feature have NULL hashes;
# verification starts the chain at the first hashed row.
_GENESIS = "0" * 64

def _content_payload(user_id, username, action, module, record_id, record_ref, detail_json, created_at):
    """The immutable fields a row commits to, order-independent (sorted keys)."""
    return {
        "user_id": user_id, "username": username, "action": action, "module": module,
        "record_id": record_id, "record_ref": record_ref, "detail": detail_json,
        "created_at": created_at,
    }

def _chain_hash(prev_hash: str, payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256((prev_hash + "|" + canonical).encode("utf-8")).hexdigest()


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
        uid         = user.get("id") or user.get("sub")
        username    = user.get("username", "unknown")
        ref         = record_ref or ""
        detail_json = json.dumps(detail) if detail else None
        created_at  = _now()

        # Link to the current tip of the chain (genesis if empty / all-legacy).
        prev = db.execute(
            "SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        prev_hash = (prev["row_hash"] if prev and prev["row_hash"] else _GENESIS)
        row_hash  = _chain_hash(prev_hash, _content_payload(
            uid, username, action, module, record_id, ref, detail_json, created_at))

        db.execute(
            "INSERT INTO audit_log "
            "(user_id, username, action, module, record_id, record_ref, detail, created_at, "
            " prev_hash, row_hash) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (uid, username, action, module, record_id, ref, detail_json, created_at,
             prev_hash, row_hash),
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


@router.get("/verify")
def verify_audit_chain(
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    """Re-walk the hash chain and report whether it is intact.

    Detects a **content edit** (a row's hash no longer matches its content) and a
    **mid-chain deletion / reorder** (a row's prev_hash no longer matches the row
    before it). A legitimately trimmed prefix (the `/purge` endpoint) is accepted:
    the earliest remaining hashed row is taken as the anchor. Legacy rows written
    before the feature (NULL hash) are skipped and re-anchor the chain.

    `tip_hash` is the hash of the newest row — an operator can record it off-box
    (the "external anchor") and re-run verify later; a change to `tip_hash` for an
    equal-or-longer history means the chain was rewritten.
    """
    rows = db.execute(
        "SELECT id, user_id, username, action, module, record_id, record_ref, "
        "       detail, created_at, prev_hash, row_hash "
        "FROM audit_log ORDER BY id ASC"
    ).fetchall()

    checked = 0
    tip_hash = None
    need_anchor = True          # accept the next hashed row's stored prev_hash
    prev_row_hash = None
    for r in rows:
        d = dict(r)
        if not d["row_hash"]:               # legacy / unhashed → skip, re-anchor
            need_anchor = True
            continue
        payload = _content_payload(
            d["user_id"], d["username"], d["action"], d["module"],
            d["record_id"], d["record_ref"], d["detail"], d["created_at"])
        # Content integrity: the stored hash must match a recompute.
        if d["row_hash"] != _chain_hash(d["prev_hash"] or _GENESIS, payload):
            return {"ok": False, "broken_at_id": d["id"], "reason": "content_modified",
                    "checked": checked, "total": len(rows)}
        # Linkage: every row after the anchor must point at its predecessor.
        if need_anchor:
            need_anchor = False
        elif d["prev_hash"] != prev_row_hash:
            return {"ok": False, "broken_at_id": d["id"], "reason": "row_deleted_or_reordered",
                    "checked": checked, "total": len(rows)}
        prev_row_hash = d["row_hash"]
        tip_hash = d["row_hash"]
        checked += 1

    return {"ok": True, "checked": checked, "total": len(rows), "tip_hash": tip_hash}


@router.get("/filters")
def audit_filter_values(
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    """Distinct modules and actions present in the log — drives the Activity
    Log filter dropdowns so they always match reality instead of a hardcoded
    list that goes stale every time a router gains a new audited action."""
    modules = [r["module"] for r in db.execute(
        "SELECT DISTINCT module FROM audit_log WHERE module IS NOT NULL ORDER BY module"
    ).fetchall()]
    actions = [r["action"] for r in db.execute(
        "SELECT DISTINCT action FROM audit_log WHERE action IS NOT NULL ORDER BY action"
    ).fetchall()]
    return {"modules": modules, "actions": actions}


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
