"""Billing a service job, and undoing a completion.

The two operations that connect service work to the money already in the system.
The invariants here are about not doing things twice and not stranding a
customer's invoice:

  * one live invoice per job, derived from the invoice rather than a status flag
  * parts bill at their price and are NOT decremented a second time
  * each line lands in the right revenue account, so parts and labour separate
  * reopening gives the stock back and reverses the cost by an equal entry
  * reopening is refused while a live invoice exists
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


@pytest.fixture(autouse=True)
def manual_billing(client):
    """Most tests here exercise the MANUAL invoice endpoint and the reopen
    rules, so they turn automatic invoicing off. The automatic path — which is
    the default — has its own section at the bottom."""
    client.put("/api/settings/", json={"service_auto_invoice": "0"})


def _completed_job(client, acme, items):
    body = {"client_id": acme, "job_type": "Repair", "items": items}
    job = client.post("/api/service/jobs", json=body).json()
    r = client.post(f"/api/service/jobs/{job['id']}/complete")
    assert r.status_code == 200, r.text
    return job


def _part(inv_id, name, qty, price):
    return {"line_type": "part", "inventory_id": inv_id, "name": name,
            "quantity": qty, "unit_price": price}


def _charge(name, price):
    return {"line_type": "charge", "name": name, "quantity": 1, "unit_price": price}


def _stock(client, inv_id):
    return client.get(f"/api/inventory/{inv_id}").json()["quantity"]


def _balance(client, code):
    body = client.get("/api/accounting/trial-balance").json()
    rows = body.get("rows") if isinstance(body, dict) else body
    for r in rows or []:
        if str(r.get("code")) == code:
            return float(r.get("debit") or 0) - float(r.get("credit") or 0)
    return 0.0


# ── Raising the invoice ──────────────────────────────────────────────────────

def test_a_completed_job_can_be_invoiced(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12),
                                        _charge("Labour", 100)])

    r = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert r.status_code == 200, r.text
    assert r.json()["amount"] == pytest.approx(136)      # 36 parts + 100 labour


def test_an_incomplete_job_cannot_be_invoiced(client, acme):
    """Billing before the work is done would invoice parts still on the shelf."""
    belt = _item(client, "Belt", 10, 4, 12)
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": [_part(belt, "Belt", 3, 12)]}).json()

    r = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert r.status_code == 400
    assert "completed" in r.json()["detail"].lower()


def test_a_job_is_invoiced_once(client, acme):
    job = _completed_job(client, acme, [_charge("Labour", 100)])
    first = client.post(f"/api/service/jobs/{job['id']}/invoice")

    second = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert first.status_code == 200
    assert second.status_code == 409
    assert first.json()["invoice_number"] in second.json()["detail"]


def test_voiding_the_invoice_makes_the_job_billable_again(client, acme):
    """Billing state is derived from the invoice, not stored on the job, so a
    void has to restore it without anything explicitly resetting a flag."""
    job = _completed_job(client, acme, [_charge("Labour", 100)])
    inv = client.post(f"/api/service/jobs/{job['id']}/invoice").json()

    assert client.patch(f"/api/invoices/{inv['invoice_id']}/void",
                       json={"reason": "wrong client"}).status_code == 200

    again = client.post(f"/api/service/jobs/{job['id']}/invoice")
    assert again.status_code == 200, again.text


def test_the_job_reports_its_invoice(client, acme):
    job = _completed_job(client, acme, [_charge("Labour", 100)])
    inv = client.post(f"/api/service/jobs/{job['id']}/invoice").json()

    d = client.get(f"/api/service/jobs/{job['id']}").json()

    assert d["invoice"]["invoice_number"] == inv["invoice_number"]


def test_invoicing_does_not_consume_the_parts_again(client, acme):
    """They left the warehouse at completion. An invoice owns no stock movement
    — it can be drafted, edited and voided."""
    belt = _item(client, "Belt", 10, 4, 12)
    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12)])
    after_completion = _stock(client, belt)

    client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert _stock(client, belt) == pytest.approx(after_completion)
    assert after_completion == pytest.approx(7)


def test_an_empty_job_has_nothing_to_invoice(client, acme):
    job = _completed_job(client, acme, [])

    r = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert r.status_code == 400
    assert "nothing to invoice" in r.json()["detail"].lower()


# ── The revenue split ────────────────────────────────────────────────────────

def test_parts_and_labour_land_in_different_revenue_accounts(client, acme):
    """The reason 4100 exists. One undifferentiated total is the first thing a
    repair shop needs broken apart."""
    belt = _item(client, "Belt", 10, 4, 12)
    goods_before = _balance(client, "4000")
    service_before = _balance(client, "4100")

    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12),
                                        _charge("Labour", 100)])
    inv = client.post(f"/api/service/jobs/{job['id']}/invoice").json()
    client.post(f"/api/invoices/{inv['invoice_id']}/payments", json={
        "amount": inv["amount"], "currency": "USD", "method": "Cash",
        "idempotency_key": "svc-split-1"})

    # Revenue accounts are credits, so the balance moves negative.
    goods = -(_balance(client, "4000") - goods_before)
    service = -(_balance(client, "4100") - service_before)

    assert goods == pytest.approx(36), "3 belts at 12.00 belong in Sales Revenue"
    assert service == pytest.approx(100), "labour belongs in Service Revenue"


def test_a_labour_only_job_credits_only_service_revenue(client, acme):
    goods_before = _balance(client, "4000")

    job = _completed_job(client, acme, [_charge("Callout", 60)])
    inv = client.post(f"/api/service/jobs/{job['id']}/invoice").json()
    client.post(f"/api/invoices/{inv['invoice_id']}/payments", json={
        "amount": inv["amount"], "currency": "USD", "method": "Cash",
        "idempotency_key": "svc-split-2"})

    assert _balance(client, "4000") == pytest.approx(goods_before)


# ── Reopening ────────────────────────────────────────────────────────────────

def test_reopening_gives_the_parts_back(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12)])
    assert _stock(client, belt) == pytest.approx(7)

    r = client.post(f"/api/service/jobs/{job['id']}/reopen")

    assert r.status_code == 200, r.text
    assert _stock(client, belt) == pytest.approx(10)
    assert client.get(f"/api/service/jobs/{job['id']}").json()["status"] == "In Progress"


def test_reopening_reverses_the_cost(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    cogs_before = _balance(client, "5000")
    inv_before = _balance(client, "1200")

    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12)])
    client.post(f"/api/service/jobs/{job['id']}/reopen")

    # Net zero on both sides: the cost was recognised and then unrecognised.
    assert _balance(client, "5000") == pytest.approx(cogs_before)
    assert _balance(client, "1200") == pytest.approx(inv_before)


def test_the_reversal_is_an_entry_not_a_deletion(client, acme):
    """A posted period must stay auditable; deleting the original leaves a gap
    nobody can explain."""
    belt = _item(client, "Belt", 10, 4, 12)
    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12)])
    client.post(f"/api/service/jobs/{job['id']}/reopen")

    entries = client.get("/api/accounting/journal-entries").json()
    rows = entries.get("rows") if isinstance(entries, dict) else entries
    memos = [str(e.get("memo") or "") for e in rows or []]

    assert any("Service parts —" in m for m in memos), "the original is gone"
    assert any("returned" in m for m in memos), "no reversing entry"


def test_an_invoiced_job_cannot_be_reopened(client, acme):
    """Un-consuming parts the customer has been billed for would leave an
    invoice for goods the warehouse still holds."""
    belt = _item(client, "Belt", 10, 4, 12)
    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12)])
    inv = client.post(f"/api/service/jobs/{job['id']}/invoice").json()

    r = client.post(f"/api/service/jobs/{job['id']}/reopen")

    assert r.status_code == 409
    assert inv["invoice_number"] in r.json()["detail"]
    assert _stock(client, belt) == pytest.approx(7), "stock came back anyway"


def test_voiding_the_invoice_allows_the_reopen(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12)])
    inv = client.post(f"/api/service/jobs/{job['id']}/invoice").json()
    client.patch(f"/api/invoices/{inv['invoice_id']}/void", json={"reason": "wrong job"})

    assert client.post(f"/api/service/jobs/{job['id']}/reopen").status_code == 200
    assert _stock(client, belt) == pytest.approx(10)


def test_an_open_job_cannot_be_reopened(client, acme):
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": [_charge("Labour", 50)]}).json()

    assert client.post(f"/api/service/jobs/{job['id']}/reopen").status_code == 400


def test_reopen_then_complete_again_is_net_correct(client, acme):
    """The full round trip: the books must end where a single completion would
    have left them, not at double the cost."""
    belt = _item(client, "Belt", 10, 4, 12)
    cogs_before = _balance(client, "5000")

    job = _completed_job(client, acme, [_part(belt, "Belt", 3, 12)])
    client.post(f"/api/service/jobs/{job['id']}/reopen")
    client.post(f"/api/service/jobs/{job['id']}/complete")

    assert _stock(client, belt) == pytest.approx(7)
    assert _balance(client, "5000") - cogs_before == pytest.approx(12)


# ── Automatic invoicing, the default ─────────────────────────────────────────

def _auto(client, on=True):
    client.put("/api/settings/", json={"service_auto_invoice": "1" if on else "0"})


def test_completing_a_job_invoices_it(client, acme):
    """What the customer asked for: the work is done and priced, so the invoice
    should not wait on somebody pressing a second button."""
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": [_part(belt, "Belt", 3, 12),
                                     _charge("Labour", 100)]}).json()

    r = client.post(f"/api/service/jobs/{job['id']}/complete")

    assert r.status_code == 200, r.text
    assert r.json()["invoice"]["invoice_number"].startswith("INV-")
    assert r.json()["invoice"]["amount"] == pytest.approx(136)


def test_the_automatic_invoice_is_an_ordinary_editable_one(client, acme):
    """It is a normal draft, not a locked document — the customer wants to edit
    it afterwards."""
    _auto(client)
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": [_charge("Labour", 100)]}).json()
    inv = client.post(f"/api/service/jobs/{job['id']}/complete").json()["invoice"]

    edited = client.put(f"/api/invoices/{inv['invoice_id']}", json={
        "client_id": acme, "amount": 150,
        "items": [{"name": "Labour", "quantity": 1, "unit_price": 150}]})

    assert edited.status_code == 200, edited.text


def test_the_setting_turns_it_off(client, acme):
    _auto(client, False)
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": [_charge("Labour", 100)]}).json()

    r = client.post(f"/api/service/jobs/{job['id']}/complete")

    assert r.json()["invoice"] is None
    assert client.get(f"/api/service/jobs/{job['id']}").json()["invoice"] is None


def test_a_job_with_no_lines_completes_without_an_invoice(client, acme):
    """Nothing to bill is not a reason to refuse the completion: the work still
    happened."""
    _auto(client)
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": []}).json()

    r = client.post(f"/api/service/jobs/{job['id']}/complete")

    assert r.status_code == 200
    assert r.json()["invoice"] is None


def test_completing_is_still_one_invoice(client, acme):
    """Auto-invoicing must not open a second route to double-billing."""
    _auto(client)
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": [_charge("Labour", 100)]}).json()
    client.post(f"/api/service/jobs/{job['id']}/complete")

    again = client.post(f"/api/service/jobs/{job['id']}/invoice")

    assert again.status_code == 409


def test_the_parts_still_leave_stock_exactly_once(client, acme):
    """The invoice does not touch stock; completion does. Doing both in one
    call must not change that."""
    _auto(client)
    belt = _item(client, "Belt", 10, 4, 12)
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "items": [_part(belt, "Belt", 3, 12)]}).json()

    client.post(f"/api/service/jobs/{job['id']}/complete")

    assert _stock(client, belt) == pytest.approx(7)
