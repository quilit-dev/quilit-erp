"""
Auth utilities — PBKDF2-SHA256 password hashing, JWT with JTI for session tracking.
No external DLL dependencies beyond PyJWT.
"""
import hashlib, hmac, os, base64, uuid, secrets
import jwt
from datetime import datetime, timedelta
from typing import Optional
from fastapi import Cookie, HTTPException


def _load_or_create_secret() -> str:
    """
    Resolve the JWT signing key.

    Priority:
      1. SECRET_KEY environment variable (preferred for server deployments).
      2. A `.secret_key` file persisted next to the database — generated once
         on first run so sessions survive restarts (needed for the packaged
         desktop build, which has no env vars).
      3. An ephemeral random key as a last resort (still secure; only downside
         is that existing sessions are invalidated on restart).
    """
    env = os.environ.get("SECRET_KEY", "").strip()
    if env:
        return env

    db_path  = os.environ.get("DB_PATH", "erp.db")
    base_dir = os.path.dirname(os.path.abspath(db_path)) or "."
    key_path = os.path.join(base_dir, ".secret_key")
    try:
        if os.path.exists(key_path):
            with open(key_path, "r", encoding="utf-8") as f:
                existing = f.read().strip()
            if existing:
                return existing
        key = secrets.token_hex(32)   # 64 hex chars = 32 bytes
        with open(key_path, "w", encoding="utf-8") as f:
            f.write(key)
        try:
            os.chmod(key_path, 0o600)
        except Exception:
            pass
        return key
    except Exception:
        return secrets.token_hex(32)


SECRET_KEY = _load_or_create_secret()

ALGORITHM          = "HS256"
TOKEN_EXPIRE_HOURS = int(os.environ.get("TOKEN_EXPIRE_HOURS", "24"))
ITERATIONS         = 260000  # OWASP recommended minimum for PBKDF2-SHA256

COOKIE_NAME   = "session"
# Default to NOT requiring HTTPS, because this product is shipped to SMB
# customers as a self-hosted LAN-only install on plain HTTP. The `Secure`
# flag, when set on a cookie served over HTTP, makes browsers silently
# drop the cookie from anything except `localhost` / `127.0.0.1` — which
# breaks cross-machine login (login appears to succeed, then redirects
# back to /login on the next request).
# Customers who put the ERP behind an HTTPS reverse proxy should flip
# COOKIE_SECURE=true in `backend/.env`.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    key  = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return base64.b64encode(salt + key).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        raw        = base64.b64decode(stored.encode())
        salt, key  = raw[:16], raw[16:]
        check      = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
        return hmac.compare_digest(key, check)
    except Exception:
        return False


def create_token(user_id: int, username: str, role: str,
                 role_id: int = None, is_superadmin: bool = False,
                 schema: str = None) -> tuple[str, str]:
    """Returns (token, jti). jti is a UUID stored in user_sessions for revocation.

    In schema-per-tenant mode the caller passes the tenant's ``schema``; it is
    embedded as a signed claim so every later request from this token is routed
    to that tenant (and only that tenant). Omitted in single-tenant mode."""
    jti = str(uuid.uuid4())
    payload = {
        "sub":          str(user_id),
        "username":     username,
        "role":         role,
        "role_id":      role_id,
        "is_superadmin": is_superadmin,
        "jti":          jti,
        "exp":          datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    if schema:
        payload["schema"] = schema
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM), jti


# ── Platform-operator (SaaS vendor) auth ─────────────────────────────────────
# A SEPARATE identity from tenant users: platform admins live in
# public.platform_admins and manage the tenant catalog. Their token carries
# scope="platform" and rides a DIFFERENT cookie, so a tenant session can never be
# mistaken for an operator session (and vice-versa).
PLATFORM_COOKIE_NAME = "platform_session"


def create_platform_token(admin_id: int, username: str) -> str:
    payload = {
        "sub":      str(admin_id),
        "username": username,
        "scope":    "platform",
        "exp":      datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token.")


def get_current_user(session: Optional[str] = Cookie(None, alias=COOKIE_NAME)) -> dict:
    """Extract and decode JWT from the HttpOnly session cookie."""
    if not session:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return decode_token(session)
