"""
Finance reconciliation (/api/finance/reconciliation).

Covers the void fix + the cash-basis ledger↔sub-ledger integrity checks:

  * a voided invoice is excluded from invoiced / collected / outstanding totals;
  * voiding an invoice that had a payment reverses its ledger entry, so it does
    NOT surface as an "unreversed_void" issue and the trial balance stays tied;
  * a healthy paid invoice reconciles clean.
"""
import pytest

CENT = 0.005


def _inv(c, client_id, items):
    r = c.post("/api/invoices/", json={"client_id": client_id, "project_id": None, "items": items})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _pay(c, inv_id, amount):
    r = c.post(f"/api/invoices/{inv_id}/payments",
               json={"amount": amount, "currency": "USD", "method": "Cash",
                     "idempotency_key": f"pay-{inv_id}-{amount}"})
    assert r.status_code in (200, 201), r.text


def test_reconciliation_excludes_voided_and_stays_clean(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Recon Co"}).json()["id"]

    # Active, fully-paid invoice.
    a = _inv(c, cl, [{"name": "X", "quantity": 1, "unit_price": 100}])
    _pay(c, a, 100)

    # Voided invoice with NO payment — excluded from totals, raises no warning.
    b = _inv(c, cl, [{"name": "Y", "quantity": 1, "unit_price": 200}])
    assert c.patch(f"/api/invoices/{b}/void", json={"reason": "t"}).status_code == 200

    rec = c.get("/api/finance/reconciliation").json()
    types = [i["type"] for i in rec["issues"]]

    # Voided invoice excluded from every total.
    assert rec["summary"]["total_invoiced"]  == pytest.approx(100, abs=CENT)
    assert rec["summary"]["total_collected"] == pytest.approx(100, abs=CENT)
    assert rec["summary"]["outstanding"]     == pytest.approx(0,   abs=CENT)

    # No integrity issues, books balanced, and nothing flagged for this dataset.
    assert "unreversed_void" not in types, rec["issues"]
    assert "gl_unbalanced"   not in types, rec["issues"]
    assert "vat_mismatch"    not in types, rec["issues"]
    assert rec["clean"] is True, rec["issues"]


def test_paid_then_voided_flags_orphaned_payment_but_reverses_ledger(make_client):
    """Voiding a PAID invoice reverses its ledger entry (so no 'unreversed_void'
    and the trial balance stays tied), while the surviving payment is surfaced as
    an orphaned payment to review for a refund. Its revenue leaves the totals."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Recon Co 3"}).json()["id"]

    b = _inv(c, cl, [{"name": "Y", "quantity": 1, "unit_price": 200}])
    _pay(c, b, 200)
    assert c.patch(f"/api/invoices/{b}/void", json={"reason": "t"}).status_code == 200

    rec = c.get("/api/finance/reconciliation").json()
    types = [i["type"] for i in rec["issues"]]

    assert "orphaned_payment" in types, rec["issues"]   # payment on voided invoice surfaced
    assert "unreversed_void"  not in types, rec["issues"]  # ledger was reversed by void
    assert "gl_unbalanced"    not in types, rec["issues"]
    # Voided invoice's revenue is excluded from collected.
    assert rec["summary"]["total_collected"] == pytest.approx(0, abs=CENT)


def test_outstanding_counts_only_active_unpaid(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Recon Co 2"}).json()["id"]

    # One unpaid active invoice → it IS outstanding.
    _inv(c, cl, [{"name": "Z", "quantity": 1, "unit_price": 150}])
    # One voided unpaid invoice → must NOT be outstanding.
    v = _inv(c, cl, [{"name": "V", "quantity": 1, "unit_price": 900}])
    assert c.patch(f"/api/invoices/{v}/void", json={"reason": "t"}).status_code == 200

    rec = c.get("/api/finance/reconciliation").json()
    assert rec["summary"]["total_invoiced"] == pytest.approx(150, abs=CENT)
    assert rec["summary"]["outstanding"]    == pytest.approx(150, abs=CENT)
