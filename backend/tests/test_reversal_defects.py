"""What undoing a sale used to get wrong.

Two paths undo a completed till sale — the POS return and the invoice void —
and both were putting back goods that had never left.

A back-ordered line is invoiced in full but only the units on the shelf are
deducted; the rest are a promise. `pos_sale_items.quantity` stores the invoiced
figure, and the restock put that number back. Sell five with three promised and
the count went from two to five: three units invented, with phantom stock
movements and a fabricated cost layer behind them. The commitment was cancelled
at the same time, so the customer's order was released AND the goods conjured.

The books balanced throughout, which is why nothing caught it.
"""
import uuid

import pytest


def _item(c, name="RD Item", qty=2, cost=4, price=10):
    return c.post("/api/inventory/", json={
        "name": name, "product_type": "finished", "quantity": qty,
        "unit_cost": cost, "sale_price": price}).json()["id"]


def _client(c, name="RD Client"):
    return c.post("/api/clients/", json={"name": name}).json()["id"]


def _open(c):
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code == 200


def _sell(c, item, cl, qty, price=10, backorder=True):
    r = c.post("/api/pos/checkout", json={
        "client_id": cl,
        "items": [{"name": "RD Item", "inventory_id": item,
                   "quantity": qty, "unit_price": price}],
        "payment_method": "Cash", "amount_tendered": qty * price,
        "allow_backorder": backorder, "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return r.json()


def _stock(c, item):
    return c.get(f"/api/inventory/{item}").json()["quantity"]


def _sale_id(db, invoice_id):
    return db.execute("SELECT id FROM pos_sales WHERE invoice_id=?",
                      (invoice_id,)).fetchone()["id"]


def _balanced(c):
    return c.get("/api/accounting/trial-balance").json()["balanced"]


# ── A: goods that never left must not come back ─────────────────────────────
def test_returning_a_backordered_sale_invents_no_stock(make_client, db):
    c = make_client("superadmin")
    item, cl = _item(c, qty=2), _client(c)
    _open(c)

    sale = _sell(c, item, cl, qty=5)          # 2 on the shelf, 3 promised
    assert _stock(c, item) == pytest.approx(0)
    assert sale["commitments"], "expected a commitment on the short line"

    r = c.post(f"/api/pos/sales/{_sale_id(db, sale['invoice_id'])}/return",
               json={"reason": "test"})
    assert r.status_code == 200, r.text

    assert _stock(c, item) == pytest.approx(2), "stock was invented on the return"
    assert _balanced(c) is True


def test_voiding_a_backordered_sale_invents_no_stock(make_client):
    """The void path shares the restock and shared the defect."""
    c = make_client("superadmin")
    item, cl = _item(c, qty=2), _client(c)
    _open(c)

    sale = _sell(c, item, cl, qty=5)
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    assert _stock(c, item) == pytest.approx(2)
    assert _balanced(c) is True


def test_only_the_delivered_units_are_moved(make_client, db):
    """The movement rows must describe what physically happened."""
    c = make_client("superadmin")
    item, cl = _item(c, qty=2), _client(c)
    _open(c)

    sale = _sell(c, item, cl, qty=5)
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    put_back = db.execute(
        "SELECT COALESCE(SUM(delta), 0) AS d FROM stock_movements "
        "WHERE inventory_id=? AND type='return'", (item,)).fetchone()["d"]
    assert put_back == pytest.approx(2), "phantom movements for promised units"


def test_a_partly_delivered_backorder_returns_what_it_took(make_client, db):
    """The case where both halves of the arithmetic matter.

    Two off the shelf at the till, two more handed over when stock arrived,
    one still promised. Four units ever left; four must come back.
    """
    c = make_client("superadmin")
    item, cl = _item(c, qty=2), _client(c)
    _open(c)
    sale = _sell(c, item, cl, qty=5)

    po = c.post("/api/purchases/", json={
        "supplier": "RD Mill", "inventory_id": item,
        "product_name": "RD Item", "quantity": 2, "unit_cost": 4})
    assert c.patch(f"/api/purchases/{po.json()['id']}/status",
                   json={"status": "Paid"}).status_code == 200
    cid = c.get("/api/commitments/").json()[0]["id"]
    d = c.post(f"/api/commitments/{cid}/deliver", json={})
    assert d.status_code == 200, d.text
    assert d.json()["delivered"] == pytest.approx(2)

    r = c.post(f"/api/pos/sales/{_sale_id(db, sale['invoice_id'])}/return",
               json={"reason": "test"})
    assert r.status_code == 200, r.text

    # 2 originally + 2 bought in = 4 units ever existed.
    assert _stock(c, item) == pytest.approx(4)
    assert _balanced(c) is True


# ── the ordinary sale must be untouched by the fix ──────────────────────────
def test_an_ordinary_sale_still_restocks_in_full(make_client, db):
    """No commitment means invoiced and delivered are the same number."""
    c = make_client("superadmin")
    item, cl = _item(c, qty=10), _client(c)
    _open(c)

    sale = _sell(c, item, cl, qty=3, backorder=False)
    assert _stock(c, item) == pytest.approx(7)

    r = c.post(f"/api/pos/sales/{_sale_id(db, sale['invoice_id'])}/return",
               json={"reason": "test"})
    assert r.status_code == 200, r.text
    assert _stock(c, item) == pytest.approx(10)
    assert _balanced(c) is True


def test_a_walk_in_sale_with_no_client_still_restocks(make_client, db):
    """No client, so no commitment can exist; the helper must not trip on it."""
    c = make_client("superadmin")
    item = _item(c, qty=10)
    _open(c)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "RD Item", "inventory_id": item,
                   "quantity": 4, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 40,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    assert _stock(c, item) == pytest.approx(6)

    assert c.post(f"/api/pos/sales/{_sale_id(db, r.json()['invoice_id'])}/return",
                  json={"reason": "test"}).status_code == 200
    assert _stock(c, item) == pytest.approx(10)


def test_the_helper_agrees_with_the_arithmetic(make_client, db):
    """Unit-level check of the formula the whole fix rests on."""
    import sale_reversal
    c = make_client("superadmin")
    item, cl = _item(c, qty=2), _client(c)
    _open(c)
    sale = _sell(c, item, cl, qty=5)

    row = db.execute(
        "SELECT * FROM pos_sale_items WHERE pos_sale_id=?",
        (_sale_id(db, sale["invoice_id"]),)).fetchone()
    # invoiced 5, promised 3, handed over 0 -> 2 left the shelf
    assert sale_reversal.delivered_quantity(db, row) == pytest.approx(2)
