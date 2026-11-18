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



# ── Voided invoices stay out of the finance detail ─────────────────────────
def test_a_voided_invoice_does_not_count_in_the_finance_breakdown(client, acme):
    """A client with a 900 sale and a voided 1,000 one received 900, not 1,900.
    Voiding keeps the payment row, so the detail has to filter it out the way
    the totals beside it do."""
    kept = _invoice(client, acme, 900)
    _pay(client, kept, 900)
    gone = _invoice(client, acme, 1000)
    _pay(client, gone, 1000)
    client.patch(f"/api/invoices/{gone}/void", json={"reason": "cancelled"})

    from datetime import date
    today = date.today().isoformat()
    detail = client.get("/api/finance/range-detail", params={"start": today, "end": today}).json()
    mine = [r for r in detail["income_records"] if r["client_name"] == "Revenue Co"]
    assert sum(r["amount"] for r in mine) == _pytest.approx(900)
    summary = client.get("/api/finance/range-summary", params={"start": today, "end": today}).json()
    assert sum(r["amount"] for r in detail["income_records"]) == _pytest.approx(summary["income"])


# ── A customer on instalments owes what falls due in the period ───────────
def test_an_invoice_plan_shows_only_what_falls_due_in_the_chosen_dates(client, acme):
    inv = _invoice(client, acme, 1200)
    r = client.post(f"/api/invoices/{inv}/plan", json={"count": 4, "start_date": "2027-01-15"})
    assert r.status_code == 200, r.text            # 300 on 15 Jan, Feb, Mar, Apr 2027

    feb = _row(client, acme, start="2027-02-01", end="2027-02-28")
    assert feb["on_plan"] is True
    assert feb["outstanding"] == _pytest.approx(300), "one instalment, not the whole 1,200"
    assert feb["overdue_before"] == _pytest.approx(0), "January is not overdue yet: it is still to come"

    q1 = _row(client, acme, start="2027-01-01", end="2027-03-31")
    assert q1["outstanding"] == _pytest.approx(900)


def test_a_part_payment_comes_off_the_earliest_instalment_first(client, acme):
    inv = _invoice(client, acme, 1200)
    client.post(f"/api/invoices/{inv}/plan", json={"count": 4, "start_date": "2027-01-15"})
    _pay(client, inv, 450)                          # January settled, February half

    assert _row(client, acme, start="2027-01-01", end="2027-01-31")["outstanding"] == _pytest.approx(0)
    assert _row(client, acme, start="2027-02-01", end="2027-02-28")["outstanding"] == _pytest.approx(150)


def test_an_account_plan_shows_only_what_falls_due_in_the_chosen_dates(client):
    cid = client.post("/api/clients/", json={"name": "Plan Co", "allow_installments": True}).json()["id"]
    _invoice(client, cid, 800)
    r = client.post(f"/api/clients/{cid}/plan", json={"count": 4, "start_date": "2027-01-10"})
    assert r.status_code == 200, r.text            # 200 a month from January 2027

    row = _row(client, cid, start="2027-02-01", end="2027-02-28")
    assert row["on_plan"] is True and row["outstanding"] == _pytest.approx(200)


def test_a_customer_without_a_plan_is_unchanged(client, acme):
    _invoice(client, acme, 500)
    row = _row(client, acme)
    assert row["on_plan"] is False and row["outstanding"] == 500


def test_instalments_missed_before_the_period_are_reported_beside_it(client, acme):
    inv = _invoice(client, acme, 1200)
    client.post(f"/api/invoices/{inv}/plan", json={"count": 4, "start_date": "2026-01-15"})

    march = _row(client, acme, start="2026-03-01", end="2026-03-31")
    assert march["outstanding"] == _pytest.approx(300)
    assert march["overdue_before"] == _pytest.approx(600), "January and February, still unpaid"
