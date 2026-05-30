"""
Manufacturing analytics — output, cost breakdown, standard-vs-actual variance,
time efficiency, on-time delivery and QC yield over completed orders.
"""
import pytest


def _item(c, name, ptype, qty=0, cost=0):
    return c.post("/api/inventory/", json={"name": name, "product_type": ptype,
                                           "quantity": qty, "unit_cost": cost}).json()["id"]


def test_analytics_output_and_cost(make_client):
    c = make_client("superadmin")
    raw = _item(c, "Steel", "raw_material", qty=1000, cost=3)
    fin = _item(c, "Part", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Part BOM", "output_inventory_id": fin, "output_quantity": 1,
        "components": [{"component_inventory_id": raw, "quantity": 2}],
    }).json()
    # Two completed orders: 5 and 3 units, each $6 material/unit.
    for q in (5, 3):
        o = c.post("/api/manufacturing/orders", json={"bom_id": bom["id"], "quantity": q}).json()
        c.post(f"/api/manufacturing/orders/{o['id']}/complete", json={})

    a = c.get("/api/manufacturing/analytics").json()
    assert a["summary"]["orders"] == 2
    assert a["summary"]["units"] == pytest.approx(8)
    assert a["summary"]["materials"] == pytest.approx(48)   # 8 units × 2 × $3
    assert a["summary"]["total_cost"] == pytest.approx(48)
    assert a["summary"]["avg_unit_cost"] == pytest.approx(6)
    # Standard == actual here (no variance, simple BOM).
    assert a["cost_variance"]["variance"] == pytest.approx(0)


def test_analytics_time_efficiency_and_resources(make_client):
    c = make_client("superadmin")
    labor = c.post("/api/manufacturing/resources",
                   json={"name": "Mill Labor", "hourly_rate": 60}).json()["id"]
    raw = _item(c, "Bar", "raw_material", qty=1000, cost=1)
    fin = _item(c, "Widget", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "W BOM", "output_inventory_id": fin, "output_quantity": 1,
        "standard_hours": 2,
        "components": [{"component_inventory_id": raw, "quantity": 1}],
        "resources": [{"resource_id": labor}],
    }).json()
    o = c.post("/api/manufacturing/orders", json={"bom_id": bom["id"], "quantity": 1}).json()
    # Standard 2h; ran 1.6h (faster → >100% efficiency).
    c.post(f"/api/manufacturing/orders/{o['id']}/complete", json={"production_hours": 1.6})

    a = c.get("/api/manufacturing/analytics").json()
    assert a["time_efficiency"]["planned_hours"] == pytest.approx(2)
    assert a["time_efficiency"]["actual_hours"] == pytest.approx(1.6)
    assert a["time_efficiency"]["efficiency_pct"] == pytest.approx(125)   # 2/1.6
    res = a["time_efficiency"]["by_resource"]
    assert any(r["resource"] == "Mill Labor" and r["cost"] == pytest.approx(96) for r in res)  # 60×1.6


def test_analytics_on_time_and_qc(make_client):
    c = make_client("superadmin")
    raw = _item(c, "Mat", "raw_material", qty=1000, cost=1)
    fin = _item(c, "Prod", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "P BOM", "output_inventory_id": fin, "output_quantity": 1,
        "qc_required": True,
        "components": [{"component_inventory_id": raw, "quantity": 1}],
    }).json()
    o = c.post("/api/manufacturing/orders",
               json={"bom_id": bom["id"], "quantity": 10, "due_date": "2099-12-31"}).json()
    res = c.post(f"/api/manufacturing/orders/{o['id']}/complete", json={}).json()
    # Resolve QC: 8 pass, 2 reject.
    c.post(f"/api/manufacturing/qc/{res['qc_id']}/resolve",
           json={"passed_qty": 8, "rejected_qty": 2})

    a = c.get("/api/manufacturing/analytics").json()
    assert a["on_time"]["on_time"] == 1          # due far in the future
    assert a["qc"]["passed"] == pytest.approx(8)
    assert a["qc"]["rejected"] == pytest.approx(2)
    assert a["qc"]["pass_rate"] == pytest.approx(80)
