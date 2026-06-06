"""
User management — admin only.
Provides CRUD for users, password reset, and session monitoring.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from auth_utils import hash_password
from permissions import require_admin
from routers.audit import log_action
import sqlite3

router = APIRouter()


class UserCreate(BaseModel):
    username:     str
    password:     str
    full_name:    Optional[str] = None
    email:        Optional[str] = None
    role_id:      Optional[int] = None
    is_superadmin: bool = False


class UserUpdate(BaseModel):
    username:     Optional[str] = None
    full_name:    Optional[str] = None
    email:        Optional[str] = None
    role_id:      Optional[int] = None
    is_active:    Optional[bool] = None
    is_superadmin: Optional[bool] = None


class ResetPasswordRequest(BaseModel):
    new_password: str


def _user_row(row, db) -> dict:
    d = dict(row)
    d.pop("password_hash", None)
    if d.get("role_id"):
        r = db.execute("SELECT name, color FROM roles WHERE id=?", (d["role_id"],)).fetchone()
        d["role_name"]  = r["name"]  if r else None
        d["role_color"] = r["color"] if r else None
    else:
        d["role_name"]  = None
        d["role_color"] = None
    return d


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("/")
def list_users(
    search: Optional[str] = None,
    user=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    q = "SELECT * FROM users WHERE deleted_at IS NULL"
    params = []
    if search:
        q += " AND (username LIKE ? OR full_name LIKE ? OR email LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s, s])
    q += " ORDER BY created_at DESC"
    rows = db.execute(q, params).fetchall()
    return [_user_row(r, db) for r in rows]


# ── Active sessions ───────────────────────────────────────────────────────────
@router.get("/sessions")
def list_sessions(
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute("""
        SELECT s.*, u.username, u.full_name
        FROM user_sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.revoked = 0 AND s.expires_at > datetime('now')
        ORDER BY s.last_active DESC
    """).fetchall()
    return [dict(r) for r in rows]


# ── Online users ────────────────────────────────────────────────────────────
# A user counts as "online" when they hold a live (non-revoked, non-expired)
# session whose `last_active` heartbeat — refreshed on every authenticated
# request by permissions._resolve_user — falls within ONLINE_WINDOW_MINUTES.
# That window is deliberately tighter than the 30-minute idle session timeout,
# so the indicator reflects who is *actively* using the ERP right now. Results
# are deduplicated per user (two devices = one online user, session_count = 2).
ONLINE_WINDOW_MINUTES = 5

@router.get("/online")
def list_online_users(
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    # Active-window cutoff computed in Python (UTC, matching SQLite's
    # datetime('now')) so it's a portable plain-string comparison on both engines.
    from datetime import datetime, timedelta
    cutoff = (datetime.utcnow() - timedelta(minutes=ONLINE_WINDOW_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
    rows = db.execute(
        """
        SELECT u.id, u.username, u.full_name, u.role,
               MAX(s.last_active) AS last_active,
               COUNT(*)           AS session_count,
               MAX(s.ip_address)  AS ip_address
        FROM user_sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.revoked = 0
          AND s.expires_at > datetime('now')
          AND s.last_active >= ?
          AND u.deleted_at IS NULL
        GROUP BY u.id
        ORDER BY last_active DESC
        """,
        (cutoff,),
    ).fetchall()
    return {
        "window_minutes": ONLINE_WINDOW_MINUTES,
        "count":          len(rows),
        "users":          [dict(r) for r in rows],
    }


# ── Revoke a single session ───────────────────────────────────────────────────
@router.delete("/sessions/{session_id}")
def revoke_session(
    session_id: int,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute(
        "SELECT s.jti, u.username FROM user_sessions s JOIN users u ON s.user_id=u.id WHERE s.id=?",
        (session_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Session not found.")
    db.execute("UPDATE user_sessions SET revoked=1 WHERE id=?", (session_id,))
    log_action(db, caller, "revoke_session", "users", session_id, row["username"])
    db.commit()
    return {"message": "Session revoked."}


# ── Single user ───────────────────────────────────────────────────────────────
@router.get("/{user_id}")
def get_user(
    user_id: int,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM users WHERE id=? AND deleted_at IS NULL", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    return _user_row(row, db)


# ── Create ────────────────────────────────────────────────────────────────────
@router.post("/")
def create_user(
    data: UserCreate,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    if len(data.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters.")
    if db.execute("SELECT id FROM users WHERE username=? AND deleted_at IS NULL", (data.username,)).fetchone():
        raise HTTPException(400, f"Username '{data.username}' is already taken.")
    if data.email and db.execute("SELECT id FROM users WHERE email=? AND deleted_at IS NULL", (data.email,)).fetchone():
        raise HTTPException(400, f"Email '{data.email}' is already in use.")
    role_name = "user"
    if data.role_id:
        rrow = db.execute("SELECT name FROM roles WHERE id=?", (data.role_id,)).fetchone()
        if not rrow:
            raise HTTPException(400, "Role not found.")
        role_name = rrow["name"]

    # Only a true superadmin may mint another superadmin. An admin-tier caller
    # (e.g. Business Owner) can manage staff but can never escalate anyone to
    # superadmin — that would unlock the module marketplace.
    make_super = 1 if (data.is_superadmin and caller.get("is_superadmin")) else 0
    cur = db.execute(
        "INSERT INTO users (username, password_hash, full_name, email, role, role_id, "
        "is_active, is_superadmin, created_at) VALUES (?,?,?,?,?,?,1,?,datetime('now'))",
        (data.username, hash_password(data.password), data.full_name, data.email,
         role_name, data.role_id, make_super)
    )
    log_action(db, caller, "create", "user", cur.lastrowid, data.username)
    db.commit()
    return {"id": cur.lastrowid, "message": "User created."}


# ── Update ────────────────────────────────────────────────────────────────────
@router.put("/{user_id}")
def update_user(
    user_id: int,
    data: UserUpdate,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM users WHERE id=? AND deleted_at IS NULL", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    # Escalation guard: an admin-tier caller (non-superadmin) may not touch a
    # superadmin account, nor grant/revoke superadmin on anyone.
    caller_is_super = bool(caller.get("is_superadmin"))
    if not caller_is_super and row["is_superadmin"]:
        raise HTTPException(403, "Only a superadmin can modify a superadmin account.")
    # Only a superadmin may change the superadmin flag; ignore it otherwise.
    effective_super = data.is_superadmin if caller_is_super else None
    # Prevent removing superadmin from the last superadmin
    if effective_super is False and row["is_superadmin"]:
        count = db.execute(
            "SELECT COUNT(*) FROM users WHERE is_superadmin=1 AND deleted_at IS NULL AND id!=?", (user_id,)
        ).fetchone()[0]
        if count == 0:
            raise HTTPException(400, "Cannot remove superadmin from the last administrator.")

    new_username = None
    if data.username is not None:
        new_username = data.username.strip()
        if not new_username:
            raise HTTPException(400, "Username cannot be empty.")
        if new_username != row["username"]:
            if db.execute("SELECT id FROM users WHERE username=? AND id!=? AND deleted_at IS NULL", (new_username, user_id)).fetchone():
                raise HTTPException(400, f"Username '{new_username}' is already taken.")
        else:
            new_username = None

    if data.email and data.email != row["email"]:
        if db.execute("SELECT id FROM users WHERE email=? AND id!=? AND deleted_at IS NULL", (data.email, user_id)).fetchone():
            raise HTTPException(400, f"Email '{data.email}' is already in use.")
    if data.role_id is not None:
        rrow = db.execute("SELECT name FROM roles WHERE id=?", (data.role_id,)).fetchone()
        if not rrow:
            raise HTTPException(400, "Role not found.")

    # Keep the legacy `role` text column in sync with the assigned RBAC role.
    role_name = rrow["name"] if data.role_id is not None else None
    # Fixed column list; COALESCE keeps the current value for any field left as
    # None, so the statement is a constant literal — no identifiers are built.
    values = [
        new_username,
        data.full_name,
        data.email,
        data.role_id,
        role_name,
        (1 if data.is_active else 0)     if data.is_active     is not None else None,
        (1 if effective_super else 0)    if effective_super    is not None else None,
    ]
    if any(v is not None for v in values):
        db.execute(
            "UPDATE users SET "
            "username=COALESCE(?,username), full_name=COALESCE(?,full_name), "
            "email=COALESCE(?,email), role_id=COALESCE(?,role_id), "
            "role=COALESCE(?,role), is_active=COALESCE(?,is_active), "
            "is_superadmin=COALESCE(?,is_superadmin) WHERE id=?",
            values + [user_id],
        )
        log_action(db, caller, "update", "user", user_id, row["username"])
        db.commit()
    return {"message": "User updated."}


# ── Reset password ────────────────────────────────────────────────────────────
@router.post("/{user_id}/reset-password")
def reset_password(
    user_id: int,
    data: ResetPasswordRequest,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT username, is_superadmin FROM users WHERE id=? AND deleted_at IS NULL", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    # Block an admin-tier caller from resetting a superadmin's password (which
    # would let them log in as the vendor and reach the module marketplace).
    if not caller.get("is_superadmin") and row["is_superadmin"]:
        raise HTTPException(403, "Only a superadmin can reset a superadmin's password.")
    if len(data.new_password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters.")
    db.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(data.new_password), user_id))
    # Revoke all active sessions for this user so they must re-login
    db.execute("UPDATE user_sessions SET revoked=1 WHERE user_id=? AND revoked=0", (user_id,))
    log_action(db, caller, "reset_password", "user", user_id, row["username"])
    db.commit()
    return {"message": "Password reset. All active sessions revoked."}


# ── Toggle active ─────────────────────────────────────────────────────────────
@router.patch("/{user_id}/toggle-active")
def toggle_active(
    user_id: int,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT username, is_active, is_superadmin FROM users WHERE id=? AND deleted_at IS NULL", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    if not caller.get("is_superadmin") and row["is_superadmin"]:
        raise HTTPException(403, "Only a superadmin can enable or disable a superadmin account.")
    if row["is_superadmin"] and row["is_active"]:
        count = db.execute("SELECT COUNT(*) FROM users WHERE is_superadmin=1 AND is_active=1 AND deleted_at IS NULL AND id!=?", (user_id,)).fetchone()[0]
        if count == 0:
            raise HTTPException(400, "Cannot disable the last active administrator.")
    new_active = 0 if row["is_active"] else 1
    db.execute("UPDATE users SET is_active=? WHERE id=?", (new_active, user_id))
    if not new_active:
        db.execute("UPDATE user_sessions SET revoked=1 WHERE user_id=? AND revoked=0", (user_id,))
    log_action(db, caller, "disable" if not new_active else "enable", "user", user_id, row["username"])
    db.commit()
    return {"message": "User " + ("disabled." if not new_active else "enabled."), "is_active": new_active}


# ── Delete (soft) ─────────────────────────────────────────────────────────────
@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT username, is_superadmin FROM users WHERE id=? AND deleted_at IS NULL", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    if not caller.get("is_superadmin") and row["is_superadmin"]:
        raise HTTPException(403, "Only a superadmin can delete a superadmin account.")
    if row["is_superadmin"]:
        count = db.execute("SELECT COUNT(*) FROM users WHERE is_superadmin=1 AND deleted_at IS NULL AND id!=?", (user_id,)).fetchone()[0]
        if count == 0:
            raise HTTPException(400, "Cannot delete the last administrator.")
    if caller["id"] == user_id:
        raise HTTPException(400, "Cannot delete your own account.")
    db.execute("UPDATE users SET deleted_at=datetime('now'), is_active=0 WHERE id=?", (user_id,))
    db.execute("UPDATE user_sessions SET revoked=1 WHERE user_id=?", (user_id,))
    log_action(db, caller, "delete", "user", user_id, row["username"])
    db.commit()
    return {"message": "User deleted."}
