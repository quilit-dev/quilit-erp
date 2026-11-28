"""Sales by address.

A customer's address is free text, so a location is the text as typed. What is
pinned here: the same text typed carelessly (case, spaces, a trailing comma) is
one place; voided invoices and credit notes are treated exactly as the Profit
Summary treats them; and money received is told apart from money billed.

The suite shares one database, so each test uses an address of its own and
reads only its own rows.
"""
import uuid
from datetime import date, timedelta

import pytest

from location_report import normalise


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


TODAY = date.today()


def _place():
    return f"Street {uuid.uuid4().hex[:6]}, Beirut"


def _customer(client, address, name=None):
    r = client.post("/api/clients/", json={"name": name or f"Buyer {uuid.uuid4().hex[:5]}",
                                           "address": address})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _zero_rate(client):
    rows = client.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    return next(r["id"] for r in rows if r.get("tax_type") == "zero")


def _invoice(client, cid, amount, tax_rate_id=None):
    item = {"name": "Goods", "quantity": 1, "unit_price": amount}
    if tax_rate_id:
        item["tax_rate_id"] = tax_rate_id
    r = client.post("/api/invoices/", json={"client_id": cid, "items": [item]})
    assert r.status_code == 200, r.text
    return r.json().get("invoice_id") or r.json().get("id")


def _pay(client, inv, amount):
    r = client.post(f"/api/invoices/{inv}/payments", json={
        "amount": amount, "method": "Cash", "currency": "USD",
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text


def _report(client, **params):
    params.setdefault("start", (TODAY - timedelta(days=1)).isoformat())
    params.setdefault("end", (TODAY + timedelta(days=1)).isoformat())
    r = client.get("/api/reports/sales-by-address", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _location(rep, address):
    return next((g for g in rep["locations"] if g["key"] == normalise(address)), None)


def test_the_same_address_typed_carelessly_is_one_place(client):
    place = _place()
    a = _customer(client, place)
    b = _customer(client, "  " + place.upper().replace(", ", ",   ") + ". ")
    _invoice(client, a, 300)
    _invoice(client, b, 200)

    g = _location(_report(client), place)
    assert g["customers"] == 2 and g["invoices"] == 2
    assert g["gross"] == 500
    assert {c["id"] for c in g["clients"]} == {a, b}
    assert g["clients"][0]["id"] == a, "the bigger customer first"


def test_billed_collected_and_outstanding(client):
    place = _place()
    cid = _customer(client, place)
    inv = _invoice(client, cid, 1000, _zero_rate(client))
    _pay(client, inv, 400)

    g = _location(_report(client), place)
    assert (g["sales"], g["gross"]) == (1000, 1000)
    assert (g["collected"], g["outstanding"]) == (400, 600)


def test_a_voided_invoice_is_not_a_sale(client):
    place = _place()
    cid = _customer(client, place)
    _invoice(client, cid, 900)
    gone = _invoice(client, cid, 1000)
    assert client.patch(f"/api/invoices/{gone}/void", json={"reason": "x"}).status_code == 200
    g = _location(_report(client), place)
    assert g["gross"] == 900 and g["invoices"] == 1


def test_a_credit_note_comes_off_the_place_it_was_sold_to(client):
    place = _place()
    cid = _customer(client, place)
    inv = _invoice(client, cid, 500, _zero_rate(client))
    lines = client.get(f"/api/returns/sales/invoice/{inv}/returnable").json()["lines"]
    r = client.post("/api/returns/sales", json={
        "invoice_id": inv, "reason": "Faulty",
        "lines": [{"invoice_item_id": lines[0]["invoice_item_id"], "quantity": 1}]})
    assert r.status_code == 200, r.text
    g = _location(_report(client), place)
    assert (g["sales"], g["gross"]) == (0, 0)


def test_a_customer_without_an_address_is_shown_apart(client):
    cid = _customer(client, "   ")
    _invoice(client, cid, 250)
    rep = _report(client)
    none = next(g for g in rep["locations"] if g["kind"] == "no_address")
    assert cid in {c["id"] for c in none["clients"]}
    assert rep["locations"][-1]["kind"] != "address", "real places are listed first"
    assert rep["summary"]["unlocated_sales"] >= 250


def test_the_period_decides(client):
    place = _place()
    _invoice(client, _customer(client, place), 700)
    later = _report(client, start=(TODAY + timedelta(days=30)).isoformat(),
                    end=(TODAY + timedelta(days=60)).isoformat())
    assert _location(later, place) is None
    bad = client.get("/api/reports/sales-by-address",
                     params={"start": "2026-02-01", "end": "2026-01-01"})
    assert bad.status_code == 400


def test_normalise():
    assert normalise(" Hamra,  BEIRUT. ") == "hamra, beirut"
    assert normalise(None) == "" and normalise(" , ") == ""


def test_a_place_is_named_as_its_biggest_customer_wrote_it(client):
    place = _place()
    _invoice(client, _customer(client, place.lower()), 50)
    _invoice(client, _customer(client, place), 5000)
    assert _location(_report(client), place)["address"] == place


def test_an_archived_customer_is_left_out(client):
    place = _place()
    kept = _customer(client, place)
    gone = _customer(client, place)
    _invoice(client, kept, 300)
    _invoice(client, gone, 900)
    assert client.patch(f"/api/clients/{gone}/archive", json={"reason": "closed"}).status_code == 200

    rep = _report(client)
    g = _location(rep, place)
    assert [c["id"] for c in g["clients"]] == [kept]
    assert (g["customers"], g["gross"]) == (1, 300)
    assert all(gone not in {c["id"] for c in x["clients"]} for x in rep["locations"])
    assert client.patch(f"/api/clients/{gone}/unarchive").status_code == 200
    assert _location(_report(client), place)["customers"] == 2, "restored, so back in"
