"""
User management — admin only.
Provides CRUD for users, password reset, and session monitoring.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import get_db
from auth_utils import hash_password
from permissions import require_admin, require_auth
from routers.audit import log_action
from utils import _now
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

    cur = db.execute(
        "INSERT INTO users (username, password_hash, full_name, email, role, role_id, "
        "is_active, is_superadmin, created_at) VALUES (?,?,?,?,?,?,1,?,datetime('now'))",
        (data.username, hash_password(data.password), data.full_name, data.email,
         role_name, data.role_id, 1 if data.is_superadmin else 0)
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
    # Prevent removing superadmin from the last superadmin
    if data.is_superadmin is False and row["is_superadmin"]:
        count = db.execute(
            "SELECT COUNT(*) FROM users WHERE is_superadmin=1 AND deleted_at IS NULL AND id!=?", (user_id,)
        ).fetchone()[0]
        if count == 0:
            raise HTTPException(400, "Cannot remove superadmin from the last administrator.")

    if data.email and data.email != row["email"]:
        if db.execute("SELECT id FROM users WHERE email=? AND id!=? AND deleted_at IS NULL", (data.email, user_id)).fetchone():
            raise HTTPException(400, f"Email '{data.email}' is already in use.")
    if data.role_id is not None:
        rrow = db.execute("SELECT name FROM roles WHERE id=?", (data.role_id,)).fetchone()
        if not rrow:
            raise HTTPException(400, "Role not found.")

    fields, params = [], []
    for field, col in [("full_name","full_name"), ("email","email"), ("role_id","role_id")]:
        val = getattr(data, field)
        if val is not None:
            fields.append(f"{col}=?"); params.append(val)
    # Keep the legacy `role` text column in sync with the assigned RBAC role
    if data.role_id is not None:
        fields.append("role=?"); params.append(rrow["name"])
    if data.is_active is not None:
        fields.append("is_active=?"); params.append(1 if data.is_active else 0)
    if data.is_superadmin is not None:
        fields.append("is_superadmin=?"); params.append(1 if data.is_superadmin else 0)

    if fields:
        params.append(user_id)
        db.execute(f"UPDATE users SET {', '.join(fields)} WHERE id=?", params)
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
    row = db.execute("SELECT username FROM users WHERE id=? AND deleted_at IS NULL", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
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
