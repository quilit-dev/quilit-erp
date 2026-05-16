from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from database import get_db
from auth_utils import (
    verify_password, create_token, hash_password,
    COOKIE_NAME, COOKIE_SECURE, TOKEN_EXPIRE_HOURS,
)
from permissions import require_auth
from utils import _now
import sqlite3
from datetime import datetime, timedelta

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str

class ForceChangePasswordRequest(BaseModel):
    new_password: str

# ── Rate limiting constants ───────────────────────────────────────────────────
_MAX_ATTEMPTS  = 5
_WINDOW_MINUTES = 15


def _check_rate_limit(db: sqlite3.Connection, ip: str):
    """Raise 429 if this IP has too many recent failed login attempts."""
    cutoff = (datetime.utcnow() - timedelta(minutes=_WINDOW_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
    # Clean stale records older than the window
    db.execute("DELETE FROM login_attempts WHERE attempted_at < ?", (cutoff,))
    count = db.execute(
        "SELECT COUNT(*) FROM login_attempts WHERE ip=? AND attempted_at >= ?", (ip, cutoff)
    ).fetchone()[0]
    if count >= _MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed attempts. Try again in {_WINDOW_MINUTES} minutes."
        )


def _record_attempt(db: sqlite3.Connection, ip: str):
    db.execute("INSERT INTO login_attempts (ip, attempted_at) VALUES (?,?)", (ip, _now()))
    db.commit()


def _clear_attempts(db: sqlite3.Connection, ip: str):
    db.execute("DELETE FROM login_attempts WHERE ip=?", (ip,))
    db.commit()


@router.post("/login")
def login(data: LoginRequest, request: Request, response: Response, db: sqlite3.Connection = Depends(get_db)):
    ip = request.client.host if request.client else "unknown"

    _check_rate_limit(db, ip)

    row = db.execute(
        "SELECT * FROM users WHERE (username=? OR email=?) AND deleted_at IS NULL",
        (data.username, data.username)
    ).fetchone()

    if not row or not verify_password(data.password, row["password_hash"]):
        _record_attempt(db, ip)
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="Account is disabled. Contact your administrator.")

    _clear_attempts(db, ip)

    token, jti = create_token(
        row["id"], row["username"], row["role"] or "user",
        row["role_id"], bool(row["is_superadmin"])
    )

    # Revoke any existing sessions for this user so only one active session exists
    db.execute("UPDATE user_sessions SET revoked=1 WHERE user_id=? AND revoked=0", (row["id"],))

    # Record session
    expires_at = (datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
    ua = request.headers.get("user-agent", "")[:200]
    now = _now()
    db.execute(
        "INSERT INTO user_sessions (user_id, jti, ip_address, user_agent, created_at, last_active, expires_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (row["id"], jti, ip, ua, now, now, expires_at)
    )
    db.execute("UPDATE users SET last_login=? WHERE id=?", (now, row["id"]))
    db.commit()

    # Fetch role name
    role_name = None
    if row["role_id"]:
        r = db.execute("SELECT name FROM roles WHERE id=?", (row["role_id"],)).fetchone()
        role_name = r["name"] if r else None

    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        max_age=TOKEN_EXPIRE_HOURS * 3600,
        path="/",
    )

    return {
        "username":             row["username"],
        "full_name":            row["full_name"],
        "role":                 row["role"],
        "role_name":            role_name,
        "role_id":              row["role_id"],
        "is_superadmin":        bool(row["is_superadmin"]),
        "must_change_password": bool(row["must_change_password"]),
    }


@router.post("/logout")
def logout(response: Response, user=Depends(require_auth), db: sqlite3.Connection = Depends(get_db)):
    jti = user.get("jti")
    if jti:
        db.execute("UPDATE user_sessions SET revoked=1 WHERE jti=?", (jti,))
        db.commit()
    response.delete_cookie(key=COOKIE_NAME, path="/")
    return {"message": "Logged out."}


@router.get("/me")
def me(user=Depends(require_auth), db: sqlite3.Connection = Depends(get_db)):
    row = db.execute(
        "SELECT id, username, full_name, email, role, role_id, is_superadmin, last_login FROM users WHERE id=?",
        (user["id"],)
    ).fetchone()
    if not row:
        raise HTTPException(404, "User not found")

    role_name = None
    permissions = {}
    if row["role_id"]:
        r = db.execute("SELECT name FROM roles WHERE id=?", (row["role_id"],)).fetchone()
        role_name = r["name"] if r else None
        perms = db.execute(
            "SELECT module, can_view, can_create, can_edit, can_delete, can_approve "
            "FROM role_permissions WHERE role_id=?",
            (row["role_id"],)
        ).fetchall()
        permissions = {
            p["module"]: {
                "view":    bool(p["can_view"]),
                "create":  bool(p["can_create"]),
                "edit":    bool(p["can_edit"]),
                "delete":  bool(p["can_delete"]),
                "approve": bool(p["can_approve"]),
            }
            for p in perms
        }

    return {
        "id":           row["id"],
        "username":     row["username"],
        "full_name":    row["full_name"],
        "email":        row["email"],
        "role":         row["role"],
        "role_id":      row["role_id"],
        "role_name":    role_name,
        "is_superadmin": bool(row["is_superadmin"]),
        "last_login":   row["last_login"],
        "permissions":  permissions,
    }


@router.post("/change-password")
def change_password(
    data: ChangePasswordRequest,
    request: Request,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    ip = request.client.host if request.client else "unknown"
    _check_rate_limit(db, ip)
    row = db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    if not verify_password(data.old_password, row["password_hash"]):
        raise HTTPException(status_code=400, detail="Incorrect current password.")
    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
    db.execute(
        "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?",
        (hash_password(data.new_password), user["id"])
    )
    db.commit()
    return {"message": "Password changed successfully."}


@router.post("/force-change-password")
def force_change_password(
    data: ForceChangePasswordRequest,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """Used when must_change_password=1. No old password required."""
    row = db.execute("SELECT must_change_password FROM users WHERE id=?", (user["id"],)).fetchone()
    if not row or not row["must_change_password"]:
        raise HTTPException(status_code=403, detail="Password change not required.")
    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    db.execute(
        "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?",
        (hash_password(data.new_password), user["id"])
    )
    db.commit()
    return {"message": "Password updated. Please log in again."}
