"""
Manufacturing — bills of materials and production orders.

Covers BOM costing, order creation (scaled component snapshot), the atomic
completion (consume raw materials + produce finished goods + cost), the
atomicity guarantee on a material shortage, and weighted-average costing of
the finished product.
"""
import pytest


def _item(c, name, qty=0, cost=0):
    """Create an inventory item, return its id."""
    r = c.post("/api/inventory/", json={"name": name, "quantity": qty, "unit_cost": cost})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _bom(c, **kw):
    r = c.post("/api/manufacturing/boms", json=kw)
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_bom_computes_unit_cost(make_client):
    """A BOM's unit cost = (components × cost + labour) / batch yield."""
    c = make_client("superadmin")
    a = _item(c, "Part A", cost=3)
    b = _item(c, "Part B", cost=2)
    out = _item(c, "Widget")
    _bom(c, name="Widget BOM", output_inventory_id=out, output_quantity=2, labor_cost=4,
         components=[{"component_inventory_id": a, "quantity": 2},
                     {"component_inventory_id": b, "quantity": 3}])
    w = c.get("/api/manufacturing/boms").json()[0]
    # batch = 2×3 + 3×2 + labour 4 = 16 ; unit = 16 / 2
    assert w["batch_cost"] == pytest.approx(16)
    assert w["unit_cost"]  == pytest.approx(8)


def test_bom_rejects_self_component(make_client):
    """A product cannot be a component of its own BOM."""
    c = make_client("superadmin")
    out = _item(c, "Thing")
    r = c.post("/api/manufacturing/boms", json={
        "name": "Bad", "output_inventory_id": out, "output_quantity": 1,
        "components": [{"component_inventory_id": out, "quantity": 1}],
    })
    assert r.status_code == 400, r.text


def test_order_snapshots_scaled_components(make_client):
    """Creating an order snapshots the BOM components scaled to the order qty."""
    c = make_client("superadmin")
    a = _item(c, "Mat", qty=100, cost=1)
    out = _item(c, "Product")
    bom = _bom(c, name="BOM", output_inventory_id=out, output_quantity=2, labor_cost=0,
               components=[{"component_inventory_id": a, "quantity": 3}])
    # BOM yields 2 per batch from 3 Mat → an order for 10 needs 15 Mat.
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom["id"], "quantity": 10}).json()
    detail = c.get(f"/api/manufacturing/orders/{order['id']}").json()
    assert detail["items"][0]["quantity_required"] == pytest.approx(15)
    assert detail["can_build"] is True


def test_complete_consumes_materials_and_produces(make_client, db):
    """Completion consumes raw materials, produces finished goods, computes cost."""
    c = make_client("superadmin")
    wood  = _item(c, "Wood",  qty=100, cost=5)
    nails = _item(c, "Nails", qty=500, cost=0.1)
    table = _item(c, "Table", qty=0)
    bom = _bom(c, name="Table BOM", output_inventory_id=table, output_quantity=1, labor_cost=10,
               components=[{"component_inventory_id": wood,  "quantity": 4},
                           {"component_inventory_id": nails, "quantity": 20}])
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom["id"], "quantity": 5}).json()
    r = c.post(f"/api/manufacturing/orders/{order['id']}/complete")
    assert r.status_code == 200, r.text
    body = r.json()
    # materials: 20 Wood × $5 + 100 Nails × $0.10 = $110
    assert body["materials_cost"] == pytest.approx(110)
    # labour defaults from the BOM scaled: 10 × (5 / 1) = 50
    assert body["total_cost"]     == pytest.approx(160)
    assert body["unit_cost"]      == pytest.approx(32)        # 160 / 5

    assert db.execute("SELECT quantity FROM inventory WHERE id=?", (wood,)).fetchone()[0]  == pytest.approx(80)
    assert db.execute("SELECT quantity FROM inventory WHERE id=?", (nails,)).fetchone()[0] == pytest.approx(400)
    assert db.execute("SELECT quantity FROM inventory WHERE id=?", (table,)).fetchone()[0] == pytest.approx(5)
    # 2 consumption + 1 output stock movement
    assert db.execute(
        "SELECT COUNT(*) FROM stock_movements WHERE type='production'").fetchone()[0] == 3


