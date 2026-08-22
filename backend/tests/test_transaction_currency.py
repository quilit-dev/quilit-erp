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


# ── Settling in a currency that has moved ────────────────────────────────────

def _pay(client, inv, amount, currency="EUR", **kw):
    body = {"amount": amount, "currency": currency, "method": "Cash",
            "idempotency_key": str(uuid.uuid4())}
    body.update(kw)
    return client.post(f"/api/invoices/{inv}/payments", json=body)


def test_paying_the_agreed_euro_in_full_clears_the_invoice(client, euro_customer, db):
    """The customer owes EUR 5,000. They pay EUR 5,000. Nothing is outstanding
    — whatever the dollar did in between."""
    inv = _id(_invoice(client, euro_customer, 5000))
    # The euro weakens: 1 EUR = 1.05 USD rather than 1.10.
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.952381, '2026-01-01', '2026-01-01')")
    db.commit()

    r = _pay(client, inv, 5000, exchange_rate=0.952381)

    assert r.status_code == 200, r.text
    body = client.get(f"/api/invoices/{inv}").json()
    assert body["remaining"] == _pytest.approx(0, abs=0.01)


def test_the_shortfall_is_posted_as_a_realised_loss(client, euro_customer, db):
    """A 5,500 claim that brought in 5,250 of cash left the company 250 worse
    off. That is a loss, not a rounding error, and the books have to say so."""
    inv = _id(_invoice(client, euro_customer, 5000))
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.952381, '2026-01-01', '2026-01-01')")
    db.commit()

    _pay(client, inv, 5000, exchange_rate=0.952381)

    entries = client.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]
    payment = next(e for e in entries if e["source_type"] == "invoice_payment")
    fx = [l for l in payment["lines"] if l["account_code"] in ("6920", "4910")]
    assert fx, "no exchange difference was posted"
    assert fx[0]["debit"] == _pytest.approx(250, abs=0.02)   # 6920, a loss
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_a_stronger_euro_posts_a_gain(client, euro_customer, db):
    inv = _id(_invoice(client, euro_customer, 5000))
    # 1 EUR = 1.20 USD.
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.833333, '2026-01-01', '2026-01-01')")
    db.commit()

    _pay(client, inv, 5000, exchange_rate=0.833333)

    entries = client.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]
    payment = next(e for e in entries if e["source_type"] == "invoice_payment")
    gain = [l for l in payment["lines"] if l["account_code"] == "4910"]
    assert gain and gain[0]["credit"] == _pytest.approx(500, abs=0.02)
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_the_receivable_is_fully_relieved(client, euro_customer, db):
    """The point of relieving at the recognition rate. Relieve at the
    settlement rate instead and the receivable carries a balance for a debt
    the customer has paid, for ever."""
    inv = _id(_invoice(client, euro_customer, 5000))
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.952381, '2026-01-01', '2026-01-01')")
    db.commit()

    _pay(client, inv, 5000, exchange_rate=0.952381)

    tb = client.get("/api/accounting/trial-balance").json()
    ar = next((r for r in tb["rows"] if r["code"] == "1100"), None)
    outstanding = 0 if not ar else round(float(ar["debit"]) - float(ar["credit"]), 2)
    assert outstanding == _pytest.approx(0, abs=0.02)


def test_the_payment_records_what_it_settled_and_what_it_cost(client,
                                                              euro_customer, db):
    inv = _id(_invoice(client, euro_customer, 5000))
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.952381, '2026-01-01', '2026-01-01')")
    db.commit()

    _pay(client, inv, 5000, exchange_rate=0.952381)

    row = db.execute("SELECT * FROM invoice_payments WHERE invoice_id=?",
                     (inv,)).fetchone()
    assert row["txn_amount"] == _pytest.approx(5000)       # euro settled
    assert row["paid_amount"] == _pytest.approx(5000)      # euro handed over
    assert row["amount"] == _pytest.approx(5500, abs=0.01)  # claim relieved
    assert row["fx_difference"] == _pytest.approx(-250, abs=0.02)


