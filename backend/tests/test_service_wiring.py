"""Service is wired INTO the system, not bolted beside it.

A module that works only on its own screen is half a feature. Each test here is
one place a service job has to show up for the module to be worth having:
global search, the dashboard, reports, the customer's own record, notifications,
the audit trail, and the stock history of the parts it consumed.

The permission gate is asserted alongside each, because "visible everywhere"
must not mean "visible to everyone".
"""
import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Acme Ltd"}).json()["id"]


@pytest.fixture
def oven(client, acme):
    return client.post("/api/service/equipment", json={
        "client_id": acme, "name": "Bakery oven", "manufacturer": "Rondo",
        "model": "R-200", "serial_number": "SN-4471"}).json()["id"]


def _item(client, name, qty, cost, price):
    return client.post("/api/inventory/", json={
        "name": name, "quantity": qty, "unit_cost": cost, "sale_price": price,
    }).json()["id"]


def _job(client, acme, items=None, **extra):
    body = {"client_id": acme, "job_type": "Repair",
            "reported_fault": "Fan seized", "items": items or []}
    body.update(extra)
    return client.post("/api/service/jobs", json=body).json()


# ── Global search ────────────────────────────────────────────────────────────

def test_a_job_is_findable_by_its_number(client, acme):
    job = _job(client, acme)

    hits = client.get(f"/api/search/?q={job['job_number']}").json()["results"]

    assert any(h["type"] == "service_job" and h["id"] == job["id"] for h in hits)


def test_a_machine_is_findable_by_its_serial(client, acme, oven):
    """How a technician actually looks something up: the plate on the machine."""
    hits = client.get("/api/search/?q=SN-4471").json()["results"]

    assert any(h["type"] == "equipment" and h["id"] == oven for h in hits)


def test_a_job_is_findable_by_the_reported_fault(client, acme):
    job = _job(client, acme, reported_fault="Compressor overheating")

    hits = client.get("/api/search/?q=overheating").json()["results"]

    assert any(h["id"] == job["id"] and h["type"] == "service_job" for h in hits)


def test_search_hides_service_from_a_role_without_it(as_role, client, acme, oven):
    _job(client, acme)
    crm = as_role("CRM Specialist")

    hits = crm.get("/api/search/?q=SN-4471").json()["results"]

    assert not [h for h in hits if h["type"] in ("service_job", "equipment")]


# ── Dashboard ────────────────────────────────────────────────────────────────

