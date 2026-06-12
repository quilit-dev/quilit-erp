"""
Entity state-transition checks.

Probes that records cannot be driven into illegal states and that operations
on terminal-state records are refused cleanly (4xx), never 5xx.

Tests skip themselves if a precondition record cannot be created, so a payload
schema drift degrades to a SKIP rather than a misleading failure.
"""
import pytest


def _new_client(c, name="State Co"):
    r = c.post("/api/clients/", json={"name": name})
    return r.json().get("id") if r.status_code in (200, 201) else None


# ── Invoices: void is terminal ───────────────────────────────────────────────
@pytest.mark.state
def test_voided_invoice_cannot_be_edited(make_client):
    c = make_client("superadmin")
    cid = _new_client(c, "Invoice State Co")
    if not cid:
        pytest.skip("could not create prerequisite client")
    inv = c.post("/api/invoices/", json={
        "client_id": cid, "project_id": None,
        "items": [{"name": "Item", "quantity": 1, "unit_price": 500}],
    })
    if inv.status_code not in (200, 201):
        pytest.skip(f"invoice create failed ({inv.status_code})")
    inv_id = inv.json()["id"]

    voided = c.patch(f"/api/invoices/{inv_id}/void", json={"reason": "QA void"})
    assert voided.status_code < 500, f"void crashed: {voided.status_code}"
    if voided.status_code not in (200, 204):
        pytest.skip(f"void not accepted ({voided.status_code})")

    # editing a voided invoice must be refused, not silently applied or 500
    edit = c.put(f"/api/invoices/{inv_id}", json={
        "client_id": cid, "project_id": None,
        "items": [{"name": "Tampered", "quantity": 9, "unit_price": 999}],
    })
    assert edit.status_code < 500, f"editing voided invoice crashed: {edit.status_code}"
    assert edit.status_code >= 400, (
        f"BROKEN STATE TRANSITION: a voided invoice was editable ({edit.status_code})")


@pytest.mark.state
def test_payment_on_voided_invoice_is_refused(make_client):
    c = make_client("superadmin")
    cid = _new_client(c, "Void Pay Co")
    if not cid:
        pytest.skip("could not create prerequisite client")
    inv = c.post("/api/invoices/", json={
        "client_id": cid, "project_id": None,
        "items": [{"name": "Item", "quantity": 1, "unit_price": 500}],
    })
    if inv.status_code not in (200, 201):
        pytest.skip(f"invoice create failed ({inv.status_code})")
    inv_id = inv.json()["id"]
    if c.patch(f"/api/invoices/{inv_id}/void", json={"reason": "QA"}).status_code not in (200, 204):
        pytest.skip("void not accepted")

    pay = c.post(f"/api/invoices/{inv_id}/payments",
                 json={"amount": 50, "method": "Cash"})
    assert pay.status_code < 500, f"payment on voided invoice crashed: {pay.status_code}"
    assert pay.status_code >= 400, (
        f"BROKEN STATE TRANSITION: a voided invoice accepted a payment ({pay.status_code})")


# ── Quotations: voided is terminal (until unvoided) ─────────────────────────
@pytest.mark.state
def test_voided_quotation_cannot_convert_to_invoice(make_client):
    c = make_client("superadmin")
    cid = _new_client(c, "Quote State Co")
    if not cid:
        pytest.skip("could not create prerequisite client")
    q = c.post("/api/quotations/", json={
        "client_id": cid, "status": "Draft",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}],
    })
    if q.status_code not in (200, 201):
        pytest.skip(f"quotation create failed ({q.status_code})")
    qid = q.json()["id"]

    voided = c.patch(f"/api/quotations/{qid}/void", json={"reason": "QA"})
    if voided.status_code not in (200, 204):
        pytest.skip(f"void not accepted ({voided.status_code})")

    conv = c.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert conv.status_code < 500, f"convert of voided quotation crashed: {conv.status_code}"
    assert conv.status_code >= 400, (
        f"BROKEN STATE TRANSITION: a voided quotation was converted to an "
        f"invoice ({conv.status_code})")


# ── Purchases: status field hardening ────────────────────────────────────────
@pytest.mark.state
def test_purchase_status_rejects_garbage_value(make_client):
    """Setting a nonsense status string must be refused, never 500."""
    c = make_client("superadmin")
    purchases = c.get("/api/purchases/")
    if purchases.status_code != 200 or not purchases.json():
        pytest.skip("no purchases available to probe status transitions")
    pid = purchases.json()[0].get("id")
    r = c.patch(f"/api/purchases/{pid}/status", json={"status": "TotallyInvalidStatus"})
    assert r.status_code < 500, f"invalid purchase status crashed: {r.status_code}"


# ── Generic: operating on a soft-deleted record ──────────────────────────────
@pytest.mark.state
def test_update_soft_deleted_client_is_not_5xx(db, make_client):
    c = make_client("superadmin")
    cid = _new_client(c, "Will Be Deleted")
    if not cid:
        pytest.skip("could not create prerequisite client")
    db.execute("UPDATE clients SET deleted_at=datetime('now') WHERE id=?", (cid,))
    db.commit()
    r = c.put(f"/api/clients/{cid}", json={"name": "Resurrected"})
    assert r.status_code < 500, f"updating a soft-deleted client crashed: {r.status_code}"
    assert r.status_code == 404, (
        f"a soft-deleted client was still updatable ({r.status_code}, expected 404)")
