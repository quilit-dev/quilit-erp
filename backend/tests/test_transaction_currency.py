"""A document remembers the currency it was agreed in.

The customer agreed EUR 5,000. That is what their invoice says, what their
receipt says, and what their statement says — for ever, whatever the rate does
afterwards. The company reports in dollars, so the same document also carries
what it was worth in dollars on the day it was recognised.

Both are stored. Neither is derived from the other at read time, because a rate
entered next month must not restate an invoice issued today: a receivable that
changes value whenever somebody edits a rate table is not a receivable.

The base figures live in the columns that were always there, so every report,
balance and ledger posting goes on reading exactly what it read before.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def rates(db):
    """1 EUR = 1.10 USD, i.e. 0.909091 EUR per dollar."""
    for cur, rate, when in (("EUR", 0.909091, "2020-01-01"),
                            ("LBP", 90000, "2020-01-01")):
        db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
                   "VALUES (?,?,?,?)", (cur, rate, when, when))
    db.commit()


@_pytest.fixture
def euro_customer(client, rates):
    return client.post("/api/clients/", json={
        "name": "Euro Customer", "preferred_currency": "EUR"}).json()["id"]


@_pytest.fixture
def dollar_customer(client):
    return client.post("/api/clients/", json={"name": "Dollar Customer"}).json()["id"]


def _invoice(client, cid, unit_price, qty=1, **kw):
    body = {"client_id": cid, "amount": 0, "due_date": "2026-06-30",
            "items": [{"name": "Goods", "quantity": qty, "unit_price": unit_price}]}
    body.update(kw)
    return client.post("/api/invoices/", json=body)


def _id(response):
    """The new invoice's id. The create response names it `invoice_id` on some
    paths and `id` on others."""
    body = response.json()
    return body.get("invoice_id") or body.get("id")


# ── The example from the brief ───────────────────────────────────────────────

def test_a_euro_invoice_keeps_its_euro_figure_and_carries_a_dollar_value(
        client, euro_customer):
    """EUR 5,000 at 1.10 is USD 5,500. The customer sees the first, the
    company reports the second, and both are on the document."""
    created = _invoice(client, euro_customer, 5000)
    assert created.status_code == 200, created.text
    inv = created.json().get("invoice_id") or created.json().get("id")

    body = client.get(f"/api/invoices/{inv}").json()

    assert body["currency"] == "EUR"
    assert body["txn_amount"] == _pytest.approx(5000)
    assert body["amount"] == _pytest.approx(5500, abs=0.01)


def test_the_rate_used_is_written_onto_the_document(client, euro_customer):
    inv = _id(_invoice(client, euro_customer, 5000))

    body = client.get(f"/api/invoices/{inv}").json()

    assert body["exchange_rate"] == _pytest.approx(0.909091)


def test_a_later_rate_does_not_restate_an_invoice_already_issued(
        client, euro_customer, db):
    """The requirement that makes the stored rate necessary. A receivable that
    moves whenever somebody edits a rate table is not a receivable."""
    inv = _id(_invoice(client, euro_customer, 5000))
    before = client.get(f"/api/invoices/{inv}").json()

    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.5, '2026-06-01', '2026-06-01')")
    db.commit()

    after = client.get(f"/api/invoices/{inv}").json()
    assert after["amount"] == _pytest.approx(before["amount"])
    assert after["txn_amount"] == _pytest.approx(before["txn_amount"])
    assert after["exchange_rate"] == _pytest.approx(before["exchange_rate"])


# ── Nothing that already worked changed ──────────────────────────────────────

def test_a_dollar_customer_is_completely_unaffected(client, dollar_customer):
    """The whole design rests on this: the base columns still mean what they
    always meant, so every report and posting reads them unchanged."""
    inv = _id(_invoice(client, dollar_customer, 250))

    body = client.get(f"/api/invoices/{inv}").json()

    assert body["currency"] == "USD"
    assert body["amount"] == _pytest.approx(250)
    assert body["exchange_rate"] == _pytest.approx(1)


def test_the_ledger_records_the_base_value(client, euro_customer):
    """The company's books are in dollars. A euro invoice raises a receivable
    of 5,500, not 5,000."""
    inv = _id(_invoice(client, euro_customer, 5000))

    entries = client.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]

    receivable = next(e for e in entries if e["source_type"] == "invoice")
    assert receivable["total_debit"] == _pytest.approx(5500, abs=0.01)
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_the_lines_carry_both_prices_and_each_side_adds_up(client, euro_customer):
    """Converting the total afterwards leaves the base lines not summing to the
    base total, and the revenue split reads the lines."""
    inv = _id(_invoice(client, euro_customer, 1000, qty=3))

    body = client.get(f"/api/invoices/{inv}").json()

    line = body["items"][0]
    assert line["txn_unit_price"] == _pytest.approx(1000)
    assert line["unit_price"] == _pytest.approx(1100, abs=0.01)
    # Each side sums to its own total.
    assert body["txn_amount"] == _pytest.approx(3000)
    assert body["amount"] == _pytest.approx(3300, abs=0.02)


# ── Refusals ─────────────────────────────────────────────────────────────────

def test_a_customer_in_a_currency_with_no_rate_cannot_be_invoiced(client, db):
    """A euro invoice has no dollar value without a rate. Issuing it in dollars
    instead would contradict the terms the customer was given."""
    cid = client.post("/api/clients/", json={
        "name": "Rateless", "preferred_currency": "EUR"}).json()["id"]

    r = _invoice(client, cid, 100)

    assert r.status_code == 400
    # The message has to say which of the two things to go and fix.
    assert "Rateless" in r.text and "EUR" in r.text


def test_an_explicit_rate_beats_the_table(client, euro_customer):
    """A rate somebody negotiated is a decision they made, and the document
    records it rather than quietly substituting the official figure."""
    inv = _id(_invoice(client, euro_customer, 1000,
                   exchange_rate=0.8))

    body = client.get(f"/api/invoices/{inv}").json()

    assert body["exchange_rate"] == _pytest.approx(0.8)
    assert body["amount"] == _pytest.approx(1250, abs=0.01)


def test_the_currency_can_be_given_explicitly_against_the_customers_default(
        client, euro_customer):
    inv = _id(_invoice(client, euro_customer, 300, currency="USD"))

    body = client.get(f"/api/invoices/{inv}").json()

    assert body["currency"] == "USD"
    assert body["amount"] == _pytest.approx(300)