def test_a_dollar_invoice_posts_no_exchange_difference(client, dollar_customer):
    """The shape of an ordinary payment must not change at all."""
    inv = _id(_invoice(client, dollar_customer, 400))

    _pay(client, inv, 400, currency="USD")

    entries = client.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]
    payment = next(e for e in entries if e["source_type"] == "invoice_payment")
    assert not [l for l in payment["lines"]
                if l["account_code"] in ("6920", "4910")]
    assert client.get(f"/api/invoices/{inv}").json()["remaining"] == _pytest.approx(0)


# ── The statement the customer reads ─────────────────────────────────────────

def test_the_statement_is_written_in_the_customers_currency(client, euro_customer, db):
    """The document they asked for, in the money they were billed in."""
    inv = _id(_invoice(client, euro_customer, 5000))
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.952381, '2026-01-01', '2026-01-01')")
    db.commit()
    _pay(client, inv, 2000, exchange_rate=0.952381)

    st = client.get(f"/api/clients/{euro_customer}/statement").json()

    assert st["currency"] == "EUR"
    assert st["total_charged"] == _pytest.approx(5000)
    assert st["total_paid"] == _pytest.approx(2000)
    assert st["closing_balance"] == _pytest.approx(3000)


def test_the_company_figures_travel_beside_them(client, euro_customer):
    """Same statement, both readings: the customer's and the company's."""
    _invoice(client, euro_customer, 5000)

    st = client.get(f"/api/clients/{euro_customer}/statement").json()

    charge = next(m for m in st["movements"] if m["type"] == "invoice")
    assert charge["charged"] == _pytest.approx(5000)        # euro
    assert charge["base_charged"] == _pytest.approx(5500, abs=0.01)  # dollars


def test_a_dollar_customers_statement_is_unchanged(client, dollar_customer):
    _invoice(client, dollar_customer, 120)

    st = client.get(f"/api/clients/{dollar_customer}/statement").json()

    assert st["currency"] == "USD"
    assert st["mixed_currencies"] is False
    assert st["total_charged"] == _pytest.approx(120)


def test_a_customer_billed_in_two_currencies_falls_back_to_the_company_currency(
        client, euro_customer):
    """A single running balance across currencies would need rate assumptions
    the statement cannot justify. It says which currency it used instead."""
    _invoice(client, euro_customer, 1000)                 # EUR
    _invoice(client, euro_customer, 500, currency="USD")  # USD

    st = client.get(f"/api/clients/{euro_customer}/statement").json()

    assert st["mixed_currencies"] is True
    assert st["currency"] == "USD"
    # 1000 EUR is 1100 USD, plus 500.
    assert st["total_charged"] == _pytest.approx(1600, abs=0.02)


# ── Quotation → invoice ──────────────────────────────────────────────────────

def _quote(client, cid, unit_price, qty=1, **kw):
    body = {"client_id": cid, "project_name": "Job",
            "items": [{"name": "Goods", "quantity": qty, "unit_price": unit_price}]}
    body.update(kw)
    return client.post("/api/quotations/", json=body)


def test_a_quote_is_given_in_the_customers_currency(client, euro_customer):
    q = _quote(client, euro_customer, 5000).json()["id"]

    body = client.get(f"/api/quotations/{q}").json()

    assert body["currency"] == "EUR"
    assert body["txn_total"] == _pytest.approx(5000)
    assert body["total"] == _pytest.approx(5500, abs=0.01)


def test_the_quoted_figure_becomes_the_invoice(client, euro_customer):
    """EUR 5,000 quoted is EUR 5,000 invoiced. Anything else is a different
    offer from the one the customer accepted."""
    q = _quote(client, euro_customer, 5000).json()["id"]

    r = client.post(f"/api/quotations/{q}/convert-to-invoice", json={})
    assert r.status_code == 200, r.text

    inv = client.get(f"/api/invoices/{r.json()['invoice_id']}").json()
    assert inv["currency"] == "EUR"
    assert inv["txn_amount"] == _pytest.approx(5000)


def test_the_invoice_is_valued_at_the_rate_on_the_day_it_is_raised(
        client, euro_customer, db):
    """A quotation is not a transaction, so nothing is recognised when one is
    issued. The sale is valued when it becomes a sale."""
    q = _quote(client, euro_customer, 5000).json()["id"]
    # The euro moves between the offer and its acceptance.
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.8, '2020-06-01', '2020-06-01')")
    db.commit()

    r = client.post(f"/api/quotations/{q}/convert-to-invoice", json={})

    inv = client.get(f"/api/invoices/{r.json()['invoice_id']}").json()
    assert inv["txn_amount"] == _pytest.approx(5000)          # the offer stands
    assert inv["exchange_rate"] == _pytest.approx(0.8)        # today's rate
    assert inv["amount"] == _pytest.approx(6250, abs=0.01)


