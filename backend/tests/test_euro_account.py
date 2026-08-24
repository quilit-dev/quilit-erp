"""A customer whose account is in euro, from the rate to the ledger.

The rate book can hold a euro rate now. What matters is whether anything USES
it: a customer set to euro should be invoiced in euro and pay in euro, at the
rate somebody recorded, without an operator typing the number from memory into
every form.

The rate is the only input here. Every figure below follows from it, which is
what makes a wrong one expensive: at the pound rate, a €100 payment books as
eleven cents.
"""
import uuid
from datetime import date, timedelta

import pytest as _pytest

pytestmark = _pytest.mark.critical

EUR_PER_USD = 0.92          # 1 USD = 0.92 EUR, so €92 is $100
LBP_PER_USD = 89000


@_pytest.fixture
def admin(as_role):
    return as_role("superadmin")


@_pytest.fixture
def priced(admin):
    """A business that has recorded what a euro and a pound are worth."""
    admin.post("/api/settings/exchange-rate",
               json={"rate": LBP_PER_USD, "currency": "LBP"})
    admin.post("/api/settings/exchange-rate",
               json={"rate": EUR_PER_USD, "currency": "EUR"})
    return admin


@_pytest.fixture
def euro_client(priced):
    return priced.post("/api/clients/", json={
        "name": "Bruxelles SA", "preferred_currency": "EUR"}).json()["id"]


def _invoice(c, cid, unit_price=100):
    r = c.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "due_date": str(date.today() + timedelta(days=30)),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": unit_price}]}).json()
    return r.get("invoice_id") or r.get("id")


def _pay(c, cid, amount, currency="EUR", rate=None):
    body = {"amount": amount, "currency": currency, "method": "Cash",
            "idempotency_key": str(uuid.uuid4())}
    if rate is not None:
        body["exchange_rate"] = rate
    return c.post(f"/api/clients/{cid}/payments", json=body)


# ── The rate reaches the invoice ─────────────────────────────────────────────

def test_a_euro_customer_is_invoiced_in_euro(priced, euro_client):
    inv = _invoice(priced, euro_client)

    body = priced.get(f"/api/invoices/{inv}").json()

    assert body["currency"] == "EUR"
    assert float(body["exchange_rate"]) == _pytest.approx(EUR_PER_USD)


def test_the_invoice_carries_both_figures(priced, euro_client):
    """What the customer owes in their money, and what it is worth in the
    company's. Neither is derived at read time, so neither can drift."""
    inv = _invoice(priced, euro_client, unit_price=92)

    body = priced.get(f"/api/invoices/{inv}").json()

    assert body["txn_amount"] == _pytest.approx(92, abs=0.01)      # euro
    assert body["amount"] == _pytest.approx(100, abs=0.01)         # dollars


def test_without_a_rate_the_refusal_names_the_customer(admin):
    """Not "no rate configured" — which reads as a system fault — but which
    customer is set to a currency nobody has priced."""
    cid = admin.post("/api/clients/", json={
        "name": "Bruxelles SA", "preferred_currency": "EUR"}).json()["id"]

    r = admin.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": str(date.today()),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": 100}]})

    assert r.status_code == 400
    assert "Bruxelles SA" in r.text
    assert "EUR" in r.text


# ── The rate reaches the payment ─────────────────────────────────────────────

def test_a_euro_payment_uses_the_stored_rate_without_being_told(priced, euro_client):
    """The operator sends no rate. The one recorded in the book applies."""
    inv = _invoice(priced, euro_client, unit_price=92)

    r = _pay(priced, euro_client, 92)

    assert r.status_code == 200, r.text
    assert r.json()["amount"] == _pytest.approx(100, abs=0.01)
    assert priced.get(f"/api/invoices/{inv}").json()["remaining"] \
        == _pytest.approx(0, abs=0.01)


def test_it_uses_the_euro_rate_and_not_the_pound_one(priced, euro_client):
    """The bug this is really about: with only one rate readable, a euro
    payment was booked at 89,000 and €92 became a tenth of a cent."""
    _invoice(priced, euro_client, unit_price=92)

    r = _pay(priced, euro_client, 92)

    assert r.json()["amount"] == _pytest.approx(100, abs=0.01)
    assert r.json()["amount"] != _pytest.approx(92 / LBP_PER_USD, abs=0.01)


def test_the_operator_can_still_override_the_rate(priced, euro_client):
    """A cashier handed euro at a rate the street agreed on has better
    information than a table somebody updated on Monday."""
    _invoice(priced, euro_client, unit_price=92)

    r = _pay(priced, euro_client, 92, rate=0.5)

    assert r.json()["amount"] == _pytest.approx(184, abs=0.01)


def test_a_payment_in_pounds_from_a_euro_customer_uses_the_pound_rate(
        priced, euro_client):
    """The account's currency is not a cage. What decides the rate is what was
    handed over."""
    _invoice(priced, euro_client, unit_price=92)

    r = _pay(priced, euro_client, 8900, currency="LBP")

    assert r.status_code == 200, r.text
    assert r.json()["amount"] == _pytest.approx(0.10, abs=0.01)


def test_the_rate_in_force_on_the_day_is_the_one_applied(priced, euro_client, db):
    """A rate recorded today does not restate what a payment last week was
    worth — and a conversion dated last week does not use today's."""
    import currency as currency_mod

    old = (date.today() - timedelta(days=20)).isoformat()
    priced.post("/api/settings/exchange-rate",
                json={"rate": 0.8, "currency": "EUR", "effective_date": old})

    assert currency_mod.rate_on(db, "EUR", old) == _pytest.approx(0.8)
    assert currency_mod.rate_on(db, "EUR", str(date.today())) \
        == _pytest.approx(EUR_PER_USD)


# ── And the books still balance ──────────────────────────────────────────────

def test_the_ledger_balances_after_a_euro_payment(priced, euro_client):
    _invoice(priced, euro_client, unit_price=92)

    _pay(priced, euro_client, 92)

    assert priced.get("/api/accounting/trial-balance").json()["balanced"]


def test_the_payment_is_recorded_in_the_money_it_was_made_in(priced, euro_client, db):
    """The customer handed over euro. The receipt has to be able to say so,
    which means the euro figure is stored beside the converted one."""
    _invoice(priced, euro_client, unit_price=92)

    _pay(priced, euro_client, 92)

    row = db.execute("SELECT paid_currency, paid_amount, amount "
                     "FROM invoice_payments ORDER BY id DESC LIMIT 1").fetchone()
    assert row["paid_currency"] == "EUR"
    assert float(row["paid_amount"]) == _pytest.approx(92, abs=0.01)
    assert float(row["amount"]) == _pytest.approx(100, abs=0.01)
