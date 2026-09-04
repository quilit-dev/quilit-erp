"""A purchase is a document with lines.

A supplier invoice covering six products had to be keyed as six separate
purchase orders, so the document in the system stopped matching the one on the
desk — and a single shipping charge could only be attached to whichever of them
the operator picked.

Three properties carry the change, and each is silent when it breaks:

  * **The header's money equals the lines'.** The supplier and insights figures
    read `subtotal` off the header rather than joining the lines, because
    joining would turn COUNT(purchases.id) into a count of LINES. That is only
    safe while exactly one function writes it.
  * **Shipping is apportioned to the cent.** A stray cent between the shares and
    the charge is the difference between the stock value and the ledger's
    inventory debit.
  * **Each line lands and reverses on its own.** Two lines of the same product
    on one order is an ordinary delivery, and it is the case that breaks a
    receipt loop which reads the stock level once.
"""
import uuid

import pytest


# ── helpers ─────────────────────────────────────────────────────────────────
def _method(c, method):
    assert c.put("/api/settings/",
                 json={"inventory_costing_method": method}).status_code == 200


def _item(c, name, qty=0, cost=0):
    r = c.post("/api/inventory/", json={
        "name": f"{name} {uuid.uuid4().hex[:6]}", "product_type": "finished",
        "quantity": qty, "unit_cost": cost, "sale_price": 100})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _po(c, lines, status="Paid", shipping=0, **extra):
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "items": lines, "additional_costs": shipping,
        "status": status, **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _line(item, qty, cost, **extra):
    return {"inventory_id": item, "product_name": "Thing",
            "quantity": qty, "unit_cost": cost, **extra}


def _stock(db, item):
    r = db.execute("SELECT quantity, unit_cost FROM inventory WHERE id=?",
                   (item,)).fetchone()
    return round(float(r["quantity"]), 4), round(float(r["unit_cost"]), 4)


def _lines(db, pid):
    return db.execute("SELECT * FROM purchase_items WHERE purchase_id=? ORDER BY id",
                      (pid,)).fetchall()


def _head(db, pid):
    return db.execute("SELECT * FROM purchases WHERE id=?", (pid,)).fetchone()


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 4)
    return 0.0