def test_a_dollar_quote_converts_exactly_as_it_always_did(client, dollar_customer):
    q = _quote(client, dollar_customer, 750).json()["id"]

    r = client.post(f"/api/quotations/{q}/convert-to-invoice", json={})

    inv = client.get(f"/api/invoices/{r.json()['invoice_id']}").json()
    assert inv["currency"] == "USD"
    assert inv["amount"] == _pytest.approx(750)


# ── The company reports in its own currency ──────────────────────────────────
#
# The other half of the architecture. A dashboard covering customers in three
# currencies is meaningless unless every figure on it is in one — and that one
# is the company's. These tests exist because "the base columns are unchanged,
# so the reports must be right" is a claim, not evidence.

def test_the_financial_report_counts_the_dollar_value(client, euro_customer):
    """EUR 5,000 invoiced is USD 5,500 of business done."""
    inv = _id(_invoice(client, euro_customer, 5000))
    _pay(client, inv, 5000)

    body = client.get("/api/reports/financial",
                      params={"start": "2000-01-01", "end": "2099-12-31"}).json()

    assert body["total_income"] == _pytest.approx(5500, abs=0.02)


def test_the_client_report_counts_the_dollar_value(client, euro_customer):
    inv = _id(_invoice(client, euro_customer, 5000))
    _pay(client, inv, 5000)

    rows = client.get("/api/reports/clients",
                      params={"start": "2000-01-01", "end": "2099-12-31"}).json()

    row = next(r for r in rows if r["id"] == euro_customer)
    assert row["total_invoiced"] == _pytest.approx(5500, abs=0.02)
    assert row["total_paid"] == _pytest.approx(5500, abs=0.02)


def test_two_currencies_aggregate_into_one(client, euro_customer, dollar_customer):
    """The whole reason for a base currency: these figures have to be
    addable, and 5,000 euro plus 1,000 dollars is not 6,000 of anything."""
    _invoice(client, euro_customer, 5000)      # 5,500 in base
    _invoice(client, dollar_customer, 1000)    # 1,000 in base

    rows = client.get("/api/reports/clients",
                      params={"start": "2000-01-01", "end": "2099-12-31"}).json()

    total = sum(r["total_invoiced"] for r in rows)
    assert total == _pytest.approx(6500, abs=0.02)


def test_the_aging_report_ages_the_dollar_value(client, euro_customer):
    _invoice(client, euro_customer, 5000)

    body = client.get("/api/reports/invoice-aging").json()

    owed = sum(b["total"] for b in body["summary"].values())
    assert owed == _pytest.approx(5500, abs=0.02)


def test_the_trial_balance_is_in_one_currency(client, euro_customer):
    """Nothing on the face of the books is in euro, and it balances."""
    _invoice(client, euro_customer, 5000)

    tb = client.get("/api/accounting/trial-balance").json()

    assert tb["balanced"]
    ar = next(r for r in tb["rows"] if r["code"] == "1100")
    assert float(ar["debit"]) == _pytest.approx(5500, abs=0.02)


# ── Work priced from the company's own list ──────────────────────────────────

def test_a_service_job_bills_a_euro_customer_in_euro(client, euro_customer, db):
    """A technician does not type euro. The parts come off the company's price
    list in dollars and the customer is billed the euro equivalent at the day's
    rate — which is what a business with a dollar price list does."""
    eq = client.post("/api/service/equipment", json={
        "client_id": euro_customer, "name": "Machine"}).json()["id"]
    job = client.post("/api/service/jobs", json={
        "client_id": euro_customer, "equipment_id": eq,
        "job_type": "Repair",
        "items": [{"line_type": "charge", "name": "Labour",
                   "quantity": 1, "unit_price": 1100}]}).json()["id"]

    client.post(f"/api/service/jobs/{job}/start", json={})
    # Completing raises the invoice: the shop has auto-invoicing on by default.
    done = client.post(f"/api/service/jobs/{job}/complete", json={})
    assert done.status_code == 200, done.text

    inv_id = done.json()["invoice"]["invoice_id"]
    inv = client.get(f"/api/invoices/{inv_id}").json()
    assert inv["currency"] == "EUR"
    # $1,100 on the price list is €1,000 at 1.10.
    assert inv["txn_amount"] == _pytest.approx(1000, abs=0.02)
    assert inv["amount"] == _pytest.approx(1100, abs=0.02)


