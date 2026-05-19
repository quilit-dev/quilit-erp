"""
Multi-currency invoice payments — a client may pay a USD invoice in LBP.

The invoice balance is always tracked in USD; an LBP payment is converted at
the rate supplied with the payment. `invoice_payments.amount` stores the USD
value applied, while `paid_currency` / `paid_amount` / `exchange_rate` record
what the client actually handed over.
"""
import uuid
import pytest


def _make_invoice(c, amount=1000):
    cl = c.post("/api/clients/", json={"name": "LBP Pay Co"})
    assert cl.status_code in (200, 201), cl.text
    inv = c.post("/api/invoices/", json={
        "client_id": cl.json()["id"], "project_id": None,
        "items": [{"name": "Service", "quantity": 1, "unit_price": amount}],
    })
    assert inv.status_code in (200, 201), inv.text
    return inv.json()["id"]


def _key():
    return str(uuid.uuid4())


def test_pay_usd_invoice_in_lbp(make_client):
    """An LBP payment converts to USD at the supplied rate and clears the balance."""
    c = make_client("superadmin")
    inv_id = _make_invoice(c, 1000)

    r = c.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 89_000_000, "currency": "LBP", "exchange_rate": 89_000,
        "method": "Cash", "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_paid"] == pytest.approx(1000, abs=0.01)
    assert body["remaining"] == pytest.approx(0, abs=0.01)
    assert body["status"] == "Paid"

    detail = c.get(f"/api/invoices/{inv_id}").json()
    pay = detail["payments"][0]
    assert pay["paid_currency"] == "LBP"
    assert pay["paid_amount"] == pytest.approx(89_000_000, abs=1)
    assert pay["exchange_rate"] == pytest.approx(89_000, abs=1)
    assert pay["amount"] == pytest.approx(1000, abs=0.01)


def test_lbp_payment_requires_exchange_rate(make_client):
    """An LBP payment with no rate is rejected with 400 — never a 500."""
    c = make_client("superadmin")
    inv_id = _make_invoice(c, 1000)
    r = c.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 89_000_000, "currency": "LBP",
        "method": "Cash", "idempotency_key": _key(),
    })
    assert r.status_code < 500
    assert r.status_code == 400


def test_usd_payment_still_works(make_client):
    """Default currency stays USD — an omitted currency behaves as before."""
    c = make_client("superadmin")
    inv_id = _make_invoice(c, 1000)
    r = c.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 400, "method": "Cash", "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Partial"
    pay = c.get(f"/api/invoices/{inv_id}").json()["payments"][0]
    assert pay["paid_currency"] == "USD"
    assert pay["amount"] == pytest.approx(400, abs=0.01)


def test_lbp_payment_cannot_exceed_balance(make_client):
    """The USD-equivalent of an LBP payment is checked against the balance."""
    c = make_client("superadmin")
    inv_id = _make_invoice(c, 1000)
    # 200,000,000 LBP / 89,000 ≈ $2,247 — well over the $1,000 balance.
    r = c.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 200_000_000, "currency": "LBP", "exchange_rate": 89_000,
        "method": "Cash", "idempotency_key": _key(),
    })
    assert r.status_code < 500
    assert r.status_code == 400
