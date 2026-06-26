"""
Promotions — automatic POS discounts.

A promo discounts matching lines by a percentage while it is live (date window
+ optional quantity cap). The cap is server-authoritative: checkout discounts
only the eligible units and records usage in the sale transaction, so "first N"
can't be over-spent; a return hands the allowance back.
"""
import uuid
from datetime import date, timedelta

import pytest


def _key():
    return str(uuid.uuid4())


def _open(c):
    return c.post("/api/pos/session/open", json={"opening_float": 100})


def _item(c, name="Widget", qty=100, price=10, category=None):
    body = {"name": name, "quantity": qty, "unit_cost": 5, "sale_price": price}
    if category:
        body["category"] = category
    r = c.post("/api/inventory/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _promo(c, **kw):
    body = {"name": "Promo", "scope_type": "all", "discount_value": 10}
    body.update(kw)
    r = c.post("/api/promotions/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _sell(c, inv_id, qty, price, discount=0, key=None):
    return c.post("/api/pos/checkout", json={
        "items": [{"name": "x", "inventory_id": inv_id, "quantity": qty,
                   "unit_price": price, "discount": discount}],
        "payment_method": "Cash", "amount_tendered": 100000,
        "idempotency_key": key or _key(),
    })


def _used(db, pid):
    return db.execute("SELECT used_quantity FROM promotions WHERE id=?", (pid,)).fetchone()["used_quantity"]


def test_item_scope_percentage_applies(make_client):
    c = make_client("superadmin"); _open(c)
    it = _item(c, price=10)
    _promo(c, scope_type="item", scope_value=str(it), discount_value=10)
    r = _sell(c, it, 2, 10)
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(18)   # 2×10 − 10%


def test_category_scope_applies(make_client):
    c = make_client("superadmin"); _open(c)
    it = _item(c, name="Cola", price=20, category="Beverages")
    _promo(c, scope_type="category", scope_value="Beverages", discount_value=25)
    assert _sell(c, it, 1, 20).json()["total"] == pytest.approx(15)


def test_store_wide_scope_applies(make_client):
    c = make_client("superadmin"); _open(c)
    it = _item(c, price=10)
    _promo(c, scope_type="all", discount_value=50)
    assert _sell(c, it, 1, 10).json()["total"] == pytest.approx(5)


def test_out_of_date_range_is_ignored(make_client):
    c = make_client("superadmin"); _open(c)
    it = _item(c, price=10)
    yest = (date.today() - timedelta(days=1)).isoformat()
    _promo(c, scope_type="all", discount_value=50, end_date=yest)   # ended yesterday
    assert _sell(c, it, 1, 10).json()["total"] == pytest.approx(10)  # full price


def test_quantity_cap_first_n_then_stops(make_client, db):
    c = make_client("superadmin"); _open(c)
    it = _item(c, qty=100, price=10)
    pid = _promo(c, scope_type="item", scope_value=str(it), discount_value=10, max_quantity=5)

    # First sale: 3 units, all within cap → all discounted.
    assert _sell(c, it, 3, 10).json()["total"] == pytest.approx(27)   # 30 − 3
    assert _used(db, pid) == 3

    # Second sale: 4 units, only 2 left in the cap → 2 discounted, 2 full price.
    assert _sell(c, it, 4, 10).json()["total"] == pytest.approx(38)   # 40 − 2
    assert _used(db, pid) == 5

    # Third sale: cap exhausted → no discount.
    assert _sell(c, it, 2, 10).json()["total"] == pytest.approx(20)
    assert _used(db, pid) == 5


def test_return_refunds_cap_usage(make_client, db):
    c = make_client("superadmin"); _open(c)
    it = _item(c, price=10)
    pid = _promo(c, scope_type="item", scope_value=str(it), discount_value=10, max_quantity=5)
    sale = _sell(c, it, 3, 10)
    assert _used(db, pid) == 3
    r = c.post(f"/api/pos/sales/{sale.json()['id']}/return", json={})
    assert r.status_code == 200, r.text
    assert _used(db, pid) == 0   # allowance handed back


def test_manual_discount_stacks_on_promo(make_client):
    c = make_client("superadmin"); _open(c)
    it = _item(c, price=10)
    _promo(c, scope_type="all", discount_value=10)
    # 2×10 = 20; manual −3 then promo −10% of 20 = −2 → 15.
    assert _sell(c, it, 2, 10, discount=3).json()["total"] == pytest.approx(15)


def test_discount_validation(make_client):
    c = make_client("superadmin")
    bad = c.post("/api/promotions/", json={"name": "x", "scope_type": "all", "discount_value": 150})
    assert bad.status_code == 400
    noscope = c.post("/api/promotions/", json={"name": "x", "scope_type": "item", "discount_value": 10})
    assert noscope.status_code == 400