# ── several products on one order ───────────────────────────────────────────
def test_one_order_can_carry_several_products(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PL A"), _item(c, "PL B")

    pid = _po(c, [_line(a, 10, 10), _line(b, 4, 25)])

    assert _stock(db, a) == (10.0, 10.0)
    assert _stock(db, b) == (4.0, 25.0)
    head = _head(db, pid)
    assert head["subtotal"] == pytest.approx(200.0)      # 100 + 100
    assert len(_lines(db, pid)) == 2


def test_the_same_product_twice_on_one_order(make_client, db):
    """The case that breaks a receipt loop reading the stock level once.

    Hoisting the inventory read out of the loop would blend the second line
    against the level from BEFORE the first one landed, so the average comes
    out wrong while the quantity looks right.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PL Same")

    pid = _po(c, [_line(item, 10, 10), _line(item, 10, 20)])

    # 20 units worth 100 + 200 = 300, so the average is 15 — not 20, which is
    # what a hoisted read produces by blending both lines against zero stock.
    assert _stock(db, item) == (20.0, 15.0)
    layers = db.execute(
        "SELECT qty_remaining, unit_cost FROM inventory_cost_layers "
        "WHERE inventory_id=? AND qty_remaining > 1e-9 ORDER BY id", (item,)).fetchall()
    assert [(float(r["qty_remaining"]), float(r["unit_cost"])) for r in layers] == \
           [(10.0, 10.0), (10.0, 20.0)], "each line needs its own layer"


def test_each_line_gets_its_own_cost_layer_key(make_client, db):
    """Keyed by line, not by PO — or reversing one line draws the other's."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PL Key")
    pid = _po(c, [_line(item, 5, 10), _line(item, 5, 20)])

    po = _head(db, pid)["po_number"]
    refs = [r["source_ref"] for r in db.execute(
        "SELECT source_ref FROM inventory_cost_layers WHERE inventory_id=? ORDER BY id",
        (item,)).fetchall()]
    ids = [str(l["id"]) for l in _lines(db, pid)]
    assert refs == [f"{po}#{ids[0]}", f"{po}#{ids[1]}"]


# ── shipping reaches the goods ──────────────────────────────────────────────
def test_shipping_is_shared_out_by_value(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PL Ship A"), _item(c, "PL Ship B")

    # 100 and 300 of goods, so a 40 charge splits 10 / 30.
    pid = _po(c, [_line(a, 10, 10), _line(b, 10, 30)], shipping=40)

    shares = [round(float(l["additional_cost_share"]), 4) for l in _lines(db, pid)]
    assert shares == [10.0, 30.0]
    assert _stock(db, a) == (10.0, 11.0)       # (100 + 10) / 10
    assert _stock(db, b) == (10.0, 33.0)       # (300 + 30) / 10


def test_the_shares_add_up_to_the_charge_exactly(make_client, db):
    """A stray cent is the gap between stock value and the ledger."""
    c = make_client("superadmin")
    _method(c, "fifo")
    items = [_item(c, f"PL Cent {i}") for i in range(3)]
    # 10 split three ways does not divide.
    pid = _po(c, [_line(i, 1, 10) for i in items], shipping=10)

    shares = [float(l["additional_cost_share"]) for l in _lines(db, pid)]
    assert sum(shares) == pytest.approx(10.0, abs=1e-9)
    assert len(set(shares)) > 1, "the residue has to land somewhere explicit"


def test_shipping_on_a_free_delivery_still_lands(make_client, db):
    """Free samples still cost freight, and zero weights cannot divide."""
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PL Free A"), _item(c, "PL Free B")
    pid = _po(c, [_line(a, 2, 0), _line(b, 2, 0)], shipping=9)

    shares = [float(l["additional_cost_share"]) for l in _lines(db, pid)]
    assert sum(shares) == pytest.approx(9.0, abs=1e-9)


# ── discounts and tax, per line ─────────────────────────────────────────────
def test_a_line_discount_lowers_its_value_and_its_tax(make_client, db):
    c = make_client("superadmin")
    _method(c, "weighted_avg")
    item = _item(c, "PL Disc")
    pid = _po(c, [_line(item, 10, 10, discount=20, discount_pct=20)])

    line = _lines(db, pid)[0]
    assert float(line["line_total"]) == pytest.approx(80.0)
    assert float(line["discount"]) == pytest.approx(20.0)
    assert float(line["discount_pct"]) == pytest.approx(20.0)
    assert _head(db, pid)["subtotal"] == pytest.approx(80.0)
    # And the goods land at what was actually paid for them.
    assert _stock(db, item) == (10.0, 8.0)


def test_a_discount_cannot_make_a_line_negative(make_client, db):
    c = make_client("superadmin")
    _method(c, "weighted_avg")
    item = _item(c, "PL Over")
    pid = _po(c, [_line(item, 1, 10, discount=999)])
    assert float(_lines(db, pid)[0]["line_total"]) == pytest.approx(0.0)


def test_a_negative_discount_is_refused(make_client):
    c = make_client("superadmin")
    item = _item(c, "PL Neg")
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "items": [_line(item, 1, 10, discount=-5)],
        "status": "Ordered"})
    assert r.status_code == 400


def test_an_empty_order_is_refused(make_client):
    c = make_client("superadmin")
    r = c.post("/api/purchases/", json={"supplier": "Acme", "items": [],
                                        "status": "Ordered"})
    assert r.status_code == 400


