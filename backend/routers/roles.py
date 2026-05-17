"""
Role and permission management — admin only.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict
from database import get_db
from permissions import require_admin, ALL_MODULES, ACTIONS
from routers.audit import log_action
import sqlite3

router = APIRouter()


class RoleCreate(BaseModel):
    name:        str
    description: Optional[str] = None
    color:       Optional[str] = "#6B7280"


class PermissionSet(BaseModel):
    # module → {view, create, edit, delete, approve}
    permissions: Dict[str, Dict[str, bool]]


def _role_with_perms(role_row, db) -> dict:
    d = dict(role_row)
    perms = db.execute(
        "SELECT module, can_view, can_create, can_edit, can_delete, can_approve "
        "FROM role_permissions WHERE role_id=?",
        (d["id"],)
    ).fetchall()
    d["permissions"] = {
        p["module"]: {
            "view":    bool(p["can_view"]),
            "create":  bool(p["can_create"]),
            "edit":    bool(p["can_edit"]),
            "delete":  bool(p["can_delete"]),
            "approve": bool(p["can_approve"]),
        }
        for p in perms
    }
    d["user_count"] = db.execute(
        "SELECT COUNT(*) FROM users WHERE role_id=? AND deleted_at IS NULL", (d["id"],)
    ).fetchone()[0]
    return d


# ── List ──────────────────────────────────────────────────────────────────────
@router.get("/")
def list_roles(
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute("SELECT * FROM roles ORDER BY is_system DESC, name ASC").fetchall()
    return [_role_with_perms(r, db) for r in rows]


# ── Available modules ─────────────────────────────────────────────────────────
@router.get("/modules")
def list_modules(caller=Depends(require_admin)):
    return {"modules": ALL_MODULES, "actions": ACTIONS}


# ── Single ────────────────────────────────────────────────────────────────────
@router.get("/{role_id}")
def get_role(
    role_id: int,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM roles WHERE id=?", (role_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Role not found")
    return _role_with_perms(row, db)


# ── Create ────────────────────────────────────────────────────────────────────
@router.post("/")
def create_role(
    data: RoleCreate,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    if db.execute("SELECT id FROM roles WHERE name=?", (data.name,)).fetchone():
        raise HTTPException(400, f"A role named '{data.name}' already exists.")
    cur = db.execute(
        "INSERT INTO roles (name, description, color, is_system, created_at) VALUES (?,?,?,0,datetime('now'))",
        (data.name, data.description, data.color or "#6B7280")
    )
    log_action(db, caller, "create", "role", cur.lastrowid, data.name)
    db.commit()
    return {"id": cur.lastrowid, "message": "Role created."}


# ── Update role metadata ──────────────────────────────────────────────────────
@router.put("/{role_id}")
def update_role(
    role_id: int,
    data: RoleCreate,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM roles WHERE id=?", (role_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Role not found")
    conflict = db.execute("SELECT id FROM roles WHERE name=? AND id!=?", (data.name, role_id)).fetchone()
    if conflict:
        raise HTTPException(400, f"Another role named '{data.name}' already exists.")
    db.execute(
        "UPDATE roles SET name=?, description=?, color=? WHERE id=?",
        (data.name, data.description, data.color or "#6B7280", role_id)
    )
    log_action(db, caller, "update", "role", role_id, data.name)
    db.commit()
    return {"message": "Role updated."}


# ── Set permissions ───────────────────────────────────────────────────────────
@router.put("/{role_id}/permissions")
def set_permissions(
    role_id: int,
    data: PermissionSet,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT name FROM roles WHERE id=?", (role_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Role not found")

    for module, actions in data.permissions.items():
        if module not in ALL_MODULES:
            continue
        db.execute("""
            INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(role_id, module) DO UPDATE SET
                can_view=excluded.can_view, can_create=excluded.can_create,
                can_edit=excluded.can_edit, can_delete=excluded.can_delete,
                can_approve=excluded.can_approve
        """, (
            role_id, module,
            1 if actions.get("view")    else 0,
            1 if actions.get("create")  else 0,
            1 if actions.get("edit")    else 0,
            1 if actions.get("delete")  else 0,
            1 if actions.get("approve") else 0,
        ))

    log_action(db, caller, "update_permissions", "role", role_id, row["name"])
    db.commit()
    return {"message": "Permissions updated."}


# ── Delete ────────────────────────────────────────────────────────────────────
@router.delete("/{role_id}")
def delete_role(
    role_id: int,
    caller=Depends(require_admin),
    db: sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT * FROM roles WHERE id=?", (role_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Role not found")
    if row["is_system"]:
        raise HTTPException(400, "System roles cannot be deleted.")
    users = db.execute("SELECT COUNT(*) FROM users WHERE role_id=? AND deleted_at IS NULL", (role_id,)).fetchone()[0]
    if users > 0:
        raise HTTPException(400, f"Cannot delete a role assigned to {users} user(s). Reassign them first.")
    pending = db.execute(
        """SELECT COUNT(*) FROM approval_steps s
           JOIN approval_requests r ON s.request_id = r.id
           WHERE s.approver_role=? AND r.status='pending'""",
        (row["name"],),
    ).fetchone()[0]
    if pending > 0:
        raise HTTPException(400, f"Cannot delete — {pending} pending approval(s) require this role. Resolve them first.")
    db.execute("DELETE FROM roles WHERE id=?", (role_id,))
    log_action(db, caller, "delete", "role", role_id, row["name"])
    db.commit()
    return {"message": "Role deleted."}
