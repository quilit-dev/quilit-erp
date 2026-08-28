"""What the Finance reconciliation can and cannot see.

It is the button somebody presses to ask "is anything wrong?", so a check it
does not have is worse than a check that fails: the answer comes back clean and
is believed.

Three things were wrong with it.

It looked for unreversed ledger entries on voided invoices, but only at the
PAYMENT entries — while a void reverses three kinds: the payment, the
receivable, and, for a till sale, the cost of the goods. An unreversed
`pos_cogs` was invisible. That is precisely the defect voids carried until it
was fixed, so the check could not detect its own subject.

It knew nothing about stock. Nothing compared the goods on the shelf with what
the balance sheet says they are worth.

The `orphaned_payment` warning on every voided invoice LOOKS like noise and is
not: it is a worklist asking whether the customer's money goes back. It fires
forever because there is nowhere to record that somebody answered. Left alone
here — see test_reconciliation.py, which pins it.
"""
import uuid

import pytest


def _recon(c):
    r = c.get("/api/finance/reconciliation")
    assert r.status_code == 200, r.text
    return r.json()


def _types(c):
    return [i["type"] for i in _recon(c)["issues"]]


def _item(c, name, qty=10, cost=4, price=10):
    return c.post("/api/inventory/", json={
        "name": name, "product_type": "finished", "quantity": qty,
        "unit_cost": cost, "sale_price": price}).json()["id"]


def _pos_sale(c, item, qty=3, price=10):
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code == 200
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "RC Item", "inventory_id": item,
                   "quantity": qty, "unit_price": price}],
        "payment_method": "Cash", "amount_tendered": qty * price,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return r.json()


def _void_the_old_way(db, invoice_id):
    """Void as it happened BEFORE the reversal was fixed: money only.

    This is the state live tenants are in for any sale voided earlier, and the
    thing the reconciliation has to be able to find.
    """
    db.execute("UPDATE invoices SET voided_at='2026-08-01 00:00:00' WHERE id=?",
               (invoice_id,))
    for p in db.execute("SELECT id FROM invoice_payments WHERE invoice_id=?",
                        (invoice_id,)).fetchall():
        db.execute("UPDATE journal_entries SET status='reversed' "
                   "WHERE source_type='invoice_payment' AND source_id=?", (p["id"],))
    db.commit()


# ── the check that could not see its own subject ────────────────────────────
def test_it_finds_a_voided_sale_whose_cost_was_never_reversed(make_client, db):
    c = make_client("superadmin")
    item = _item(c, "RC Item")
    sale = _pos_sale(c, item, qty=3)
    _void_the_old_way(db, sale["invoice_id"])

    found = _types(c)
    assert "unreversed_void" in found, \
        "a live pos_cogs entry on a voided invoice went unreported"
    entry = next(i for i in _recon(c)["issues"] if i["type"] == "unreversed_void")
    assert "cost of the goods" in entry["message"]
    assert entry["params"]["amount"] == pytest.approx(12)   # 3 × $4


def test_it_finds_the_goods_that_never_came_back(make_client, db):
    c = make_client("superadmin")
    item = _item(c, "RC Item")
    sale = _pos_sale(c, item, qty=3)
    _void_the_old_way(db, sale["invoice_id"])

    issues = _recon(c)["issues"]
    stock = [i for i in issues if i["type"] == "unrestocked_void"]
    assert stock, "3 units never went back and nothing said so"
    assert stock[0]["params"]["units"] == pytest.approx(3)


def test_a_properly_voided_sale_is_clean(make_client):
    """The fixed path must not trip the checks that hunt the old one."""
    c = make_client("superadmin")
    item = _item(c, "RC Item")
    sale = _pos_sale(c, item, qty=3)
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    found = _types(c)
    assert "unreversed_void" not in found
    assert "unrestocked_void" not in found


# ── stock against the balance sheet ─────────────────────────────────────────
def test_it_notices_stock_the_ledger_does_not_carry(make_client):
    """Opening stock posts nothing to the ledger, so the gap is real."""
    c = make_client("superadmin")
    _item(c, "RC Opening", qty=10, cost=5)      # $50 on the shelf, $0 in the GL

    issues = [i for i in _recon(c)["issues"] if i["type"] == "stock_gl_mismatch"]
    assert issues, "the balance sheet is short by $50 and nothing said so"
    assert issues[0]["params"]["gap"] == pytest.approx(50)
    # A warning, not an error: the commonest cause is opening balances, not a bug.
    assert issues[0]["severity"] == "warning"
    assert "opening stock" in issues[0]["message"].lower()


def test_stock_bought_through_a_purchase_ties_out(make_client):
    """The path that DOES post must not be flagged."""
    c = make_client("superadmin")
    item = _item(c, "RC Bought", qty=0, cost=0)
    po = c.post("/api/purchases/", json={
        "supplier": "RC Mill", "inventory_id": item,
        "product_name": "RC Bought", "quantity": 4, "unit_cost": 25})
    assert c.patch(f"/api/purchases/{po.json()['id']}/status",
                   json={"status": "Paid"}).status_code == 200

    assert "stock_gl_mismatch" not in _types(c)


# ── money held for goods not yet handed over ────────────────────────────────
def test_deferred_revenue_ties_to_what_is_still_owed(make_client, db):
    c = make_client("superadmin")
    item = _item(c, "RC Short", qty=1)
    cl = c.post("/api/clients/", json={"name": "RC Waiting"}).json()["id"]
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code == 200
    r = c.post("/api/pos/checkout", json={
        "client_id": cl,
        "items": [{"name": "RC Short", "inventory_id": item,
                   "quantity": 5, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 50, "allow_backorder": True,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    assert r.json()["deferred_total"] > 0

    assert "deferred_revenue_mismatch" not in _types(c)

    # Close the promise without releasing the liability behind it — the exact
    # inconsistency this check exists to catch.
    db.execute("UPDATE sale_commitments SET status='fulfilled' WHERE invoice_id=?",
               (r.json()["invoice_id"],))
    db.commit()

    bad = [i for i in _recon(c)["issues"] if i["type"] == "deferred_revenue_mismatch"]
    assert bad, "money is being held for nobody and nothing said so"
    assert bad[0]["params"]["held"] == pytest.approx(40)
    assert bad[0]["params"]["owed"] == pytest.approx(0)