# ── the header's money ──────────────────────────────────────────────────────
def test_the_header_totals_equal_the_lines(make_client, db):
    c = make_client("superadmin")
    _method(c, "weighted_avg")
    a, b = _item(c, "PL T A"), _item(c, "PL T B")
    pid = _po(c, [_line(a, 3, 7), _line(b, 2, 11)], shipping=5)

    head, lines = _head(db, pid), _lines(db, pid)
    assert head["subtotal"] == pytest.approx(sum(float(l["line_total"]) for l in lines))
    assert head["tax_total"] == pytest.approx(sum(float(l["tax_amount"]) for l in lines))
    # `total_cost` keeps the meaning every caller already relies on.
    body = c.get(f"/api/purchases/{pid}").json()
    assert body["total_cost"] == pytest.approx(head["subtotal"] + 5)


def test_no_purchase_anywhere_disagrees_with_its_lines(make_client, db):
    """The invariant that makes reading the header safe, over the whole table."""
    c = make_client("superadmin")
    _method(c, "fifo")
    a = _item(c, "PL Inv")
    _po(c, [_line(a, 2, 5)], shipping=3)
    _po(c, [_line(a, 1, 9), _line(a, 4, 2)], status="Ordered")

    bad = db.execute(
        "SELECT p.id, p.subtotal, p.tax_total, "
        "  COALESCE((SELECT SUM(line_total) FROM purchase_items WHERE purchase_id=p.id),0) s, "
        "  COALESCE((SELECT SUM(tax_amount) FROM purchase_items WHERE purchase_id=p.id),0) t "
        "FROM purchases p WHERE p.deleted_at IS NULL "
        "AND (ABS(p.subtotal - COALESCE((SELECT SUM(line_total) FROM purchase_items "
        "     WHERE purchase_id=p.id),0)) > 0.005 "
        " OR ABS(p.tax_total - COALESCE((SELECT SUM(tax_amount) FROM purchase_items "
        "     WHERE purchase_id=p.id),0)) > 0.005)").fetchall()
    assert not [dict(r) for r in bad], "a header's money disagrees with its lines"


# ── editing while still on order ────────────────────────────────────────────
def test_editing_replaces_the_whole_line_set(make_client, db):
    c = make_client("superadmin")
    a, b = _item(c, "PL E A"), _item(c, "PL E B")
    pid = _po(c, [_line(a, 1, 10), _line(b, 1, 20)], status="Ordered")

    r = c.put(f"/api/purchases/{pid}", json={
        "items": [_line(a, 5, 4, discount=2)]})
    assert r.status_code == 200, r.text

    lines = _lines(db, pid)
    assert len(lines) == 1, "a removed line has to actually go"
    assert float(lines[0]["line_total"]) == pytest.approx(18.0)
    assert _head(db, pid)["subtotal"] == pytest.approx(18.0)


def test_an_edit_that_says_nothing_about_lines_leaves_them(make_client, db):
    c = make_client("superadmin")
    a = _item(c, "PL E Keep")
    pid = _po(c, [_line(a, 2, 6)], status="Ordered")

    assert c.put(f"/api/purchases/{pid}", json={"notes": "call the driver"}).status_code == 200
    lines = _lines(db, pid)
    assert len(lines) == 1 and float(lines[0]["line_total"]) == pytest.approx(12.0)


def test_a_discount_survives_being_re_saved(make_client, db):
    """The invoice version of this once dropped `discount` on re-insert and
    silently reset every line's discount."""
    c = make_client("superadmin")
    a = _item(c, "PL E Disc")
    pid = _po(c, [_line(a, 10, 10, discount=15, discount_pct=15)], status="Ordered")
    assert c.put(f"/api/purchases/{pid}",
                 json={"items": [_line(a, 10, 10, discount=15, discount_pct=15)]}).status_code == 200
    line = _lines(db, pid)[0]
    assert float(line["discount"]) == pytest.approx(15.0)
    assert float(line["discount_pct"]) == pytest.approx(15.0)