def test_a_service_job_for_a_dollar_customer_is_unchanged(client, dollar_customer):
    eq = client.post("/api/service/equipment", json={
        "client_id": dollar_customer, "name": "Machine"}).json()["id"]
    job = client.post("/api/service/jobs", json={
        "client_id": dollar_customer, "equipment_id": eq, "job_type": "Repair",
        "items": [{"line_type": "charge", "name": "Labour",
                   "quantity": 1, "unit_price": 300}]}).json()["id"]

    client.post(f"/api/service/jobs/{job}/start", json={})
    done = client.post(f"/api/service/jobs/{job}/complete", json={})

    inv = client.get(f"/api/invoices/{done.json()['invoice']['invoice_id']}").json()
    assert inv["currency"] == "USD"
    assert inv["amount"] == _pytest.approx(300)


# ── The till ─────────────────────────────────────────────────────────────────

def _till(client):
    client.post("/api/pos/session/open", json={"opening_float": 0})
    return client


def _sku(client, price=1100):
    return client.post("/api/inventory/", json={
        "name": "Till Goods", "quantity": 50, "unit_price": price,
        "unit_cost": 100, "category": "Goods"}).json()["id"]


def _checkout(client, sku, cid=None, qty=1, price=1100):
    return client.post("/api/pos/checkout", json={
        "client_id": cid,
        "items": [{"name": "Till Goods", "inventory_id": sku,
                   "quantity": qty, "unit_price": price}],
        "payment_method": "Cash", "currency": "USD",
        "amount_tendered": price * qty,
        "idempotency_key": str(uuid.uuid4())})


def test_a_till_sale_to_a_euro_customer_is_billed_in_euro(client, euro_customer):
    """Their account is in euro, so the sale on it is too — even though the
    cash that crossed the counter was dollars."""
    till, sku = _till(client), _sku(client)

    r = _checkout(till, sku, euro_customer)
    assert r.status_code == 200, r.text

    inv = client.get(f"/api/invoices/{r.json()['invoice_id']}").json()
    assert inv["currency"] == "EUR"
    assert inv["txn_amount"] == _pytest.approx(1000, abs=0.02)
    assert inv["amount"] == _pytest.approx(1100, abs=0.02)


def test_a_walk_in_sale_is_untouched(client):
    """No customer, no currency of their own — which is nearly every sale the
    shop makes, and none of it changes."""
    till, sku = _till(client), _sku(client)

    r = _checkout(till, sku)

    inv = client.get(f"/api/invoices/{r.json()['invoice_id']}").json()
    assert inv["currency"] == "USD"
    assert inv["amount"] == _pytest.approx(1100)


def test_the_till_still_takes_dollars_and_the_books_still_balance(
        client, euro_customer):
    """The drawer counts dollars and pounds. Billing in euro does not change
    what physically went in it."""
    till, sku = _till(client), _sku(client)

    _checkout(till, sku, euro_customer)

    closed = till.post("/api/pos/session/close", json={"closing_count": 1100}).json()
    assert closed["expected_cash"] == _pytest.approx(1100)
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_a_project_invoice_is_billed_in_the_customers_currency(client, euro_customer):
    """Projects need nothing of their own: an invoice raised against one goes
    through the same constructor as any other, so it carries the customer's
    currency. Their estimated and actual cost are the company's own figures and
    belong in the company's own currency."""
    proj = client.post("/api/projects/", json={
        "name": "Euro Project", "client_id": euro_customer}).json()["id"]

    inv = _id(_invoice(client, euro_customer, 2000, project_id=proj))

    body = client.get(f"/api/invoices/{inv}").json()
    assert body["currency"] == "EUR"
    assert body["txn_amount"] == _pytest.approx(2000)
    assert body["amount"] == _pytest.approx(2200, abs=0.02)
