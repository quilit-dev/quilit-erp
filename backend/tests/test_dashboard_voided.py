"""A voided invoice is not money, and the dashboard must stop saying it is.

Void reverses the ledger correctly — the receivable, the payments, the VAT all
come back out, and the trial balance, the finance summary and the client
statement all read zero. The dashboard did not know about any of it: its
invoice queries guarded only `deleted_at`, a column nothing ever sets on an
invoice, so they filtered nothing whatsoever.

Two separate wrongs came out of that. A half-paid invoice that was voided went
on being counted as outstanding — £600 owed by a customer who owes nothing.
And the £400 they had already paid, and had refunded, went on being counted as
this month's income.

The two rules are NOT the same, which is why they are tested apart:

  * Receivables (unpaid, overdue) exclude voided AND archived. Archiving hides
    a record from every other list, and the aged-receivables report already
    excludes it.
  * Income excludes voided ONLY — deliberately, though it makes no difference
    today: an invoice carrying a payment cannot be archived at all (the router
    refuses it and points at void), so there is no archived income to exclude.
    Adding the filter anyway would state a rule the system does not hold, and
    would start silently erasing income the day that restriction is relaxed.
"""
import pytest


def _invoice(c, client_id, amount):
    r = c.post("/api/invoices/", json={
        "client_id": client_id,
        "items": [{"name": "Consulting", "quantity": 1, "unit_price": amount}]})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _pay(c, invoice_id, amount, key):
    r = c.post(f"/api/invoices/{invoice_id}/payments",
               json={"amount": amount, "method": "Cash", "idempotency_key": key})
    assert r.status_code == 200, r.text


def _dash(c):
    r = c.get("/api/dashboard/")
    assert r.status_code == 200, r.text
    return r.json()


# ── the report ──────────────────────────────────────────────────────────────
def test_a_voided_half_paid_invoice_owes_nothing(make_client):
    """The whole point: no outstanding, on an ordinary invoice with no stock."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "DV Client"}).json()["id"]
    inv = _invoice(c, cl, 1000)
    _pay(c, inv, 400, "dv-1")

    before = _dash(c)
    assert before["unpaid_invoices_amount"] == pytest.approx(600)

    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "test"}).status_code == 200

    after = _dash(c)
    assert after["unpaid_invoices_count"] == 0
    assert after["unpaid_invoices_amount"] == pytest.approx(0)


def test_the_money_paid_on_it_stops_counting_as_income(make_client):
    """It was refunded with the void; it is not this month's takings."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "DV Income"}).json()["id"]
    inv = _invoice(c, cl, 1000)
    _pay(c, inv, 400, "dv-2")

    assert _dash(c)["monthly_income"] == pytest.approx(400)
    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "test"}).status_code == 200
    assert _dash(c)["monthly_income"] == pytest.approx(0)


def test_a_voided_overdue_invoice_is_not_overdue(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "DV Overdue"}).json()["id"]
    r = c.post("/api/invoices/", json={
        "client_id": cl, "due_date": "2020-01-01",
        "items": [{"name": "Old job", "quantity": 1, "unit_price": 500}]})
    inv = r.json()["id"]

    assert _dash(c)["overdue_invoices_count"] >= 1
    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "test"}).status_code == 200
    assert _dash(c)["overdue_invoices_count"] == 0
    assert _dash(c)["overdue_invoices_amount"] == pytest.approx(0)


def test_it_drops_off_the_recent_list(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "DV Recent"}).json()["id"]
    inv = _invoice(c, cl, 250)

    nums = [i["invoice_number"] for i in _dash(c)["recent_invoices"]]
    assert nums, "expected the invoice on the recent list to begin with"

    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "test"}).status_code == 200
    after = [i["invoice_number"] for i in _dash(c)["recent_invoices"]]
    assert nums[0] not in after


# ── the distinction that is easy to get wrong ───────────────────────────────
def test_an_archived_invoice_is_not_chased(make_client):
    """Archiving is not voiding, but an archived debt is still off the list.

    An invoice that has taken a payment CANNOT be archived — the router refuses
    it and points at void instead — so an archived invoice never carries one,
    and the income queries deliberately do not filter on `archived_at`: there
    is nothing there for them to exclude. Only the receivable side needs it.
    """
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "DV Archived"}).json()["id"]
    inv = _invoice(c, cl, 1000)

    assert _dash(c)["unpaid_invoices_amount"] == pytest.approx(1000)
    r = c.patch(f"/api/invoices/{inv}/archive", json={})
    assert r.status_code == 200, r.text

    assert _dash(c)["unpaid_invoices_amount"] == pytest.approx(0)


def test_a_paid_invoice_cannot_be_archived_only_voided(make_client):
    """The rule the test above leans on, pinned so it cannot drift."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "DV Rule"}).json()["id"]
    inv = _invoice(c, cl, 500)
    _pay(c, inv, 100, "dv-5")

    r = c.patch(f"/api/invoices/{inv}/archive", json={})
    assert r.status_code == 400, r.text


def test_a_live_invoice_is_untouched(make_client):
    """The guards must not quietly hide invoices that are simply unpaid."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "DV Live"}).json()["id"]
    inv = _invoice(c, cl, 800)
    _pay(c, inv, 300, "dv-4")

    d = _dash(c)
    assert d["unpaid_invoices_count"] == 1
    assert d["unpaid_invoices_amount"] == pytest.approx(500)
    assert d["monthly_income"] == pytest.approx(300)
