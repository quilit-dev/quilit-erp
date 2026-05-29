"""HR contracts — CRUD, activation side-effects, print-data shape."""
import pytest


def _emp(c, **overrides):
    payload = {"full_name": "John Smith", "job_title": "Engineer",
               "employment_type": "Full-time", "status": "Active", "salary": 2500}
    payload.update(overrides)
    return c.post("/api/hr/employees", json=payload).json()["id"]


def _contract(c, employee_id, **overrides):
    payload = {"employee_id": employee_id, "contract_type": "Permanent",
               "status": "Draft", "start_date": "2025-01-01",
               "job_title": "Software Engineer", "salary": 3000}
    payload.update(overrides)
    r = c.post("/api/hr/contracts/", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def test_contract_crud(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c)
    created = _contract(c, emp_id)
    contract_id = created["id"]
    assert created["contract_number"].startswith("CTR-")

    detail = c.get(f"/api/hr/contracts/{contract_id}").json()
    assert detail["employee_name"]
    assert detail["status"] == "Draft"
    assert detail["salary"] == 3000


def test_activating_contract_syncs_employee_salary_and_history(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c, salary=2500)
    contract = _contract(c, emp_id, salary=3200, job_title="Senior Engineer")
    r = c.post(f"/api/hr/contracts/{contract['id']}/status",
               json={"status": "Active"})
    assert r.status_code == 200, r.text
    # Employee should now be at the contract salary + title
    emp = c.get(f"/api/hr/employees/{emp_id}").json()
    assert emp["salary"]    == 3200
    assert emp["job_title"] == "Senior Engineer"
    # And the timeline records the change with reason referencing the contract
    assert any("Contract" in (h.get("reason") or "") for h in emp["history"])


def test_terminate_contract(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c)
    contract = _contract(c, emp_id, salary=3000)
    c.post(f"/api/hr/contracts/{contract['id']}/status", json={"status": "Active"})
    r = c.post(f"/api/hr/contracts/{contract['id']}/status",
               json={"status": "Terminated", "reason": "End of project"})
    assert r.status_code == 200, r.text
    detail = c.get(f"/api/hr/contracts/{contract['id']}").json()
    assert detail["status"] == "Terminated"
    assert detail["terminated_reason"] == "End of project"
    assert detail["terminated_at"] is not None


def test_print_data_includes_company_branding(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c)
    contract = _contract(c, emp_id)
    r = c.get(f"/api/hr/contracts/{contract['id']}/print-data")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "contract" in body and body["contract"]["id"] == contract["id"]
    assert "company"  in body
    # Settings keys that should be present (values may be None on fresh installs)
    for k in ("company_name", "currency"):
        assert k in body["company"]


def test_list_contracts_filter_by_employee(make_client):
    c = make_client("superadmin")
    a = _emp(c, full_name="A")
    b = _emp(c, full_name="B")
    _contract(c, a)
    _contract(c, b)
    only_a = c.get(f"/api/hr/contracts/?employee_id={a}").json()
    assert all(item["employee_id"] == a for item in only_a)
