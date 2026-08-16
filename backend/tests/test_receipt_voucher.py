"""The receipt voucher a customer is handed when they pay.

The number is allocated once per invoice and returned unchanged forever after.
That is not a caching nicety — it is the correctness property the whole feature
rests on. A voucher states what has been paid on its invoice TO DATE, so it is
one document that gets reprinted as instalments arrive. If a second printing
minted a second number, a customer who paid 100 and then 150 would hold vouchers
reading 100 and 250: paper receipts for 350 against 250 actually received.
"""
import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def invoice(client):
    c = client.post("/api/clients/", json={"name": "Acme Ltd"}).json()
    return client.post("/api/invoices/", json={
        "client_id": c["id"], "amount": 1000,
        "items": [{"name": "Signage", "quantity": 1, "unit_price": 1000}],
    }).json()


def _pay(client, inv, amount, method="Cash"):
    import uuid
    return client.post(f"/api/invoices/{inv['id']}/payments", json={
        "amount": amount, "currency": "USD", "method": method,
        "idempotency_key": str(uuid.uuid4()),
    })


def _voucher(client, inv):
    return client.post(f"/api/invoices/{inv['id']}/receipt-voucher")


# ── The property everything rests on ─────────────────────────────────────────

def test_reprinting_returns_the_same_number(client, invoice):
    _pay(client, invoice, 400)
    first = _voucher(client, invoice)
    assert first.status_code == 200
    assert first.json()["issued"] is True

    # A second instalment, then print again. The document is the same document.
    _pay(client, invoice, 600)
    second = _voucher(client, invoice)

    assert second.json()["number"] == first.json()["number"], (
        "a reprint minted a new number — the customer would hold two receipts "
        "totalling more than they paid"
    )
    assert second.json()["issued"] is False


def test_the_constraint_backs_it_up(client, invoice, db):
    """Not merely convention: the schema refuses a second row."""
    import sqlite3
    _pay(client, invoice, 100)
    _voucher(client, invoice)

    with pytest.raises(Exception) as e:
        db.execute("INSERT INTO receipt_vouchers (invoice_id, number, created_at) "
                   "VALUES (?, 'RV-DUP', '2026-01-01')", (invoice["id"],))
        db.commit()
    assert "unique" in str(e.value).lower() or "duplicate" in str(e.value).lower()


def test_separate_invoices_get_separate_numbers(client):
    c = client.post("/api/clients/", json={"name": "Acme"}).json()
    numbers = []
    for _ in range(2):
        inv = client.post("/api/invoices/", json={
            "client_id": c["id"], "amount": 50,
            "items": [{"name": "x", "quantity": 1, "unit_price": 50}]}).json()
        _pay(client, inv, 50)
        numbers.append(_voucher(client, inv).json()["number"])

    assert numbers[0] != numbers[1]


# ── Refusals ─────────────────────────────────────────────────────────────────

def test_an_unpaid_invoice_has_nothing_to_receipt(client, invoice):
    r = _voucher(client, invoice)
    assert r.status_code == 400
    assert "nothing to receipt" in r.json()["detail"].lower()


def test_a_voided_invoice_is_refused(client, invoice):
    _pay(client, invoice, 100)
    client.patch(f"/api/invoices/{invoice['id']}/void", json={"reason": "test"})

    r = _voucher(client, invoice)
    assert r.status_code == 400
    assert "voided" in r.json()["detail"].lower()


def test_a_missing_invoice_is_a_404(client):
    assert client.post("/api/invoices/999999/receipt-voucher").status_code == 404


# ── Numbering ────────────────────────────────────────────────────────────────

def test_the_number_uses_the_configured_prefix(client, invoice):
    client.put("/api/settings/", json={"receipt_voucher_prefix": "REC/"})
    _pay(client, invoice, 100)

    number = _voucher(client, invoice).json()["number"]
    assert number.startswith("REC/"), number


def test_the_prefix_defaults_and_is_writable(client):
    assert client.get("/api/settings/").json()["receipt_voucher_prefix"] == "RV-"
    assert client.put("/api/settings/",
                      json={"receipt_voucher_prefix": "V-"}).status_code == 200
    assert client.get("/api/settings/").json()["receipt_voucher_prefix"] == "V-"


def test_issuing_is_recorded_in_the_audit_trail(client, invoice, db):
    # A numbered financial document that appears with no trace of who produced
    # it is exactly what an auditor asks about.
    _pay(client, invoice, 100)
    number = _voucher(client, invoice).json()["number"]

    rows = db.execute(
        "SELECT detail FROM audit_log WHERE action='issue_receipt_voucher'"
    ).fetchall()
    assert rows, "issuing a voucher left no audit entry"
    assert number in str(rows[-1][0])
