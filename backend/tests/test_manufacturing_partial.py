"""
Manufacturing — production scheduling/priority and partial completion.

Partial completion produces an order across multiple runs: each run consumes its
proportional materials, accumulates actual cost, and leaves the order open until
the cumulative output reaches the planned quantity (or the caller closes it).
"""
import pytest


def _item(c, name, ptype, qty=0, cost=0):
    r = c.post("/api/inventory/", json={"name": name, "product_type": ptype,
                                        "quantity": qty, "unit_cost": cost})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _bom(c, labor=0, overhead=0):
    raw = _item(c, "Raw", "raw_material", qty=1000, cost=2)
    fin = _item(c, "Fin", "finished")
    b = c.post("/api/manufacturing/boms", json={
        "name": "B", "output_inventory_id": fin, "output_quantity": 1,
        "labor_cost": labor, "overhead_cost": overhead,
        "components": [{"component_inventory_id": raw, "quantity": 1}],
    }).json()
    return b["id"], raw, fin


def _qty(db, item_id):
    return float(db.execute("SELECT quantity FROM inventory WHERE id=?", (item_id,)).fetchone()["quantity"])


def test_partial_runs_accumulate_and_autoclose(make_client, db):
    c = make_client("superadmin")
    bom_id, raw, fin = _bom(c)
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom_id, "quantity": 10}).json()
    oid = order["id"]

    r1 = c.post(f"/api/manufacturing/orders/{oid}/complete-partial",
                json={"quantity_produced": 4}).json()
    assert r1["status"] == "In Progress"
    assert r1["quantity_completed"] == pytest.approx(4)
    assert r1["remaining"] == pytest.approx(6)
    assert _qty(db, fin) == pytest.approx(4)     # 4 units in sellable stock
    assert _qty(db, raw) == pytest.approx(996)   # 4 consumed

    r2 = c.post(f"/api/manufacturing/orders/{oid}/complete-partial",
                json={"quantity_produced": 6}).json()
    assert r2["status"] == "Completed"           # auto-closed at planned qty
    assert r2["quantity_completed"] == pytest.approx(10)
    assert r2["remaining"] == pytest.approx(0)
    # Material cost accrued over both runs: 10 units × $2 = $20 → $2/unit.
    assert r2["total_cost"] == pytest.approx(20)
    assert r2["unit_cost"] == pytest.approx(2)
    assert _qty(db, fin) == pytest.approx(10)


def test_partial_conversion_cost_accumulates(make_client):
    c = make_client("superadmin")
    # BOM labour $10/unit → standard $100 over the 10-unit plan.
    bom_id, raw, fin = _bom(c, labor=10)
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom_id, "quantity": 10}).json()
    oid = order["id"]
    a = c.post(f"/api/manufacturing/orders/{oid}/complete-partial", json={"quantity_produced": 4}).json()
    assert a["labor_cost"] == pytest.approx(40)   # 40% share of the $100 standard
    b = c.post(f"/api/manufacturing/orders/{oid}/complete-partial", json={"quantity_produced": 6}).json()
    assert b["labor_cost"] == pytest.approx(100)  # accumulated to the full 100
    assert b["status"] == "Completed"


def test_partial_cannot_overproduce(make_client):
    c = make_client("superadmin")
    bom_id, *_ = _bom(c)
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom_id, "quantity": 5}).json()
    oid = order["id"]
    c.post(f"/api/manufacturing/orders/{oid}/complete-partial", json={"quantity_produced": 3})
    over = c.post(f"/api/manufacturing/orders/{oid}/complete-partial", json={"quantity_produced": 5})
    assert over.status_code == 400          # only 2 remain


def test_partial_then_close_remaining(make_client, db):
    c = make_client("superadmin")
    bom_id, raw, fin = _bom(c)
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom_id, "quantity": 8}).json()
    oid = order["id"]
    c.post(f"/api/manufacturing/orders/{oid}/complete-partial", json={"quantity_produced": 3})
    # A full complete() now finishes the remaining 5 and closes.
    fin_res = c.post(f"/api/manufacturing/orders/{oid}/complete", json={}).json()
    assert fin_res["status"] == "Completed"
    assert fin_res["quantity_completed"] == pytest.approx(8)
    assert _qty(db, fin) == pytest.approx(8)


def test_schedule_sort_orders_by_due_date(make_client):
    c = make_client("superadmin")
    bom_id, *_ = _bom(c)
    c.post("/api/manufacturing/orders",
           json={"bom_id": bom_id, "quantity": 1, "due_date": "2030-12-31", "priority": "Low"})
    early = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom_id, "quantity": 1, "due_date": "2030-01-01", "priority": "Urgent"}).json()
    rows = c.get("/api/manufacturing/orders?sort=schedule").json()
    assert rows[0]["id"] == early["id"]                 # soonest due first
    assert rows[0]["priority"] == "Urgent"


def test_priority_persists(make_client):
    c = make_client("superadmin")
    bom_id, *_ = _bom(c)
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom_id, "quantity": 1, "priority": "High",
                         "due_date": "2030-06-01"}).json()
    d = c.get(f"/api/manufacturing/orders/{order['id']}").json()
    assert d["priority"] == "High"
    assert d["due_date"] == "2030-06-01"
    assert d["remaining"] == pytest.approx(1)
