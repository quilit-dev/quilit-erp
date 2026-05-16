from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from database import get_db
from permissions import require_auth, require_admin
from utils import _now
import sqlite3, json

router = APIRouter()

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
    db.commit()
    return {"ok": True, "is_active": bool(new_val)}


@router.delete("/{policy_id}")
def delete_policy(
    policy_id: int,
    user=Depends(require_admin),
    db:   sqlite3.Connection = Depends(get_db),
):
    db.execute("DELETE FROM approval_policies WHERE id=?", (policy_id,))
    db.commit()
    return {"ok": True}


@router.get("/meta/modules")
def get_modules(user=Depends(require_auth)):
    """Return module/field/action metadata for the policy builder UI."""
    return {
        "modules": ["expense", "invoice", "purchase", "project"],
        "module_actions": {
            "expense":  ["create"],
            "invoice":  ["create", "void"],
            "purchase": ["create"],
            "project":  ["create", "cancel"],
        },
        "module_fields": {
            "expense":  [
                {"key": "amount",   "label": "Amount",   "type": "number"},
                {"key": "category", "label": "Category", "type": "text"},
                {"key": "status",   "label": "Status",   "type": "text"},
            ],
            "invoice":  [
                {"key": "amount",   "label": "Amount",   "type": "number"},
                {"key": "status",   "label": "Status",   "type": "text"},
            ],
            "purchase": [
                {"key": "total_cost", "label": "Total Cost",  "type": "number"},
                {"key": "quantity",   "label": "Quantity",    "type": "number"},
                {"key": "status",     "label": "Status",      "type": "text"},
            ],
            "project":  [
                {"key": "budget", "label": "Budget", "type": "number"},
                {"key": "status", "label": "Status", "type": "text"},
            ],
        },
        "operators": {
            "number": [">", "<", ">=", "<=", "==", "!="],
            "text":   ["==", "!=", "contains"],
        },
    }
