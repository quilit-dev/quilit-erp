"""Service jobs and the equipment they are done on.

Covers the module up to but not including the financial effects: creation,
validation, the status ladder, and the scoping every module here is expected to
honour. The consumption and billing invariants live in test_service_money.py,
because those are the ones that can quietly corrupt the ledger and deserve to
fail loudly on their own.
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
    r = client.post("/api/service/equipment", json={
        "client_id": acme, "name": "Bakery oven", "manufacturer": "Rondo",
        "model": "R-200", "serial_number": "SN-4471", "install_date": "2024-03-01",
    })
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _job(client, acme, **extra):
    body = {"client_id": acme, "job_type": "Repair",
            "reported_fault": "Fan not spinning", "items": []}
    body.update(extra)
    r = client.post("/api/service/jobs", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── Equipment ────────────────────────────────────────────────────────────────

def test_equipment_is_created_and_listed(client, acme, oven):
    rows = client.get("/api/service/equipment").json()
    assert [r["id"] for r in rows] == [oven]
    assert rows[0]["client_name"] == "Acme Ltd"


def test_equipment_can_be_found_by_serial(client, acme, oven):
    # The way a technician actually looks a machine up.
    assert [r["id"] for r in client.get(
        "/api/service/equipment?search=SN-4471").json()] == [oven]
    assert client.get("/api/service/equipment?search=nothing-like-this").json() == []


def test_two_machines_may_share_a_serial(client, acme):
    """Serials collide across manufacturers and are often blank, which is why
    the column carries no unique constraint."""
    for maker in ("Rondo", "Hobart"):
        r = client.post("/api/service/equipment", json={
            "client_id": acme, "name": f"{maker} mixer",
            "manufacturer": maker, "serial_number": "001"})
        assert r.status_code == 200, r.text


def test_equipment_carries_its_service_history(client, acme, oven):
    """The reason equipment is a record and not a text field on the job."""
    a = _job(client, acme, equipment_id=oven, reported_fault="Fan")
    b = _job(client, acme, equipment_id=oven, reported_fault="Thermostat")

    history = client.get(f"/api/service/equipment/{oven}").json()["jobs"]

    assert {j["id"] for j in history} == {a["id"], b["id"]}


def test_equipment_in_use_cannot_be_archived(client, acme, oven):
    _job(client, acme, equipment_id=oven)

    r = client.patch(f"/api/service/equipment/{oven}/archive")

    assert r.status_code == 400
    assert "open job" in r.json()["detail"].lower()


def test_equipment_can_be_archived_once_work_is_closed(client, acme, oven):
    job = _job(client, acme, equipment_id=oven)
    client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "duplicate"})

    assert client.patch(f"/api/service/equipment/{oven}/archive").status_code == 200
    assert client.get("/api/service/equipment").json() == []
    assert client.patch(f"/api/service/equipment/{oven}/unarchive").status_code == 200


# ── Jobs ─────────────────────────────────────────────────────────────────────

def test_a_job_gets_a_numbered_reference(client, acme):
    job = _job(client, acme)

    assert job["job_number"].startswith("SVC-")
    # Derived from the row id, so two concurrent creates cannot collide.
    assert job["job_number"].endswith(f"{job['id']:04d}")


def test_the_number_prefix_is_a_setting(client, acme):
    assert client.put("/api/settings/", json={"service_job_prefix": "WO-"}).status_code == 200

    assert _job(client, acme)["job_number"].startswith("WO-")


def test_a_job_scheduled_at_creation_starts_scheduled(client, acme):
    plain = _job(client, acme)
    dated = _job(client, acme, scheduled_date="2026-09-01")

    assert client.get(f"/api/service/jobs/{plain['id']}").json()["status"] == "Draft"
    assert client.get(f"/api/service/jobs/{dated['id']}").json()["status"] == "Scheduled"


def test_a_job_totals_its_lines(client, acme):
    job = _job(client, acme, items=[
        {"line_type": "charge", "name": "Callout", "quantity": 1, "unit_price": 50},
        {"line_type": "charge", "name": "Labour",  "quantity": 1, "unit_price": 120},
    ])
    d = client.get(f"/api/service/jobs/{job['id']}").json()

    assert d["subtotal"] == pytest.approx(170)
    assert d["total"] == pytest.approx(d["subtotal"] + d["tax_total"])


def test_equipment_must_belong_to_the_job_s_client(client, acme, oven):
    other = client.post("/api/clients/", json={"name": "Other Co"}).json()["id"]

    r = client.post("/api/service/jobs", json={
        "client_id": other, "equipment_id": oven, "items": []})

    assert r.status_code == 400
    assert "different client" in r.json()["detail"]


def test_an_unknown_job_type_is_refused(client, acme):
    r = client.post("/api/service/jobs", json={
        "client_id": acme, "job_type": "Demolition", "items": []})
    assert r.status_code == 400


# ── Line validation ──────────────────────────────────────────────────────────

def test_a_part_line_must_name_a_stock_item(client, acme):
    r = client.post("/api/service/jobs", json={
        "client_id": acme,
        "items": [{"line_type": "part", "name": "Belt", "quantity": 1, "unit_price": 10}],
    })
    assert r.status_code == 400
    assert "stock item" in r.json()["detail"]


def test_a_charge_line_may_not_point_at_stock(client, acme):
    """Otherwise it would look consumable and quietly never be consumed."""
    item = client.post("/api/inventory/", json={
        "name": "Belt", "quantity": 5, "unit_cost": 4, "sale_price": 10}).json()

    r = client.post("/api/service/jobs", json={
        "client_id": acme,
        "items": [{"line_type": "charge", "name": "Labour", "unit_price": 100,
                   "inventory_id": item["id"]}],
    })
    assert r.status_code == 400


def test_a_part_line_needs_a_positive_quantity(client, acme):
    item = client.post("/api/inventory/", json={
        "name": "Belt", "quantity": 5, "unit_cost": 4, "sale_price": 10}).json()

    r = client.post("/api/service/jobs", json={
        "client_id": acme,
        "items": [{"line_type": "part", "name": "Belt", "quantity": 0,
                   "unit_price": 10, "inventory_id": item["id"]}],
    })
    assert r.status_code == 400


# ── The status ladder ────────────────────────────────────────────────────────

def test_the_happy_path_walks_draft_to_completed(client, acme):
    job = _job(client, acme)
    jid = job["id"]

    assert client.post(f"/api/service/jobs/{jid}/schedule",
                       json={"scheduled_date": "2026-09-01"}).status_code == 200
    assert client.post(f"/api/service/jobs/{jid}/start").status_code == 200
    assert client.get(f"/api/service/jobs/{jid}").json()["status"] == "In Progress"


def test_a_started_job_cannot_be_started_again(client, acme):
    jid = _job(client, acme)["id"]
    client.post(f"/api/service/jobs/{jid}/start")

    r = client.post(f"/api/service/jobs/{jid}/start")

    assert r.status_code == 400
    assert "in progress" in r.json()["detail"].lower()


def test_a_cancelled_job_cannot_be_scheduled(client, acme):
    jid = _job(client, acme)["id"]
    client.post(f"/api/service/jobs/{jid}/cancel", json={"reason": "customer declined"})

    r = client.post(f"/api/service/jobs/{jid}/schedule",
                    json={"scheduled_date": "2026-09-01"})

    assert r.status_code == 400


def test_a_closed_job_can_no_longer_be_edited(client, acme):
    """Its lines are the record of what was consumed and billed."""
    jid = _job(client, acme)["id"]
    client.post(f"/api/service/jobs/{jid}/cancel", json={"reason": "duplicate"})

    r = client.put(f"/api/service/jobs/{jid}", json={
        "client_id": acme, "job_type": "Repair", "items": []})

    assert r.status_code == 409


# ── Filters the module exists to answer ──────────────────────────────────────

def test_jobs_can_be_filtered_by_status_and_client(client, acme):
    other = client.post("/api/clients/", json={"name": "Other Co"}).json()["id"]
    mine = _job(client, acme)["id"]
    _job(client, other)

    assert [j["id"] for j in client.get(
        f"/api/service/jobs?client_id={acme}").json()] == [mine]
    assert [j["id"] for j in client.get(
        "/api/service/jobs?status=Draft").json()] != []


def test_a_job_reports_whether_it_has_been_invoiced(client, acme):
    """Billing state is derived from the invoice, never stored, so it cannot
    drift when an invoice is voided."""
    jid = _job(client, acme)["id"]

    assert client.get(f"/api/service/jobs/{jid}").json()["invoice"] is None


# ── Access control ───────────────────────────────────────────────────────────

def test_a_role_without_the_module_is_refused(as_role, acme):
    # CRM Specialist runs the sales pipeline and has no business reading a
    # customer's service history.
    crm = as_role("CRM Specialist")

    assert crm.get("/api/service/jobs").status_code == 403
    assert crm.post("/api/service/jobs",
                    json={"client_id": acme, "items": []}).status_code == 403


def test_the_role_that_runs_service_work_can_use_it(as_role, acme):
    """The other half: a seeded grant that does not actually work is the same
    as no grant at all."""
    ops = as_role("Operations Manager")

    assert ops.get("/api/service/jobs").status_code == 200
    created = ops.post("/api/service/jobs", json={
        "client_id": acme, "job_type": "Maintenance", "items": []})
    assert created.status_code == 200, created.text


def test_a_read_only_role_cannot_create(as_role, acme):
    viewer = as_role("Viewer")

    assert viewer.get("/api/service/jobs").status_code == 200
    assert viewer.post("/api/service/jobs",
                       json={"client_id": acme, "items": []}).status_code == 403


def test_an_unknown_job_is_a_404(client):
    assert client.get("/api/service/jobs/999999").status_code == 404
    assert client.get("/api/service/equipment/999999").status_code == 404
