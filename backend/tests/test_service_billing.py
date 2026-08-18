"""Billing a service, and undoing one recorded by mistake.

Recording a service raises its invoice in the same call. Cancelling reverses
everything that recording did — the parts, the cost and the invoice — because a
correction that undoes only part of it leaves two records disagreeing: an
invoice for goods still on the shelf, or a cost with no work behind it.

The one thing cancelling will not do is unwind money that has actually moved.
"""
import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Acme Ltd"}).json()["id"]


def _item(client, name, qty, cost, price):
    return client.post("/api/inventory/", json={
        "name": name, "quantity": qty, "unit_cost": cost, "sale_price": price,
    }).json()["id"]


def _part(inv_id, name, qty, price):
    return {"line_type": "part", "inventory_id": inv_id, "name": name,
            "quantity": qty, "unit_price": price}


def _charge(name, price):
    return {"line_type": "charge", "name": name, "quantity": 1, "unit_price": price}


def _service(client, acme, items):
    r = client.post("/api/service/jobs", json={
        "client_id": acme, "job_type": "Repair", "items": items})
    assert r.status_code == 200, r.text
    return r.json()


def _stock(client, inv_id):
    return client.get(f"/api/inventory/{inv_id}").json()["quantity"]


def _balance(client, code):
    body = client.get("/api/accounting/trial-balance").json()
    rows = body.get("rows") if isinstance(body, dict) else body
    for r in rows or []:
        if str(r.get("code")) == code:
            return float(r.get("debit") or 0) - float(r.get("credit") or 0)
    return 0.0


def _auto(client, on=True):
    client.put("/api/settings/", json={"service_auto_invoice": "1" if on else "0"})


# ── Recording raises the invoice ─────────────────────────────────────────────

def test_recording_a_service_invoices_it(client, acme):
    """The whole point of the simplification: one action, and the customer is
    billed."""
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)

    job = _service(client, acme, [_part(belt, "Belt", 3, 12), _charge("Labour", 100)])

    assert job["invoice"]["invoice_number"].startswith("INV-")
    assert job["invoice"]["amount"] == pytest.approx(136)
    assert job["parts_cost"] == pytest.approx(12)


def test_the_invoice_is_an_ordinary_editable_one(client, acme):
    _auto(client)
    job = _service(client, acme, [_charge("Labour", 100)])

    edited = client.put(f"/api/invoices/{job['invoice']['invoice_id']}", json={
        "client_id": acme, "amount": 150,
        "items": [{"name": "Labour", "quantity": 1, "unit_price": 150}]})

    assert edited.status_code == 200, edited.text


def test_the_setting_turns_automatic_billing_off(client, acme):
    _auto(client, False)

    job = _service(client, acme, [_charge("Labour", 100)])

    assert job["invoice"] is None
    assert client.get(f"/api/service/jobs/{job['id']}").json()["invoice"] is None


def test_an_unbilled_service_can_be_invoiced_by_hand(client, acme):
    _auto(client, False)
    job = _service(client, acme, [_charge("Labour", 100)])

    r = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert r.status_code == 200, r.text
    assert r.json()["amount"] == pytest.approx(100)


def test_a_service_is_invoiced_once(client, acme):
    _auto(client)
    job = _service(client, acme, [_charge("Labour", 100)])

    again = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert again.status_code == 409
    assert job["invoice"]["invoice_number"] in again.json()["detail"]


def test_a_service_with_no_lines_records_without_an_invoice(client, acme):
    """Nothing to bill is not a reason to refuse the record."""
    _auto(client)

    job = _service(client, acme, [])

    assert job["invoice"] is None


def test_the_parts_leave_stock_exactly_once(client, acme):
    """The invoice owns no stock movement; recording does."""
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)

    _service(client, acme, [_part(belt, "Belt", 3, 12)])

    assert _stock(client, belt) == pytest.approx(7)


# ── The revenue split ────────────────────────────────────────────────────────

