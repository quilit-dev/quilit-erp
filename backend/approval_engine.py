"""
Approval engine — the single, layered home of all approval-workflow logic.

The module is organised into four independent layers. Each layer only depends
on the ones above it, so they can be reasoned about (and tested) in isolation:

  1. POLICY EVALUATION  — given an action, decide which policy (if any) applies
  2. WORKFLOW EXECUTION — create requests and run the step state machine
  3. NOTIFICATION       — route alerts to the right approvers / requester
  4. RESOLUTION         — apply side-effects to the originating business entity

State machine
-------------
approval_requests.status : pending → approved | rejected | cancelled
approval_steps.status    : waiting → pending → approved | rejected | skipped

Invariants
----------
  * A pending request sits at exactly one `current_step`.
  * Step rows at current_step are 'pending'; later steps 'waiting';
    earlier steps 'approved' (or 'skipped' when force-approved).
  * Once a request leaves 'pending' it is immutable except for comments.
  * Role routing uses roles.name resolved via users.role_id — never the
    legacy users.role text column.
"""
import json
import sqlite3
from utils import _now, notify


class WorkflowError(Exception):
    """Raised by workflow actions; routers convert it to an HTTPException."""
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


# ══════════════════════════════════════════════════════════════════════════════
# 1. POLICY EVALUATION
# ══════════════════════════════════════════════════════════════════════════════

def _eval_condition(cond: dict, entity: dict) -> bool:
    """Evaluate one {field, op, value} condition against an entity snapshot."""
    field = cond.get("field", "")
    op    = cond.get("op", "==")
    value = cond.get("value", "")
    raw   = entity.get(field)
    if raw is None:
        return False
    try:
        if op in (">", "<", ">=", "<="):
            ev, cv = float(raw), float(value)
            return (ev > cv if op == ">" else ev < cv if op == "<"
                    else ev >= cv if op == ">=" else ev <= cv)
        if op == "==":
            return str(raw).strip().lower() == str(value).strip().lower()
        if op == "!=":
            return str(raw).strip().lower() != str(value).strip().lower()
        if op == "contains":
            return str(value).strip().lower() in str(raw).strip().lower()
    except (ValueError, TypeError):
        return False
    return False


def evaluate_policies(db: sqlite3.Connection, *, module: str, action: str,
                      entity_data: dict):
    """
    Return the first matching active policy row for module+action, or None.
    Pure read — performs no writes. Policies are checked by priority DESC.
    """
    policies = db.execute(
        """SELECT * FROM approval_policies
           WHERE module=? AND trigger_action=? AND is_active=1
           ORDER BY priority DESC, id ASC""",
        (module, action),
    ).fetchall()

    for policy in policies:
        conditions = json.loads(policy["conditions"] or "[]")
        if not conditions:
            return policy
        logic   = (policy["condition_logic"] or "AND").upper()
        results = [_eval_condition(c, entity_data) for c in conditions]
        if (logic == "OR" and any(results)) or (logic != "OR" and all(results)):
            return policy
    return None


# ══════════════════════════════════════════════════════════════════════════════
# 2. WORKFLOW EXECUTION
# ══════════════════════════════════════════════════════════════════════════════

def _normalize_steps(policy) -> list:
    """
    Reduce a policy into an ordered list of steps. Each step is a list of
    approver role names — any one of which may act on that step.

      * single     → a single step containing all approver_roles
      * multi_step → one step per ordered StepItem

    Consecutive steps that require the identical set of roles are collapsed,
    which prevents redundant or accidentally circular approval chains
    (e.g. Manager → Manager → Admin becomes Manager → Admin).
    """
    if policy["approval_type"] == "multi_step":
        raw   = sorted(json.loads(policy["steps"] or "[]"),
                       key=lambda s: int(s.get("step", 1)))
        steps = [[(s.get("role") or "").strip()] for s in raw]
    else:
        roles = [(r or "").strip() for r in json.loads(policy["approver_roles"] or "[]")]
        steps = [roles] if roles else []

    # drop blank roles, then drop empty steps
    steps = [[r for r in s if r] for s in steps]
    steps = [s for s in steps if s]

    # collapse consecutive identical steps
    cleaned: list = []
    for s in steps:
        if not cleaned or sorted(cleaned[-1]) != sorted(s):
            cleaned.append(s)
    return cleaned


