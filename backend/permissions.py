"""
Permission middleware for RBAC.
Separated from auth_utils.py to avoid circular imports with database.py.
"""
import sqlite3
from datetime import datetime, timedelta
from fastapi import Depends, HTTPException
from auth_utils import get_current_user
from database import get_db

_SESSION_TIMEOUT = timedelta(minutes=30)

MODULES = [
    'dashboard', 'clients', 'projects', 'quotations', 'invoices',
    'inventory', 'purchases', 'suppliers', 'finance', 'expenses', 'accounting', 'reports', 'crm', 'planning',
    'hr', 'hr_contracts', 'recruitment', 'hr_activities',
    'pos', 'cash',
    'manufacturing', 'assets',
    # Field service — maintenance, installation and repair jobs against a
    # customer's own equipment. Its own module because a business that only
    # sells goods should not see it, and a business that only services should
    # not be charged for manufacturing.
    'service',
    # Client communications — emailing / WhatsApp-ing invoices and quotations,
    # plus the sent-log. Its own module so it can be licensed and priced
    # separately, and so a role can be allowed to view what was sent without
    # being allowed to send.
    'communications',
    # Internal comms — uses require_perm("announcements") in its router and
    # appears in the Roles UI; declaring it here keeps the RBAC catalog
    # honest (and matches what role_permissions actually stores).
    'announcements',
    # Multi-warehouse — module-level RBAC (can the user reach the Warehouses
    # admin page at all?). Per-warehouse row-level access is enforced
    # separately via user_warehouse_access (see warehouse_access.py).
    'warehouses',
]
ADMIN_MODULES = ['settings', 'users', 'roles', 'audit']
ALL_MODULES   = MODULES + ADMIN_MODULES
ACTIONS       = ['view', 'create', 'edit', 'delete', 'approve']


