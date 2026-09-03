"""A voided invoice is not money owed, on the screens that say who owes what.

Reported from the field: a customer bought two items through the till for $400
and paid $200. His profile showed $200 paid and $200 outstanding, which was
right. The invoice was then voided — and the profile went on showing $200 paid
and $200 outstanding, for a document that no longer existed and money that had
been handed back.

The account page summed every invoice on the client, filtering archived ones but
not voided ones. The project page had the same query, the same omission, and the
same consequence: a cancelled invoice made a project look billed.

The invoice itself stays in the list. The customer's history should show that it
happened and that it was cancelled, so the row is labelled Void rather than
hidden — it is only the figures it must stay out of.
"""
import uuid

import pytest


def _sale_on_account(c, client_id, *, price, deposit):
    """A till sale taken on a plan: goods out, part paid, the rest owed."""
    item = c.post("/api/inventory/", json={
        "name": f"VN Item {uuid.uuid4().hex[:6]}", "product_type": "finished",
        "quantity": 20, "unit_cost": 50, "sale_price": price}).json()["id"]
    # 409 just means this client already has the register open.
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)
    r = c.post("/api/pos/checkout", json={
        "client_id": client_id,
        "items": [{"name": "VN Item", "inventory_id": item,
                   "quantity": 2, "unit_price": price / 2}],
        "payment_method": "Cash", "amount_tendered": deposit,
        "installment_plan": {"down_payment": deposit, "count": 1,
                             "frequency": "monthly"},
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return r.json()


def _stats(c, client_id):
    return c.get(f"/api/clients/{client_id}").json()["stats"]


# ── the report, reproduced ──────────────────────────────────────────────────
def test_voiding_clears_the_clients_balance(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "VN Client"}).json()["id"]

    sale = _sale_on_account(c, cl, price=400, deposit=200)
    before = _stats(c, cl)
    assert before["total_invoiced"] == pytest.approx(400)
    assert before["total_paid"] == pytest.approx(200)
    assert before["outstanding"] == pytest.approx(200)

    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    after = _stats(c, cl)
    assert after["total_invoiced"] == pytest.approx(0), "billed for a void invoice"
    assert after["total_paid"] == pytest.approx(0), "credited a refunded payment"
    assert after["outstanding"] == pytest.approx(0), "still chasing a void invoice"


def test_the_invoice_is_still_shown_and_labelled(make_client):
    """Out of the figures, not out of the history."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "VN Shown"}).json()["id"]
    sale = _sale_on_account(c, cl, price=400, deposit=200)
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    rows = c.get(f"/api/clients/{cl}").json()["invoices"]
    assert len(rows) == 1, "the invoice vanished from the customer's history"
    assert rows[0]["status"] == "Void"


def test_a_live_invoice_still_counts(make_client):
    """The guard must not stop the screen reporting real debt."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "VN Live"}).json()["id"]
    _sale_on_account(c, cl, price=400, deposit=200)

    st = _stats(c, cl)
    assert st["total_invoiced"] == pytest.approx(400)
    assert st["total_paid"] == pytest.approx(200)
    assert st["outstanding"] == pytest.approx(200)


def test_only_the_voided_one_drops_out(make_client):
    """Two invoices, one voided — the other must be untouched."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "VN Both"}).json()["id"]
    kept = _sale_on_account(c, cl, price=400, deposit=200)
    dropped = _sale_on_account(c, cl, price=100, deposit=40)

    assert c.patch(f"/api/invoices/{dropped['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    st = _stats(c, cl)
    assert st["total_invoiced"] == pytest.approx(400)
    assert st["total_paid"] == pytest.approx(200)
    assert st["outstanding"] == pytest.approx(200)
    assert len(c.get(f"/api/clients/{cl}").json()["invoices"]) == 2


# ── the same query, the same omission, on the project page ──────────────────
def test_a_voided_invoice_does_not_make_a_project_look_billed(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "VN Proj Client"}).json()["id"]
    pr = c.post("/api/projects/", json={"name": "VN Project", "client_id": cl})
    assert pr.status_code in (200, 201), pr.text
    project_id = pr.json()["id"]

    inv = c.post("/api/invoices/", json={
        "client_id": cl, "project_id": project_id,
        "items": [{"name": "Work", "quantity": 1, "unit_price": 500}]})
    assert inv.status_code in (200, 201), inv.text
    invoice_id = inv.json()["id"]
    assert c.post(f"/api/invoices/{invoice_id}/payments", json={
        "amount": 300, "method": "Cash", "idempotency_key": "vn-1"}).status_code == 200

    before = c.get(f"/api/projects/{project_id}").json()["stats"]
    assert before["total_invoiced"] == pytest.approx(500)
    assert before["total_paid"] == pytest.approx(300)

    assert c.patch(f"/api/invoices/{invoice_id}/void",
                   json={"reason": "test"}).status_code == 200

    after = c.get(f"/api/projects/{project_id}").json()["stats"]
    assert after["total_invoiced"] == pytest.approx(0)
    assert after["total_paid"] == pytest.approx(0)
    assert after["outstanding"] == pytest.approx(0)
    rows = c.get(f"/api/projects/{project_id}").json()["invoices"]
    assert rows and rows[0]["status"] == "Void"


# ── the readers that were already right, pinned so they stay right ──────────
def test_the_statement_and_the_payment_plan_agree(make_client):
    """Both already filtered voided invoices; this keeps them honest."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "VN Agree"}).json()["id"]
    sale = _sale_on_account(c, cl, price=400, deposit=200)
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    st = c.get(f"/api/clients/{cl}/statement").json()
    assert st["closing_balance"] == pytest.approx(0)
    assert st["total_charged"] == pytest.approx(0)

    plan = c.get(f"/api/clients/{cl}/plan").json()
    assert plan["outstanding"] == pytest.approx(0)
