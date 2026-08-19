"""Void / Unvoid lifecycle — invoices and quotations.

Deletion is not part of the document lifecycle: the terminal action is Void,
and it is reversible via Unvoid.

Invoices:
  * unvoid clears voided_at, returns the invoice to finance/VAT totals, and
    RE-POSTS the ledger entry for every payment (void had reversed them) —
    the GL must round-trip void → unvoid back to its original balances.
  * POS-sale invoices cannot be unvoided (the return already restocked the
    goods; unvoiding would desync stock and COGS).

Quotations:
  * /cancel is gone — Void replaces it. Void remembers the previous status
    and Unvoid restores it exactly.
  * A voided quotation is inert: no edit, no convert-to-invoice, no
    convert-to-project, and the Voided status cannot be set via PUT.
"""
import uuid

import pytest

CENT = 0.01


def _key():
    return str(uuid.uuid4())


def _tb_balance(c, code):
    tb = c.get("/api/accounting/trial-balance").json()
    for r in tb["rows"]:
        if r["code"] == code:
            return r["debit"], r["credit"]
    return 0.0, 0.0


# ═══════════════════════════════════════════════════════════════════════════
# Invoices
# ═══════════════════════════════════════════════════════════════════════════
def test_invoice_void_unvoid_round_trips_the_ledger(make_client, db):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "UV Co"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "Service", "quantity": 1, "unit_price": 500}],
    }).json()["id"]
    c.post(f"/api/invoices/{iid}/payments",
           json={"amount": 500, "method": "Cash", "idempotency_key": _key()})
    assert _tb_balance(c, "4000")[1] == pytest.approx(500, abs=CENT)

    # Void: revenue leaves the ledger and the finance summary.
    assert c.patch(f"/api/invoices/{iid}/void",
                   json={"reason": "test"}).status_code == 200
    assert _tb_balance(c, "4000")[1] == pytest.approx(0, abs=CENT)
    s = c.get("/api/finance/range-summary",
              params={"start": "2000-01-01", "end": "2099-12-31"}).json()
    assert s["income"] == pytest.approx(0, abs=CENT)

    # Unvoid: invoice is live again, payment re-recognised, GL restored.
    r = c.patch(f"/api/invoices/{iid}/unvoid")
    assert r.status_code == 200, r.text
    d = c.get(f"/api/invoices/{iid}").json()
    assert not d.get("voided_at")
    assert d["payment_status"] == "Paid"
    assert _tb_balance(c, "4000")[1] == pytest.approx(500, abs=CENT)
    assert _tb_balance(c, "1000")[0] == pytest.approx(500, abs=CENT)
    s = c.get("/api/finance/range-summary",
              params={"start": "2000-01-01", "end": "2099-12-31"}).json()
    assert s["income"] == pytest.approx(500, abs=CENT)

    # The audit trail keeps every ledger movement: the payment, its reversal,
    # the reversal of the invoice's own receivable, and the re-post on unvoid.
    # Four rather than three because voiding an invoice now also reverses the
    # claim it created — leaving that standing would keep asserting an asset the
    # business no longer has.
    n = db.execute(
        "SELECT COUNT(*) n FROM journal_entries "
        "WHERE source_type IN ('invoice_payment', 'reversal')").fetchone()["n"]
    assert n == 4

    # And the round trip really is a round trip: the receivable and its deferred
    # revenue are both back to nil on a fully paid invoice.
    assert _tb_balance(c, "1100")[0] - _tb_balance(c, "1100")[1] == pytest.approx(0, abs=CENT)
    assert _tb_balance(c, "2400")[0] - _tb_balance(c, "2400")[1] == pytest.approx(0, abs=CENT)

    # A second void → unvoid cycle must work too (no idempotency-key residue).
    assert c.patch(f"/api/invoices/{iid}/void",
                   json={"reason": "again"}).status_code == 200
    assert c.patch(f"/api/invoices/{iid}/unvoid").status_code == 200
    assert _tb_balance(c, "4000")[1] == pytest.approx(500, abs=CENT)


