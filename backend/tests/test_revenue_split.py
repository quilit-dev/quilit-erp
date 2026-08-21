"""Splitting a payment across revenue accounts.

Revenue here is recognised on PAYMENT, not on invoicing, so the split has to
happen when the money arrives — and payments are often partial. A $1,000
invoice that is 40% parts and 60% labour, paying $500, must credit $200 to
goods and $300 to service. "Service first" would overstate one account on
every part-paid invoice.

The other half of this is arithmetic: the credits must sum to the payment to
the cent, or post_entry rejects the entry as unbalanced and the payment fails.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import pytest

import accounting
from accounting import REVENUE, SERVICE_REVENUE


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Acme Ltd"}).json()["id"]


def _split_invoice(client, acme, parts=400.0, labour=600.0):
    """An invoice whose lines are deliberately mixed: a part and a charge."""
    import database
    inv = client.post("/api/invoices/", json={
        "client_id": acme,
        "items": [
            {"name": "Bearing", "quantity": 1, "unit_price": parts},
            {"name": "Labour",  "quantity": 1, "unit_price": labour},
        ],
    })
    assert inv.status_code == 200, inv.text
    inv_id = inv.json()["id"]
    # The service module sets this when it raises the invoice; here we set it
    # directly so the split can be tested without the whole module.
    with database.session() as db:
        db.execute("UPDATE invoice_items SET revenue_account=? "
                   "WHERE invoice_id=? AND name='Labour'", (SERVICE_REVENUE, inv_id))
        db.commit()
    return inv_id


def _credits(inv_id):
    """Revenue credited per account, from the ledger, for one invoice.

    Restricted to INCOME accounts, which is what this helper has always claimed
    to return. A payment entry also credits 1100 Accounts Receivable now (the
    payment converts the claim into cash as well as earning the revenue), and
    without the filter that receivable credit shows up here as if it were
    revenue. The split itself is unchanged — every expected figure below is
    exactly what it was.
    """
    import database
    with database.session() as db:
        rows = db.execute(
            "SELECT a.code AS code, SUM(l.credit) AS c "
            "FROM journal_entry_lines l "
            "JOIN journal_entries e ON e.id = l.journal_entry_id "
            "JOIN chart_of_accounts a ON a.id = l.account_id "
            "WHERE e.source_type='invoice_payment' AND e.source_id IN "
            "  (SELECT id FROM invoice_payments WHERE invoice_id=?) "
            "  AND l.credit > 0 AND a.type = 'Income' GROUP BY 1", (inv_id,)).fetchall()
    return {r["code"]: round(float(r["c"] or 0), 2) for r in rows}


def _pay(client, inv_id, amount):
    import uuid
    r = client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": amount, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4()),
    })
    assert r.status_code == 200, r.text
    return r


# ── the unit, in isolation ───────────────────────────────────────────────────

def test_an_invoice_with_no_items_credits_the_default_account():
    import database
    with database.session() as db:
        lines = accounting.revenue_split(db, -1, 100.0)
    assert lines == [{"code": REVENUE, "credit": 100.0}]


def test_the_credits_always_sum_to_the_payment(client, acme):
    """A third of an odd figure loses a cent unless the residue is placed."""
    inv_id = _split_invoice(client, acme, parts=1.0, labour=2.0)
    import database
    for amount in (0.01, 0.02, 0.05, 10.0, 33.33, 100.0, 999.99):
        with database.session() as db:
            lines = accounting.revenue_split(db, inv_id, amount)
        assert round(sum(l["credit"] for l in lines), 2) == round(amount, 2), \
            f"{amount} split into {lines}"


# ── through the real payment path ────────────────────────────────────────────

def test_full_payment_lands_in_both_accounts(client, acme):
    inv_id = _split_invoice(client, acme, parts=400, labour=600)
    _pay(client, inv_id, 1000)

    assert _credits(inv_id) == {REVENUE: 400.0, SERVICE_REVENUE: 600.0}


def test_a_partial_payment_is_split_pro_rata(client, acme):
    # The case that makes "labour first" wrong.
    inv_id = _split_invoice(client, acme, parts=400, labour=600)
    _pay(client, inv_id, 500)

    assert _credits(inv_id) == {REVENUE: 200.0, SERVICE_REVENUE: 300.0}


def test_paying_the_rest_reaches_the_full_split_with_no_drift(client, acme):
    inv_id = _split_invoice(client, acme, parts=400, labour=600)
    _pay(client, inv_id, 500)
    _pay(client, inv_id, 500)

    assert _credits(inv_id) == {REVENUE: 400.0, SERVICE_REVENUE: 600.0}


# ── nothing else changes ─────────────────────────────────────────────────────

def test_an_ordinary_invoice_still_posts_one_line_to_4000(client, acme):
    """No invoice outside the service module sets revenue_account, so every
    existing caller must behave exactly as before."""
    inv_id = client.post("/api/invoices/", json={
        "client_id": acme,
        "items": [{"name": "Widget", "quantity": 2, "unit_price": 50}],
    }).json()["id"]
    _pay(client, inv_id, 100)

    credits = _credits(inv_id)
    assert credits == {REVENUE: 100.0}
    assert SERVICE_REVENUE not in credits


# ── the one that was easiest to miss ─────────────────────────────────────────

def test_void_then_unvoid_restores_both_accounts(client, acme):
    """unvoid_invoice re-posts the payments it reversed. It used to re-post them
    all to 4000, so a void/unvoid round trip silently migrated service revenue
    into the goods account — a corruption with no error message."""
    inv_id = _split_invoice(client, acme, parts=400, labour=600)
    _pay(client, inv_id, 1000)
    before = _credits(inv_id)

    assert client.patch(f"/api/invoices/{inv_id}/void",
                        json={"reason": "test"}).status_code == 200
    assert client.patch(f"/api/invoices/{inv_id}/unvoid").status_code == 200

    import database
    with database.session() as db:
        rows = db.execute(
            "SELECT a.code AS code, "
            "       SUM(COALESCE(l.credit,0)) - SUM(COALESCE(l.debit,0)) AS net "
            "FROM journal_entry_lines l "
            "JOIN chart_of_accounts a ON a.id = l.account_id "
            "WHERE a.code IN (?,?) GROUP BY 1", (REVENUE, SERVICE_REVENUE)).fetchall()
    net = {r["code"]: round(float(r["net"] or 0), 2) for r in rows}

    assert net.get(REVENUE, 0) == before[REVENUE]
    assert net.get(SERVICE_REVENUE, 0) == before[SERVICE_REVENUE]