def test_complete_insufficient_materials_rolls_back(make_client, db):
    """A material shortage rejects completion and persists NOTHING (atomicity)."""
    c = make_client("superadmin")
    wood  = _item(c, "Wood", qty=10, cost=5)
    table = _item(c, "Table", qty=0)
    bom = _bom(c, name="Table BOM", output_inventory_id=table, output_quantity=1, labor_cost=0,
               components=[{"component_inventory_id": wood, "quantity": 4}])
    # Order needs 5 × 4 = 20 Wood; only 10 in stock.
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom["id"], "quantity": 5}).json()
    r = c.post(f"/api/manufacturing/orders/{order['id']}/complete")
    assert r.status_code == 400, r.text

    assert db.execute("SELECT quantity FROM inventory WHERE id=?", (wood,)).fetchone()[0]  == pytest.approx(10)
    assert db.execute("SELECT quantity FROM inventory WHERE id=?", (table,)).fetchone()[0] == pytest.approx(0)
    assert db.execute(
        "SELECT COUNT(*) FROM stock_movements WHERE type='production'").fetchone()[0] == 0
    assert c.get(f"/api/manufacturing/orders/{order['id']}").json()["status"] == "Draft"


def test_finished_good_weighted_average_cost(make_client, db):
    """The finished product's inventory unit_cost is weighted-averaged on completion."""
    c = make_client("superadmin")
    mat = _item(c, "Mat", qty=1000, cost=10)
    out = _item(c, "Prod", qty=10, cost=20)        # 10 units already on hand @ $20
    bom = _bom(c, name="BOM", output_inventory_id=out, output_quantity=1, labor_cost=0,
               components=[{"component_inventory_id": mat, "quantity": 3}])
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom["id"], "quantity": 10}).json()
    r = c.post(f"/api/manufacturing/orders/{order['id']}/complete")
    assert r.status_code == 200, r.text
    assert r.json()["unit_cost"] == pytest.approx(30)          # 3 Mat × $10
    # weighted average: (10 × 20 + 10 × 30) / 20 = 25
    assert db.execute("SELECT unit_cost FROM inventory WHERE id=?", (out,)).fetchone()[0] == pytest.approx(25)


def test_cancel_blocks_completion(make_client):
    """A cancelled order cannot be completed."""
    c = make_client("superadmin")
    a = _item(c, "Mat", qty=100, cost=1)
    out = _item(c, "Product")
    bom = _bom(c, name="BOM", output_inventory_id=out, output_quantity=1, labor_cost=0,
               components=[{"component_inventory_id": a, "quantity": 1}])
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom["id"], "quantity": 1}).json()
    assert c.post(f"/api/manufacturing/orders/{order['id']}/cancel",
                  json={"reason": "test"}).status_code == 200
    assert c.get(f"/api/manufacturing/orders/{order['id']}").json()["status"] == "Cancelled"
    assert c.post(f"/api/manufacturing/orders/{order['id']}/complete").status_code == 400


def test_double_complete_is_refused(make_client):
    """Completing an already-completed order is rejected."""
    c = make_client("superadmin")
    a = _item(c, "Mat", qty=100, cost=2)
    out = _item(c, "Product")
    bom = _bom(c, name="BOM", output_inventory_id=out, output_quantity=1, labor_cost=0,
               components=[{"component_inventory_id": a, "quantity": 2}])
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom["id"], "quantity": 3}).json()
    assert c.post(f"/api/manufacturing/orders/{order['id']}/complete").status_code == 200
    assert c.post(f"/api/manufacturing/orders/{order['id']}/complete").status_code == 400


def test_viewer_cannot_create_bom(make_client):
    """A read-only role can view manufacturing but cannot create a BOM."""
    c = make_client("Viewer")
    r = c.post("/api/manufacturing/boms", json={
        "name": "X", "output_inventory_id": 1, "output_quantity": 1,
        "components": [{"component_inventory_id": 1, "quantity": 1}],
    })
    assert r.status_code == 403, r.text
