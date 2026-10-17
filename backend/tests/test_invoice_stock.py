"""An invoice that takes its goods out of stock.

Off by default --- an ordinary invoice bills and moves nothing. Switched on, the
stock lines leave the shelf at cost exactly as a till sale does, and everything
that later undoes the sale (void, edit, credit note, the explicit put-back) has
to put the same goods back at the same cost.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def c(make_client):
    return make_client("superadmin")


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 2)
    return 0.0


def _item(c, qty=10, cost=4):
    r = c.post("/api/inventory/", json={"name": "Bolt " + uuid.uuid4().hex[:5],
                                        "quantity": qty, "unit_cost": cost, "sale_price": 10})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _qty(c, item):
    return float(c.get(f"/api/inventory/{item}").json()["quantity"])


def _zero(c):
    rows = c.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    return next(r["id"] for r in rows if r.get("tax_type") == "zero")


def _client(c):
    return c.post("/api/clients/", json={"name": "Stock Co " + uuid.uuid4().hex[:4]}).json()["id"]


def _invoice(c, lines, deduct=True, client_id=None):
    z = _zero(c)
    body = {"client_id": client_id or _client(c), "deduct_stock": deduct,
            "items": [{"name": n, "quantity": q, "unit_price": p, "tax_rate_id": z,
                       **({"inventory_id": i} if i else {})} for n, i, q, p in lines]}
    return c.post("/api/invoices/", json=body)


def test_off_by_default_an_invoice_moves_nothing(c):
    item = _item(c)
    r = _invoice(c, [("Bolt", item, 3, 10)], deduct=None)
    assert r.status_code == 200, r.text
    assert _qty(c, item) == 10


def test_switched_on_the_goods_leave_at_cost(c):
    item = _item(c, qty=10, cost=4)
    stock0, cogs0 = _gl(c, "1200"), _gl(c, "5000")
    r = _invoice(c, [("Bolt", item, 3, 10), ("Labour", None, 1, 50)])
    assert r.status_code == 200, r.text
    assert r.json()["stock"]["cost"] == 12
    assert _qty(c, item) == 7
    assert _gl(c, "1200") == stock0 - 12
    assert _gl(c, "5000") == cogs0 + 12
    inv = c.get(f"/api/invoices/{r.json()['id']}").json()
    assert inv["stock_deducted_at"]


def test_short_of_stock_nothing_is_created_or_moved(c):
    item = _item(c, qty=2)
    before = len(c.get("/api/invoices/").json())
    r = _invoice(c, [("Bolt", item, 5, 10)])
    assert r.status_code == 400
    assert "2 available, 5 needed" in r.json()["detail"]
    assert _qty(c, item) == 2
    assert len(c.get("/api/invoices/").json()) == before, "the invoice was rolled back too"


def test_voiding_puts_the_goods_back(c):
    item = _item(c, qty=10, cost=4)
    stock0 = _gl(c, "1200")
    iid = _invoice(c, [("Bolt", item, 3, 10)]).json()["id"]
    assert c.patch(f"/api/invoices/{iid}/void", json={"reason": "x"}).status_code == 200
    assert _qty(c, item) == 10
    assert _gl(c, "1200") == stock0


def test_editing_the_lines_moves_the_difference(c):
    item = _item(c, qty=10, cost=4)
    stock0 = _gl(c, "1200")
    iid = _invoice(c, [("Bolt", item, 3, 10)]).json()["id"]
    inv = c.get(f"/api/invoices/{iid}").json()
    r = c.put(f"/api/invoices/{iid}", json={
        "client_id": inv["client_id"], "version": inv["version"],
        "items": [{"name": "Bolt", "inventory_id": item, "quantity": 5, "unit_price": 10,
                   "tax_rate_id": _zero(c)}]})
    assert r.status_code == 200, r.text
    assert _qty(c, item) == 5
    assert _gl(c, "1200") == stock0 - 20


def test_the_actions_take_out_and_put_back(c):
    item = _item(c, qty=10, cost=4)
    iid = _invoice(c, [("Bolt", item, 4, 10)], deduct=False).json()["id"]
    assert _qty(c, item) == 10
    assert c.post(f"/api/invoices/{iid}/stock").status_code == 200
    assert _qty(c, item) == 6
    assert c.post(f"/api/invoices/{iid}/stock").status_code == 400, "not twice"
    assert c.delete(f"/api/invoices/{iid}/stock").status_code == 200
    assert _qty(c, item) == 10


def test_a_paid_invoice_can_still_take_its_goods(c):
    item = _item(c, qty=10, cost=4)
    iid = _invoice(c, [("Bolt", item, 2, 10)], deduct=False).json()["id"]
    assert c.post(f"/api/invoices/{iid}/payments", json={
        "amount": 20, "method": "Cash", "idempotency_key": str(uuid.uuid4())}).status_code == 200
    inv = c.get(f"/api/invoices/{iid}").json()
    r = c.put(f"/api/invoices/{iid}", json={"client_id": inv["client_id"],
                                            "version": inv["version"], "deduct_stock": True})
    assert r.status_code == 200, r.text
    assert _qty(c, item) == 8


def test_a_credit_note_restocks_at_the_cost_they_left_at(c):
    item = _item(c, qty=10, cost=4)
    iid = _invoice(c, [("Bolt", item, 5, 10)]).json()["id"]
    lines = c.get(f"/api/returns/sales/invoice/{iid}/returnable").json()["lines"]
    assert lines[0]["can_restock"] and lines[0]["unit_cost"] == 4
    stock0 = _gl(c, "1200")
    r = c.post("/api/returns/sales", json={"invoice_id": iid, "lines": [
        {"invoice_item_id": lines[0]["invoice_item_id"], "quantity": 2, "condition": "restock"}]})
    assert r.status_code == 200, r.text
    assert _qty(c, item) == 7
    assert _gl(c, "1200") == stock0 + 8
    # ...and the invoice cannot then put "all" its goods back underneath it.
    assert c.delete(f"/api/invoices/{iid}/stock").status_code == 409
    assert c.patch(f"/api/returns/sales/{r.json()['id']}/void", json={}).status_code == 200
    assert _qty(c, item) == 5


def test_a_till_sale_cannot_take_its_goods_twice(c):
    item = _item(c, qty=10, cost=4)
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code in (200, 409)
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Bolt", "inventory_id": item, "quantity": 1, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 10, "idempotency_key": str(uuid.uuid4())})
    assert sale.status_code == 200, sale.text
    r = c.post(f"/api/invoices/{sale.json()['invoice_id']}/stock")
    assert r.status_code == 400 and "till sale" in r.json()["detail"]
    assert _qty(c, item) == 9
