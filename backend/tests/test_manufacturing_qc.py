"""
Manufacturing quality control — quarantine on completion, then release / reject
/ rework with defect logging.

A qc_required BOM sends its finished batch to a non-sellable quarantine bucket
and opens a Pending inspection; resolving it releases the passed units to
sellable stock, scraps the rejects, and can spawn a linked rework order.
"""
import pytest


def _item(c, name, ptype, qty=0, cost=0):
    r = c.post("/api/inventory/", json={"name": name, "product_type": ptype,
                                        "quantity": qty, "unit_cost": cost})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _qc_bom(c, qc_required=True):
    raw = _item(c, "Raw", "raw_material", qty=1000, cost=2)
    fin = _item(c, "Gadget", "finished")
    bom = c.post("/api/manufacturing/boms", json={
        "name": "Gadget BOM", "output_inventory_id": fin, "output_quantity": 1,
        "qc_required": qc_required,
        "components": [{"component_inventory_id": raw, "quantity": 1}],
    })
    assert bom.status_code in (200, 201), bom.text
    return bom.json()["id"], fin


def _complete(c, bom_id, qty):
    order = c.post("/api/manufacturing/orders", json={"bom_id": bom_id, "quantity": qty}).json()
    res = c.post(f"/api/manufacturing/orders/{order['id']}/complete", json={})
    assert res.status_code in (200, 201), res.text
    return order["id"], res.json()


def _inv(db, item_id):
    r = db.execute("SELECT quantity, quarantine_quantity FROM inventory WHERE id=?", (item_id,)).fetchone()
    return float(r["quantity"]), float(r["quarantine_quantity"] or 0)


def test_qc_required_quarantines_output(make_client, db):
    c = make_client("superadmin")
    bom_id, fin = _qc_bom(c)
    _, res = _complete(c, bom_id, 10)
    assert res["qc_required"] is True
    assert res["qc_id"]
    sellable, quarantine = _inv(db, fin)
    assert sellable == pytest.approx(0)        # nothing sellable yet
    assert quarantine == pytest.approx(10)     # whole batch quarantined
    qc = c.get(f"/api/manufacturing/qc/{res['qc_id']}").json()
    assert qc["status"] == "Pending"
    assert qc["quantity"] == pytest.approx(10)
    assert qc["unit_cost"] == pytest.approx(2)


def test_resolve_partial_release_and_reject(make_client, db):
    c = make_client("superadmin")
    bom_id, fin = _qc_bom(c)
    _, res = _complete(c, bom_id, 10)
    out = c.post(f"/api/manufacturing/qc/{res['qc_id']}/resolve", json={
        "passed_qty": 7, "rejected_qty": 3,
        "defects": [{"reason": "Surface scratch", "quantity": 3}],
    })
    assert out.status_code in (200, 201), out.text
    j = out.json()
    assert j["status"] == "Partial"
    assert j["scrap_cost"] == pytest.approx(6)   # 3 × $2
    sellable, quarantine = _inv(db, fin)
    assert sellable == pytest.approx(7)
    assert quarantine == pytest.approx(0)        # batch fully cleared from quarantine
    qc = c.get(f"/api/manufacturing/qc/{res['qc_id']}").json()
    assert qc["status"] == "Partial"
    assert len(qc["defects"]) == 1
    assert qc["defects"][0]["reason"] == "Surface scratch"


def test_resolve_all_passed(make_client, db):
    c = make_client("superadmin")
    bom_id, fin = _qc_bom(c)
    _, res = _complete(c, bom_id, 5)
    out = c.post(f"/api/manufacturing/qc/{res['qc_id']}/resolve", json={"passed_qty": 5}).json()
    assert out["status"] == "Passed"
    sellable, quarantine = _inv(db, fin)
    assert (sellable, quarantine) == (pytest.approx(5), pytest.approx(0))


def test_rework_spawns_linked_order(make_client, db):
    c = make_client("superadmin")
    bom_id, fin = _qc_bom(c)
    src_order_id, res = _complete(c, bom_id, 4)
    out = c.post(f"/api/manufacturing/qc/{res['qc_id']}/resolve", json={
        "passed_qty": 1, "rejected_qty": 3, "rework_qty": 2,
        "defects": [{"reason": "Bad weld", "quantity": 3}],
    }).json()
    assert out["status"] == "Partial"
    assert out["rework_order_id"]
    rw = db.execute("SELECT quantity, status, rework_of_order_id FROM production_orders WHERE id=?",
                    (out["rework_order_id"],)).fetchone()
    assert float(rw["quantity"]) == pytest.approx(2)
    assert rw["status"] == "Draft"
    assert rw["rework_of_order_id"] == src_order_id


def test_resolve_quantities_must_match_batch(make_client):
    c = make_client("superadmin")
    bom_id, _ = _qc_bom(c)
    _, res = _complete(c, bom_id, 10)
    bad = c.post(f"/api/manufacturing/qc/{res['qc_id']}/resolve",
                 json={"passed_qty": 5, "rejected_qty": 3})   # 8 ≠ 10
    assert bad.status_code == 400


def test_cannot_resolve_twice(make_client):
    c = make_client("superadmin")
    bom_id, _ = _qc_bom(c)
    _, res = _complete(c, bom_id, 2)
    assert c.post(f"/api/manufacturing/qc/{res['qc_id']}/resolve",
                  json={"passed_qty": 2}).status_code in (200, 201)
    again = c.post(f"/api/manufacturing/qc/{res['qc_id']}/resolve", json={"passed_qty": 2})
    assert again.status_code == 400


def test_non_qc_bom_skips_quarantine(make_client, db):
    """Backward compatibility: a BOM without qc_required goes straight to stock."""
    c = make_client("superadmin")
    bom_id, fin = _qc_bom(c, qc_required=False)
    _, res = _complete(c, bom_id, 8)
    assert res.get("qc_required") is False
    assert res.get("qc_id") is None
    sellable, quarantine = _inv(db, fin)
    assert (sellable, quarantine) == (pytest.approx(8), pytest.approx(0))
    assert c.get("/api/manufacturing/qc").json() == []
