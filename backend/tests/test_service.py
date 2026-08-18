"""Service — a record of completed work, and the equipment it was done on.

The module is deliberately one action wide: recording a service consumes its
parts, posts their cost and raises the invoice together, because they describe
one real event. Cancelling reverses all three. There is no draft, no schedule
and no start/finish ladder, so there are no transitions to test — only that
recording does everything, and cancelling undoes everything.

The money invariants live in test_service_money.py and test_service_billing.py.
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


def _charge(name, price):
    return {"line_type": "charge", "name": name, "quantity": 1, "unit_price": price}


def _service(client, acme, **extra):
    body = {"client_id": acme, "job_type": "Repair",
            "reported_fault": "Fan not spinning", "items": [_charge("Labour", 100)]}
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
    """The reason equipment is a record and not a text field on the service."""
    a = _service(client, acme, equipment_id=oven, reported_fault="Fan")
    b = _service(client, acme, equipment_id=oven, reported_fault="Thermostat")

    history = client.get(f"/api/service/equipment/{oven}").json()["jobs"]

    assert {j["id"] for j in history} == {a["id"], b["id"]}


def test_equipment_with_history_cannot_be_archived(client, acme, oven):
    """Archiving would orphan the history that is the reason for registering
    the machine at all."""
    _service(client, acme, equipment_id=oven)

    r = client.patch(f"/api/service/equipment/{oven}/archive")

    assert r.status_code == 400
    assert "reference this equipment" in r.json()["detail"]


def test_a_cancelled_service_does_not_block_archiving(client, acme, oven):
    """It was a mistake, not a visit."""
    job = _service(client, acme, equipment_id=oven)
    client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "duplicate"})

    assert client.patch(f"/api/service/equipment/{oven}/archive").status_code == 200
    assert client.get("/api/service/equipment").json() == []
    assert client.patch(f"/api/service/equipment/{oven}/unarchive").status_code == 200


# ── Recording a service ──────────────────────────────────────────────────────

def test_a_service_gets_a_numbered_reference(client, acme):
    job = _service(client, acme)

    assert job["job_number"].startswith("SVC-")
    # Derived from the row id, so two concurrent records cannot collide.
    assert job["job_number"].endswith(f"{job['id']:04d}")


def test_the_number_prefix_is_a_setting(client, acme):
    assert client.put("/api/settings/", json={"service_job_prefix": "WO-"}).status_code == 200

    assert _service(client, acme)["job_number"].startswith("WO-")


def test_a_service_is_complete_the_moment_it_is_recorded(client, acme):
    """There is no draft: by the time anyone types it in, the work is done."""
    job = _service(client, acme)

    assert client.get(f"/api/service/jobs/{job['id']}").json()["status"] == "Completed"


def test_the_service_date_defaults_to_today_and_is_settable(client, acme):
    """A technician often writes up yesterday's visit this morning."""
    today = _service(client, acme)
    dated = _service(client, acme, service_date="2026-01-15")

    assert client.get(f"/api/service/jobs/{today['id']}").json()["completed_at"]
    assert client.get(
        f"/api/service/jobs/{dated['id']}").json()["completed_at"] == "2026-01-15"


def test_a_service_totals_its_lines(client, acme):
    job = _service(client, acme, items=[_charge("Callout", 50), _charge("Labour", 120)])
    d = client.get(f"/api/service/jobs/{job['id']}").json()

    assert d["subtotal"] == pytest.approx(170)
    assert d["total"] == pytest.approx(d["subtotal"] + d["tax_total"])


def test_equipment_must_belong_to_the_service_s_client(client, acme, oven):
    other = client.post("/api/clients/", json={"name": "Other Co"}).json()["id"]

    r = client.post("/api/service/jobs", json={
        "client_id": other, "equipment_id": oven, "items": []})

    assert r.status_code == 400
    assert "different client" in r.json()["detail"]


def test_an_unknown_service_type_is_refused(client, acme):
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


# ── The lifecycle that no longer exists ──────────────────────────────────────

@pytest.mark.parametrize("path", ["schedule", "start", "complete", "reopen"])
def test_the_removed_transitions_are_gone(client, acme, path):
    """The ladder was replaced by a single record-and-invoice step. These must
    not linger as half-working endpoints."""
    job = _service(client, acme)

    r = client.post(f"/api/service/jobs/{job['id']}/{path}", json={})

    assert r.status_code in (404, 405), f"{path} still responds"


def test_a_recorded_service_cannot_be_edited(client, acme):
    """Its lines are the record of what was consumed and billed. Cancelling and
    re-recording is the correction."""
    job = _service(client, acme)

    r = client.put(f"/api/service/jobs/{job['id']}",
                   json={"client_id": acme, "items": []})

    assert r.status_code in (404, 405)


# ── Cancelling ───────────────────────────────────────────────────────────────

def test_cancelling_marks_it_cancelled(client, acme):
    job = _service(client, acme)

    r = client.post(f"/api/service/jobs/{job['id']}/cancel",
                    json={"reason": "wrong customer"})

    assert r.status_code == 200
    assert client.get(f"/api/service/jobs/{job['id']}").json()["status"] == "Cancelled"


def test_cancelling_twice_is_refused(client, acme):
    job = _service(client, acme)
    client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "x"})

    again = client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "x"})

    assert again.status_code == 400
    assert "already cancelled" in again.json()["detail"].lower()


# ── Filters ──────────────────────────────────────────────────────────────────

def test_services_can_be_filtered_by_client(client, acme):
    other = client.post("/api/clients/", json={"name": "Other Co"}).json()["id"]
    mine = _service(client, acme)["id"]
    _service(client, other)

    assert [j["id"] for j in client.get(
        f"/api/service/jobs?client_id={acme}").json()] == [mine]


# ── Access control ───────────────────────────────────────────────────────────

def test_a_role_without_the_module_is_refused(as_role, acme):
    # CRM Specialist runs the sales pipeline and has no business reading a
    # customer's service history.
    crm = as_role("CRM Specialist")

    assert crm.get("/api/service/jobs").status_code == 403
    assert crm.post("/api/service/jobs",
                    json={"client_id": acme, "items": []}).status_code == 403


def test_the_role_that_runs_service_work_can_use_it(as_role, acme):
    ops = as_role("Operations Manager")

    assert ops.get("/api/service/jobs").status_code == 200
    created = ops.post("/api/service/jobs", json={
        "client_id": acme, "job_type": "Maintenance",
        "items": [_charge("Labour", 50)]})
    assert created.status_code == 200, created.text


def test_a_read_only_role_cannot_record(as_role, acme):
    viewer = as_role("Viewer")

    assert viewer.get("/api/service/jobs").status_code == 200
    assert viewer.post("/api/service/jobs",
                       json={"client_id": acme, "items": []}).status_code == 403


def test_an_unknown_service_is_a_404(client):
    assert client.get("/api/service/jobs/999999").status_code == 404
    assert client.get("/api/service/equipment/999999").status_code == 404
