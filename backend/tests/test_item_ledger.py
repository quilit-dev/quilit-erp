"""Item ledger: one item's sales, buyers, purchases, returns and movements."""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def c(make_client):
    return make_client("superadmin")


def _zero(c):
    rows = c.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    return next(r["id"] for r in rows if r.get("tax_type") == "zero")


def _item(c, qty=20, cost=4, price=10):
    r = c.post("/api/inventory/", json={"name": "Ledger " + uuid.uuid4().hex[:5],
                                        "quantity": qty, "unit_cost": cost, "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _client(c, name):
    return c.post("/api/clients/", json={"name": f"{name} {uuid.uuid4().hex[:4]}"}).json()["id"]


def _invoice(c, cid, lines):
    r = c.post("/api/invoices/", json={"client_id": cid, "items": [
        {"name": n, "quantity": q, "unit_price": p, "tax_rate_id": _zero(c),
         **({"inventory_id": i} if i else {})} for n, i, q, p in lines]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _ledger(c, item, **params):
    r = c.get("/api/reports/item-ledger", params={"inventory_id": item, **params})
    assert r.status_code == 200, r.text
    return r.json()


def test_sales_and_who_bought_it(c):
    item = _item(c)
    name = c.get(f"/api/inventory/{item}").json()["name"]
    nour, rami = _client(c, "Nour"), _client(c, "Rami")
    _invoice(c, nour, [(name, item, 3, 10)])
    _invoice(c, nour, [(name, item, 2, 12)])
    _invoice(c, rami, [(name, None, 1, 10)])          # typed, not picked
    _invoice(c, rami, [("Something else", None, 5, 1)])
    led = _ledger(c, item)
    assert led["summary"]["quantity_sold"] == 6
    assert led["summary"]["net_sales"] == 64
    assert led["summary"]["customers"] == 2 and led["summary"]["invoices"] == 3
    assert led["summary"]["average_price"] == pytest.approx(64 / 6, abs=0.01)
    assert len(led["sales"]) == 3
    top = led["customers"][0]
    assert top["client_id"] == nour and top["quantity"] == 5 and top["invoices"] == 2
    assert led["sales"][0]["payment_status"] == "Unpaid"
    assert led["monthly"] and led["monthly"][-1]["quantity"] == 6


def test_till_sales_returns_and_movements(c):
    item = _item(c, qty=20, cost=4)
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code in (200, 409)
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "x", "inventory_id": item, "quantity": 4, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 40, "idempotency_key": str(uuid.uuid4())}).json()
    lines = c.get(f"/api/returns/sales/invoice/{sale['invoice_id']}/returnable").json()["lines"]
    assert c.post("/api/returns/sales", json={
        "invoice_id": sale["invoice_id"], "settlement": "refund",
        "lines": [{"invoice_item_id": lines[0]["invoice_item_id"], "quantity": 1,
                   "condition": "restock"}]}).status_code == 200
    led = _ledger(c, item)
    s = led["summary"]
    assert s["quantity_sold"] == 4 and s["quantity_returned"] == 1 and s["net_quantity"] == 3
    assert s["net_sales"] == 30 and s["cost"] == 12 and s["profit"] == 18
    assert led["sales"][0]["source"] == "pos" and led["sales"][0]["payment_status"] == "Paid"
    assert led["returns_in"][0]["quantity"] == 1
    types = [m["type"] for m in led["movements"]]
    assert "sale" in types and "return" in types
    assert led["movements"][-1]["qty_after"] == led["item"]["on_hand"] == 17


def test_purchases_are_listed(c):
    item = _item(c, qty=0, cost=0)
    r = c.post("/api/purchases/", json={"supplier": "Acme", "inventory_id": item,
                                        "product_name": "Thing", "quantity": 10,
                                        "unit_cost": 3, "status": "Paid"})
    assert r.status_code in (200, 201), r.text
    led = _ledger(c, item)
    assert led["purchases"][0]["supplier"] == "Acme" and led["purchases"][0]["quantity"] == 10
    assert led["summary"]["quantity_purchased"] == 10
    assert led["purchases"][0]["unit_cost"] == 3


def test_period_and_unknown_item(c):
    item = _item(c)
    _invoice(c, _client(c, "Old"), [("x", item, 1, 10)])
    assert _ledger(c, item, start="2000-01-01", end="2000-12-31")["sales"] == []
    assert c.get("/api/reports/item-ledger", params={"inventory_id": 99999999}).status_code == 404


def test_costs_are_hidden_without_permission(make_client):
    admin = make_client("superadmin")
    item = _item(admin, cost=7)
    _invoice(admin, _client(admin, "Buyer"), [("x", item, 2, 10)])
    led = make_client("Viewer").get("/api/reports/item-ledger", params={"inventory_id": item})
    assert led.status_code == 200, led.text
    led = led.json()
    assert led["show_cost"] is False
    assert "cost" not in led["summary"] and "profit" not in led["summary"]
    assert "unit_cost" not in led["item"] and "stock_value" not in led["item"]
    assert all("cost" not in s for s in led["sales"])