def test_invoice_unvoid_guards(make_client, db):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "UV Guard Co"}).json()["id"]

    # Not voided → 400.
    iid = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "A", "quantity": 1, "unit_price": 50}],
    }).json()["id"]
    assert c.patch(f"/api/invoices/{iid}/unvoid").status_code == 400

    # POS-sale invoices are excluded: the return already moved stock back.
    item = c.post("/api/inventory/", json={
        "name": "UV Soda", "product_type": "finished",
        "quantity": 10, "unit_cost": 1, "sale_price": 3}).json()["id"]
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 50}).status_code == 200
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "UV Soda", "inventory_id": item,
                   "quantity": 2, "unit_price": 3}],
        "payment_method": "Cash", "amount_tendered": 10, "idempotency_key": _key(),
    })
    assert sale.status_code == 200, sale.text
    pos_invoice = sale.json()["invoice_id"]
    sale_id = db.execute("SELECT id FROM pos_sales WHERE invoice_id=?",
                         (pos_invoice,)).fetchone()["id"]
    assert c.post(f"/api/pos/sales/{sale_id}/return",
                  json={"reason": "t"}).status_code == 200
    r = c.patch(f"/api/invoices/{pos_invoice}/unvoid")
    assert r.status_code == 400 and "pos" in r.text.lower()


# ═══════════════════════════════════════════════════════════════════════════
# Quotations
# ═══════════════════════════════════════════════════════════════════════════
def _quote(c, status="Sent", price=100):
    cl = c.post("/api/clients/", json={"name": f"QV {_key()[:8]}"}).json()["id"]
    qid = c.post("/api/quotations/", json={
        "client_id": cl, "status": status,
        "items": [{"name": "Item", "quantity": 1, "unit_price": price}],
    }).json()["id"]
    return cl, qid


def test_quotation_void_restores_exact_previous_status(make_client):
    c = make_client("superadmin")
    _, qid = _quote(c, status="Sent")

    assert c.patch(f"/api/quotations/{qid}/void",
                   json={"reason": "t"}).status_code == 200
    assert c.get(f"/api/quotations/{qid}").json()["status"] == "Voided"
    # Double-void → 400.
    assert c.patch(f"/api/quotations/{qid}/void",
                   json={"reason": "t"}).status_code == 400

    assert c.patch(f"/api/quotations/{qid}/unvoid").status_code == 200
    assert c.get(f"/api/quotations/{qid}").json()["status"] == "Sent"   # not Draft
    # Unvoiding a live quotation → 400.
    assert c.patch(f"/api/quotations/{qid}/unvoid").status_code == 400


def test_voided_quotation_is_inert(make_client):
    c = make_client("superadmin")
    cl, qid = _quote(c, status="Accepted")
    assert c.patch(f"/api/quotations/{qid}/void",
                   json={"reason": "t"}).status_code == 200

    # No invoice, no project, no edit.
    assert c.post(f"/api/quotations/{qid}/convert-to-invoice").status_code == 400
    assert c.post(f"/api/quotations/{qid}/convert-to-project").status_code == 400
    r = c.put(f"/api/quotations/{qid}", json={
        "client_id": cl, "status": "Draft",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}]})
    assert r.status_code == 400

    # And 'Voided' cannot be smuggled in through a plain update on a live one.
    _, q2 = _quote(c)
    cl2 = c.get(f"/api/quotations/{q2}").json()["client_id"]
    r = c.put(f"/api/quotations/{q2}", json={
        "client_id": cl2, "status": "Voided",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}]})
    assert r.status_code == 400

    # After unvoid the quotation works again end-to-end.
    assert c.patch(f"/api/quotations/{qid}/unvoid").status_code == 200
    conv = c.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert conv.status_code in (200, 201), conv.text


def test_quotation_with_active_invoice_cannot_be_voided(make_client):
    c = make_client("superadmin")
    _, qid = _quote(c, status="Accepted")
    assert c.post(f"/api/quotations/{qid}/convert-to-invoice").status_code in (200, 201)
    r = c.patch(f"/api/quotations/{qid}/void", json={"reason": "t"})
    assert r.status_code == 400 and "invoice" in r.text.lower()


def test_cancel_endpoint_is_gone(make_client):
    c = make_client("superadmin")
    _, qid = _quote(c)
    assert c.patch(f"/api/quotations/{qid}/cancel",
                   json={"reason": "t"}).status_code in (404, 405)
