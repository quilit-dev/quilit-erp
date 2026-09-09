"""Audit logging — the write side, with no HTTP attached.

Every create/update/delete/payment across the system calls `log_action`. It
used to live in `routers/audit.py`, which meant 39 of the 47 routers imported
another *router* to do it: a module that defines endpoints, depends on
`require_admin`, and exists to answer GET /api/audit. Importing it for a write
helper made the router layer a dependency of itself, and made the import graph
say something untrue about how the application is arranged.

The helper has no HTTP in it — it takes a connection and a user dict and writes
a row — so it belongs beside `accounting.py` and `costing.py`, not among the
handlers. `routers/audit.py` still re-exports the names it needs for the verify
endpoint, and `from routers.audit import log_action` still works, so nothing
outside this file had to change for correctness; the 39 imports were rewritten
because the point of the move is what the graph says.
"""
import hashlib
import json
import sqlite3

from utils import _now

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
