"""Exporting a period: invoices, quotations and till sales by date.

The export button asks for a period --- last month, this year, a from-to ---
and the lists it reads must honour it on the server, inclusive at both ends.
The till history is also capped at 200 rows for the screen; an export asks
for every sale in the period, or a month's figures would be silently cut.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _cid(client):
    return client.post("/api/clients/", json={"name": "C " + uuid.uuid4().hex[:5]}).json()["id"]


def _set_date(db, table, row_id, day):
    db.execute(f"UPDATE {table} SET created_at = ? WHERE id = ?", (day + " 10:00:00", row_id))
    db.commit()


def _ids(body):
    rows = body if isinstance(body, list) else body.get("items", [])
    return {r["id"] for r in rows}


def test_invoices_can_be_listed_for_a_period(client, db):
    cid = _cid(client)
    made = {}
    for day in ("2026-08-31", "2026-09-01", "2026-09-30", "2026-10-01"):
        r = client.post("/api/invoices/", json={
            "client_id": cid, "items": [{"name": "x", "quantity": 1, "unit_price": 10}]}).json()
        made[day] = r.get("id") or r.get("invoice_id")
        _set_date(db, "invoices", made[day], day)

    body = client.get("/api/invoices/", params={"date_from": "2026-09-01",
                                                "date_to": "2026-09-30"}).json()
    got = _ids(body) & set(made.values())
    assert got == {made["2026-09-01"], made["2026-09-30"]}, "both ends are inclusive"


def test_invoice_dates_combine_with_the_other_filters(client, db):
    a, b = _cid(client), _cid(client)
    ia = client.post("/api/invoices/", json={"client_id": a, "items": [{"name": "x", "quantity": 1, "unit_price": 1}]}).json()
    ib = client.post("/api/invoices/", json={"client_id": b, "items": [{"name": "x", "quantity": 1, "unit_price": 1}]}).json()
    for inv in (ia, ib):
        _set_date(db, "invoices", inv.get("id") or inv.get("invoice_id"), "2026-09-10")
    body = client.get("/api/invoices/", params={"client_id": a, "date_from": "2026-09-01",
                                                "date_to": "2026-09-30"}).json()
    assert _ids(body) == {ia.get("id") or ia.get("invoice_id")}


def test_quotations_can_be_listed_for_a_period(client, db):
    cid = _cid(client)
    made = {}
    for day in ("2026-08-31", "2026-09-15", "2026-10-01"):
        r = client.post("/api/quotations/", json={
            "client_id": cid, "items": [{"name": "x", "quantity": 1, "unit_price": 10}]})
        assert r.status_code in (200, 201), r.text
        made[day] = r.json()["id"]
        _set_date(db, "quotations", made[day], day)
    body = client.get("/api/quotations/", params={"date_from": "2026-09-01",
                                                  "date_to": "2026-09-30"}).json()
    assert _ids(body) & set(made.values()) == {made["2026-09-15"]}


def _till_sale(client, n=1):
    client.post("/api/pos/session/open", json={"opening_float": 0})
    name = "Item " + uuid.uuid4().hex[:6]
    item = client.post("/api/inventory/", json={
        "name": name, "quantity": 1000, "unit_cost": 1, "sale_price": 2}).json()["id"]
    for _ in range(n):
        r = client.post("/api/pos/checkout", json={
            "items": [{"name": name, "inventory_id": item, "quantity": 1, "unit_price": 2}],
            "payment_method": "Cash", "amount_tendered": 2,
            "idempotency_key": str(uuid.uuid4())})
        assert r.status_code == 200, r.text


def test_till_sales_can_be_listed_for_a_period(client, db):
    _till_sale(client, 3)
    ids = [r["id"] for r in db.execute("SELECT id FROM pos_sales ORDER BY id").fetchall()]
    for sid, day in zip(ids, ("2026-08-31", "2026-09-15", "2026-10-01")):
        _set_date(db, "pos_sales", sid, day)
    rows = client.get("/api/pos/sales", params={"date_from": "2026-09-01",
                                                "date_to": "2026-09-30", "limit": 0}).json()
    assert [r["id"] for r in rows] == [ids[1]]


def test_the_till_history_keeps_its_200_cap_but_an_export_does_not(client, db):
    _till_sale(client, 205)
    assert len(client.get("/api/pos/sales").json()) == 200, "the screen still shows the latest 200"
    assert len(client.get("/api/pos/sales", params={"limit": 0}).json()) == 205
