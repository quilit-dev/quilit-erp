"""Money settled through a bank lands in that bank.

Bank accounts have existed since 154: a table, a code of their own in the
chart so a balance can be reconciled against a statement, and a full API. Two
tables could name one. Almost nothing did.

Worse than the missing choice was where the money went instead. Every path but
the customer's account payment posted through `cash_account_for`, which knows
the currency and nothing about the method — so a bank transfer debited cash on
hand. On the default chart that is one combined "Cash & Bank" account and the
error is invisible; on Lebanon's plan, where 5312 is the till and 512 is the
bank, the till was overstated by every transfer it never received and the bank
showed nothing at all.

These tests run on the Lebanese chart for exactly that reason: it is the one
that can tell the two apart.
"""
import uuid
from datetime import date

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    c = as_role("superadmin")
    r = c.post("/api/accounting/chart/lebanon/install", json={"confirm": "SWITCH CHART"})
    assert r.status_code == 200, r.text
    return c


@_pytest.fixture
def bank(client):
    """A named account, with its own code in the chart."""
    r = client.post("/api/banks/", json={"name": "Byblos current", "currency": "USD"})
    assert r.status_code in (200, 201), r.text
    return r.json()


@_pytest.fixture
def other_bank(client):
    return client.post("/api/banks/",
                       json={"name": "Audi current", "currency": "USD"}).json()


def _codes(db, source_type):
    """Every account touched by one kind of posting, with its net movement."""
    rows = db.execute(
        "SELECT a.code, SUM(l.debit) AS dr, SUM(l.credit) AS cr "
        "  FROM journal_entry_lines l "
        "  JOIN journal_entries je ON je.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id "
        " WHERE je.source_type = ? GROUP BY a.code", (source_type,)).fetchall()
    return {r["code"]: (float(r["dr"] or 0), float(r["cr"] or 0)) for r in rows}


TILL = "5312"          # cash on hand, USD
BANK_ROLE = "512"      # the general bank account


def _client_id(c, name="Bank Co"):
    return c.post("/api/clients/", json={"name": name}).json()["id"]


def _invoice(c, cid, amount=500):
    r = c.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": str(date.today()),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": amount}]}).json()
    return r.get("invoice_id") or r.get("id")


# ── An invoice paid by transfer ──────────────────────────────────────────────

def test_a_transfer_no_longer_debits_the_till(client, db):
    cid = _client_id(client)
    inv = _invoice(client, cid)

    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 500, "currency": "USD", "method": "Bank Transfer",
        "idempotency_key": str(uuid.uuid4())})

    touched = _codes(db, "invoice_payment")
    assert TILL not in touched, "a transfer went into cash on hand"
    assert touched[BANK_ROLE][0] == _pytest.approx(500)


def test_it_lands_in_the_account_that_was_chosen(client, bank, db):
    """Which is what makes reconciling against a statement possible at all."""
    cid = _client_id(client)
    inv = _invoice(client, cid)

    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 500, "currency": "USD", "method": "Bank Transfer",
        "bank_account_id": bank["id"], "idempotency_key": str(uuid.uuid4())})

    touched = _codes(db, "invoice_payment")
    assert touched[bank["account_code"]][0] == _pytest.approx(500)


def test_two_banks_keep_separate_balances(client, bank, other_bank, db):
    cid = _client_id(client)
    a, b = _invoice(client, cid, 300), _invoice(client, cid, 700)

    for inv, acct, amt in ((a, bank, 300), (b, other_bank, 700)):
        client.post(f"/api/invoices/{inv}/payments", json={
            "amount": amt, "currency": "USD", "method": "Bank Transfer",
            "bank_account_id": acct["id"], "idempotency_key": str(uuid.uuid4())})

    touched = _codes(db, "invoice_payment")
    assert touched[bank["account_code"]][0] == _pytest.approx(300)
    assert touched[other_bank["account_code"]][0] == _pytest.approx(700)


def test_cash_still_goes_to_the_till(client, db):
    """The change must not swing the other way: notes are notes."""
    cid = _client_id(client)
    inv = _invoice(client, cid)

    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 500, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    assert _codes(db, "invoice_payment")[TILL][0] == _pytest.approx(500)


