"""One payment, several invoices, oldest first.

A customer hands over money for "the account", not for invoice #114. Making the
operator split it themselves is how the wrong invoice gets marked paid and an
old one sits open for months.

The payment is broken into one `invoice_payments` row per invoice it touches, so
every balance, statement and ledger posting keeps working exactly as before —
nothing downstream learns a new concept. These tests care most about that: the
allocation is only correct if the ledger agrees with it.
"""
import uuid

import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Allocation Co"}).json()["id"]


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


def _owing(client, inv):
    return client.get(f"/api/invoices/{inv}").json()["remaining"]


# ── Oldest first ─────────────────────────────────────────────────────────────

def test_the_oldest_invoice_is_settled_first(client, acme):
    old = _invoice(client, acme, 100, "2026-01-31")
    new = _invoice(client, acme, 100, "2026-06-30")

    r = _pay(client, acme, 100)

    assert r.status_code == 200, r.text
    assert _owing(client, old) == _pytest.approx(0)
    assert _owing(client, new) == _pytest.approx(100)


def test_a_payment_flows_through_to_the_next_invoice(client, acme):
    """150 against two 100s clears the first and part-pays the second."""
    old = _invoice(client, acme, 100, "2026-01-31")
    new = _invoice(client, acme, 100, "2026-06-30")

    r = _pay(client, acme, 150)

    body = r.json()
    assert [a["applied"] for a in body["allocated"]] == [100, 50]
    assert body["allocated"][0]["settled"] is True
    assert body["allocated"][1]["settled"] is False
    assert _owing(client, old) == _pytest.approx(0)
    assert _owing(client, new) == _pytest.approx(50)


def test_it_spans_as_many_invoices_as_it_reaches(client, acme):
    a = _invoice(client, acme, 50, "2026-01-31")
    b = _invoice(client, acme, 50, "2026-02-28")
    c = _invoice(client, acme, 50, "2026-03-31")

    _pay(client, acme, 125)

    assert _owing(client, a) == _pytest.approx(0)
    assert _owing(client, b) == _pytest.approx(0)
    assert _owing(client, c) == _pytest.approx(25)


def test_an_already_part_paid_invoice_only_takes_what_it_still_needs(client, acme):
    old = _invoice(client, acme, 100, "2026-01-31")
    new = _invoice(client, acme, 100, "2026-06-30")
    client.post(f"/api/invoices/{old}/payments", json={
        "amount": 60, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    _pay(client, acme, 100)

    # The old one needed only its remaining 40; the other 60 went to the new
    # one, leaving 40 there.
    assert _owing(client, old) == _pytest.approx(0)
    assert _owing(client, new) == _pytest.approx(40)


# ── The ledger has to agree ──────────────────────────────────────────────────

def test_the_ledger_balances_after_an_allocation(client, acme):
    """The allocation is only correct if the books say the same thing."""
    _invoice(client, acme, 100, "2026-01-31")
    _invoice(client, acme, 100, "2026-06-30")

    _pay(client, acme, 150)

    body = client.get("/api/accounting/trial-balance").json()
    assert body["balanced"]


def test_each_invoice_gets_its_own_posting(client, acme, db):
    """One row per invoice touched, so every existing balance calculation keeps
    working without learning a new concept."""
    _invoice(client, acme, 100, "2026-01-31")
    _invoice(client, acme, 100, "2026-06-30")

    _pay(client, acme, 150)

    n = db.execute("SELECT COUNT(*) AS n FROM invoice_payments").fetchone()["n"]
    assert n == 2
    entries = db.execute(
        "SELECT COUNT(*) AS n FROM journal_entries "
        "WHERE source_type='invoice_payment'").fetchone()["n"]
    assert entries == 2


def test_the_customer_statement_shows_the_whole_payment(client, acme):
    _invoice(client, acme, 100, "2026-01-31")
    _invoice(client, acme, 100, "2026-06-30")

    _pay(client, acme, 150)

    st = client.get(f"/api/clients/{acme}/statement").json()
    assert st["total_paid"] == _pytest.approx(150)
    assert st["closing_balance"] == _pytest.approx(50)


# ── Refusals ─────────────────────────────────────────────────────────────────

def test_overpayment_is_refused_not_parked(client, acme):
    """A credit balance is a real accounting object with its own rules.
    Inventing one as a side effect of a rounding difference would be worse than
    asking."""
    _invoice(client, acme, 100, "2026-01-31")

    r = _pay(client, acme, 150)

    assert r.status_code == 400
    assert "outstanding" in r.text


def test_paying_a_customer_who_owes_nothing_is_refused(client, acme):
    r = _pay(client, acme, 50)

    assert r.status_code == 400
    assert "nothing outstanding" in r.text


def test_a_duplicate_submission_is_caught(client, acme):
    _invoice(client, acme, 100, "2026-01-31")
    key = str(uuid.uuid4())

    first = _pay(client, acme, 40, idempotency_key=key)
    second = _pay(client, acme, 40, idempotency_key=key)

    assert first.status_code == 200
    assert second.status_code == 409


def test_a_draft_invoice_takes_no_money(client, acme, db):
    """An invoice awaiting approval is a draft. Allocating to it would mark a
    document paid that has not been agreed."""
    inv = _invoice(client, acme, 100, "2026-01-31")
    db.execute("UPDATE invoices SET approval_status='Pending Approval' WHERE id=?", (inv,))
    db.commit()

    r = _pay(client, acme, 50)

    assert r.status_code == 400
    assert "nothing outstanding" in r.text


def test_a_voided_invoice_is_not_owed(client, acme):
    old = _invoice(client, acme, 100, "2026-01-31")
    new = _invoice(client, acme, 100, "2026-06-30")
    client.patch(f"/api/invoices/{old}/void", json={"reason": "cancelled"})

    _pay(client, acme, 100)

    assert _owing(client, new) == _pytest.approx(0)


def test_nothing_is_recorded_when_it_is_refused(client, acme, db):
    """A rejected allocation must leave no half-applied payment behind."""
    _invoice(client, acme, 100, "2026-01-31")

    _pay(client, acme, 500)

    assert db.execute("SELECT COUNT(*) AS n FROM invoice_payments").fetchone()["n"] == 0
