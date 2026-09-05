"""Paying a supplier and paying the staff — out of which account.

The two paths that move the most money and recorded the least about it.
Neither had a payment method at all, so there was nothing to switch on and
both credited cash: a supplier settled by transfer and a payroll paid into
staff bank accounts both came out of the till.

On the default chart cash and bank are one combined account and the error is
invisible. These run on the Lebanese plan, where 5312 is the till and 512 is
the bank, because that is the chart that can tell them apart.

Both fields are optional throughout. A caller that says nothing still posts to
cash, which is exactly what it meant before — the change adds an answer, it
does not demand one.
"""
from datetime import date, timedelta

import pytest as _pytest

pytestmark = _pytest.mark.critical

TILL = "5312"


@_pytest.fixture
def client(as_role):
    c = as_role("superadmin")
    r = c.post("/api/accounting/chart/lebanon/install", json={"confirm": "SWITCH CHART"})
    assert r.status_code == 200, r.text
    return c


@_pytest.fixture
def bank(client):
    return client.post("/api/banks/",
                       json={"name": "Byblos current", "currency": "USD"}).json()


def _codes(db, *source_types):
    """Debits and credits by account code, across the given entry sources.

    A purchase is TWO entries now, not one. Receiving the goods debits stock
    and credits the supplier's account; paying debits that account and credits
    whatever the money came out of. So the question this file asks — did a
    transfer come out of the bank or the till — is answered by the payment
    entry, and looking only at `purchase` would find no money side at all.
    """
    marks = ",".join("?" for _ in source_types)
    rows = db.execute(
        "SELECT a.code, SUM(l.debit) AS dr, SUM(l.credit) AS cr "
        "  FROM journal_entry_lines l "
        "  JOIN journal_entries je ON je.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id "
        f" WHERE je.source_type IN ({marks}) GROUP BY a.code",
        source_types).fetchall()
    return {r["code"]: (float(r["dr"] or 0), float(r["cr"] or 0)) for r in rows}


# Everything a purchase posts: the receipt and the payments that settle it.
PURCHASE = ("purchase", "purchase_payment")


# ── Paying a supplier ────────────────────────────────────────────────────────

def _purchase(c):
    item = c.post("/api/inventory/", json={
        "name": "Widget", "quantity": 0, "unit_cost": 20, "sale_price": 50,
        "category": "Goods"}).json()["id"]
    return c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item, "product_name": "Widget",
        "quantity": 10, "unit_cost": 20, "status": "Ordered"}).json()["id"]


def test_a_supplier_paid_by_transfer_credits_the_bank(client, bank, db):
    po = _purchase(client)

    client.patch(f"/api/purchases/{po}/status", json={
        "status": "Paid", "payment_method": "Bank Transfer",
        "bank_account_id": bank["id"]})

    touched = _codes(db, *PURCHASE)
    assert TILL not in touched, "a supplier transfer came out of the till"
    assert touched[bank["account_code"]][1] == _pytest.approx(200)
    # ...and it is the PAYMENT that moved it, not the receipt.
    assert _codes(db, "purchase_payment")[bank["account_code"]][1] == _pytest.approx(200)


def test_a_supplier_paid_in_cash_still_credits_the_till(client, db):
    po = _purchase(client)

    client.patch(f"/api/purchases/{po}/status",
                 json={"status": "Paid", "payment_method": "Cash"})

    assert _codes(db, *PURCHASE)[TILL][1] == _pytest.approx(200)


def test_saying_nothing_behaves_as_it_always_did(client, db):
    """An older client sends only a status. It must still work."""
    po = _purchase(client)

    r = client.patch(f"/api/purchases/{po}/status", json={"status": "Paid"})

    assert r.status_code == 200, r.text
    assert _codes(db, *PURCHASE)[TILL][1] == _pytest.approx(200)


