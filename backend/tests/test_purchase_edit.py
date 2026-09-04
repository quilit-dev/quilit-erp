"""Correcting a purchase whose goods have already landed.

A unit cost keyed wrong was uncorrectable: editing was refused once a purchase
was received — rightly, because by then the stock and the ledger had both
moved — so the only remedy was a hand-typed stock adjustment plus a manual
journal, from memory, with nothing tying the two together.

Two things hide under "edit", and they behave differently:

  * the MONEY was wrong. The same goods sit on the same shelf; only what they
    are worth changes. Allowed even when some have already been SOLD, which is
    the case that matters and the one a reverse-and-redo cannot serve;
  * the GOODS were wrong — a different item or quantity. That moves stock, so
    it is refused when the goods are no longer there.

The arithmetic that has to hold, per line:

    d_unit    = new landed cost - old landed cost
    inventory =  remaining x d_unit
    COGS      =  consumed  x d_unit   (posted TODAY)

and the two must always sum to the change in what the purchase cost. Get the
split wrong and the books still balance — the money is simply in the wrong
place, which is why every test here checks both sides.
"""
import uuid

import pytest


# ── helpers ─────────────────────────────────────────────────────────────────
def _method(c, method):
    assert c.put("/api/settings/",
                 json={"inventory_costing_method": method}).status_code == 200


def _item(c, name):
    return c.post("/api/inventory/", json={
        "name": f"{name} {uuid.uuid4().hex[:6]}", "product_type": "finished",
        "quantity": 0, "unit_cost": 0, "sale_price": 100}).json()["id"]


def _line(item, qty, cost, **extra):
    return {"inventory_id": item, "product_name": "Thing",
            "quantity": qty, "unit_cost": cost, **extra}


def _po(c, lines, status="Paid", shipping=0):
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "items": lines, "additional_costs": shipping,
        "status": status})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _edit(c, pid, lines, shipping=0):
    return c.put(f"/api/purchases/{pid}",
                 json={"items": lines, "additional_costs": shipping})


def _stock(db, item):
    r = db.execute("SELECT quantity, unit_cost FROM inventory WHERE id=?",
                   (item,)).fetchone()
    return round(float(r["quantity"]), 4), round(float(r["unit_cost"]), 4)


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 4)
    return 0.0


def _sell(c, item, qty, price=90):
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "x", "inventory_id": item, "quantity": qty,
                   "unit_price": price}],
        "payment_method": "Cash", "amount_tendered": qty * price,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text


INV, COGS, CASH = "1200", "5000", "1000"


# ── nothing sold: the whole difference stays on the shelf ───────────────────
@pytest.mark.parametrize("method", ["fifo", "lifo", "weighted_avg"])
def test_a_cost_correction_re_values_stock_still_held(make_client, db, method):
    c = make_client("superadmin")
    _method(c, method)
    item = _item(c, "PE Held")
    inv0, cogs0, cash0 = _gl(c, INV), _gl(c, COGS), _gl(c, CASH)
    pid = _po(c, [_line(item, 10, 10)])
    assert _stock(db, item) == (10.0, 10.0)

    r = _edit(c, pid, [_line(item, 10, 12)])
    assert r.status_code == 200, r.text

    # 10 units now worth 12 each, and the money followed.
    assert _stock(db, item) == (10.0, 12.0)
    assert _gl(c, INV) - inv0 == pytest.approx(120.0, abs=0.01)
    assert _gl(c, COGS) - cogs0 == pytest.approx(0.0, abs=0.01), "nothing was sold"
    assert _gl(c, CASH) - cash0 == pytest.approx(-120.0, abs=0.01), "cash was not restated"