def test_the_dashboard_counts_open_and_unbilled_work(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    _job(client, acme)                                     # open
    done = _job(client, acme, [{"line_type": "part", "inventory_id": belt,
                                "name": "Belt", "quantity": 1, "unit_price": 12}])
    client.post(f"/api/service/jobs/{done['id']}/complete")

    d = client.get("/api/dashboard/").json()

    assert d["service"]["open_jobs"] == 1
    assert d["service"]["unbilled"] == 1, "completed work nobody has invoiced"


def test_invoicing_clears_the_unbilled_count(client, acme):
    job = _job(client, acme, [{"line_type": "charge", "name": "Labour",
                               "quantity": 1, "unit_price": 100}])
    client.post(f"/api/service/jobs/{job['id']}/complete")
    assert client.get("/api/dashboard/").json()["service"]["unbilled"] == 1

    client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert client.get("/api/dashboard/").json()["service"]["unbilled"] == 0


def test_the_dashboard_omits_service_for_a_role_without_it(as_role):
    crm = as_role("CRM Specialist")

    d = crm.get("/api/dashboard/").json()

    assert d["service"] is None
    assert d["permissions"]["service"] is False


# ── Reports ──────────────────────────────────────────────────────────────────

def test_the_report_shows_margin_per_job(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [
        {"line_type": "part", "inventory_id": belt, "name": "Belt",
         "quantity": 3, "unit_price": 12},
        {"line_type": "charge", "name": "Labour", "quantity": 1, "unit_price": 100},
    ])
    client.post(f"/api/service/jobs/{job['id']}/complete")

    rows = client.get("/api/reports/service-jobs").json()

    mine = [r for r in rows["jobs"] if r["id"] == job["id"]][0]
    assert mine["revenue"] == pytest.approx(136)
    assert mine["parts_cost"] == pytest.approx(12)
    assert mine["margin"] == pytest.approx(124)
    assert mine["billed"] is False


def test_the_report_totals_the_unbilled_value(client, acme):
    job = _job(client, acme, [{"line_type": "charge", "name": "Labour",
                               "quantity": 1, "unit_price": 250}])
    client.post(f"/api/service/jobs/{job['id']}/complete")

    totals = client.get("/api/reports/service-jobs").json()["totals"]

    assert totals["unbilled_count"] == 1
    assert totals["unbilled_value"] == pytest.approx(250)


def test_a_zero_revenue_job_reports_no_margin_percent(client, acme):
    """A draft with no lines is not a 0% margin job — it is not yet a job."""
    job = _job(client, acme)

    rows = client.get("/api/reports/service-jobs").json()["jobs"]

    assert [r for r in rows if r["id"] == job["id"]][0]["margin_pct"] is None


# ── The customer's own record ────────────────────────────────────────────────

def test_a_client_shows_their_machines_and_their_jobs(client, acme, oven):
    job = _job(client, acme, equipment_id=oven)

    d = client.get(f"/api/clients/{acme}").json()

    assert [e["id"] for e in d["equipment"]] == [oven]
    assert [j["id"] for j in d["service_jobs"]] == [job["id"]]
    assert d["service_jobs"][0]["equipment_name"] == "Bakery oven"


def test_a_client_record_hides_service_from_a_role_without_it(as_role, client, acme, oven):
    """A salesperson may read the client and still have no business reading
    their service history."""
    _job(client, acme, equipment_id=oven)
    sales = as_role("Sales")

    d = sales.get(f"/api/clients/{acme}").json()

    assert d["equipment"] == []
    assert d["service_jobs"] == []


# ── Notifications ────────────────────────────────────────────────────────────

def test_assigning_a_job_notifies_the_technician(client, acme, as_role):
    tech = client.get("/api/users/").json()
    target = [u for u in tech if u["username"] == "u_ops_mgr"][0]

    job = _job(client, acme, assigned_to=target["id"])

    ops = as_role("Operations Manager")
    rows = ops.get("/api/notifications/").json()["notifications"]
    assert any(n["type"] == "service_job_scheduled"
               and job["job_number"] in (n.get("title") or "") for n in rows)


def test_the_service_notification_types_are_registered(client):
    """Unregistered types are not filtered by module, so a tenant without the
    licence would receive them."""
    from routers.notifications import NOTIFICATION_TYPE_MODULE

    assert NOTIFICATION_TYPE_MODULE["service_job_scheduled"] == "service"
    assert NOTIFICATION_TYPE_MODULE["service_job_completed"] == "service"


# ── Audit trail ──────────────────────────────────────────────────────────────

def test_every_money_moving_action_is_audited(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [{"line_type": "part", "inventory_id": belt,
                               "name": "Belt", "quantity": 2, "unit_price": 12}])
    client.post(f"/api/service/jobs/{job['id']}/complete")
    client.post(f"/api/service/jobs/{job['id']}/invoice")

    rows = client.get("/api/audit/?module=service_job").json()["rows"]
    actions = {r["action"] for r in rows if r["record_id"] == job["id"]}

    assert {"create", "complete", "invoice"} <= actions


# ── Stock history ────────────────────────────────────────────────────────────

def test_the_parts_history_names_the_job(client, acme):
    """An item's movement list has to explain itself without a join."""
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [{"line_type": "part", "inventory_id": belt,
                               "name": "Belt", "quantity": 2, "unit_price": 12}])
    client.post(f"/api/service/jobs/{job['id']}/complete")

    moves = client.get(f"/api/inventory/{belt}/movements").json()

    svc = [m for m in moves if m["type"] == "service"]
    assert len(svc) == 1
    assert svc[0]["reference"] == job["job_number"]
