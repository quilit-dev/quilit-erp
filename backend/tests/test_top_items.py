"""Top selling items: what sells, what it earns, and what sits on the shelf."""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def c(make_client):
    return make_client("superadmin")


def _item(c, name, qty=50, cost=4, price=10):
    r = c.post("/api/inventory/", json={"name": f"{name} {uuid.uuid4().hex[:4]}",
                                        "quantity": qty, "unit_cost": cost, "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _zero(c):
    rows = c.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    return next(r["id"] for r in rows if r.get("tax_type") == "zero")


def _invoice(c, lines, **extra):
    z = _zero(c)
    cid = c.post("/api/clients/", json={"name": "Buyer " + uuid.uuid4().hex[:4]}).json()["id"]
    r = c.post("/api/invoices/", json={"client_id": cid, "items": [
        {"name": n, "quantity": q, "unit_price": p, "tax_rate_id": z,
         **({"inventory_id": i} if i else {})} for n, i, q, p in lines], **extra})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _till(c, item, qty, price):
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code in (200, 409)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "x", "inventory_id": item, "quantity": qty, "unit_price": price}],
        "payment_method": "Cash", "amount_tendered": qty * price,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return r.json()


def _report(c, **params):
    r = c.get("/api/reports/top-items", params={"limit": 1000, **params})
    assert r.status_code == 200, r.text
    return r.json()


def _row(rep, item_id):
    return next(r for r in rep["items"] if r["inventory_id"] == item_id)


def test_invoices_and_the_till_rank_together(c):
    a, b = _item(c, "Alpha", cost=4), _item(c, "Beta", cost=6)
    _invoice(c, [("Alpha", a, 5, 10), ("Fitting", None, 1, 30)])
    _till(c, b, 2, 15)
    rep = _report(c)
    ra, rb = _row(rep, a), _row(rep, b)
    assert ra["quantity_sold"] == 5 and ra["net_sales"] == 50 and ra["documents"] == 1
    assert rb["quantity_sold"] == 2 and rb["net_sales"] == 30
    # Cost: the till's snapshot is real; the plain invoice moved nothing, so
    # the item's current cost stands in and says so.
    assert rb["cost"] == 12 and rb["cost_estimated"] is False
    assert ra["cost"] == 20 and ra["cost_estimated"] is True
    assert ra["profit"] == 30 and ra["margin_pct"] == 60.0
    # A line that names no stock item still ranks, as a service.
    svc = next(r for r in rep["items"] if r["name"] == "Fitting")
    assert svc["kind"] == "service" and svc["net_sales"] == 30
    assert svc["profit"] is None and svc["margin_pct"] is None, "no fake 100% margin"
    # Profit totals are for goods only.
    assert rep["totals"]["goods_sales"] == rep["totals"]["sales"] - 30
    names = [r["inventory_id"] for r in rep["items"]]
    assert names.index(a) < names.index(b), "sorted by quantity by default"


def test_sorting_by_sales_and_by_profit(c):
    a, b = _item(c, "Cheap", cost=1), _item(c, "Dear", cost=90)
    _invoice(c, [("Cheap", a, 10, 5), ("Dear", b, 1, 100)])
    by_rev = [r["inventory_id"] for r in _report(c, sort="revenue")["items"]]
    assert by_rev.index(b) < by_rev.index(a)                 # 100 > 50
    by_profit = [r["inventory_id"] for r in _report(c, sort="profit")["items"]]
    assert by_profit.index(a) < by_profit.index(b)           # 40 > 10


def test_a_whole_invoice_discount_comes_off_the_item(c):
    a = _item(c, "Disc")
    _invoice(c, [("Disc", a, 10, 10)], discount_type="percent", discount_value=10)
    assert _row(_report(c), a)["net_sales"] == 90


def test_returns_come_off_the_item(c):
    a = _item(c, "Ret", cost=4)
    sale = _till(c, a, 4, 10)
    lines = c.get(f"/api/returns/sales/invoice/{sale['invoice_id']}/returnable").json()["lines"]
    r = c.post("/api/returns/sales", json={"invoice_id": sale["invoice_id"], "settlement": "refund",
                                           "lines": [{"invoice_item_id": lines[0]["invoice_item_id"],
                                                      "quantity": 1, "condition": "restock"}]})
    assert r.status_code == 200, r.text
    row = _row(_report(c), a)
    assert row["quantity_returned"] == 1 and row["net_quantity"] == 3
    assert row["net_sales"] == 30
    assert row["cost"] == 12, "the restocked unit's cost is no longer a cost of the sale"


def test_voided_sales_and_other_periods_do_not_count(c):
    a = _item(c, "Void")
    iid = _invoice(c, [("Void", a, 3, 10)])
    assert c.patch(f"/api/invoices/{iid}/void", json={"reason": "x"}).status_code == 200
    rep = _report(c)
    assert all(r["inventory_id"] != a for r in rep["items"])
    b = _item(c, "Old")
    _invoice(c, [("Old", b, 2, 10)])
    assert all(r["inventory_id"] != b for r in _report(c, start="2000-01-01", end="2000-12-31")["items"])


def test_stock_that_did_not_sell_is_listed_most_valuable_first(c):
    idle_big, idle_small = _item(c, "IdleBig", qty=10, cost=50), _item(c, "IdleSmall", qty=10, cost=1)
    sold = _item(c, "Sold")
    _invoice(c, [("Sold", sold, 1, 10)])
    rep = _report(c)
    ids = [r["inventory_id"] for r in rep["unsold"]]
    assert sold not in ids
    assert ids.index(idle_big) < ids.index(idle_small)
    assert next(r for r in rep["unsold"] if r["inventory_id"] == idle_big)["stock_value"] == 500


def test_cost_and_profit_are_hidden_without_the_costs_permission(make_client, db):
    """The Viewer role reads reports but not what stock cost to buy."""
    admin = make_client("superadmin")
    a = _item(admin, "Secret", cost=7)
    _invoice(admin, [("Secret", a, 2, 10)])
    has_reports = db.execute(
        "SELECT rp.can_view FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
        "WHERE r.name = 'Viewer' AND rp.module = 'reports'").fetchone()
    if not (has_reports and has_reports["can_view"]):
        pytest.skip("Viewer cannot open reports in this seed")
    viewer = make_client("Viewer")
    rep = _report(viewer, sort="profit")
    assert rep["show_cost"] is False and rep["sort"] == "revenue"
    row = _row(rep, a)
    for k in ("cost", "profit", "margin_pct", "cost_estimated"):
        assert k not in row
    assert "profit" not in rep["totals"]
    assert all("stock_value" not in r for r in rep["unsold"])


def test_a_line_named_like_a_stock_item_counts_as_that_item(c):
    a = _item(c, "Typed", cost=3)
    name = c.get(f"/api/inventory/{a}").json()["name"]
    _invoice(c, [(f"  {name.upper()} ", None, 4, 10)])      # typed, not picked
    row = _row(_report(c), a)
    assert row["kind"] == "item" and row["quantity_sold"] == 4
    assert row["cost"] == 12 and row["cost_estimated"] is True
