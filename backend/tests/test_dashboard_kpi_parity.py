"""A dashboard card must agree with the page it links to.

A KPI is a promise that a number means something. Clicking through and finding
a different one does not just mislead about that figure — it costs the operator
their trust in every other number on the screen, which is the expensive part.

Seven of them disagreed, and six were the same mistake wearing different
clothes: the dashboard filtered `deleted_at`, a column most of these tables
never set, while the list screens filter `archived_at`. An archived row was
counted on the front page and invisible everywhere else, with nothing failing.
The remaining two were a deny-list that admitted every status invented after it
was written, and an invoice awaiting approval being called overdue when the
Invoices page says explicitly that it is not.

These tests build the awkward row through the real API — archive it, void it,
amend it — and then hold the two endpoints against each other. Comparing the
SQL by eye is what let this through in the first place.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


# ── helpers ─────────────────────────────────────────────────────────────────
def _dash(c, key=None):
    r = c.get("/api/dashboard/")
    assert r.status_code == 200, r.text
    d = r.json()
    return d if key is None else d[key]


def _item(c, name, qty=0, min_stock=0, price=10):
    r = c.post("/api/inventory/", json={
        "name": f"{name} {uuid.uuid4().hex[:6]}", "product_type": "finished",
        "quantity": qty, "min_stock": min_stock, "unit_cost": 1,
        "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _client(c, name="Dash Co"):
    r = c.post("/api/clients/", json={"name": f"{name} {uuid.uuid4().hex[:5]}"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _invoice(c, client_id, amount, due_date=None):
    body = {"client_id": client_id,
            "items": [{"name": "Work", "quantity": 1, "unit_price": amount}]}
    if due_date:
        body["due_date"] = due_date
    r = c.post("/api/invoices/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _invoices(c, **params):
    r = c.get("/api/invoices/", params=params)
    assert r.status_code == 200, r.text
    body = r.json()
    return body["items"] if isinstance(body, dict) else body


# ── the archived-row family ─────────────────────────────────────────────────
def test_an_archived_low_stock_item_is_off_both_screens(make_client):
    """The card filtered `deleted_at`, which inventory never sets."""
    c = make_client("superadmin")
    before = _dash(c, "low_stock_alerts")
    iid = _item(c, "KPI Low", qty=0, min_stock=5)
    assert _dash(c, "low_stock_alerts") == before + 1, "setup: it should count"

    assert c.patch(f"/api/inventory/{iid}/archive").status_code == 200

    page = c.get("/api/inventory/", params={"low_stock": True}).json()
    assert not any(x["id"] == iid for x in page), "setup: the list hides it"
    assert _dash(c, "low_stock_alerts") == before, \
        "an item the Inventory list hides must not be counted on the dashboard"


def test_an_archived_project_is_not_an_active_one(make_client):
    """Archiving a project has no status guard, so this one is reachable.

    Quotations have the same gap in the dashboard query and cannot reach it —
    archiving one is refused until it has been voided, and voiding takes it out
    of Draft/Sent anyway. The filter is there on both for the same reason; only
    this one could actually be seen.
    """
    c = make_client("superadmin")
    before = _dash(c, "active_projects")
    r = c.post("/api/projects/", json={
        "name": f"KPI Project {uuid.uuid4().hex[:6]}",
        "client_id": _client(c), "status": "In Progress"})
    assert r.status_code in (200, 201), r.text
    pid = r.json()["id"]
    assert _dash(c, "active_projects") == before + 1, "setup: it should count"

    assert c.patch(f"/api/projects/{pid}/archive").status_code == 200
    page = c.get("/api/projects/").json()
    page = page["items"] if isinstance(page, dict) else page
    assert not any(x["id"] == pid for x in page), "setup: the list hides it"
    assert _dash(c, "active_projects") == before,         "a project the Projects list hides must not be counted on the dashboard"


# ── money that was taken back ───────────────────────────────────────────────
def test_a_voided_purchase_leaves_no_cost_on_the_dashboard(make_client):
    """Voiding a purchase voids its expense rows.

    Finance, the P&L and the VAT return all dropped the cost; the dashboard
    kept it, so a cancelled delivery went on making the month look worse on the
    one screen everybody reads.
    """
    c = make_client("superadmin")
    item = _item(c, "KPI Void", qty=0)
    before = _dash(c, "monthly_expenses")

    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item, "product_name": "Thing",
        "quantity": 10, "unit_cost": 20, "status": "Paid"})
    assert r.status_code in (200, 201), r.text
    pid = r.json()["id"]
    assert _dash(c, "monthly_expenses") == pytest.approx(before + 200, abs=0.01), \
        "setup: the purchase should be a cost"

    assert c.patch(f"/api/purchases/{pid}/void",
                   json={"reason": "never arrived"}).status_code == 200
    assert _dash(c, "monthly_expenses") == pytest.approx(before, abs=0.01), \
        "a voided purchase must not still be spending money on the dashboard"


def test_todays_takings_count_a_sale_once(make_client):
    """`!= 'voided'` admitted every status invented afterwards.

    A returned sale was already being counted as a sale. Then amending one
    marked the original 'amended' and rang a replacement, so the same money
    landed in today's takings twice — on the front page, in a figure a manager
    reads to decide whether the day went well.
    """
    c = make_client("superadmin")
    item = _item(c, "KPI Till", qty=100, price=50)
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)

    def ring(qty):
        r = c.post("/api/pos/checkout", json={
            "items": [{"name": "x", "inventory_id": item, "quantity": qty,
                       "unit_price": 50}],
            "payment_method": "Cash", "amount_tendered": qty * 50,
            "idempotency_key": str(uuid.uuid4())})
        assert r.status_code == 200, r.text
        return r.json()

    before = _dash(c, "pos")
    sale = ring(2)
    after = _dash(c, "pos")
    assert after["c"] == before["c"] + 1, "setup: one sale, counted once"

    # Amend it: the original becomes 'amended' and a replacement is rung.
    sale_id = sale["id"]
    r = c.post(f"/api/pos/sales/{sale_id}/amend", json={
        "reason": "wrong quantity",
        "items": [{"name": "x", "inventory_id": item, "quantity": 3,
                   "unit_price": 50}],
        "payment_method": "Cash", "amount_tendered": 150,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text

    amended = _dash(c, "pos")
    assert amended["c"] == before["c"] + 1, \
        "a corrected sale and its replacement are one sale, not two"
    assert amended["total"] == pytest.approx(before["total"] + 150, abs=0.01), \
        "and the takings are what was actually taken"


# ── the two invoice cards ───────────────────────────────────────────────────
def test_the_outstanding_card_counts_what_the_invoice_list_shows_owing(make_client):
    """The card's count and its amount have to describe the same set.

    Its label used to read "Unpaid Invoices" while it counted every invoice
    with a balance — part-paid ones included. The Invoices list means something
    narrower by Unpaid: nothing paid at all. Two counts, one word, and the card
    read wrong against the page it links to. The figures are the useful ones;
    the label was the lie, so the label changed.
    """
    c = make_client("superadmin")
    cid = _client(c)
    before = _dash(c)["unpaid_invoices_count"]

    inv = _invoice(c, cid, 300)
    r = c.post(f"/api/invoices/{inv}/payments",
               json={"amount": 100, "method": "Cash",
                     "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text

    rows = _invoices(c)
    row = next(x for x in rows if x["id"] == inv)
    assert row["payment_status"] == "Partial", "setup: part-paid"
    assert row["remaining"] == pytest.approx(200, abs=0.01)

    # The card counts it, because it is money still owed.
    assert _dash(c)["unpaid_invoices_count"] == before + 1

    # And the amount agrees with the list's own `remaining`, which is the
    # property that makes the count meaningful.
    owed = sum(x["remaining"] for x in rows
               if x["payment_status"] in ("Unpaid", "Partial", "Pending Approval"))
    assert _dash(c)["unpaid_invoices_amount"] == pytest.approx(owed, abs=0.01), \
        "the money on the card must be the money the list says is outstanding"


def test_an_invoice_awaiting_approval_is_not_overdue(make_client, db):
    """routers/invoices.py forces `is_overdue` false on it, deliberately.

    It is a draft: it has not been issued, nobody can be chased for it, and the
    dashboard was putting it on the overdue card anyway.
    """
    c = make_client("superadmin")
    inv = _invoice(c, _client(c), 500, due_date="2020-01-01")
    before = _dash(c)["overdue_invoices_count"]
    assert before >= 1, "setup: it is past due and counted"

    db.execute("UPDATE invoices SET approval_status='Pending Approval' WHERE id=?",
               (inv,))
    db.commit()

    row = next(x for x in _invoices(c) if x["id"] == inv)
    assert row["payment_status"] == "Pending Approval"
    assert row["is_overdue"] is False, "setup: the list says it is not overdue"
    assert _dash(c)["overdue_invoices_count"] == before - 1, \
        "the card must not call overdue what the list says is not"


def test_a_voided_invoice_is_owed_by_nobody(make_client):
    """The one that was already right — pinned so it stays that way."""
    c = make_client("superadmin")
    inv = _invoice(c, _client(c), 400)
    before = _dash(c)["unpaid_invoices_count"]

    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "keyed twice"}).status_code == 200
    assert _dash(c)["unpaid_invoices_count"] == before - 1
