"""Revenue by customer, and where each customer's revenue came from.

The report already said how much a customer had paid. What it could not say is
which part of the business earned it — a customer who buys at the till and also
runs an account is two different relationships, and the totals hid that.

Revenue here is cash, because that is when this system recognises it. These
tests hold that line: an invoice raised is not revenue until it is paid.
"""
import uuid

import pytest as _pytest


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Revenue Co"}).json()["id"]


def _invoice(client, cid, amount=100):
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-03-31",
        "items": [{"name": "Item", "quantity": 1, "unit_price": amount}]}).json()
    return created.get("invoice_id") or created.get("id")


def _pay(client, inv, amount):
    return client.post(f"/api/invoices/{inv}/payments", json={
        "amount": amount, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})


def _row(client, cid, **params):
    rows = client.get("/api/reports/clients", params=params).json()
    return next(r for r in rows if r["id"] == cid)


def test_an_unpaid_invoice_is_not_revenue(client, acme):
    _invoice(client, acme, 500)

    row = _row(client, acme)

    assert row["total_invoiced"] == 500
    assert row["total_paid"] == 0
    assert row["revenue_by_source"] == {}
    assert row["outstanding"] == 500


def test_the_money_is_attributed_to_where_it_came_from(client, acme):
    inv = _invoice(client, acme, 500)
    _pay(client, inv, 300)

    row = _row(client, acme)

    assert row["revenue_by_source"] == {"sales": 300}
    assert row["total_paid"] == 300


def test_the_breakdown_adds_up_to_the_total(client, acme):
    """If the parts and the total disagree, one of them is wrong and the
    reader has no way to tell which."""
    a, b = _invoice(client, acme, 100), _invoice(client, acme, 250)
    _pay(client, a, 100)
    _pay(client, b, 125)

    row = _row(client, acme)

    assert sum(row["revenue_by_source"].values()) == _pytest.approx(row["total_paid"])


def test_a_voided_invoice_takes_its_revenue_with_it(client, acme):
    inv = _invoice(client, acme, 400)
    _pay(client, inv, 400)
    client.patch(f"/api/invoices/{inv}/void", json={"reason": "cancelled"})

    row = _row(client, acme)

    assert row["total_paid"] == 0
    assert row["revenue_by_source"] == {}


def test_payments_outside_the_period_are_not_counted(client, acme):
    inv = _invoice(client, acme, 100)
    _pay(client, inv, 100)

    row = _row(client, acme, start="2000-01-01", end="2000-12-31")

    assert row["total_paid"] == 0
    assert row["revenue_by_source"] == {}
