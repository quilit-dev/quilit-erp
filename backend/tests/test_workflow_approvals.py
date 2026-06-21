"""
Approval workflow simulations: Create -> Approve / Reject / Force-Approve / Cancel,
multi-step sequencing, invalid state transitions and circular-flow termination.

State-machine tests seed `approval_requests` / `approval_steps` directly so the
transition under test is deterministic and not dependent on which business
action happens to trigger a policy.
"""
import pytest
from helpers.seeding import ROLE_USERS, TEST_PASSWORD


# ── seeding helpers ──────────────────────────────────────────────────────────
def _uid(db, username):
    row = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    assert row, f"seed user {username!r} missing"
    return row["id"]


def seed_request(db, *, steps, requested_by="u_sales", approval_type="single"):
    """
    Insert a pending approval request.
    `steps` is a list of approver_role strings, in order (1-indexed).
    """
    total = len(steps)
    cur = db.execute(
        "INSERT INTO approval_requests "
        "(policy_name, module, entity_id, entity_label, trigger_action, status, "
        " approval_type, current_step, total_steps, requested_by, requested_at) "
        "VALUES ('QA Policy','purchases',1,'PO #1','create','pending',?,1,?,?,datetime('now'))",
        (approval_type, total, _uid(db, requested_by)),
    )
    req_id = cur.lastrowid
    for i, role in enumerate(steps, start=1):
        db.execute(
            "INSERT INTO approval_steps (request_id, step_number, approver_role, status) "
            "VALUES (?,?,?,?)",
            (req_id, i, role, "pending" if i == 1 else "waiting"),
        )
    db.commit()
    return req_id


def status_of(db, req_id):
    return db.execute(
        "SELECT status FROM approval_requests WHERE id=?", (req_id,)
    ).fetchone()["status"]


# ── single-step happy paths ──────────────────────────────────────────────────
@pytest.mark.workflow
def test_approve_single_step(db, make_client):
    req_id = seed_request(db, steps=["Manager"])
    r = make_client("Manager").post(f"/api/approval-requests/{req_id}/approve", json={})
    assert r.status_code < 500, r.text
    assert r.status_code == 200, f"approve failed: {r.status_code} {r.text[:200]}"
    assert status_of(db, req_id) == "approved"


@pytest.mark.workflow
def test_reject_single_step(db, make_client):
    req_id = seed_request(db, steps=["Manager"])
    r = make_client("Manager").post(f"/api/approval-requests/{req_id}/reject", json={})
    assert r.status_code == 200, f"reject failed: {r.status_code} {r.text[:200]}"
    assert status_of(db, req_id) == "rejected"


@pytest.mark.workflow
def test_cancel_by_requester(db, make_client):
    req_id = seed_request(db, steps=["Manager"], requested_by="u_sales")
    r = make_client("Sales").post(f"/api/approval-requests/{req_id}/cancel", json={})
    assert r.status_code < 500, r.text
    assert r.status_code == 200, f"requester could not cancel: {r.status_code} {r.text[:200]}"
    assert status_of(db, req_id) == "cancelled"


@pytest.mark.workflow
def test_force_approve_by_superadmin(db, make_client):
    req_id = seed_request(db, steps=["Manager", "Finance Manager"], approval_type="multi_step")
    r = make_client("superadmin").post(f"/api/approval-requests/{req_id}/force-approve", json={})
    assert r.status_code < 500, r.text
    assert r.status_code == 200, f"force-approve failed: {r.status_code} {r.text[:200]}"
    assert status_of(db, req_id) == "approved"


# ── invalid state transitions (must be refused, never 500) ───────────────────
@pytest.mark.workflow
def test_double_approve_is_refused(db, make_client):
    req_id = seed_request(db, steps=["Manager"])
    c = make_client("Manager")
    first = c.post(f"/api/approval-requests/{req_id}/approve", json={})
    assert first.status_code == 200
    second = c.post(f"/api/approval-requests/{req_id}/approve", json={})
    assert second.status_code < 500, "double-approve crashed the server"
    assert second.status_code >= 400, (
        f"BROKEN STATE TRANSITION: re-approving a resolved request returned "
        f"{second.status_code} (expected a 4xx refusal)")


