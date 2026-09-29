"""A part-paid invoice keeps its amounts, but its due date and notes can move.

The metadata-only branch read its row count with `SELECT changes()`, which is
SQLite's; on PostgreSQL every such edit was a 500. Run this with
DB_BACKEND=postgres to cover the path that broke.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _part_paid(client):
    cid = client.post("/api/clients/", json={"name": "Due Date Co"}).json()["id"]
    inv = client.post("/api/invoices/", json={
        "client_id": cid, "due_date": "2026-10-01",
        "items": [{"name": "Service", "quantity": 1, "unit_price": 100}]}).json()
    iid = inv.get("id") or inv.get("invoice_id")
    r = client.post(f"/api/invoices/{iid}/payments", json={
        "amount": 40, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return cid, iid


def test_the_due_date_of_a_part_paid_invoice_can_be_changed(client):
    cid, iid = _part_paid(client)
    full = client.get(f"/api/invoices/{iid}").json()
    r = client.put(f"/api/invoices/{iid}", json={
        "client_id": cid, "due_date": "2026-11-15", "notes": "extended",
        "version": full["version"],
        "items": [{"name": "Service", "quantity": 1, "unit_price": 100}]})
    assert r.status_code == 200, r.text
    after = client.get(f"/api/invoices/{iid}").json()
    assert after["due_date"][:10] == "2026-11-15"
    assert after["notes"] == "extended"
    assert float(after["amount"]) == pytest.approx(100), "amounts stay locked"


def test_a_stale_version_is_still_a_conflict(client):
    cid, iid = _part_paid(client)
    full = client.get(f"/api/invoices/{iid}").json()
    r = client.put(f"/api/invoices/{iid}", json={
        "client_id": cid, "due_date": "2026-11-15", "version": full["version"] - 1,
        "items": [{"name": "Service", "quantity": 1, "unit_price": 100}]})
    assert r.status_code == 409