# ── the flat single-item body every existing caller sends ───────────────────
def test_the_old_flat_shape_still_works(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PL Flat")
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item, "product_name": "Thing",
        "quantity": 6, "unit_cost": 5, "additional_costs": 6, "status": "Paid"})
    assert r.status_code in (200, 201), r.text
    pid = r.json()["id"]

    lines = _lines(db, pid)
    assert len(lines) == 1
    assert float(lines[0]["quantity"]) == pytest.approx(6)
    assert _stock(db, item) == (6.0, 6.0)      # (30 + 6) / 6


def test_a_body_with_neither_items_nor_fields_is_refused(make_client):
    c = make_client("superadmin")
    assert c.post("/api/purchases/",
                  json={"supplier": "Acme", "status": "Ordered"}).status_code == 400


# ── voiding a multi-line order ──────────────────────────────────────────────
def test_voiding_gives_back_every_line(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PL V A"), _item(c, "PL V B")
    gl0 = _gl(c, "1200")
    pid = _po(c, [_line(a, 10, 10), _line(b, 5, 20)], shipping=15)

    r = c.patch(f"/api/purchases/{pid}/void", json={"reason": "wrong supplier"})
    assert r.status_code == 200, r.text
    assert r.json()["restocked"] == pytest.approx(15)
    assert len(r.json()["lines"]) == 2

    assert _stock(db, a)[0] == pytest.approx(0)
    assert _stock(db, b)[0] == pytest.approx(0)
    assert _gl(c, "1200") == pytest.approx(gl0, abs=0.01)


def test_a_void_is_refused_when_one_line_has_moved(make_client, db):
    """All or nothing: the order is checked before a single write."""
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PL VR A"), _item(c, "PL VR B")
    pid = _po(c, [_line(a, 10, 10), _line(b, 5, 20)])

    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)
    assert c.post("/api/pos/checkout", json={
        "items": [{"name": "x", "inventory_id": b, "quantity": 2, "unit_price": 90}],
        "payment_method": "Cash", "amount_tendered": 180,
        "idempotency_key": str(uuid.uuid4())}).status_code == 200

    r = c.patch(f"/api/purchases/{pid}/void", json={"reason": "x"})
    assert r.status_code == 409
    assert _stock(db, a)[0] == pytest.approx(10), "the untouched line moved anyway"
    assert _stock(db, b)[0] == pytest.approx(3)


def test_two_lines_of_one_item_cannot_be_over_reversed(make_client, db):
    """Ten and ten of the same product with twelve on hand: a line-by-line
    check passes twice and takes the item to minus eight."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PL VD")
    pid = _po(c, [_line(item, 10, 10), _line(item, 10, 10)])

    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)
    assert c.post("/api/pos/checkout", json={
        "items": [{"name": "x", "inventory_id": item, "quantity": 8, "unit_price": 90}],
        "payment_method": "Cash", "amount_tendered": 720,
        "idempotency_key": str(uuid.uuid4())}).status_code == 200

    r = c.patch(f"/api/purchases/{pid}/void", json={"reason": "x"})
    assert r.status_code == 409
    assert _stock(db, item)[0] == pytest.approx(12), "stock went negative"


# ── the apportionment on its own ────────────────────────────────────────────
def test_apportion_is_exact_and_weighted():
    from routers.purchases import _apportion

    assert _apportion(40, [100, 300]) == [10.0, 30.0]
    assert sum(_apportion(10, [1, 1, 1])) == pytest.approx(10.0, abs=1e-9)
    assert sum(_apportion(0.03, [1, 1])) == pytest.approx(0.03, abs=1e-9)
    assert _apportion(5, []) == []
    # Every weight zero: split evenly rather than divide by nothing.
    assert sum(_apportion(9, [0, 0, 0])) == pytest.approx(9.0, abs=1e-9)
    # The residue goes to the largest line, so it is least visible per unit.
    assert _apportion(10, [1, 1, 1])[0] == pytest.approx(3.34)
