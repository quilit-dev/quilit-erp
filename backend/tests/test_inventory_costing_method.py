"""
Inventory costing method — FIFO / LIFO / weighted-average integration.

Verifies that the `inventory_costing_method` setting drives how a stock-OUT is
valued, that cost layers are maintained across purchases, and that switching to
a lot-based method rebases layers from current on-hand stock.

Setup for the FIFO/LIFO cases is always: receive 10 @ $10 then 10 @ $20, giving
a moving average of $15. Consuming 15 units then exposes the difference:
  • FIFO consumes 10@10 + 5@20  -> leaves 5 @ $20
  • LIFO consumes 10@20 + 5@10  -> leaves 5 @ $10
  • weighted_avg values at the $15 average and never touches layers.
"""
import pytest


def _set_method(c, method):
    r = c.put("/api/settings/", json={"inventory_costing_method": method})
    assert r.status_code == 200, r.text
    assert r.json()["inventory_costing_method"] == method


def _make_item(c, name, qty=0, cost=0):
    r = c.post("/api/inventory/", json={"name": name, "quantity": qty, "unit_cost": cost})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _receive(c, inventory_id, qty, cost):
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": inventory_id, "product_name": "Restock",
        "quantity": qty, "unit_cost": cost, "status": "Received",
    })
    assert r.status_code in (200, 201), r.text


def _adjust(c, item_id, delta):
    r = c.patch(f"/api/inventory/{item_id}/stock",
                json={"delta": delta, "type": "adjustment"})
    assert r.status_code == 200, r.text


def _inv(db, item_id):
    row = db.execute("SELECT quantity, unit_cost FROM inventory WHERE id=?", (item_id,)).fetchone()
    return float(row["quantity"]), float(row["unit_cost"])


def _layers(db, item_id):
    rows = db.execute(
        "SELECT qty_remaining, unit_cost FROM inventory_cost_layers "
        "WHERE inventory_id=? AND qty_remaining > 1e-9 ORDER BY created_at, id",
        (item_id,),
    ).fetchall()
    return [(float(r["qty_remaining"]), float(r["unit_cost"])) for r in rows]


def test_fifo_consumes_oldest_layers_first(make_client, db):
    c = make_client("superadmin")
    _set_method(c, "fifo")
    item = _make_item(c, "Bolt-FIFO")
    _receive(c, item, 10, 10)
    _receive(c, item, 10, 20)

    _adjust(c, item, -15)

    qty, cost = _inv(db, item)
    assert qty == pytest.approx(5)
    # FIFO leaves the newest 5 units @ $20.
    assert cost == pytest.approx(20.0, abs=1e-6)
    assert _layers(db, item) == [pytest.approx((5.0, 20.0))]


def test_lifo_consumes_newest_layers_first(make_client, db):
    c = make_client("superadmin")
    _set_method(c, "lifo")
    item = _make_item(c, "Bolt-LIFO")
    _receive(c, item, 10, 10)
    _receive(c, item, 10, 20)

    _adjust(c, item, -15)

    qty, cost = _inv(db, item)
    assert qty == pytest.approx(5)
    # LIFO leaves the oldest 5 units @ $10.
    assert cost == pytest.approx(10.0, abs=1e-6)


def test_weighted_average_unchanged_and_no_layers(make_client, db):
    c = make_client("superadmin")
    _set_method(c, "weighted_avg")
    item = _make_item(c, "Bolt-WA")
    _receive(c, item, 10, 10)
    _receive(c, item, 10, 20)

    qty, cost = _inv(db, item)
    assert (qty, cost) == (pytest.approx(20), pytest.approx(15.0, abs=1e-6))

    _adjust(c, item, -15)
    qty, cost = _inv(db, item)
    # Average cost is unaffected by consumption; layers are never created.
    assert qty == pytest.approx(5)
    assert cost == pytest.approx(15.0, abs=1e-6)
    assert _layers(db, item) == []


def test_project_deduction_uses_fifo_cogs(make_client, db):
    """The material cost charged to a project follows FIFO when configured."""
    c = make_client("superadmin")
    _set_method(c, "fifo")
    item = _make_item(c, "Plank-FIFO")
    _receive(c, item, 10, 10)
    _receive(c, item, 10, 20)

    cl = c.post("/api/clients/", json={"name": "Proj Client", "type": "Company"})
    assert cl.status_code in (200, 201), cl.text
    pr = c.post("/api/projects/", json={"name": "Build", "client_id": cl.json()["id"]})
    assert pr.status_code in (200, 201), pr.text
    project_id = pr.json()["id"]

    r = c.post(f"/api/inventory/{item}/deduct-to-project",
               json={"project_id": project_id, "quantity": 15})
    assert r.status_code in (200, 201), r.text
    # FIFO: 10 @ $10 + 5 @ $20 = $200 (weighted average would be 15 × $15 = $225).
    assert r.json()["cost"] == pytest.approx(200.0, abs=1e-6)


def test_switching_to_fifo_rebases_layers_from_current_stock(make_client, db):
    """Stock accumulated under weighted_avg gets an opening layer when the
    method is switched to fifo, so lot-based costing works immediately."""
    c = make_client("superadmin")
    _set_method(c, "weighted_avg")
    item = _make_item(c, "Widget", qty=100, cost=10)
    # No layers under weighted_avg.
    assert _layers(db, item) == []

    _set_method(c, "fifo")
    # One opening layer seeded from current quantity + unit_cost.
    assert _layers(db, item) == [pytest.approx((100.0, 10.0))]

    _adjust(c, item, -40)
    qty, cost = _inv(db, item)
    assert qty == pytest.approx(60)
    assert cost == pytest.approx(10.0, abs=1e-6)


def test_invalid_method_rejected(make_client):
    c = make_client("superadmin")
    r = c.put("/api/settings/", json={"inventory_costing_method": "nonsense"})
    assert r.status_code == 400, r.text
