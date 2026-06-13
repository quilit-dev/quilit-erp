"""
Approval requests router.

This is a thin HTTP layer — all workflow logic lives in `approval_engine.py`.
The router only: parses input, enforces visibility, delegates to the engine,
and writes an audit-log entry.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from permissions import require_auth
import approval_engine as engine
from routers.audit import log_action
import sqlite3, json

router = APIRouter()


class ActionPayload(BaseModel):
    comment: Optional[str] = None


class CommentPayload(BaseModel):
    comment: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_request(db: sqlite3.Connection, req_id: int):
    row = db.execute("SELECT * FROM approval_requests WHERE id=?", (req_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Approval request not found")
    return row


def _serialize(req, db: sqlite3.Connection, user: dict) -> dict:
    """Turn a request row into the API shape, including per-user action flags."""
    d = dict(req)

    if d.get("entity_snapshot"):
        try:
            d["entity_snapshot"] = json.loads(d["entity_snapshot"])
        except Exception:
            d["entity_snapshot"] = {}

    steps = db.execute(
        """SELECT s.*, u.full_name AS actor_name
           FROM approval_steps s
           LEFT JOIN users u ON s.approver_user_id = u.id
           WHERE s.request_id=? ORDER BY s.step_number, s.id""",
        (d["id"],),
    ).fetchall()
    d["steps_detail"] = [dict(s) for s in steps]
    d["comments"]     = engine.get_comments(db, d["id"])

    # UI never decides permissions on its own — the server states them outright.
    d["can_act"]   = engine.can_act_on(db, req, user)
    d["can_force"] = req["status"] == "pending" and engine.can_force(user)
    d["can_cancel"] = (
        req["status"] == "pending"
        and (req["requested_by"] == user["id"] or user.get("is_superadmin"))
    )
    d["is_mine"]   = req["requested_by"] == user["id"]
    return d


def _act(action_fn, req_id, comment, user, db, audit_verb):
    """Shared wrapper: load request, run an engine action, audit, commit."""
    req = _get_request(db, req_id)
    try:
        result = action_fn(db, req, user, comment)
    except engine.WorkflowError as e:
        raise HTTPException(e.status_code, e.detail)
    log_action(db, user, audit_verb, "approval_request", req_id,
               req["entity_label"] or f"{req['module']} #{req['entity_id']}",
               {"comment": comment} if comment else None)
    db.commit()
    return {"ok": True, "result": result}


# ── List / count ──────────────────────────────────────────────────────────────

@router.get("/count")
def pending_count(
    user=Depends(require_auth),
    db:   sqlite3.Connection = Depends(get_db),
):
    """Number of pending requests awaiting THIS user's action (their inbox)."""
    if user.get("is_superadmin"):
        count = db.execute(
            "SELECT COUNT(*) FROM approval_requests WHERE status='pending'"
        ).fetchone()[0]
    else:
        count = db.execute(
            """SELECT COUNT(*) FROM approval_requests ar
               WHERE ar.status='pending'
                 AND EXISTS (SELECT 1 FROM approval_steps s
                             WHERE s.request_id=ar.id
                               AND s.step_number=ar.current_step
                               AND s.approver_role=?)""",
            (user.get("role_name"),),
        ).fetchone()[0]
    return {"count": count}


@router.get("/")
def list_requests(
    view:   str = "all",          # all | inbox | mine
    status: Optional[str] = None,
    module: Optional[str] = None,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """
    List requests filtered by `view`:
      * all   — everything the user is allowed to see
      * inbox — pending requests awaiting the user's action (current step)
      * mine  — requests the user raised
    `status` and `module` are additional optional filters.
    """
    role     = user.get("role_name")
    uid      = user["id"]
    is_admin = user.get("is_superadmin", False)

    q = [
        """SELECT ar.*,
                  u1.full_name AS requester_name,
                  u2.full_name AS resolver_name
           FROM approval_requests ar
           LEFT JOIN users u1 ON ar.requested_by = u1.id
           LEFT JOIN users u2 ON ar.resolved_by  = u2.id
           WHERE 1=1"""
    ]
    p: list = []

    if view == "mine":
        q.append("AND ar.requested_by = ?")
        p.append(uid)
    elif view == "inbox":
        q.append("AND ar.status = 'pending'")
        if not is_admin:
            q.append("""AND EXISTS (SELECT 1 FROM approval_steps s
                          WHERE s.request_id = ar.id
                            AND s.step_number = ar.current_step
                            AND s.approver_role = ?)""")
            p.append(role)
    else:  # all
        if not is_admin:
            q.append("""AND (ar.requested_by = ?
                          OR EXISTS (SELECT 1 FROM approval_steps s
                                     WHERE s.request_id = ar.id
                                       AND s.approver_role = ?))""")
            p += [uid, role]

    if status:
        q.append("AND ar.status = ?")
        p.append(status)
    if module:
        q.append("AND ar.module = ?")
        p.append(module)

    q.append("ORDER BY ar.requested_at DESC LIMIT 300")
    rows = db.execute(" ".join(q), p).fetchall()
    return [_serialize(r, db, user) for r in rows]


@router.get("/{req_id}")
def get_request(
    req_id: int,
    user=Depends(require_auth),
    db:   sqlite3.Connection = Depends(get_db),
):
    req = _get_request(db, req_id)
    if not engine.can_view(db, req, user):
        raise HTTPException(403, "You do not have access to this approval request")
    return _serialize(req, db, user)


# ── Workflow actions ──────────────────────────────────────────────────────────

@router.post("/{req_id}/approve")
def approve_request(req_id: int, data: ActionPayload,
                    user=Depends(require_auth),
                    db: sqlite3.Connection = Depends(get_db)):
    return _act(engine.approve, req_id, data.comment, user, db, "approve")


@router.post("/{req_id}/reject")
def reject_request(req_id: int, data: ActionPayload,
                   user=Depends(require_auth),
                   db: sqlite3.Connection = Depends(get_db)):
    return _act(engine.reject, req_id, data.comment, user, db, "reject")


@router.post("/{req_id}/force-approve")
def force_approve_request(req_id: int, data: ActionPayload,
                          user=Depends(require_auth),
                          db: sqlite3.Connection = Depends(get_db)):
    return _act(engine.force_approve, req_id, data.comment, user, db, "force_approve")


@router.post("/{req_id}/cancel")
def cancel_request(req_id: int, data: ActionPayload,
                   user=Depends(require_auth),
                   db: sqlite3.Connection = Depends(get_db)):
    return _act(engine.cancel, req_id, data.comment, user, db, "cancel")


# ── Comment thread ────────────────────────────────────────────────────────────

@router.post("/{req_id}/comments")
def add_comment(req_id: int, data: CommentPayload,
                user=Depends(require_auth),
                db: sqlite3.Connection = Depends(get_db)):
    req = _get_request(db, req_id)
    if not engine.can_view(db, req, user):
        raise HTTPException(403, "You do not have access to this approval request")
    try:
        comment = engine.add_comment(db, req_id, user["id"], data.comment)
    except engine.WorkflowError as e:
        raise HTTPException(e.status_code, e.detail)
    log_action(db, user, "comment", "approval_request", req_id,
               req["entity_label"] or f"{req['module']} #{req['entity_id']}")
    db.commit()
    comment["author_name"] = user.get("full_name") or user.get("username")
    return comment
