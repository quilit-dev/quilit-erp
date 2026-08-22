"""A receipt for the payment the customer actually made.

A customer hands over one sum for "the account". The system splits it into one
row per invoice — which is what keeps every balance and statement working, and
what left the payment itself with no identity: only the first row carried the
idempotency key, so nothing tied the rows together. There was a receipt voucher
per invoice and none for the thing the customer did.

So a payment is now a record of its own, and the voucher written against it
names every invoice the money reached.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Voucher Co"}).json()["id"]


def _invoice(client, cid, amount, due):
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": due,
        "items": [{"name": "Item", "quantity": 1, "unit_price": amount}]}).json()
    return created.get("invoice_id") or created.get("id")


def _pay(client, cid, amount, **kw):
    body = {"amount": amount, "method": "Cash", "currency": "USD",
            "idempotency_key": str(uuid.uuid4())}
    body.update(kw)
    return client.post(f"/api/clients/{cid}/payments", json=body)


# ── The payment is a thing ───────────────────────────────────────────────────

def test_a_payment_comes_back_with_an_identity(client, acme):
    _invoice(client, acme, 100, "2026-01-31")

    body = _pay(client, acme, 100).json()

    assert body["payment_id"]


def test_every_allocation_points_back_at_the_payment(client, acme, db):
    """Without the link there is nothing to write a receipt from."""
    _invoice(client, acme, 100, "2026-01-31")
    _invoice(client, acme, 100, "2026-06-30")

    pid = _pay(client, acme, 150).json()["payment_id"]

    n = db.execute("SELECT COUNT(*) AS n FROM invoice_payments "
                   "WHERE customer_payment_id=?", (pid,)).fetchone()["n"]
    assert n == 2


def test_the_customers_payments_read_back_as_they_were_made(client, acme):
    """One row per payment, not one per allocation — which is how the ledger
    stores it and not how anybody remembers paying."""
    _invoice(client, acme, 100, "2026-01-31")
    _invoice(client, acme, 100, "2026-06-30")
    _pay(client, acme, 150)

    rows = client.get(f"/api/clients/{acme}/payments").json()

    assert len(rows) == 1
    assert rows[0]["amount"] == _pytest.approx(150)
    assert len(rows[0]["allocated"]) == 2


# ── The voucher ──────────────────────────────────────────────────────────────

def test_the_voucher_names_every_invoice_the_money_reached(client, acme):
    """The whole point: one document the customer is handed."""
    _invoice(client, acme, 100, "2026-01-31")
    _invoice(client, acme, 100, "2026-06-30")
    pid = _pay(client, acme, 150).json()["payment_id"]

    body = client.post(f"/api/clients/payments/{pid}/voucher").json()

    assert body["number"]
    assert body["amount"] == _pytest.approx(150)
    assert [a["applied"] for a in body["allocated"]] == [100, 50]
    assert all(a["invoice_number"] for a in body["allocated"])


def test_reprinting_hands_back_the_same_number(client, acme):
    """A second number would be a second receipt for money received once."""
    _invoice(client, acme, 100, "2026-01-31")
    pid = _pay(client, acme, 100).json()["payment_id"]

    first = client.post(f"/api/clients/payments/{pid}/voucher").json()
    second = client.post(f"/api/clients/payments/{pid}/voucher").json()

    assert first["number"] == second["number"]
    assert first["issued"] is True
    assert second["issued"] is False


def test_two_payments_get_two_numbers(client, acme):
    _invoice(client, acme, 300, "2026-01-31")
    a = _pay(client, acme, 100).json()["payment_id"]
    b = _pay(client, acme, 100).json()["payment_id"]

    n1 = client.post(f"/api/clients/payments/{a}/voucher").json()["number"]
    n2 = client.post(f"/api/clients/payments/{b}/voucher").json()["number"]

    assert n1 != n2


def test_the_voucher_carries_what_the_customer_actually_handed_over(client, acme):
    """Paid in pounds, receipted in pounds. A receipt showing only the USD
    equivalent is not a receipt for what was handed over."""
    _invoice(client, acme, 100, "2026-01-31")
    pid = _pay(client, acme, 1_000_000, currency="LBP",
               exchange_rate=100_000).json()["payment_id"]

    body = client.post(f"/api/clients/payments/{pid}/voucher").json()

    assert body["currency"] == "LBP"
    assert body["paid_amount"] == _pytest.approx(1_000_000)
    assert body["exchange_rate"] == _pytest.approx(100_000)


def test_the_voucher_uses_the_configured_prefix(client, acme, db):
    db.execute("INSERT OR REPLACE INTO settings (key, value) "
               "VALUES ('receipt_voucher_prefix', 'REC-')")
    db.commit()
    _invoice(client, acme, 100, "2026-01-31")
    pid = _pay(client, acme, 100).json()["payment_id"]

    number = client.post(f"/api/clients/payments/{pid}/voucher").json()["number"]

    assert number.startswith("REC-")


def test_it_does_not_collide_with_the_per_invoice_voucher_series(client, acme):
    """Both draw from the same prefix and year. Two documents sharing a number
    is the one thing a voucher series must never do."""
    inv = _invoice(client, acme, 100, "2026-01-31")
    pid = _pay(client, acme, 100).json()["payment_id"]

    per_invoice = client.post(f"/api/invoices/{inv}/receipt-voucher").json()["number"]
    per_payment = client.post(f"/api/clients/payments/{pid}/voucher").json()["number"]

    assert per_invoice != per_payment


def test_an_unknown_payment_is_a_404(client):
    assert client.post("/api/clients/payments/999999/voucher").status_code == 404


def test_it_needs_permission(as_role, client, acme):
    _invoice(client, acme, 100, "2026-01-31")
    pid = _pay(client, acme, 100).json()["payment_id"]

    r = as_role("Inventory").post(f"/api/clients/payments/{pid}/voucher")

    assert r.status_code == 403
