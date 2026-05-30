"""
Purchase stock-intake costing — weighted-average regression.

Receiving a purchase must blend the lot into inventory.unit_cost as a moving
weighted average, NOT overwrite the average with the latest lot's price.
Downstream COGS (POS, project consumption, manufacturing material cost) all
read inventory.unit_cost, so an overwrite would mis-state inventory value and
every margin computed from it.

Regression for P-01: 100 @ $10 + 10 @ $20  ->  110 @ $10.909091  (never $20).
"""
import pytest


def _make_item(c, name, qty, cost):
    r = c.post("/api/inventory/", json={"name": name, "quantity": qty, "unit_cost": cost})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _receive(c, inventory_id, qty, cost, additional=0):
    r = c.post("/api/purchases/", json={
        "supplier": "Acme",
        "inventory_id": inventory_id,
        "product_name": "Restock",
        "quantity": qty,
        "unit_cost": cost,
        "additional_costs": additional,
        "status": "Received",          # triggers _credit_stock
    })
    assert r.status_code in (200, 201), r.text
    return r.json()


def _inv(db, item_id):
    row = db.execute(
        "SELECT quantity, unit_cost FROM inventory WHERE id=?", (item_id,)
    ).fetchone()
    return float(row["quantity"]), float(row["unit_cost"])


def test_restock_blends_unit_cost_weighted_average(make_client, db):
    c = make_client("superadmin")
    item = _make_item(c, "Bolt", qty=100, cost=10)        # 100 @ $10 = $1,000

    _receive(c, item, qty=10, cost=20)                    # + 10 @ $20 = $200

    qty, cost = _inv(db, item)
    assert qty == pytest.approx(110)
    # (100*10 + 10*20) / 110 = 10.909090...
    assert cost == pytest.approx(10.909091, abs=1e-6)
    assert cost != pytest.approx(20)                      # must NOT overwrite


def test_additional_costs_fold_into_landed_cost(make_client, db):
    c = make_client("superadmin")
    item = _make_item(c, "Plank", qty=0, cost=0)          # empty start

    _receive(c, item, qty=10, cost=20, additional=50)     # landed = (200+50)/10 = 25

    qty, cost = _inv(db, item)
    assert qty == pytest.approx(10)
    assert cost == pytest.approx(25.0, abs=1e-6)


def test_sequential_receipts_keep_moving_average(make_client, db):
    c = make_client("superadmin")
    item = _make_item(c, "Screw", qty=0, cost=0)

    _receive(c, item, qty=10, cost=10)                    # 10 @ $10
    _receive(c, item, qty=10, cost=20)                    # blend -> (100+200)/20 = 15

    qty, cost = _inv(db, item)
    assert qty == pytest.approx(20)
    assert cost == pytest.approx(15.0, abs=1e-6)
