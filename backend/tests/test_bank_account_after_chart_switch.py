"""Paying through a bank account that was set up before the chart switch.

A bank account opens its own ledger account under the bank heading of the
chart in use --- 10001 under 1000 on the default chart. Switching to the
Lebanese chart retires every default-chart account, that one included, and
the ledger refuses a retired account, so every payment through that bank
account was a 500: "Account 10001 ... is inactive and cannot be posted to".

The bank account now gets a live code under the current bank heading (5121
under 512), at boot and on first use, and the payment posts there.
"""
import uuid

import pytest

import accounting
import chart_lebanon as LB

pytestmark = pytest.mark.critical


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _bank(client, name="BLOM main"):
    r = client.post("/api/banks/", json={"name": name, "bank_name": "BLOM", "currency": "USD"})
    assert r.status_code in (200, 201), r.text
    return r.json()


def _active(db, code):
    row = db.execute("SELECT is_active, is_postable FROM chart_of_accounts WHERE code=?",
                     (code,)).fetchone()
    return bool(row) and int(row["is_active"]) == 1 and int(row["is_postable"]) == 1


def _pay_invoice_by_bank(client, bank_id):
    cid = client.post("/api/clients/", json={"name": "Bank Co " + uuid.uuid4().hex[:4]}).json()["id"]
    inv = client.post("/api/invoices/", json={"client_id": cid,
                      "items": [{"name": "W", "quantity": 1, "unit_price": 100}]}).json()
    iid = inv.get("id") or inv.get("invoice_id")
    return client.post(f"/api/invoices/{iid}/payments", json={
        "amount": 100, "currency": "USD", "method": "Bank Transfer",
        "bank_account_id": bank_id, "idempotency_key": str(uuid.uuid4())})


def test_a_bank_account_from_before_the_switch_can_be_paid_through(client, db):
    bank = _bank(client)
    assert bank["account_code"] == "10001"
    LB.install(db)
    db.commit()
    assert not _active(db, "10001"), "setup: the switch retired the old code"

    r = _pay_invoice_by_bank(client, bank["id"])
    assert r.status_code == 200, r.text

    code = db.execute("SELECT account_code FROM bank_accounts WHERE id=?",
                      (bank["id"],)).fetchone()["account_code"]
    assert code.startswith("512") and _active(db, code), code
    landed = db.execute(
        "SELECT COALESCE(SUM(l.debit),0) d FROM journal_entry_lines l "
        "  JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.code=?", (code,)).fetchone()["d"]
    assert float(landed) == pytest.approx(100), "the money went to the bank account's own code"


def test_the_boot_pass_rehomes_it_before_anyone_pays(client, db):
    bank = _bank(client)
    LB.install(db)
    db.commit()
    LB.ensure_current(db)
    db.commit()
    code = db.execute("SELECT account_code FROM bank_accounts WHERE id=?",
                      (bank["id"],)).fetchone()["account_code"]
    assert code != "10001" and _active(db, code)


def test_a_bank_account_that_is_fine_is_left_alone(client, db):
    LB.install(db)
    db.commit()
    bank = _bank(client)                       # opened under 512 already
    assert accounting.ensure_live_bank_account(db, bank["id"]) == bank["account_code"]
    assert accounting.rehome_retired_bank_accounts(db) == 0


def test_every_bank_path_works_on_both_charts(client, db):
    """Invoice payment, expense, owed-expense instalment, supplier payment,
    salary advance and payroll, each through a chosen bank account."""
    for chart in ("default", "lebanese"):
        if chart == "lebanese":
            LB.install(db, force=True)      # a test sandbox, mid-life
            db.commit()
        bid = _bank(client, name=f"Bank {chart}")["id"]
        assert _pay_invoice_by_bank(client, bid).status_code == 200
        assert client.post("/api/finance/expenses", json={
            "category": "Rent", "amount": 300, "description": "Rent", "date": "2026-10-01",
            "payment_method": "Bank Transfer", "bank_account_id": bid}).status_code == 200
        owed = client.post("/api/finance/expenses", json={
            "category": "Rent", "amount": 300, "description": "Owed", "date": "2026-10-01",
            "on_credit": True, "payee": "Landlord"}).json()
        assert client.post(f"/api/finance/expenses/{owed['id']}/payments", json={
            "amount": 100, "payment_method": "Bank Transfer",
            "bank_account_id": bid}).status_code == 200
        po = client.post("/api/purchases/", json={"supplier": "Acme", "status": "Received",
                         "items": [{"product_name": "Thing", "quantity": 1, "unit_cost": 40}]}).json()
        assert client.post(f"/api/purchases/{po['id']}/payments", json={
            "amount": 40, "payment_method": "Bank Transfer",
            "bank_account_id": bid}).status_code == 200
