"""
Batch / lot tracking — per-item opt-in, FEFO consumption with specific-lot
costing, expiry, and forward/backward traceability through production.
"""
import uuid
import pytest


def _item(c, name, ptype="raw_material", qty=0, cost=0, lot_tracked=True, shelf=None):
    r = c.post("/api/inventory/", json={
        "name": name, "product_type": ptype, "quantity": qty, "unit_cost": cost,
        "lot_tracked": lot_tracked, "shelf_life_days": shelf,
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _receive(c, item_id, qty, cost):
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item_id, "product_name": "x",
        "quantity": qty, "unit_cost": cost, "status": "Received",
    })
    assert r.status_code in (200, 201), r.text


def _project(c):
    cl = c.post("/api/clients/", json={"name": "C", "type": "Company"}).json()["id"]
    return c.post("/api/projects/", json={"name": "P", "client_id": cl}).json()["id"]


def _lots(db, item_id):
    return db.execute(
        "SELECT id, lot_number, quantity_remaining, unit_cost, expiry_date, status "
        "FROM inventory_lots WHERE inventory_id=? ORDER BY id", (item_id,)).fetchall()


def test_purchase_creates_lot_with_expiry(make_client, db):
    c = make_client("superadmin")
    item = _item(c, "Milk", shelf=10)
    _receive(c, item, 50, 2)
    rows = _lots(db, item)
    assert len(rows) == 1
    assert rows[0]["quantity_remaining"] == pytest.approx(50)
    assert rows[0]["unit_cost"] == pytest.approx(2)
    assert rows[0]["expiry_date"] is not None      # derived from shelf_life_days
    assert rows[0]["lot_number"]


def test_fefo_consumes_earliest_expiry_first(make_client, db):
    c = make_client("superadmin")
    item = _item(c, "Yogurt", cost=5)
    # Two lots via adjustments with explicit expiry dates (same cost).
    c.patch(f"/api/inventory/{item}/stock", json={"delta": 30, "expiry_date": "2031-01-01"})
    c.patch(f"/api/inventory/{item}/stock", json={"delta": 30, "expiry_date": "2030-06-01"})  # earlier
    rows = _lots(db, item)
    assert len(rows) == 2
    earlier = next(r for r in rows if r["expiry_date"] == "2030-06-01")
    later   = next(r for r in rows if r["expiry_date"] == "2031-01-01")

    # Consume 40 → FEFO takes the 30 earliest-expiry first, then 10 from the later.
    pid = _project(c)
    c.post(f"/api/inventory/{item}/deduct-to-project", json={"project_id": pid, "quantity": 40})
    rows2 = {r["id"]: r for r in _lots(db, item)}
    assert rows2[earlier["id"]]["quantity_remaining"] == pytest.approx(0)
    assert rows2[earlier["id"]]["status"] == "consumed"
    assert rows2[later["id"]]["quantity_remaining"] == pytest.approx(20)


def test_specific_lot_costing(make_client):
    c = make_client("superadmin")
    item = _item(c, "Resin")
    _receive(c, item, 50, 2)     # lot A @ $2
    _receive(c, item, 50, 3)     # lot B @ $3
    pid = _project(c)
    # Consume 60 → 50@2 + 10@3 = $130 (specific-lot, oldest first).
    r = c.post(f"/api/inventory/{item}/deduct-to-project",
               json={"project_id": pid, "quantity": 60})
    assert r.json()["cost"] == pytest.approx(130)


def test_expiry_listing(make_client):
    c = make_client("superadmin")
    item = _item(c, "Reagent", cost=1)
    c.patch(f"/api/inventory/{item}/stock", json={"delta": 5, "expiry_date": "2020-01-01"})  # expired
    c.patch(f"/api/inventory/{item}/stock", json={"delta": 5, "expiry_date": "2099-01-01"})  # ok
    expiring = c.get("/api/inventory/lots?expiring=true").json()
    assert any(l["inventory_id"] == item and l["expiry_status"] == "expired" for l in expiring)
    assert all(l["expiry_status"] in ("expired", "expiring") for l in expiring)


def test_production_traceability(make_client, db):
    c = make_client("superadmin")
    flour = _item(c, "Flour", "raw_material", lot_tracked=True)
    bread = _item(c, "Bread", "finished", lot_tracked=True, shelf=5)
    _receive(c, flour, 100, 1)
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Bread BOM", "output_inventory_id": bread, "output_quantity": 1,
        "components": [{"component_inventory_id": flour, "quantity": 2}],
    }).json()
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom["id"], "quantity": 10}).json()
    res = c.post(f"/api/manufacturing/orders/{order['id']}/complete", json={})
    assert res.status_code in (200, 201), res.text

    bread_lots = _lots(db, bread)
    assert len(bread_lots) == 1
    out_lot_id = bread_lots[0]["id"]

    # Backward: the bread lot was made from the flour lot (20 consumed).
    detail = c.get(f"/api/inventory/lots/{out_lot_id}").json()
    assert len(detail["made_from"]) == 1
    assert detail["made_from"][0]["input_item_name"] == "Flour"
    assert detail["made_from"][0]["quantity"] == pytest.approx(20)

    # Forward: the flour lot shows it was used to produce the bread lot.
    flour_lot_id = _lots(db, flour)[0]["id"]
    fwd = c.get(f"/api/inventory/lots/{flour_lot_id}").json()
    used = [u for u in fwd["used_in"] if u["source_type"] == "production"]
    assert used and used[0]["output_item_name"] == "Bread"
    assert used[0]["order_number"] == order["order_number"]


def test_production_order_detail_exposes_lots(make_client):
    """The production-order detail surfaces produced + consumed lot genealogy."""
    c = make_client("superadmin")
    flour = _item(c, "Flour2", "raw_material", lot_tracked=True)
    bread = _item(c, "Bread2", "finished", lot_tracked=True, shelf=5)
    _receive(c, flour, 100, 1)
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Bread2 BOM", "output_inventory_id": bread, "output_quantity": 1,
        "components": [{"component_inventory_id": flour, "quantity": 2}],
    }).json()
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom["id"], "quantity": 5}).json()
    c.post(f"/api/manufacturing/orders/{order['id']}/complete", json={})

    detail = c.get(f"/api/manufacturing/orders/{order['id']}").json()
    assert len(detail["produced_lots"]) == 1
    assert detail["produced_lots"][0]["original_quantity"] == pytest.approx(5)
    assert any(cl["item_name"] == "Flour2" and cl["quantity"] == pytest.approx(10)
               for cl in detail["consumed_lots"])


def test_non_lot_item_creates_no_lots(make_client, db):
    """Backward compatibility: items without lot_tracked never create lots."""
    c = make_client("superadmin")
    item = _item(c, "Bolt", lot_tracked=False, qty=10, cost=1)
    _receive(c, item, 5, 1)
    assert _lots(db, item) == []
