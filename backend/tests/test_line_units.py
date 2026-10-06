"""A line says what its quantity counts: 5 kg, 12 pcs, 3 m.

Stored on the line --- the unit it was sold in --- taken from the stock item
when the line is picked from stock, free text otherwise, and filled from the
stock item on read for a line written before units were stored.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Units " + uuid.uuid4().hex[:4]}).json()["id"]


def _stock(client, unit, name=None):
    r = client.post("/api/inventory/", json={
        "name": name or f"Flour {uuid.uuid4().hex[:5]}", "quantity": 100,
        "unit_cost": 1, "sale_price": 2, "unit": unit})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_a_line_picked_from_stock_carries_its_unit(client, acme):
    flour = _stock(client, "kg")
    inv = client.post("/api/invoices/", json={"client_id": acme, "items": [
        {"name": "Flour", "quantity": 5, "unit_price": 2, "inventory_id": flour}]}).json()
    body = client.get(f"/api/invoices/{inv.get('id') or inv.get('invoice_id')}").json()
    assert body["items"][0]["unit"] == "kg"


def test_a_unit_the_form_sends_wins_and_a_typed_line_has_none(client, acme):
    flour = _stock(client, "kg")
    inv = client.post("/api/invoices/", json={"client_id": acme, "items": [
        {"name": "Flour", "quantity": 1, "unit_price": 2, "inventory_id": flour, "unit": "bag"},
        {"name": "Delivery", "quantity": 1, "unit_price": 10}]}).json()
    items = client.get(f"/api/invoices/{inv.get('id') or inv.get('invoice_id')}").json()["items"]
    by = {i["name"]: i["unit"] for i in items}
    assert by == {"Flour": "bag", "Delivery": None}


def test_editing_an_invoice_keeps_the_units(client, acme):
    flour = _stock(client, "kg")
    inv = client.post("/api/invoices/", json={"client_id": acme, "items": [
        {"name": "Flour", "quantity": 5, "unit_price": 2, "inventory_id": flour}]}).json()
    iid = inv.get("id") or inv.get("invoice_id")
    full = client.get(f"/api/invoices/{iid}").json()
    r = client.put(f"/api/invoices/{iid}", json={
        "client_id": acme, "version": full["version"],
        "items": [{"name": "Flour", "quantity": 7, "unit_price": 2, "inventory_id": flour}]})
    assert r.status_code == 200, r.text
    assert client.get(f"/api/invoices/{iid}").json()["items"][0]["unit"] == "kg"


def test_a_quotation_carries_units_to_its_invoice(client, acme):
    cable = _stock(client, "m", name="Cable " + uuid.uuid4().hex[:4])
    q = client.post("/api/quotations/", json={"client_id": acme, "items": [
        {"name": "Cable", "quantity": 30, "unit_price": 1, "inventory_id": cable}]})
    assert q.status_code in (200, 201), q.text
    qid = q.json()["id"]
    assert client.get(f"/api/quotations/{qid}").json()["items"][0]["unit"] == "m"
    conv = client.post(f"/api/quotations/{qid}/convert-to-invoice").json()
    inv = client.get(f"/api/invoices/{conv['invoice_id']}").json()
    assert inv["items"][0]["unit"] == "m"


def test_an_older_line_without_a_stored_unit_reads_its_stock_items(client, acme, db):
    flour = _stock(client, "kg")
    inv = client.post("/api/invoices/", json={"client_id": acme, "items": [
        {"name": "Flour", "quantity": 5, "unit_price": 2, "inventory_id": flour}]}).json()
    iid = inv.get("id") or inv.get("invoice_id")
    db.execute("UPDATE invoice_items SET unit = NULL WHERE invoice_id = ?", (iid,))
    db.commit()
    assert client.get(f"/api/invoices/{iid}").json()["items"][0]["unit"] == "kg"


def test_a_till_sale_line_carries_the_unit(client, db):
    flour = _stock(client, "kg", name="Rice " + uuid.uuid4().hex[:4])
    client.post("/api/pos/session/open", json={"opening_float": 0})
    r = client.post("/api/pos/checkout", json={
        "items": [{"name": "Rice", "inventory_id": flour, "quantity": 2, "unit_price": 2}],
        "payment_method": "Cash", "amount_tendered": 4, "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    row = db.execute("SELECT unit FROM invoice_items ORDER BY id DESC LIMIT 1").fetchone()
    assert row["unit"] == "kg"