def create_request(db: sqlite3.Connection, *, policy, module: str, action: str,
                   entity_id: int, entity_label, entity_data: dict,
                   user_id: int):
    """
    Materialise an approval request + its step rows from a matched policy.
    Returns the request id, or None if the policy yields no usable steps.
    A pending request already covering this entity is reused (no duplicates).
    """
    existing = db.execute(
        "SELECT id FROM approval_requests WHERE module=? AND entity_id=? AND status='pending'",
        (module, entity_id),
    ).fetchone()
    if existing:
        return existing["id"]

    steps = _normalize_steps(policy)
    if not steps:
        return None

    now   = _now()
    total = len(steps)
    req_id = db.execute(
        """INSERT INTO approval_requests
               (policy_id, policy_name, module, entity_id, entity_label,
                trigger_action, entity_snapshot, status, approval_type,
                current_step, total_steps, requested_by, requested_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (policy["id"], policy["name"], module, entity_id, entity_label, action,
         json.dumps(entity_data, default=str), "pending", policy["approval_type"],
         1, total, user_id, now),
    ).lastrowid

    for idx, roles in enumerate(steps):
        step_num    = idx + 1
        step_status = "pending" if step_num == 1 else "waiting"
        for role in roles:
            db.execute(
                "INSERT INTO approval_steps (request_id, step_number, approver_role, status) "
                "VALUES (?,?,?,?)",
                (req_id, step_num, role, step_status),
            )

    _notify_step(db, req_id, policy["name"], module, entity_label, 1, steps[0])
    return req_id


def evaluate_and_apply(db: sqlite3.Connection, *, module: str, action: str,
                       entity_data: dict, user_id: int, entity_id: int,
                       entity_label=None) -> bool:
    """
    Convenience entry point for routers: evaluate policies and, if one matches,
    create the approval request. Returns True when approval is required so the
    caller can mark its entity 'Pending Approval'. Call BEFORE db.commit().
    """
    policy = evaluate_policies(db, module=module, action=action, entity_data=entity_data)
    if not policy:
        return False
    req_id = create_request(
        db, policy=policy, module=module, action=action,
        entity_id=entity_id, entity_label=entity_label,
        entity_data=entity_data, user_id=user_id,
    )
    return req_id is not None


# ── Step / permission helpers ─────────────────────────────────────────────────

def _step_roles(db: sqlite3.Connection, req_id: int, step_num: int) -> list:
    rows = db.execute(
        "SELECT approver_role FROM approval_steps WHERE request_id=? AND step_number=?",
        (req_id, step_num),
    ).fetchall()
    return [r["approver_role"] for r in rows]


def can_act_on(db: sqlite3.Connection, req, user: dict) -> bool:
    """True if `user` may approve/reject the request's current step."""
    if req["status"] != "pending":
        return False
    if user.get("is_superadmin"):
        return True
    return user.get("role_name") in _step_roles(db, req["id"], req["current_step"])


def can_force(user: dict) -> bool:
    """Force-approval is limited to superadmins and the built-in Admin role."""
    return bool(user.get("is_superadmin")) or user.get("role_name") == "Admin"


def can_view(db: sqlite3.Connection, req, user: dict) -> bool:
    """A user may view a request if they raised it, can approve any of its
    steps, or are an administrator."""
    if user.get("is_superadmin") or req["requested_by"] == user["id"]:
        return True
    roles = db.execute(
        "SELECT DISTINCT approver_role FROM approval_steps WHERE request_id=?",
        (req["id"],),
    ).fetchall()
    return user.get("role_name") in [r["approver_role"] for r in roles]


def _lock_pending(db: sqlite3.Connection, req_id: int) -> None:
    """Atomically confirm the request is still pending (race-condition guard)."""
    locked = db.execute(
        "UPDATE approval_requests SET current_step=current_step WHERE id=? AND status='pending'",
        (req_id,),
    ).rowcount
    if locked == 0:
        raise WorkflowError(409, "This request was just processed by someone else.")


def _finalize(db: sqlite3.Connection, req, status: str, user: dict, comment) -> None:
    db.execute(
        """UPDATE approval_requests
           SET status=?, resolved_at=?, resolved_by=?, resolution_comment=?
           WHERE id=?""",
        (status, _now(), user["id"], comment, req["id"]),
    )
    try:
        snapshot = json.loads(req["entity_snapshot"] or "{}")
    except (TypeError, ValueError):
        snapshot = {}
    apply_resolution(
        db, req["module"], req["trigger_action"], req["entity_id"], status,
        original_status=snapshot.get("status"),
    )
    _notify_requester(db, req, status, comment)


# ── Workflow actions ──────────────────────────────────────────────────────────

def approve(db: sqlite3.Connection, req, user: dict, comment=None) -> str:
    """Approve the current step. Advances to the next step or finalises."""
    if req["status"] != "pending":
        raise WorkflowError(400, f"Request is already {req['status']}.")
    if not can_act_on(db, req, user):
        roles = _step_roles(db, req["id"], req["current_step"])
        raise WorkflowError(403, f"This step requires the role: {', '.join(roles)}.")

    _lock_pending(db, req["id"])
    now      = _now()
    cur_step = req["current_step"]

    db.execute(
        """UPDATE approval_steps
           SET status='approved', approver_user_id=?, acted_at=?, comment=?
           WHERE request_id=? AND step_number=?""",
        (user["id"], now, comment, req["id"], cur_step),
    )

    next_roles = _step_roles(db, req["id"], cur_step + 1)
    if next_roles:
        db.execute(
            "UPDATE approval_requests SET current_step=? WHERE id=?",
            (cur_step + 1, req["id"]),
        )
        db.execute(
            "UPDATE approval_steps SET status='pending' WHERE request_id=? AND step_number=?",
            (req["id"], cur_step + 1),
        )
        _notify_step(db, req["id"], req["policy_name"], req["module"],
                     req["entity_label"], cur_step + 1, next_roles)
        return "advanced"

    _finalize(db, req, "approved", user, comment)
    return "approved"


def reject(db: sqlite3.Connection, req, user: dict, comment=None) -> str:
    """Reject the request outright at its current step."""
    if req["status"] != "pending":
        raise WorkflowError(400, f"Request is already {req['status']}.")
    if not can_act_on(db, req, user):
        roles = _step_roles(db, req["id"], req["current_step"])
        raise WorkflowError(403, f"This step requires the role: {', '.join(roles)}.")

    _lock_pending(db, req["id"])
    db.execute(
        """UPDATE approval_steps
           SET status='rejected', approver_user_id=?, acted_at=?, comment=?
           WHERE request_id=? AND step_number=?""",
        (user["id"], _now(), comment, req["id"], req["current_step"]),
    )
    _finalize(db, req, "rejected", user, comment)
    return "rejected"


def force_approve(db: sqlite3.Connection, req, user: dict, comment=None) -> str:
    """
    Administrator override: approve the current step and skip every remaining
    step, finalising the request immediately. Use when an approver in the chain
    is unavailable.
    """
    if req["status"] != "pending":
        raise WorkflowError(400, f"Request is already {req['status']}.")
    if not can_force(user):
        raise WorkflowError(403, "Only an administrator can force-approve a request.")

    _lock_pending(db, req["id"])
    now  = _now()
    note = (comment or "").strip() or "Force-approved by administrator."
    cur  = req["current_step"]

    db.execute(
        """UPDATE approval_steps
           SET status='approved', approver_user_id=?, acted_at=?, comment=?
           WHERE request_id=? AND step_number=?""",
        (user["id"], now, note, req["id"], cur),
    )
    db.execute(
        """UPDATE approval_steps
           SET status='skipped', acted_at=?
           WHERE request_id=? AND step_number>? AND status IN ('waiting','pending')""",
        (now, req["id"], cur),
    )
    _finalize(db, req, "approved", user, f"[Force-approved] {note}")
    return "approved"


def cancel(db: sqlite3.Connection, req, user: dict, comment=None) -> str:
    """Withdraw a still-pending request. Requester or administrator only."""
    if req["status"] != "pending":
        raise WorkflowError(400, f"Cannot cancel a request that is already {req['status']}.")
    if req["requested_by"] != user["id"] and not user.get("is_superadmin"):
        raise WorkflowError(403, "Only the requester or an administrator can cancel this request.")

    db.execute(
        """UPDATE approval_requests
           SET status='cancelled', resolved_at=?, resolved_by=?, resolution_comment=?
           WHERE id=?""",
        (_now(), user["id"], comment or "Cancelled by requester.", req["id"]),
    )
    return "cancelled"


# ── Comment thread ────────────────────────────────────────────────────────────

def add_comment(db: sqlite3.Connection, req_id: int, user_id: int, text: str) -> dict:
    """Append a comment to a request's discussion thread."""
    text = (text or "").strip()
    if not text:
        raise WorkflowError(400, "Comment cannot be empty.")
    now = _now()
    cid = db.execute(
        "INSERT INTO approval_comments (request_id, user_id, comment, created_at) "
        "VALUES (?,?,?,?)",
        (req_id, user_id, text, now),
    ).lastrowid
    return {"id": cid, "request_id": req_id, "user_id": user_id,
            "comment": text, "created_at": now}


def get_comments(db: sqlite3.Connection, req_id: int) -> list:
    rows = db.execute(
        """SELECT ac.*, u.full_name AS author_name
           FROM approval_comments ac
           LEFT JOIN users u ON u.id = ac.user_id
           WHERE ac.request_id=?
           ORDER BY ac.created_at ASC, ac.id ASC""",
        (req_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# ══════════════════════════════════════════════════════════════════════════════
# 3. NOTIFICATION
# ══════════════════════════════════════════════════════════════════════════════

def _users_with_role(db: sqlite3.Connection, role_name: str) -> list:
    """
    Resolve approver user ids by RBAC role name via users.role_id → roles.name.
    This is the correct routing path — the legacy users.role text column is
    NOT consulted.
    """
    rows = db.execute(
        """SELECT u.id FROM users u
           JOIN roles r ON r.id = u.role_id
           WHERE r.name = ? AND u.is_active = 1 AND u.deleted_at IS NULL""",
        (role_name,),
    ).fetchall()
    return [r["id"] for r in rows]


def _notify_step(db: sqlite3.Connection, req_id: int, policy_name: str,
                 module: str, entity_label, step_num: int, roles: list) -> None:
    """Notify every active user who can act on a freshly-activated step."""
    label = entity_label or module
    seen: set = set()
    for role in roles:
        for uid in _users_with_role(db, role):
            if uid in seen:
                continue
            seen.add(uid)
            notify(
                db,
                user_id=uid,
                type="approval_request",
                title=f"Approval required: {label}",
                body=f'"{policy_name}" — step {step_num} awaits your review.',
                msg="approval_request", params={"label": label, "policy": policy_name, "step": step_num},
                link="/approvals",
                entity_type="approval_request",
                entity_id=req_id,
            )


def _notify_requester(db: sqlite3.Connection, req, status: str, comment) -> None:
    """Tell the original requester their request was resolved."""
    label = req["entity_label"] or req["module"]
    if status == "approved":
        notify(
            db, user_id=req["requested_by"], type="approval_approved",
            title=f"Approved: {label}",
            body=f'Your request "{req["policy_name"]}" has been approved.',
            msg="approval_approved", params={"label": label, "policy": req["policy_name"]},
            link="/approvals", entity_type="approval_request", entity_id=req["id"],
        )
    elif status == "rejected":
        notify(
            db, user_id=req["requested_by"], type="approval_rejected",
            title=f"Rejected: {label}",
            body=f'Your request "{req["policy_name"]}" was rejected. {comment or ""}'.strip(),
            msg="approval_rejected",
            params={"label": label, "policy": req["policy_name"], "comment": comment or ""},
            link="/approvals", entity_type="approval_request", entity_id=req["id"],
        )


# ══════════════════════════════════════════════════════════════════════════════
# 4. MODULE REGISTRY — the single source of truth for what approvals can govern
# ══════════════════════════════════════════════════════════════════════════════
#
# Bringing a module (or a new action on an existing module) under approval is a
# one-place change: register it here, then wire evaluate_and_apply(...) into the
# matching router action. Everything else is *derived* from this table — the
# policy-builder metadata served to the UI (so the builder can never advertise a
# module the engine doesn't actually enforce) and the post-resolution status
# side-effects applied when a request is approved or rejected.
#
# Each action declares the entity status to write on approval / rejection. The
# RESTORE sentinel means "put the entity back to the status it held when the
# request was raised" (read from the request's entity snapshot) — used by
# create-gates that parked a brand-new record in 'Pending Approval' and simply
# need to release it once approved.
#
# SECURITY: `table` and `status_column` are trusted developer-defined constants.
# The `module` / `action` values arriving on a request are only ever used as
# dict *keys* into this registry — never interpolated into SQL. A resolution
# UPDATE is assembled solely from the registry's own table/column strings, so an
# attacker-controlled module string can never reach raw SQL.

RESTORE = "__restore__"

MODULE_REGISTRY = {
    "expense": {
        "label": "Expense",
        "table": "expenses",
        "status_column": "status",
        "fields": [
            {"key": "amount",         "label": "Amount",         "type": "number"},
            {"key": "category",       "label": "Category",       "type": "text"},
            {"key": "payment_method", "label": "Payment Method", "type": "text"},
            {"key": "status",         "label": "Status",         "type": "text"},
        ],
        "actions": {
            "create": {"approved": "Approved", "rejected": "Rejected"},
        },
    },
    "purchase": {
        "label": "Purchase Order",
        "table": "purchases",
        "status_column": "status",
        "fields": [
            {"key": "total_cost", "label": "Total Cost", "type": "number"},
            {"key": "quantity",   "label": "Quantity",   "type": "number"},
            {"key": "supplier",   "label": "Supplier",   "type": "text"},
            {"key": "category",   "label": "Category",   "type": "text"},
            {"key": "status",     "label": "Status",     "type": "text"},
        ],
        "actions": {
            "create": {"approved": "Ordered", "rejected": "Cancelled"},
        },
    },
    "fixed_asset": {
        "label": "Fixed Asset",
        "table": "fixed_assets",
        "status_column": "status",
        "fields": [
            {"key": "acquisition_cost",    "label": "Acquisition Cost", "type": "number"},
            {"key": "category",            "label": "Category",         "type": "text"},
            {"key": "depreciation_method", "label": "Method",           "type": "text"},
        ],
        "actions": {
            "create": {"approved": "Active", "rejected": "Disposed"},
        },
    },
    "project": {
        "label": "Project",
        "table": "projects",
        "status_column": "status",
        "fields": [
            {"key": "estimated_cost",   "label": "Estimated Cost",   "type": "number"},
            {"key": "expected_revenue", "label": "Expected Revenue", "type": "number"},
            {"key": "status",           "label": "Status",           "type": "text"},
        ],
        "actions": {
            # A new project is parked in 'Pending Approval' on create; approval
            # releases it back to the status it was created with.
            "create": {"approved": RESTORE, "rejected": "Cancelled"},
        },
    },
    "quotation": {
        "label": "Quotation",
        "table": "quotations",
        "status_column": "status",
        "fields": [
            {"key": "total",     "label": "Total",     "type": "number"},
            {"key": "tax_total", "label": "Tax Total", "type": "number"},
            {"key": "status",    "label": "Status",    "type": "text"},
        ],
        "actions": {
            "create": {"approved": RESTORE, "rejected": "Rejected"},
        },
    },
    "invoice": {
        # Invoices have NO stored payment-status column — payment state is
        # derived from amount/paid/voided_at — so the gate lives in its own
        # `approval_status` field (migration 129). A gated invoice is parked in
        # 'Pending Approval', cannot take payments, and does not advance its
        # project until it clears; a rejected invoice is voided (see the
        # side-effects in apply_resolution).
        "label": "Invoice",
        "table": "invoices",
        "status_column": "approval_status",
        "fields": [
            {"key": "amount",    "label": "Amount",    "type": "number"},
            {"key": "subtotal",  "label": "Subtotal",  "type": "number"},
            {"key": "tax_total", "label": "Tax Total", "type": "number"},
        ],
        "actions": {
            "create": {"approved": "Approved", "rejected": "Rejected"},
        },
    },
}

_OPERATORS = {
    "number": [">", "<", ">=", "<=", "==", "!="],
    "text":   ["==", "!=", "contains"],
}


def supported_module(module: str) -> bool:
    """True if `module` can be governed by approval policies."""
    return module in MODULE_REGISTRY


def supported_action(module: str, action: str) -> bool:
    """True if `action` is a governable trigger for `module`."""
    return action in (MODULE_REGISTRY.get(module, {}).get("actions") or {})


def policy_metadata() -> dict:
    """
    Module / action / field metadata for the policy-builder UI, derived wholly
    from MODULE_REGISTRY so the builder can never drift from what the engine
    actually enforces.
    """
    return {
        "modules":        list(MODULE_REGISTRY.keys()),
        "module_labels":  {m: cfg["label"] for m, cfg in MODULE_REGISTRY.items()},
        "module_actions": {m: list(cfg["actions"].keys()) for m, cfg in MODULE_REGISTRY.items()},
        "module_fields":  {m: cfg["fields"] for m, cfg in MODULE_REGISTRY.items()},
        "operators":      _OPERATORS,
    }


# ══════════════════════════════════════════════════════════════════════════════
# 5. RESOLUTION — side-effects on the originating business entity
# ══════════════════════════════════════════════════════════════════════════════

def apply_resolution(db: sqlite3.Connection, module: str, action: str,
                     entity_id: int, resolution: str, *,
                     original_status=None) -> None:
    """
    Update the originating entity once its request is fully resolved.

    Driven by MODULE_REGISTRY and *aware of the trigger action*, so different
    actions on the same module (e.g. a future 'create' vs 'void') can resolve to
    different statuses. Silently no-ops for any module/action not in the registry
    (e.g. legacy requests), so an unrecognised request can never crash a resolve.
    """
    cfg     = MODULE_REGISTRY.get(module)
    act_cfg = (cfg.get("actions", {}).get(action) if cfg else None)
    if cfg and act_cfg:
        target = act_cfg.get("approved" if resolution == "approved" else "rejected")
        if target == RESTORE:
            target = original_status
        if target:
            # table / status_column are trusted registry constants — see the
            # SECURITY note on MODULE_REGISTRY; `module` never reaches this SQL.
            db.execute(
                f'UPDATE {cfg["table"]} SET {cfg["status_column"]}=? WHERE id=?',
                (target, entity_id),
            )

    # ── module-specific side-effects ──────────────────────────────────────────
    # An approved expense rolls its amount into the linked project's actual cost.
    if module == "expense" and resolution == "approved":
        row = db.execute(
            "SELECT project_id, amount FROM expenses WHERE id=?", (entity_id,)
        ).fetchone()
        if row and row["project_id"]:
            db.execute(
                "UPDATE projects SET actual_cost = actual_cost + ? WHERE id=?",
                (row["amount"], row["project_id"]),
            )

    # A rejected fixed-asset purchase is stamped as a same-day disposal with
    # zero proceeds, so the ledger stays internally consistent (the status
    # column alone would leave disposal_date/reason NULL and break reporting).
    if module == "fixed_asset" and resolution == "rejected":
        from datetime import datetime
        db.execute(
            "UPDATE fixed_assets SET disposal_date=?, disposal_proceeds=0, "
            " disposal_reason=? WHERE id=? AND disposal_date IS NULL",
            (datetime.utcnow().strftime("%Y-%m-%d"),
             "Approval rejected", entity_id),
        )

    # Invoice gate side-effects. The 'Invoiced' project advance is deferred from
    # creation to approval (so a draft awaiting sign-off doesn't drag the project
    # forward); a rejected invoice is voided so it leaves all financial totals
    # exactly like a manual void would. A pending invoice can hold no payments
    # (the router blocks them), so there is no ledger to reverse here.
    if module == "invoice":
        row = db.execute(
            "SELECT project_id, invoice_number, amount, branch_id "
            "FROM invoices WHERE id=?", (entity_id,)
        ).fetchone()
        if resolution == "approved":
            if row and row["project_id"]:
                from routers.projects import bump_project_status   # lazy: avoid import cycle
                bump_project_status(db, row["project_id"], "Invoiced")
            # The receivable is booked HERE for a gated invoice, not at
            # creation: one parked in 'Pending Approval' takes no payments and
            # may still be rejected, so it is not yet a claim on anyone. See
            # accounting.post_receivable.
            if row:
                import accounting
                accounting.post_receivable(
                    db, entity_id,
                    invoice_number=row["invoice_number"],
                    amount=float(row["amount"] or 0),
                    entry_date=_now()[:10], branch_id=row["branch_id"])
        elif resolution == "rejected":
            db.execute(
                "UPDATE invoices SET voided_at=?, void_reason=?, version=version+1 "
                "WHERE id=? AND voided_at IS NULL",
                (_now(), "Approval rejected", entity_id),
            )