# ── everything sold: the whole difference is a cost correction ──────────────
@pytest.mark.parametrize("method", ["fifo", "lifo", "weighted_avg"])
def test_a_cost_correction_on_sold_goods_lands_in_cogs(make_client, db, method):
    c = make_client("superadmin")
    _method(c, method)
    item = _item(c, "PE Sold")
    inv0, cogs0 = _gl(c, INV), _gl(c, COGS)
    pid = _po(c, [_line(item, 10, 10)])
    _sell(c, item, 10)
    assert _stock(db, item)[0] == pytest.approx(0)

    r = _edit(c, pid, [_line(item, 10, 12)])
    assert r.status_code == 200, r.text
    assert r.json()["cogs_correction"] == pytest.approx(20.0, abs=0.01)

    # The goods cost $20 more than the books said, and every unit is gone —
    # so the whole $20 belongs in cost of sales, and none on the shelf.
    assert _gl(c, COGS) - cogs0 == pytest.approx(100.0 + 20.0, abs=0.01)
    assert _gl(c, INV) - inv0 == pytest.approx(0.0, abs=0.01)


# ── the case the whole design exists for ────────────────────────────────────
@pytest.mark.parametrize("method", ["fifo", "lifo", "weighted_avg"])
def test_a_partly_sold_receipt_splits_the_difference(make_client, db, method):
    """Six sold, four on the shelf: $2 more each means $12 to COGS and $8 to
    stock. Both sides are asserted, because a wrong split still balances."""
    c = make_client("superadmin")
    _method(c, method)
    item = _item(c, "PE Split")
    inv0, cogs0 = _gl(c, INV), _gl(c, COGS)
    pid = _po(c, [_line(item, 10, 10)])
    _sell(c, item, 6)

    r = _edit(c, pid, [_line(item, 10, 12)])
    assert r.status_code == 200, r.text
    assert r.json()["cogs_correction"] == pytest.approx(12.0, abs=0.01)

    assert _stock(db, item) == (4.0, 12.0), "the four still held are worth 12 each"
    assert _gl(c, COGS) - cogs0 == pytest.approx(60.0 + 12.0, abs=0.01)
    assert _gl(c, INV) - inv0 == pytest.approx(48.0, abs=0.01)   # 4 x 12


def test_the_two_sides_always_sum_to_the_change(make_client, db):
    """Whatever the split, inventory + COGS must move by the whole difference."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Sum")
    inv0, cogs0 = _gl(c, INV), _gl(c, COGS)
    pid = _po(c, [_line(item, 20, 5)])
    _sell(c, item, 7)

    _edit(c, pid, [_line(item, 20, 8)])
    moved = (_gl(c, INV) - inv0) + (_gl(c, COGS) - cogs0)
    # 20 units at 5 became 20 at 8. Wherever the money ended up, the two
    # accounts together must hold what the goods finally cost: 13 still on the
    # shelf at 8, and 7 that passed through cost of sales at 8.
    assert moved == pytest.approx(20 * 8, abs=0.02)


# ── a cost that goes DOWN ───────────────────────────────────────────────────
def test_a_cost_corrected_downwards_reverses_the_same_way(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Down")
    inv0, cogs0 = _gl(c, INV), _gl(c, COGS)
    pid = _po(c, [_line(item, 10, 20)])
    _sell(c, item, 4)

    r = _edit(c, pid, [_line(item, 10, 15)])
    assert r.status_code == 200, r.text
    assert r.json()["cogs_correction"] == pytest.approx(-20.0, abs=0.01)   # 4 x -5

    assert _stock(db, item) == (6.0, 15.0)
    assert _gl(c, COGS) - cogs0 == pytest.approx(80.0 - 20.0, abs=0.01)
    assert _gl(c, INV) - inv0 == pytest.approx(90.0, abs=0.01)             # 6 x 15


# ── corrections accumulate ──────────────────────────────────────────────────
def test_correcting_twice_is_the_same_as_correcting_once(make_client, db):
    """10 -> 12 -> 15 must cost what 10 -> 15 costs.

    A journal entry is keyed by its source, and `post_entry` returns the live
    one unchanged rather than posting a second — so a second correction would
    be swallowed in silence unless the standing one is reversed and re-posted
    at the cumulative figure.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PE Twice"), _item(c, "PE Once")

    def spend(item, steps):
        inv0, cogs0 = _gl(c, INV), _gl(c, COGS)
        pid = _po(c, [_line(item, 10, steps[0])])
        _sell(c, item, 6)
        for cost in steps[1:]:
            assert _edit(c, pid, [_line(item, 10, cost)]).status_code == 200
        return _gl(c, INV) - inv0, _gl(c, COGS) - cogs0

    twice = spend(a, [10, 12, 15])
    once  = spend(b, [10, 15])
    assert twice[0] == pytest.approx(once[0], abs=0.01), "inventory disagrees"
    assert twice[1] == pytest.approx(once[1], abs=0.01), "cost of sales disagrees"
    assert _stock(db, a)[1] == pytest.approx(_stock(db, b)[1], abs=0.01)


