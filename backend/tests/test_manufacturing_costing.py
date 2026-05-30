"""
Manufacturing — resource-based overhead costing (SME model).

A reusable resource carries a per-hour rate. A BOM assigns resources (from the
master list or inline) + a standard production time; production cost adds
Σ(resource rates) × actual production hours to the material cost.
"""
import pytest


def _resource(c, name, rate):
    r = c.post("/api/manufacturing/resources", json={"name": name, "hourly_rate": rate})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _item(c, name, ptype, qty=0, cost=0):
    r = c.post("/api/inventory/", json={"name": name, "product_type": ptype,
                                        "quantity": qty, "unit_cost": cost})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_resource_crud(make_client):
    c = make_client("superadmin")
    rid = _resource(c, "Labor", 60)
    rows = c.get("/api/manufacturing/resources").json()
    assert any(r["id"] == rid and r["name"] == "Labor" and r["hourly_rate"] == 60 for r in rows)
    assert c.put(f"/api/manufacturing/resources/{rid}",
                 json={"name": "Labor", "hourly_rate": 65}).status_code == 200
    assert c.patch(f"/api/manufacturing/resources/{rid}/archive").status_code == 200
    assert all(r["id"] != rid for r in c.get("/api/manufacturing/resources").json())


def test_resource_negative_rate_rejected(make_client):
    c = make_client("superadmin")
    assert c.post("/api/manufacturing/resources",
                  json={"name": "Bad", "hourly_rate": -5}).status_code == 400


def test_bom_standard_conversion_from_resources(make_client):
    c = make_client("superadmin")
    labor = _resource(c, "Labor", 60)
    cnc   = _resource(c, "CNC", 30)
    elec  = _resource(c, "Electricity", 5)
    raw = _item(c, "Steel", "raw_material", qty=100, cost=5)
    fin = _item(c, "Widget", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Widget BOM", "output_inventory_id": fin, "output_quantity": 1,
        "standard_hours": 1,
        "components": [{"component_inventory_id": raw, "quantity": 2}],
        "resources": [{"resource_id": labor}, {"resource_id": cnc}, {"resource_id": elec}],
    })
    assert bom.status_code in (200, 201), bom.text
    d = c.get(f"/api/manufacturing/boms/{bom.json()['id']}").json()
    # Σ rates = 95; standard_hours = 1 → conversion 95; material 2×5=10 → unit 105
    assert d["has_resources"] is True
    assert d["rate_sum"] == pytest.approx(95)
    assert d["conversion_cost"] == pytest.approx(95)
    assert d["unit_cost"] == pytest.approx(105)
    # Master-list assignment snapshots name + rate onto the BOM.
    names = sorted(r["name"] for r in d["resources"])
    assert names == ["CNC", "Electricity", "Labor"]


def test_actual_hours_costing_at_completion(make_client, db):
    c = make_client("superadmin")
    labor = _resource(c, "Labor", 60)
    cnc   = _resource(c, "CNC", 30)
    elec  = _resource(c, "Electricity", 5)
    raw = _item(c, "Steel", "raw_material", qty=100, cost=5)
    fin = _item(c, "Widget", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Widget BOM", "output_inventory_id": fin, "output_quantity": 1,
        "standard_hours": 1,
        "components": [{"component_inventory_id": raw, "quantity": 2}],
        "resources": [{"resource_id": labor}, {"resource_id": cnc}, {"resource_id": elec}],
    }).json()
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom["id"], "quantity": 1}).json()
    detail = c.get(f"/api/manufacturing/orders/{order['id']}").json()
    assert len(detail["resources"]) == 3   # snapshotted onto the order

    # Ran 2 actual hours instead of the standard 1.
    res = c.post(f"/api/manufacturing/orders/{order['id']}/complete",
                 json={"production_hours": 2})
    assert res.status_code in (200, 201), res.text
    j = res.json()
    # overhead = Σ rates (95) × 2h = 190; material 10 → total 200
    assert j["overhead_cost"] == pytest.approx(190)
    assert j["total_cost"] == pytest.approx(200)
    assert j["unit_cost"] == pytest.approx(200)
    # Per-resource cost frozen on the order.
    rows = {r["name"]: r for r in db.execute(
        "SELECT name, hours, cost FROM production_order_resources WHERE production_order_id=?",
        (order["id"],)).fetchall()}
    assert rows["Labor"]["cost"] == pytest.approx(120)
    assert rows["CNC"]["cost"] == pytest.approx(60)
    assert rows["Electricity"]["cost"] == pytest.approx(10)
    assert rows["Labor"]["hours"] == pytest.approx(2)


def test_inline_resource_without_master(make_client):
    """The simplified option: resources defined inline on the BOM (name + rate)."""
    c = make_client("superadmin")
    raw = _item(c, "Wood", "raw_material", qty=100, cost=5)
    fin = _item(c, "Board", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Board BOM", "output_inventory_id": fin, "output_quantity": 1,
        "standard_hours": 2,
        "components": [{"component_inventory_id": raw, "quantity": 1}],
        "resources": [{"name": "Glue", "hourly_rate": 8}, {"name": "Sander", "hourly_rate": 12}],
    }).json()
    d = c.get(f"/api/manufacturing/boms/{bom['id']}").json()
    assert d["rate_sum"] == pytest.approx(20)
    assert d["conversion_cost"] == pytest.approx(40)   # 20 × 2h
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom["id"], "quantity": 1}).json()
    j = c.post(f"/api/manufacturing/orders/{order['id']}/complete",
               json={"production_hours": 3}).json()
    assert j["overhead_cost"] == pytest.approx(60)     # 20 × 3h
    assert j["total_cost"] == pytest.approx(65)        # + 5 material


def test_no_resources_falls_back_to_flat(make_client):
    c = make_client("superadmin")
    raw = _item(c, "Cloth", "raw_material", qty=100, cost=5)
    fin = _item(c, "Shirt", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Shirt BOM", "output_inventory_id": fin, "output_quantity": 1,
        "labor_cost": 40, "overhead_cost": 10,
        "components": [{"component_inventory_id": raw, "quantity": 1}],
    }).json()
    d = c.get(f"/api/manufacturing/boms/{bom['id']}").json()
    assert d["has_resources"] is False
    assert d["conversion_cost"] == pytest.approx(50)
    assert d["unit_cost"] == pytest.approx(55)
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom["id"], "quantity": 1}).json()
    j = c.post(f"/api/manufacturing/orders/{order['id']}/complete", json={}).json()
    assert j["overhead_cost"] == pytest.approx(10)
    assert j["labor_cost"] == pytest.approx(40)
    assert j["total_cost"] == pytest.approx(55)


def test_bom_rejects_unknown_resource(make_client):
    c = make_client("superadmin")
    raw = _item(c, "Steel", "raw_material", qty=10, cost=5)
    fin = _item(c, "Widget", "finished")
    r = c.post("/api/manufacturing/boms", json={
        "name": "X", "output_inventory_id": fin, "output_quantity": 1,
        "components": [{"component_inventory_id": raw, "quantity": 1}],
        "resources": [{"resource_id": 99999}],
    })
    assert r.status_code == 400
    assert "Resource" in r.text