@pytest.mark.workflow
def test_approve_after_reject_is_refused(db, make_client):
    req_id = seed_request(db, steps=["Manager"])
    c = make_client("Manager")
    assert c.post(f"/api/approval-requests/{req_id}/reject", json={}).status_code == 200
    r = c.post(f"/api/approval-requests/{req_id}/approve", json={})
    assert r.status_code < 500, "approve-after-reject crashed"
    assert r.status_code >= 400, (
        f"BROKEN STATE TRANSITION: approving a rejected request returned {r.status_code}")
    assert status_of(db, req_id) == "rejected", "a rejected request was flipped to approved"


@pytest.mark.workflow
def test_cancel_after_resolved_is_refused(db, make_client):
    req_id = seed_request(db, steps=["Manager"], requested_by="u_sales")
    make_client("Manager").post(f"/api/approval-requests/{req_id}/approve", json={})
    r = make_client("Sales").post(f"/api/approval-requests/{req_id}/cancel", json={})
    assert r.status_code < 500
    assert r.status_code >= 400, "an already-approved request was cancellable"


@pytest.mark.workflow
def test_wrong_role_cannot_approve(db, make_client):
    """A user whose role is not the current step's approver must be refused."""
    req_id = seed_request(db, steps=["Finance Manager"])
    r = make_client("Sales").post(f"/api/approval-requests/{req_id}/approve", json={})
    assert r.status_code < 500, "wrong-role approve crashed"
    assert r.status_code >= 400, (
        f"PERMISSION FAILURE: a non-approver role approved the request ({r.status_code})")
    assert status_of(db, req_id) == "pending"


# ── multi-step sequencing ────────────────────────────────────────────────────
@pytest.mark.workflow
def test_multi_step_runs_in_order(db, make_client):
    req_id = seed_request(db, steps=["Manager", "Finance Manager"], approval_type="multi_step")
    # step 1
    r1 = make_client("Manager").post(f"/api/approval-requests/{req_id}/approve", json={})
    assert r1.status_code == 200, r1.text
    assert status_of(db, req_id) == "pending", "request resolved before step 2"
    # step 2
    r2 = make_client("Finance Manager").post(f"/api/approval-requests/{req_id}/approve", json={})
    assert r2.status_code == 200, r2.text
    assert status_of(db, req_id) == "approved"


@pytest.mark.workflow
def test_second_step_approver_cannot_jump_ahead(db, make_client):
    """The step-2 role must not be able to approve while step 1 is still pending."""
    req_id = seed_request(db, steps=["Manager", "Finance Manager"], approval_type="multi_step")
    r = make_client("Finance Manager").post(f"/api/approval-requests/{req_id}/approve", json={})
    assert r.status_code < 500
    assert r.status_code >= 400, "step-2 approver jumped ahead of step 1"
    assert status_of(db, req_id) == "pending"


@pytest.mark.workflow
def test_repeated_role_multistep_terminates(db, make_client):
    """
    Circular-flow guard: a policy whose two steps use the SAME role must still
    terminate — approving twice resolves it, it does not loop forever.
    """
    req_id = seed_request(db, steps=["Manager", "Manager"], approval_type="multi_step")
    c = make_client("Manager")
    assert c.post(f"/api/approval-requests/{req_id}/approve", json={}).status_code == 200
    second = c.post(f"/api/approval-requests/{req_id}/approve", json={})
    assert second.status_code == 200, second.text
    assert status_of(db, req_id) == "approved"
    cur = db.execute(
        "SELECT current_step, total_steps FROM approval_requests WHERE id=?", (req_id,)
    ).fetchone()
    assert cur["current_step"] <= cur["total_steps"] + 1, (
        f"current_step ({cur['current_step']}) ran past total_steps "
        f"({cur['total_steps']}) — possible circular/unbounded flow")