def _resolve_user(user: dict, db: sqlite3.Connection) -> dict:
    """Re-validate user from DB: checks is_active, session revocation, and refreshes role."""
    row = db.execute(
        "SELECT is_active, is_superadmin, role_id, role, branch_id FROM users WHERE id=? AND deleted_at IS NULL",
        (int(user["sub"]),)
    ).fetchone()
    if not row or not row["is_active"]:
        raise HTTPException(status_code=401, detail="Account is disabled. Contact your administrator.")

    # Resolve the canonical RBAC role name via role_id. The legacy `role` text
    # column is unreliable, so `role_name` is the single source of truth used
    # for approval routing and any role-based logic.
    role_name = None
    role_is_admin = False
    if row["role_id"]:
        rr = db.execute("SELECT name, is_admin FROM roles WHERE id=?", (row["role_id"],)).fetchone()
        if rr:
            role_name = rr["name"]
            role_is_admin = bool(rr["is_admin"])

    jti = user.get("jti")
    if jti:
        session = db.execute(
            "SELECT id, revoked, last_active FROM user_sessions WHERE jti=?", (jti,)
        ).fetchone()
        if not session or session["revoked"]:
            raise HTTPException(status_code=401, detail="Session expired. Please log in again.")

        try:
            last_active = datetime.strptime(session["last_active"], "%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            last_active = datetime.utcnow()

        if datetime.utcnow() - last_active > _SESSION_TIMEOUT:
            db.execute("UPDATE user_sessions SET revoked=1 WHERE id=?", (session["id"],))
            db.commit()
            raise HTTPException(status_code=401, detail="Session expired due to inactivity. Please log in again.")

        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        db.execute("UPDATE user_sessions SET last_active=? WHERE id=?", (now, session["id"]))
        db.commit()

    is_superadmin = bool(row["is_superadmin"])
    return {
        **user,
        "id":           int(user["sub"]),
        "is_superadmin": is_superadmin,
        # `is_admin` = the role is flagged as an admin-tier role (e.g. "Business
        # Owner"). `admin_access` = the caller can reach administrative surfaces
        # (users/roles/settings/audit/backups) — either a vendor superadmin or
        # an admin-tier role. Module installs stay superadmin-only (see
        # require_superadmin), so admin_access deliberately does NOT unlock them.
        "is_admin":      role_is_admin,
        "admin_access":  is_superadmin or role_is_admin,
        "role_id":       row["role_id"],
        "role":          role_name or row["role"],
        "role_name":     role_name,
        # Home branch for visibility scoping (branch_access). Global users
        # (superadmin / admin-tier) ignore it; scoped users are pinned to it.
        "branch_id":     row["branch_id"],
    }


def check_perm(user: dict, db: sqlite3.Connection, module: str, action: str = "view") -> None:
    """Imperative permission check for handlers whose target module is only
    known at runtime (e.g. a generic endpoint keyed by a path parameter, like
    the attachments router). `user` must already be resolved via `_resolve_user`
    (i.e. obtained through require_auth / require_perm). Superadmin bypasses RBAC;
    otherwise raises 403 exactly like the require_perm dependency."""
    # Module paywall (defence in depth): a module the customer didn't purchase
    # is unreachable via its API too, not just hidden from the sidebar — and
    # this runs BEFORE the superadmin bypass, so the vendor build/instance is
    # the source of truth even for the owner. No-op on unrestricted builds.
    import vendor_config
    if not vendor_config.module_allowed(module):
        raise HTTPException(
            status_code=403,
            detail=f"The '{module}' module is not included in this plan.",
        )
    if user.get("is_superadmin"):
        return
    role_id = user.get("role_id")
    if not role_id:
        raise HTTPException(
            status_code=403,
            detail="Your account has no role assigned. Contact your administrator."
        )
    perm = db.execute(
        "SELECT * FROM role_permissions WHERE role_id=? AND module=?",
        (role_id, module)
    ).fetchone()
    if not perm or not perm[f"can_{action}"]:
        raise HTTPException(
            status_code=403,
            detail=f"You don't have '{action}' access to '{module}'."
        )


def require_perm(module: str, action: str = "view"):
    """
    Dependency factory. Usage:
        user = Depends(require_perm("clients", "view"))
    Superadmin bypasses all permission checks.
    """
    def dep(
        user: dict = Depends(get_current_user),
        db:   sqlite3.Connection = Depends(get_db),
    ) -> dict:
        resolved = _resolve_user(user, db)
        check_perm(resolved, db, module, action)
        return resolved

    return dep


def require_any_perm(*modules: str, action: str = "view"):
    """Dependency factory: allow the request if the user can `action` ANY of
    `modules`.

    For read-only data that several modules legitimately need. The promotion
    preview is the case that prompted it: the register, the invoice form and the
    quotation form all price lines against live promotions, and gating that feed
    on `pos` alone would mean an invoicing clerk with no till access could not
    see the discount their own document is about to apply.
    """
    def dep(
        user: dict = Depends(get_current_user),
        db:   sqlite3.Connection = Depends(get_db),
    ) -> dict:
        resolved = _resolve_user(user, db)
        last = None
        for m in modules:
            try:
                check_perm(resolved, db, m, action)
                return resolved
            except HTTPException as e:
                last = e
        # Report the failure for the FIRST module asked for, so the message
        # names something the caller recognises rather than the last one tried.
        raise last or HTTPException(status_code=403, detail="Not permitted.")

    return dep


def require_admin(
    user: dict = Depends(get_current_user),
    db:   sqlite3.Connection = Depends(get_db),
) -> dict:
    """
    Require administrative access — a vendor superadmin OR an admin-tier role
    (e.g. "Business Owner"). Used for user/role management, system settings,
    audit and backups. NOTE: this does NOT grant the module-marketplace
    surfaces (Module Requests + enabled_modules) — those use require_superadmin.
    """
    resolved = _resolve_user(user, db)
    if not resolved["admin_access"]:
        raise HTTPException(status_code=403, detail="Administrator access required.")
    return resolved


def require_superadmin(
    user: dict = Depends(get_current_user),
    db:   sqlite3.Connection = Depends(get_db),
) -> dict:
    """
    Require a true vendor superadmin. Reserved for surfaces the customer must
    never reach even with admin-tier access: the module-marketplace inbox and
    changing which modules are installed.
    """
    resolved = _resolve_user(user, db)
    if not resolved["is_superadmin"]:
        raise HTTPException(status_code=403, detail="Superadmin access required.")
    return resolved


def require_auth(
    user: dict = Depends(get_current_user),
    db:   sqlite3.Connection = Depends(get_db),
) -> dict:
    """Require valid, active login (no module-level permission check)."""
    return _resolve_user(user, db)