def test_the_bank_is_kept_on_the_payment(client, bank, db):
    cid = _client_id(client)
    inv = _invoice(client, cid)

    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 500, "currency": "USD", "method": "Bank Transfer",
        "bank_account_id": bank["id"], "idempotency_key": str(uuid.uuid4())})

    row = db.execute("SELECT bank_account_id FROM invoice_payments "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row["bank_account_id"] == bank["id"]


# ── An expense paid by transfer ──────────────────────────────────────────────

def test_an_expense_paid_by_transfer_credits_the_bank(client, bank, db):
    client.post("/api/finance/expenses", json={
        "category": "Rent", "description": "Office", "amount": 200,
        "date": str(date.today()), "payment_method": "Bank Transfer",
        "bank_account_id": bank["id"]})

    touched = _codes(db, "expense")
    assert TILL not in touched
    assert touched[bank["account_code"]][1] == _pytest.approx(200)


def test_an_expense_paid_in_cash_still_credits_the_till(client, db):
    client.post("/api/finance/expenses", json={
        "category": "Rent", "amount": 200, "date": str(date.today()),
        "payment_method": "Cash"})

    assert _codes(db, "expense")[TILL][1] == _pytest.approx(200)


# ── A card at the till ───────────────────────────────────────────────────────

def test_a_card_sale_does_not_go_in_the_drawer(client, bank, db):
    """The register takes more than notes, and what is not notes must not be
    counted at close as though it were."""
    item = client.post("/api/inventory/", json={
        "name": "Widget", "quantity": 10, "sale_price": 50, "unit_cost": 20,
        "category": "Goods"}).json()["id"]
    client.post("/api/pos/session/open", json={"opening_float": 0})

    client.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item,
                   "quantity": 1, "unit_price": 50}],
        "payment_method": "Card", "currency": "USD", "amount_tendered": 50,
        "bank_account_id": bank["id"], "idempotency_key": str(uuid.uuid4())})

    touched = _codes(db, "invoice_payment")
    assert TILL not in touched
    assert touched[bank["account_code"]][0] == _pytest.approx(50)


def test_a_cash_sale_is_unchanged(client, db):
    item = client.post("/api/inventory/", json={
        "name": "Widget", "quantity": 10, "sale_price": 50, "unit_cost": 20,
        "category": "Goods"}).json()["id"]
    client.post("/api/pos/session/open", json={"opening_float": 0})

    client.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item,
                   "quantity": 1, "unit_price": 50}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 50,
        "idempotency_key": str(uuid.uuid4())})

    assert _codes(db, "invoice_payment")[TILL][0] == _pytest.approx(50)


# ── A payment against the account ────────────────────────────────────────────

def test_an_account_payment_names_its_bank_on_the_batch_row(client, bank, db):
    """The batch row is what the receipt is written against, so it has to be
    able to say where the money went as well."""
    cid = _client_id(client)
    _invoice(client, cid, 400)

    client.post(f"/api/clients/{cid}/payments", json={
        "amount": 400, "currency": "USD", "method": "Bank Transfer",
        "bank_account_id": bank["id"], "idempotency_key": str(uuid.uuid4())})

    row = db.execute("SELECT bank_account_id FROM customer_payments "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row["bank_account_id"] == bank["id"]


# ── The books still add up ───────────────────────────────────────────────────

def test_the_ledger_balances_across_every_route(client, bank, db):
    cid = _client_id(client)
    inv = _invoice(client, cid, 500)
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 500, "currency": "USD", "method": "Bank Transfer",
        "bank_account_id": bank["id"], "idempotency_key": str(uuid.uuid4())})
    client.post("/api/finance/expenses", json={
        "category": "Rent", "amount": 200, "date": str(date.today()),
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]})

    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_the_account_balance_reads_back_on_the_bank_itself(client, bank):
    """What the whole thing is for: a figure to hold against a statement."""
    cid = _client_id(client)
    inv = _invoice(client, cid, 500)
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 500, "currency": "USD", "method": "Bank Transfer",
        "bank_account_id": bank["id"], "idempotency_key": str(uuid.uuid4())})

    listed = client.get("/api/banks/").json()
    mine = next(b for b in listed if b["id"] == bank["id"])
    assert mine["balance"] == _pytest.approx(500)