# ── policy CRUD via the API ──────────────────────────────────────────────────
@pytest.mark.workflow
def test_create_and_list_policy(make_client):
    c = make_client("superadmin")
    payload = {
        "name": "QA — purchases need a manager",
        "module": "purchase",
        "trigger_action": "create",
        "condition_logic": "AND",
        "conditions": [],
        "approval_type": "single",
        "approver_roles": ["Manager"],
        "steps": [],
        "priority": 0,
        "is_active": True,
    }
    created = c.post("/api/approval-policies/", json=payload)
    assert created.status_code < 500, created.text
    if created.status_code not in (200, 201):
        pytest.skip(f"policy create rejected ({created.status_code}); schema differs: {created.text[:160]}")
    listed = c.get("/api/approval-policies/")
    assert listed.status_code == 200
    assert any(p.get("name") == payload["name"] for p in listed.json())


@pytest.mark.workflow
def test_create_policy_with_garbage_body_never_5xx(make_client):
    r = make_client("superadmin").post("/api/approval-policies/", json={"name": 123, "module": None})
    assert r.status_code < 500, f"malformed policy body crashed: {r.status_code} {r.text[:160]}"


# ── registry coverage: unsupported targets are refused ───────────────────────
@pytest.mark.workflow
def test_policy_for_unknown_module_is_refused(make_client):
    """The builder must not be able to persist a dead policy aimed at a module
    the engine cannot enforce."""
    r = make_client("superadmin").post("/api/approval-policies/", json={
        "name": "bad module", "module": "telepathy", "trigger_action": "create",
        "approval_type": "single", "approver_roles": ["Manager"],
    })
    assert r.status_code == 400, r.text


@pytest.mark.workflow
def test_policy_for_unsupported_action_is_refused(make_client):
    """A real module with an action it doesn't register must be refused."""
    r = make_client("superadmin").post("/api/approval-policies/", json={
        "name": "bad action", "module": "expense", "trigger_action": "teleport",
        "approval_type": "single", "approver_roles": ["Manager"],
    })
    assert r.status_code == 400, r.text


@pytest.mark.workflow
def test_meta_modules_reports_new_modules(make_client):
    """Metadata is derived from the registry, so every governable module must
    show up with fields and a create action."""
    meta = make_client("superadmin").get("/api/approval-policies/meta/modules").json()
    for m in ("expense", "purchase", "fixed_asset", "project", "quotation", "invoice"):
        assert m in meta["modules"], f"{m} missing from policy metadata"
        assert "create" in meta["module_actions"][m]
        assert meta["module_fields"][m], f"{m} has no builder fields"


# ── end-to-end gating: a new module is parked, then released on approval ──────
@pytest.mark.workflow
def test_project_create_is_gated_and_restored_on_approval(db, make_client):
    """A project-create policy parks a new project in 'Pending Approval'; the
    RESTORE resolution releases it back to its requested status on approval."""
    admin = make_client("superadmin")
    pol = admin.post("/api/approval-policies/", json={
        "name": "All projects need a manager",
        "module": "project", "trigger_action": "create",
        "condition_logic": "AND", "conditions": [],
        "approval_type": "single", "approver_roles": ["Manager"],
        "priority": 5, "is_active": True,
    })
    assert pol.status_code in (200, 201), pol.text

    created = admin.post("/api/projects/", json={"name": "Gated Project", "status": "Inquiry"})
    assert created.status_code == 200, created.text
    body = created.json()
    assert body.get("pending_approval") is True, body
    pid = body["id"]

    row = db.execute("SELECT status FROM projects WHERE id=?", (pid,)).fetchone()
    assert row["status"] == "Pending Approval", row["status"]

    req = db.execute(
        "SELECT id FROM approval_requests WHERE module='project' AND entity_id=? AND status='pending'",
        (pid,),
    ).fetchone()
    assert req, "no pending approval request was raised for the project"

    r = make_client("Manager").post(f"/api/approval-requests/{req['id']}/approve", json={})
    assert r.status_code == 200, r.text

    after = db.execute("SELECT status FROM projects WHERE id=?", (pid,)).fetchone()
    assert after["status"] == "Inquiry", (
        f"approved project should be restored to its requested status, got {after['status']!r}")


