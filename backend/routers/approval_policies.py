from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from permissions import require_auth, require_admin
from routers.audit import log_action
from utils import _now
import approval_engine as engine
import sqlite3, json

router = APIRouter()


def _validate_target(module: str, action: str) -> None:
    """Reject policies aimed at a module/action the engine cannot enforce, so the
    builder can never persist a dead policy that would silently do nothing."""
    if not engine.supported_module(module):
        raise HTTPException(400, f"Unsupported approval module: {module!r}")
    if not engine.supported_action(module, action):
        allowed = ", ".join(engine.MODULE_REGISTRY[module]["actions"].keys())
        raise HTTPException(
            400, f"Module {module!r} does not support the action {action!r} "
                 f"(allowed: {allowed})")

# ── Pydantic models ───────────────────────────────────────────────────────────

class ConditionItem(BaseModel):
    field: str
    op:    str
    value: str

class StepItem(BaseModel):
    step: int
    role: str

class PolicyBody(BaseModel):
    name:            str
    description:     Optional[str] = None
    module:          str
    trigger_action:  str
    condition_logic: str = "AND"
    conditions:      List[ConditionItem] = []
    approval_type:   str = "single"
    approver_roles:  List[str] = []
    steps:           List[StepItem] = []
    priority:        int = 0
    is_active:       bool = True

# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/")
def list_policies(
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    rows = db.execute(
        """SELECT p.*, u.full_name AS creator_name
           FROM approval_policies p
           LEFT JOIN users u ON p.created_by = u.id
           ORDER BY p.priority DESC, p.id ASC"""
    ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["conditions"]     = json.loads(d.get("conditions")     or "[]")
        d["approver_roles"] = json.loads(d.get("approver_roles") or "[]")
        d["steps"]          = json.loads(d.get("steps")          or "[]")
        result.append(d)
    return result


@router.post("/")
def create_policy(
    data: PolicyBody,
    user=Depends(require_admin),
    db:   sqlite3.Connection = Depends(get_db),
):
    _validate_target(data.module, data.trigger_action)
    now = _now()
    db.execute(
        """INSERT INTO approval_policies
               (name, description, module, trigger_action, condition_logic,
                conditions, approval_type, approver_roles, steps,
                priority, is_active, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            data.name, data.description, data.module, data.trigger_action,
            data.condition_logic,
            json.dumps([c.dict() for c in data.conditions]),
            data.approval_type,
            json.dumps(data.approver_roles),
            json.dumps([s.dict() for s in data.steps]),
            data.priority,
            1 if data.is_active else 0,
            user["id"], now, now,
        ),
    )
    log_action(db, user, "create", "approval_policy", db.execute(
        "SELECT MAX(id) m FROM approval_policies").fetchone()["m"], data.name,
        {"module": data.module, "trigger": data.trigger_action})
    db.commit()
    return {"ok": True}


@router.put("/{policy_id}")
def update_policy(
    policy_id: int,
    data:       PolicyBody,
    user=Depends(require_admin),
    db:   sqlite3.Connection = Depends(get_db),
):
    existing = db.execute("SELECT id FROM approval_policies WHERE id=?", (policy_id,)).fetchone()
    if not existing:
        raise HTTPException(404, "Policy not found")
    _validate_target(data.module, data.trigger_action)
    db.execute(
        """UPDATE approval_policies SET
               name=?, description=?, module=?, trigger_action=?, condition_logic=?,
               conditions=?, approval_type=?, approver_roles=?, steps=?,
               priority=?, is_active=?, updated_at=?
           WHERE id=?""",
        (
            data.name, data.description, data.module, data.trigger_action,
            data.condition_logic,
            json.dumps([c.dict() for c in data.conditions]),
            data.approval_type,
            json.dumps(data.approver_roles),
            json.dumps([s.dict() for s in data.steps]),
            data.priority,
            1 if data.is_active else 0,
            _now(), policy_id,
        ),
    )
    log_action(db, user, "update", "approval_policy", policy_id, data.name)
    db.commit()
    return {"ok": True}


@router.patch("/{policy_id}/toggle")
def toggle_policy(
    policy_id: int,
    user=Depends(require_admin),
    db:   sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT is_active FROM approval_policies WHERE id=?", (policy_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Policy not found")
    new_val = 0 if row["is_active"] else 1
    db.execute(
        "UPDATE approval_policies SET is_active=?, updated_at=? WHERE id=?",
        (new_val, _now(), policy_id),
    )
    log_action(db, user, "enable" if new_val else "disable",
               "approval_policy", policy_id)
    db.commit()
    return {"ok": True, "is_active": bool(new_val)}


@router.delete("/{policy_id}")
def delete_policy(
    policy_id: int,
    user=Depends(require_admin),
    db:   sqlite3.Connection = Depends(get_db),
):
    row = db.execute("SELECT name FROM approval_policies WHERE id=?", (policy_id,)).fetchone()
    db.execute("DELETE FROM approval_policies WHERE id=?", (policy_id,))
    log_action(db, user, "delete", "approval_policy", policy_id,
               row["name"] if row else "")
    db.commit()
    return {"ok": True}


@router.get("/meta/modules")
def get_modules(user=Depends(require_auth)):
    """Module/field/action metadata for the policy builder UI, derived from the
    engine's MODULE_REGISTRY so the builder only ever offers targets the engine
    can actually enforce."""
    return engine.policy_metadata()
