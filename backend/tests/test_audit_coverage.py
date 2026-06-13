"""Activity-log coverage — every business mutation leaves an audit row.

Each test drives a real endpoint and asserts the (module, action) row landed
in audit_log. These cover the areas that historically logged NOTHING:
settings, inventory, auth, approval policies, documents, planning task
moves, HR attendance, and the archives restore path.
"""
import uuid

import pytest


def _key():
    return str(uuid.uuid4())


def _has(db, module, action):
    return db.execute(
        "SELECT COUNT(*) n FROM audit_log WHERE module=? AND action=?",
        (module, action)).fetchone()["n"] > 0


def test_settings_changes_are_logged(make_client, db):
    c = make_client("superadmin")
    assert c.put("/api/settings/", json={"company_name": "Audit Co"}).status_code == 200
    assert c.post("/api/settings/exchange-rate",
                  json={"rate": 89500}).status_code == 200
    assert _has(db, "settings", "update")
    rows = db.execute(
        "SELECT record_ref FROM audit_log WHERE module='settings'").fetchall()
    refs = {r["record_ref"] for r in rows}
    assert "Exchange rate" in refs


def test_inventory_lifecycle_is_logged(make_client, db):
    c = make_client("superadmin")
    item = c.post("/api/inventory/", json={
        "name": "AUDIT Widget", "quantity": 5, "unit_cost": 2, "sale_price": 5,
    }).json()["id"]
    assert c.put(f"/api/inventory/{item}", json={
        "name": "AUDIT Widget v2", "quantity": 5, "unit_cost": 2, "sale_price": 6,
    }).status_code == 200
    assert c.patch(f"/api/inventory/{item}/stock",
                   json={"delta": -5, "type": "adjustment"}).status_code == 200
    assert c.patch(f"/api/inventory/{item}/archive").status_code == 200
    assert c.patch(f"/api/inventory/{item}/unarchive").status_code == 200

    for action in ("create", "update", "stock_adjust", "archive", "unarchive"):
        assert _has(db, "inventory", action), f"inventory/{action} not logged"


def test_auth_events_are_logged(make_client, db):
    c = make_client("superadmin")
    # The fixture login itself must have logged a row.
    assert _has(db, "auth", "login")
    r = c.post("/api/auth/change-password",
               json={"old_password": "x", "new_password": "irrelevant1"})
    assert r.status_code == 400          # wrong old password — and NOT logged
    n_before = db.execute(
        "SELECT COUNT(*) n FROM audit_log WHERE module='auth' AND action='change_password'"
    ).fetchone()["n"]
    assert n_before == 0


def test_approval_policy_lifecycle_is_logged(make_client, db):
    c = make_client("superadmin")
    r = c.post("/api/approval-policies/", json={
        "name": "AUDIT policy", "module": "expense", "trigger_action": "create",
        "approver_roles": ["Finance Manager"],
    })
    assert r.status_code in (200, 201), r.text
    pid = db.execute("SELECT MAX(id) m FROM approval_policies").fetchone()["m"]
    assert c.patch(f"/api/approval-policies/{pid}/toggle").status_code == 200
    assert c.delete(f"/api/approval-policies/{pid}").status_code == 200
    for action in ("create", "disable", "delete"):
        assert _has(db, "approval_policy", action), f"approval_policy/{action} not logged"


def test_document_save_and_delete_are_logged(make_client, db):
    c = make_client("superadmin")
    doc = c.post("/api/documents/", json={
        "record_type": "invoice", "record_id": 1,
        "title": "AUDIT snapshot", "html_content": "<p>x</p>",
    })
    assert doc.status_code in (200, 201), doc.text
    assert c.delete(f"/api/documents/{doc.json()['id']}").status_code == 200
    assert _has(db, "document", "create")
    assert _has(db, "document", "delete")


def test_planning_task_moves_are_logged(make_client, db):
    c = make_client("superadmin")
    pid = c.post("/api/planning/projects", json={"name": "AUDIT plan"}).json()["id"]
    tid = c.post("/api/planning/tasks", json={
        "project_id": pid, "name": "AUDIT task",
        "start_date": "2026-06-01", "end_date": "2026-06-05",
    }).json()["id"]
    assert c.patch(f"/api/planning/tasks/{tid}/status",
                   json={"status": "In Progress"}).status_code == 200
    assert c.patch(f"/api/planning/tasks/{tid}/progress",
                   json={"progress": 40}).status_code == 200
    assert _has(db, "planning", "status_change")
    n = db.execute(
        "SELECT COUNT(*) n FROM audit_log WHERE module='planning' AND action='update'"
    ).fetchone()["n"]
    assert n >= 1


def test_hr_attendance_is_logged(make_client, db):
    c = make_client("superadmin")
    emp = c.post("/api/hr/employees", json={
        "full_name": "AUDIT Emp", "job_title": "T", "employment_type": "Full-time",
        "status": "Active", "salary": 1000}).json()["id"]
    assert c.post("/api/hr/attendance", json={
        "employee_id": emp, "date": "2026-06-12", "status": "Present",
    }).status_code == 200
    assert _has(db, "hr_employee", "attendance")


def test_audit_filters_endpoint_reflects_log(make_client):
    c = make_client("superadmin")
    c.put("/api/settings/", json={"company_name": "Filter Co"})
    f = c.get("/api/audit/filters")
    assert f.status_code == 200
    body = f.json()
    assert "settings" in body["modules"]
    assert "update" in body["actions"]
    # Admin-only.
    sales = make_client("Sales")
    assert sales.get("/api/audit/filters").status_code == 403