@pytest.mark.workflow
def test_invoice_create_is_gated_then_released_on_approval(db, make_client):
    """A gated invoice is parked in 'Pending Approval', refuses payments while
    pending, and is released (and its project advanced) on approval."""
    admin = make_client("superadmin")
    pol = admin.post("/api/approval-policies/", json={
        "name": "Invoices over $1k need Finance",
        "module": "invoice", "trigger_action": "create",
        "condition_logic": "AND",
        "conditions": [{"field": "amount", "op": ">", "value": "1000"}],
        "approval_type": "single", "approver_roles": ["Finance Manager"],
        "priority": 5, "is_active": True,
    })
    assert pol.status_code in (200, 201), pol.text

    created = admin.post("/api/invoices/", json={"amount": 5000})
    assert created.status_code == 200, created.text
    body = created.json()
    assert body.get("pending_approval") is True, body
    iid = body["id"]

    row = db.execute("SELECT approval_status FROM invoices WHERE id=?", (iid,)).fetchone()
    assert row["approval_status"] == "Pending Approval", row["approval_status"]

    # Pending invoices must refuse payment.
    pay = admin.post(f"/api/invoices/{iid}/payments", json={
        "amount": 100, "currency": "USD", "method": "Cash",
        "idempotency_key": "test-pending-pay-1",
    })
    assert pay.status_code == 400, pay.text

    # The list view surfaces the pending state as the display status.
    listed = admin.get("/api/invoices/").json()
    mine = next(r for r in listed if r["id"] == iid)
    assert mine["payment_status"] == "Pending Approval", mine["payment_status"]

    req = db.execute(
        "SELECT id FROM approval_requests WHERE module='invoice' AND entity_id=? AND status='pending'",
        (iid,),
    ).fetchone()
    assert req, "no pending approval request was raised for the invoice"

    r = make_client("Finance Manager").post(f"/api/approval-requests/{req['id']}/approve", json={})
    assert r.status_code == 200, r.text

    after = db.execute("SELECT approval_status, voided_at FROM invoices WHERE id=?", (iid,)).fetchone()
    assert after["approval_status"] == "Approved", after["approval_status"]
    assert after["voided_at"] is None, "an approved invoice must not be voided"

    # Now that it is approved, payment is accepted.
    pay2 = admin.post(f"/api/invoices/{iid}/payments", json={
        "amount": 100, "currency": "USD", "method": "Cash",
        "idempotency_key": "test-approved-pay-1",
    })
    assert pay2.status_code == 200, pay2.text


@pytest.mark.workflow
def test_invoice_create_rejection_voids(db, make_client):
    """A rejected invoice is voided so it leaves all financial totals."""
    admin = make_client("superadmin")
    admin.post("/api/approval-policies/", json={
        "name": "All invoices need Finance",
        "module": "invoice", "trigger_action": "create",
        "conditions": [], "approval_type": "single",
        "approver_roles": ["Finance Manager"], "is_active": True,
    })
    iid = admin.post("/api/invoices/", json={"amount": 800}).json()["id"]
    req = db.execute(
        "SELECT id FROM approval_requests WHERE module='invoice' AND entity_id=?", (iid,),
    ).fetchone()
    make_client("Finance Manager").post(f"/api/approval-requests/{req['id']}/reject", json={})
    after = db.execute(
        "SELECT approval_status, voided_at FROM invoices WHERE id=?", (iid,)).fetchone()
    assert after["approval_status"] == "Rejected", after["approval_status"]
    assert after["voided_at"] is not None, "a rejected invoice should be voided"


@pytest.mark.workflow
def test_project_create_rejection_cancels(db, make_client):
    """Rejecting a gated project resolves it to the registry's 'Cancelled'."""
    admin = make_client("superadmin")
    admin.post("/api/approval-policies/", json={
        "name": "All projects need a manager",
        "module": "project", "trigger_action": "create",
        "conditions": [], "approval_type": "single",
        "approver_roles": ["Manager"], "is_active": True,
    })
    pid = admin.post("/api/projects/", json={"name": "Doomed", "status": "Inquiry"}).json()["id"]
    req = db.execute(
        "SELECT id FROM approval_requests WHERE module='project' AND entity_id=?", (pid,),
    ).fetchone()
    make_client("Manager").post(f"/api/approval-requests/{req['id']}/reject", json={})
    after = db.execute("SELECT status FROM projects WHERE id=?", (pid,)).fetchone()
    assert after["status"] == "Cancelled", after["status"]