def test_only_one_correction_stands_at_a_time(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE One")
    pid = _po(c, [_line(item, 10, 10)])
    _sell(c, item, 5)
    for cost in (12, 14, 16):
        assert _edit(c, pid, [_line(item, 10, cost)]).status_code == 200

    live = db.execute(
        "SELECT COUNT(*) AS n FROM journal_entries "
        "WHERE source_type='purchase_cost_adjustment' AND source_id=? "
        "AND status='posted' AND reversed_by IS NULL", (pid,)).fetchone()["n"]
    assert live == 1, "each correction should supersede the last, not stack"


# ── shipping is money on the goods too ──────────────────────────────────────
def test_correcting_the_delivery_charge_re_values_the_goods(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PE Ship A"), _item(c, "PE Ship B")
    pid = _po(c, [_line(a, 10, 10), _line(b, 10, 30)], shipping=40)
    assert _stock(db, a) == (10.0, 11.0)
    assert _stock(db, b) == (10.0, 33.0)

    r = c.put(f"/api/purchases/{pid}", json={"additional_costs": 80})
    assert r.status_code == 200, r.text

    # 80 over line values of 100 and 300 splits 20 / 60.
    assert _stock(db, a) == (10.0, 12.0)
    assert _stock(db, b) == (10.0, 36.0)


# ── when the goods themselves change ────────────────────────────────────────
def test_changing_the_quantity_moves_stock(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Qty")
    pid = _po(c, [_line(item, 10, 10)])

    r = _edit(c, pid, [_line(item, 4, 10)])
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "re-received"
    assert _stock(db, item) == (4.0, 10.0)


def test_changing_the_goods_is_refused_once_they_have_moved(make_client, db):
    """Correcting the money is always allowed; un-receiving what is gone is not."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Gone")
    pid = _po(c, [_line(item, 10, 10)])
    _sell(c, item, 6)

    r = _edit(c, pid, [_line(item, 4, 10)])
    assert r.status_code == 409, r.text
    assert _stock(db, item)[0] == pytest.approx(4), "a refusal must change nothing"

    # ...but the COST can still be corrected, which is the point.
    assert _edit(c, pid, [_line(item, 10, 13)]).status_code == 200


def test_adding_a_line_re_receives_the_order(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PE Add A"), _item(c, "PE Add B")
    pid = _po(c, [_line(a, 5, 10)])

    r = _edit(c, pid, [_line(a, 5, 10), _line(b, 3, 20)])
    assert r.status_code == 200, r.text
    assert _stock(db, a) == (5.0, 10.0)
    assert _stock(db, b) == (3.0, 20.0)


# ── the guards ──────────────────────────────────────────────────────────────
def test_a_voided_purchase_cannot_be_corrected(make_client):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Void")
    pid = _po(c, [_line(item, 5, 10)])
    assert c.patch(f"/api/purchases/{pid}/void",
                   json={"reason": "test"}).status_code == 200

    r = _edit(c, pid, [_line(item, 5, 12)])
    assert r.status_code == 400
    assert "voided" in r.text.lower()


def test_a_locked_period_stops_it(make_client, db):
    """The receipt posted into its own month and the correction posts into
    today, so a lock on either has to stop it."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Lock")
    pid = _po(c, [_line(item, 5, 10)])
    row = db.execute("SELECT paid_at, ordered_at FROM purchases WHERE id=?",
                     (pid,)).fetchone()
    ym = str(row["paid_at"] or row["ordered_at"])[:7]
    db.execute("INSERT INTO accounting_periods (year, month, locked_at) VALUES (?,?,?)",
               (int(ym[:4]), int(ym[5:7]), "2026-01-01 00:00:00"))
    db.commit()
    try:
        r = _edit(c, pid, [_line(item, 5, 12)])
        assert r.status_code == 400
        assert "locked" in r.text.lower()
        assert _stock(db, item) == (5.0, 10.0), "a refusal must change nothing"
    finally:
        db.execute("DELETE FROM accounting_periods WHERE year=? AND month=?",
                   (int(ym[:4]), int(ym[5:7])))
        db.commit()


def test_an_order_still_on_order_edits_freely(make_client, db):
    """Nothing has moved yet, so there is nothing to restate."""
    c = make_client("superadmin")
    _method(c, "fifo")
    a, b = _item(c, "PE Ord A"), _item(c, "PE Ord B")
    pid = _po(c, [_line(a, 5, 10)], status="Ordered")

    assert _edit(c, pid, [_line(b, 9, 3)]).status_code == 200
    assert _stock(db, a) == (0.0, 0.0)
    assert _stock(db, b) == (0.0, 0.0), "an order on paper moves no stock"
    head = db.execute("SELECT subtotal FROM purchases WHERE id=?", (pid,)).fetchone()
    assert head["subtotal"] == pytest.approx(27.0)


# ── the books stay coherent ─────────────────────────────────────────────────
def test_the_ledger_balances_and_the_stock_agrees_with_it(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Books")
    inv0 = _gl(c, INV)
    pid = _po(c, [_line(item, 12, 6)], shipping=12)
    _sell(c, item, 5)
    assert _edit(c, pid, [_line(item, 12, 9)], shipping=12).status_code == 200

    tb = c.get("/api/accounting/trial-balance").json()
    assert tb["balanced"], "the correction left the ledger out of balance"

    qty, cost = _stock(db, item)
    assert qty * cost == pytest.approx(_gl(c, INV) - inv0, abs=0.05), \
        "stock value and the inventory account disagree"

    lay = db.execute(
        "SELECT COALESCE(SUM(qty_remaining),0) q, COALESCE(SUM(qty_remaining*unit_cost),0) v "
        "FROM inventory_cost_layers WHERE inventory_id=? AND qty_remaining > 1e-9",
        (item,)).fetchone()
    assert float(lay["q"]) == pytest.approx(qty)
    assert float(lay["v"]) == pytest.approx(qty * cost, abs=0.01)


def test_the_correction_is_dated_today_not_backdated(make_client, db):
    """It moves a past month's profit into this one, which is the accepted
    trade-off — but it must be visible as a current-period entry."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Date")
    pid = _po(c, [_line(item, 10, 10)])
    _sell(c, item, 10)
    assert _edit(c, pid, [_line(item, 10, 14)]).status_code == 200

    from datetime import datetime
    je = db.execute(
        "SELECT entry_date FROM journal_entries "
        "WHERE source_type='purchase_cost_adjustment' AND source_id=? "
        "AND status='posted' AND reversed_by IS NULL", (pid,)).fetchone()
    assert je, "no correction was posted"
    assert str(je["entry_date"])[:10] == datetime.utcnow().strftime("%Y-%m-%d")


def test_it_is_logged_with_what_changed(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PE Log")
    pid = _po(c, [_line(item, 10, 10)])
    _sell(c, item, 3)
    assert _edit(c, pid, [_line(item, 10, 17)]).status_code == 200

    row = db.execute(
        "SELECT detail FROM audit_log WHERE module='purchase' AND record_id=? "
        "AND action='update' ORDER BY id DESC LIMIT 1", (pid,)).fetchone()
    assert row and "restated" in row["detail"]
    assert "17" in row["detail"], "the new cost should be recorded"