def test_parts_and_labour_land_in_different_revenue_accounts(client, acme):
    """The reason 4100 exists. One undifferentiated total is the first thing a
    repair business needs broken apart."""
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)
    goods_before = _balance(client, "4000")
    service_before = _balance(client, "4100")

    job = _service(client, acme, [_part(belt, "Belt", 3, 12), _charge("Labour", 100)])
    client.post(f"/api/invoices/{job['invoice']['invoice_id']}/payments", json={
        "amount": job["invoice"]["amount"], "currency": "USD", "method": "Cash",
        "idempotency_key": "svc-split-1"})

    # Revenue accounts are credits, so the balance moves negative.
    goods = -(_balance(client, "4000") - goods_before)
    service = -(_balance(client, "4100") - service_before)

    assert goods == pytest.approx(36), "3 belts at 12.00 belong in Sales Revenue"
    assert service == pytest.approx(100), "labour belongs in Service Revenue"


def test_a_labour_only_service_credits_only_service_revenue(client, acme):
    _auto(client)
    goods_before = _balance(client, "4000")

    job = _service(client, acme, [_charge("Callout", 60)])
    client.post(f"/api/invoices/{job['invoice']['invoice_id']}/payments", json={
        "amount": job["invoice"]["amount"], "currency": "USD", "method": "Cash",
        "idempotency_key": "svc-split-2"})

    assert _balance(client, "4000") == pytest.approx(goods_before)


# ── Cancelling reverses all three ────────────────────────────────────────────

def test_cancelling_voids_the_invoice(client, acme):
    _auto(client)
    job = _service(client, acme, [_charge("Labour", 100)])

    r = client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "wrong client"})

    assert r.status_code == 200, r.text
    assert r.json()["voided_invoice"] == job["invoice"]["invoice_number"]
    inv = client.get(f"/api/invoices/{job['invoice']['invoice_id']}").json()
    assert inv["voided_at"], "the invoice is still live"


def test_cancelling_returns_the_parts_and_reverses_the_cost(client, acme):
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)
    cogs_before = _balance(client, "5000")

    job = _service(client, acme, [_part(belt, "Belt", 3, 12)])
    client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "mistake"})

    assert _stock(client, belt) == pytest.approx(10)
    assert _balance(client, "5000") == pytest.approx(cogs_before)


def test_the_reversal_is_an_entry_not_a_deletion(client, acme):
    """A posted period must stay auditable; deleting the original leaves a gap
    nobody can explain."""
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)
    job = _service(client, acme, [_part(belt, "Belt", 3, 12)])
    client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "mistake"})

    entries = client.get("/api/accounting/journal-entries").json()
    rows = entries.get("rows") if isinstance(entries, dict) else entries
    memos = [str(e.get("memo") or "") for e in rows or []]

    assert any("Service parts —" in m for m in memos), "the original is gone"
    assert any("returned" in m for m in memos), "no reversing entry"


def test_a_paid_service_cannot_be_cancelled(client, acme):
    """Money has actually moved. Voiding would leave a payment against nothing,
    so this is a refund conversation rather than a data-entry correction."""
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)
    job = _service(client, acme, [_part(belt, "Belt", 3, 12)])
    client.post(f"/api/invoices/{job['invoice']['invoice_id']}/payments", json={
        "amount": job["invoice"]["amount"], "currency": "USD", "method": "Cash",
        "idempotency_key": "svc-paid-1"})

    r = client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "oops"})

    assert r.status_code == 409
    assert "payments against it" in r.json()["detail"]
    assert _stock(client, belt) == pytest.approx(7), "stock came back anyway"


def test_cancelling_an_unbilled_service_still_returns_the_parts(client, acme):
    _auto(client, False)
    belt = _item(client, "Belt", 10, 4, 12)
    job = _service(client, acme, [_part(belt, "Belt", 3, 12)])

    r = client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "mistake"})

    assert r.status_code == 200
    assert r.json()["voided_invoice"] is None
    assert _stock(client, belt) == pytest.approx(10)


def test_a_cancelled_service_cannot_be_invoiced(client, acme):
    _auto(client, False)
    job = _service(client, acme, [_charge("Labour", 100)])
    client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "mistake"})

    r = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert r.status_code == 400