def test_how_it_was_paid_is_kept_on_the_purchase(client, bank, db):
    po = _purchase(client)

    client.patch(f"/api/purchases/{po}/status", json={
        "status": "Paid", "payment_method": "Bank Transfer",
        "bank_account_id": bank["id"]})

    row = db.execute("SELECT payment_method, bank_account_id FROM purchases "
                     "WHERE id=?", (po,)).fetchone()
    assert row["payment_method"] == "Bank Transfer"
    assert row["bank_account_id"] == bank["id"]


def test_the_goods_still_arrive_and_the_books_still_balance(client, bank):
    po = _purchase(client)

    client.patch(f"/api/purchases/{po}/status", json={
        "status": "Paid", "payment_method": "Bank Transfer",
        "bank_account_id": bank["id"]})

    assert client.get("/api/accounting/trial-balance").json()["balanced"]
    inv = client.get("/api/inventory/").json()
    widget = next(i for i in inv if i["name"] == "Widget")
    assert widget["quantity"] == 10


# ── Paying the staff ─────────────────────────────────────────────────────────

def _payroll(c):
    emp = c.post("/api/hr/employees", json={
        "full_name": "Sami", "salary": 1000, "hire_date": "2026-01-01"}).json()["id"]
    start = date.today().replace(day=1)
    end = start + timedelta(days=27)
    run = c.post("/api/hr/payroll/runs", json={
        "period_start": str(start), "period_end": str(end)}).json()["id"]
    c.post(f"/api/hr/payroll/runs/{run}/approve", json={})
    return emp, run


def test_a_payroll_paid_by_transfer_credits_the_bank(client, bank, db):
    _emp, run = _payroll(client)

    r = client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]})

    assert r.status_code == 200, r.text
    touched = _codes(db, "payroll")
    assert TILL not in touched, "salaries came out of the till"
    assert touched[bank["account_code"]][1] > 0


def test_a_payroll_paid_in_cash_still_credits_the_till(client, db):
    _emp, run = _payroll(client)

    client.post(f"/api/hr/payroll/runs/{run}/mark-paid",
                json={"payment_method": "Cash"})

    assert _codes(db, "payroll")[TILL][1] > 0


def test_marking_paid_with_no_body_still_works(client, db):
    """The button sent nothing before this existed, and some caller still
    will. It has to keep working rather than 422."""
    _emp, run = _payroll(client)

    r = client.post(f"/api/hr/payroll/runs/{run}/mark-paid")

    assert r.status_code == 200, r.text
    assert _codes(db, "payroll")[TILL][1] > 0


def test_how_the_staff_were_paid_is_kept_on_the_run(client, bank, db):
    _emp, run = _payroll(client)

    client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]})

    row = db.execute("SELECT payment_method, bank_account_id FROM hr_payroll_runs "
                     "WHERE id=?", (run,)).fetchone()
    assert row["payment_method"] == "Bank Transfer"
    assert row["bank_account_id"] == bank["id"]


def test_the_expense_it_posts_carries_it_too(client, bank, db):
    """Finance shows one Payroll expense for the run. It should say how it was
    paid, like every other expense on that screen."""
    _emp, run = _payroll(client)

    client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]})

    row = db.execute("SELECT payment_method, bank_account_id FROM expenses "
                     "WHERE category='Payroll' ORDER BY id DESC LIMIT 1").fetchone()
    assert row["payment_method"] == "Bank Transfer"
    assert row["bank_account_id"] == bank["id"]


def test_paying_twice_is_still_refused_the_same_way(client, bank):
    """Idempotence is what stops a second click paying the staff twice."""
    _emp, run = _payroll(client)
    first = client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]}).json()

    again = client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={
        "payment_method": "Cash"}).json()

    assert again["expense_id"] == first["expense_id"]


def test_the_ledger_balances_after_paying_the_staff(client, bank):
    _emp, run = _payroll(client)

    client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]})

    assert client.get("/api/accounting/trial-balance").json()["balanced"]
