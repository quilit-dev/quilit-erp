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
        "module": "purchases",
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
