"""Voiding a purchase — the mirror of voiding an invoice.

A purchase entered against the wrong supplier, keyed twice, or received for
goods that never arrived had no way out. Archiving hid the row while leaving the
stock on the shelf and the entry in the ledger; editing is refused once
received, correctly, because by then the goods and the money have moved. The
only remedy was a hand-typed stock adjustment plus a manual journal, done from
memory, with nothing tying the two together.

What a void has to undo is everything the receipt did, and the test for "did it"
is that the four independent records of the same goods still agree afterwards:

  * the quantity on the shelf,
  * the item's average cost,
  * the cost layers under FIFO/LIFO,
  * the inventory account in the ledger.

The other half is knowing when to refuse. Units already sold cannot be unbought,
and inventing the shortfall would produce exactly the disagreement above. So the
receipt's own layer is checked before a single write, and a refusal leaves
nothing half-done.
"""
import uuid

import pytest


# ── helpers ─────────────────────────────────────────────────────────────────
def _method(c, method):
    assert c.put("/api/settings/",
                 json={"inventory_costing_method": method}).status_code == 200


def _item(c, name, qty=0, cost=0, price=100, **extra):
    r = c.post("/api/inventory/", json={
        "name": f"{name} {uuid.uuid4().hex[:6]}", "product_type": "finished",
        "quantity": qty, "unit_cost": cost, "sale_price": price, **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _po(c, item, qty, cost, status="Paid", extra=0):
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item, "product_name": "Thing",
        "quantity": qty, "unit_cost": cost, "additional_costs": extra,
        "status": status})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _void(c, purchase_id, reason="test"):
    return c.patch(f"/api/purchases/{purchase_id}/void", json={"reason": reason})


def _stock(db, item):
    r = db.execute("SELECT quantity, unit_cost FROM inventory WHERE id=?",
                   (item,)).fetchone()
    return round(float(r["quantity"]), 4), round(float(r["unit_cost"]), 4)


def _layers(db, item):
    r = db.execute(
        "SELECT COALESCE(SUM(qty_remaining),0) q, "
        "       COALESCE(SUM(qty_remaining*unit_cost),0) v "
        "FROM inventory_cost_layers WHERE inventory_id=? AND qty_remaining > 1e-9",
        (item,)).fetchone()
    return round(float(r["q"]), 4), round(float(r["v"]), 4)


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 4)
    return 0.0


def _sell(c, item, qty, unit_price=50):
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "T", "inventory_id": item,
                   "quantity": qty, "unit_price": unit_price}],
        "payment_method": "Cash", "amount_tendered": qty * unit_price,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return r.json()


# ── the goods come back off the shelf ───────────────────────────────────────
@pytest.mark.parametrize("method", ["fifo", "lifo", "weighted_avg"])
def test_voiding_undoes_the_receipt(make_client, db, method):
    """All four records of the same goods, still agreeing afterwards."""
    c = make_client("superadmin")
    _method(c, method)
    item = _item(c, "PV")
    gl0, cash0 = _gl(c, "1200"), _gl(c, "1000")

    _po(c, item, 10, 10)                 # kept
    second = _po(c, item, 10, 20)        # voided
    assert _stock(db, item) == (20.0, 15.0), "setup: the receipt should blend"

    r = _void(c, second, "wrong supplier")
    assert r.status_code == 200, r.text
    assert r.json()["restocked"] == pytest.approx(10)

    # The shelf, and the average as it was before the second receipt landed.
    assert _stock(db, item) == (10.0, 10.0)
    # The ledger, by a mirror entry — the cash paid to the supplier comes back.
    assert _gl(c, "1200") - gl0 == pytest.approx(100.0, abs=0.01)
    assert _gl(c, "1000") - cash0 == pytest.approx(-100.0, abs=0.01)
    if method in ("fifo", "lifo"):
        assert _layers(db, item) == (10.0, 100.0)


def test_the_landed_cost_is_what_comes_back_out(make_client, db):
    """Shipping and customs went into the average, so they have to come out.

    Reversing at the item's CURRENT average instead would leave the difference
    between the two behind as a silent gain or loss on the remaining stock.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVA")
    _po(c, item, 10, 10)
    # 10 x $20 plus $50 of shipping = $250 landed, $25 a unit.
    second = _po(c, item, 10, 20, extra=50)
    assert _stock(db, item) == (20.0, 17.5), "setup: (100 + 250) / 20"

    r = _void(c, second)
    assert r.status_code == 200, r.text
    # The payload reports what each LINE gave back, since an order has several.
    assert [l["unit_cost"] for l in r.json()["lines"]] == [pytest.approx(25.0)]
    assert _stock(db, item) == (10.0, 10.0)
    assert _layers(db, item) == (10.0, 100.0)


def test_it_draws_its_own_layer_not_the_next_in_the_queue(make_client, db):
    """The units reversed are the ones that arrived, not the ones due out next.

    Under FIFO the queue would hand back the OLDEST layer. Voiding the second of
    two receipts has to take the second one's goods, or the layers left behind
    describe stock that is not there.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVQ")
    _po(c, item, 10, 10)                 # oldest — must survive untouched
    second = _po(c, item, 10, 20)

    assert _void(c, second).status_code == 200
    rows = db.execute(
        "SELECT qty_remaining, unit_cost FROM inventory_cost_layers "
        "WHERE inventory_id=? AND qty_remaining > 1e-9 ORDER BY id", (item,)).fetchall()
    assert [(float(r["qty_remaining"]), float(r["unit_cost"])) for r in rows] == \
           [(10.0, 10.0)], "the wrong layer was drawn down"


def test_an_order_that_never_arrived_reverses_nothing(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVO", qty=7, cost=3)
    before = _stock(db, item)
    gl0 = _gl(c, "1200")

    ordered = _po(c, item, 5, 99, status="Ordered")
    r = _void(c, ordered)
    assert r.status_code == 200, r.text
    assert r.json()["restocked"] == pytest.approx(0)
    assert _stock(db, item) == before
    assert _gl(c, "1200") == pytest.approx(gl0, abs=0.01)


def test_a_received_but_unpaid_purchase_books_the_goods_and_the_debt(make_client, db):
    """Receiving is what books the goods, whether or not they are paid for.

    This test used to assert the opposite — that an unpaid receipt posted
    nothing — because the ledger entry waited for the move to 'Paid'. That was
    a real gap, not a policy: between Received and Paid the stock sat on the
    shelf with cost layers under it while GL 1200 had never been debited, so a
    sale in that window drew a layer and relieved inventory that was never
    booked. Receiving posts it now, and what is not yet paid is a debt to the
    supplier rather than nothing at all.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVR")
    gl0, ap0 = _gl(c, "1200"), _gl(c, "2000")
    pid = _po(c, item, 10, 10, status="Received")
    assert _stock(db, item) == (10.0, 10.0)
    assert _gl(c, "1200") == pytest.approx(gl0 + 100, abs=0.01),         "receiving 10 at 10 has to put 100 of stock into the ledger"
    # 2000 is a liability, so _gl's debit-minus-credit goes DOWN by what is owed.
    assert _gl(c, "2000") == pytest.approx(ap0 - 100, abs=0.01),         "the supplier is owed for goods delivered and not yet paid for"

    assert _void(c, pid).status_code == 200
    assert _stock(db, item)[0] == pytest.approx(0)
    assert _gl(c, "1200") == pytest.approx(gl0, abs=0.01)
    assert _gl(c, "2000") == pytest.approx(ap0, abs=0.01),         "and the debt goes with the goods"


# ── when it must refuse ─────────────────────────────────────────────────────
def test_it_refuses_once_the_goods_have_been_sold(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVS")
    pid = _po(c, item, 10, 10)
    _sell(c, item, 4)

    r = _void(c, pid)
    assert r.status_code == 409
    assert "6" in r.text and "10" in r.text, "the message should name the shortfall"
    assert _stock(db, item)[0] == pytest.approx(6), "a refusal must change nothing"


def test_a_refusal_leaves_the_ledger_and_the_layers_alone(make_client, db):
    """Checked before a single write, so nothing is half-done."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVH")
    pid = _po(c, item, 10, 10)
    _sell(c, item, 1)
    gl_before, layers_before, stock_before = _gl(c, "1200"), _layers(db, item), _stock(db, item)

    assert _void(c, pid).status_code == 409
    assert _gl(c, "1200") == pytest.approx(gl_before, abs=0.01)
    assert _layers(db, item) == layers_before
    assert _stock(db, item) == stock_before
    assert db.execute("SELECT voided_at FROM purchases WHERE id=?",
                      (pid,)).fetchone()["voided_at"] is None


def test_it_refuses_when_the_goods_are_promised_to_a_customer(make_client, db):
    """Receiving hands stock to whoever was waiting. Those units are spoken for
    even though they are physically present, and taking them would break a
    promise somebody has already paid a deposit against."""
    c = make_client("superadmin")
    _method(c, "weighted_avg")
    item = _item(c, "PVC")
    cl = c.post("/api/clients/", json={"name": "Waiting"}).json()["id"]

    # Sell what is not there yet: a back-order the receipt will then fill.
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)
    order = c.post("/api/pos/checkout", json={
        "client_id": cl,
        "items": [{"name": "T", "inventory_id": item, "quantity": 6,
                   "unit_price": 50}],
        "payment_method": "Cash", "amount_tendered": 300,
        "allow_backorder": True, "idempotency_key": str(uuid.uuid4())})
    if order.status_code != 200:
        pytest.skip(f"back-orders not available in this configuration: {order.text[:120]}")

    pid = _po(c, item, 10, 10)
    reserved = float(db.execute(
        "SELECT COALESCE(reserved_quantity, 0) AS r FROM inventory WHERE id=?",
        (item,)).fetchone()["r"] or 0)
    if reserved <= 0:
        pytest.skip("the receipt allocated nothing, so there is no promise to protect")

    r = _void(c, pid)
    assert r.status_code == 409
    assert "reserved" in r.text.lower() or "customer" in r.text.lower()


def test_it_cannot_be_voided_twice(make_client):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVD")
    pid = _po(c, item, 10, 10, status="Received")
    assert _void(c, pid).status_code == 200
    assert _void(c, pid).status_code == 400


def test_a_missing_purchase_is_a_404(make_client):
    c = make_client("superadmin")
    assert _void(c, 999999).status_code == 404


def test_it_needs_permission_to_delete_purchases(make_client):
    c = make_client("superadmin")
    item = _item(c, "PVP")
    pid = _po(c, item, 5, 10, status="Ordered")
    viewer = make_client("Viewer")
    assert viewer.patch(f"/api/purchases/{pid}/void",
                        json={"reason": "x"}).status_code in (401, 403)


def test_a_locked_period_stops_it(make_client, db):
    """The receipt posted into its own month and the reversal posts into today,
    so a lock on either has to stop it."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVL")
    pid = _po(c, item, 10, 10, status="Received")

    row = db.execute(
        "SELECT paid_at, received_at, ordered_at FROM purchases WHERE id=?",
        (pid,)).fetchone()
    ym = str(row["paid_at"] or row["received_at"] or row["ordered_at"])[:7]
    db.execute(
        "INSERT INTO accounting_periods (year, month, locked_at) VALUES (?,?,?)",
        (int(ym[:4]), int(ym[5:7]), "2026-01-01 00:00:00"))
    db.commit()
    try:
        r = _void(c, pid)
        assert r.status_code == 400
        assert "locked" in r.text.lower()
        assert _stock(db, item)[0] == pytest.approx(10), "a refusal must change nothing"
    finally:
        db.execute("DELETE FROM accounting_periods WHERE year=? AND month=?",
                   (int(ym[:4]), int(ym[5:7])))
        db.commit()


# ── a voided purchase is finished ───────────────────────────────────────────
def test_its_status_cannot_be_moved_on(make_client, db):
    """And crucially, that path cannot credit the stock a second time.

    Voiding releases the `stock_updated` claim so the receipt is not counted
    twice. That is exactly what would let a later status change re-credit the
    goods, so the claim itself excludes voided rows as well.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVN")
    pid = _po(c, item, 10, 10, status="Received")
    assert _void(c, pid).status_code == 200
    assert _stock(db, item)[0] == pytest.approx(0)

    r = c.patch(f"/api/purchases/{pid}/status", json={"status": "Paid"})
    assert r.status_code == 400
    assert _stock(db, item)[0] == pytest.approx(0), "the stock was credited twice"


def test_it_leaves_the_purchasing_totals(make_client):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVT")
    _po(c, item, 10, 10)
    before = c.get("/api/purchases/stats").json()

    second = _po(c, item, 10, 10)
    assert c.get("/api/purchases/stats").json()["total_spent"] > before["total_spent"]

    assert _void(c, second).status_code == 200
    after = c.get("/api/purchases/stats").json()
    assert after["total_spent"] == pytest.approx(before["total_spent"], abs=0.01)
    assert after.get("paid", 0) == before.get("paid", 0)


def test_the_expense_is_voided_with_it(make_client, db):
    """The ledger is the accrual truth; the expense row is the cash-basis view
    of the same money, and it has to drop out too."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVE")
    kept = _po(c, item, 10, 10)
    second = _po(c, item, 10, 10)
    po = db.execute("SELECT po_number FROM purchases WHERE id=?", (second,)).fetchone()["po_number"]
    kept_po = db.execute("SELECT po_number FROM purchases WHERE id=?", (kept,)).fetchone()["po_number"]

    assert _void(c, second).status_code == 200
    rows = {r["description"].split(" ")[0]: r["voided_at"] for r in db.execute(
        "SELECT description, voided_at FROM expenses WHERE category='Purchase'").fetchall()}
    assert rows.get(po) is not None, "the voided purchase's expense still stands"
    assert rows.get(kept_po) is None, "it voided another purchase's expense"


def test_the_row_stays_in_the_list_and_says_so(make_client):
    """Out of the figures, not out of the history — as a voided invoice is."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVV")
    pid = _po(c, item, 10, 10, status="Received")
    assert _void(c, pid, "keyed twice").status_code == 200

    row = next(p for p in c.get("/api/purchases/").json() if p["id"] == pid)
    assert row["voided_at"]
    assert row["void_reason"] == "keyed twice"


def test_it_is_logged(make_client, db):
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVG")
    pid = _po(c, item, 10, 10, status="Received")
    assert _void(c, pid, "duplicate entry").status_code == 200

    row = db.execute(
        "SELECT action, detail FROM audit_log WHERE module='purchase' "
        "AND record_id=? AND action='void' ORDER BY id DESC LIMIT 1",
        (pid,)).fetchone()
    assert row is not None, "the void left no audit trail"
    assert "duplicate entry" in row["detail"]


# ── the ledger keeps its own rules ──────────────────────────────────────────
def test_the_entry_is_reversed_not_deleted(make_client, db):
    """A mirror entry, and the original marked reversed — never edited away."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "PVJ")
    pid = _po(c, item, 10, 10)

    original = db.execute(
        "SELECT id FROM journal_entries WHERE source_type='purchase' AND source_id=?",
        (pid,)).fetchone()
    assert original, "setup: paying a purchase should post an entry"

    assert _void(c, pid).status_code == 200
    after = db.execute("SELECT status FROM journal_entries WHERE id=?",
                       (original["id"],)).fetchone()
    assert after["status"] == "reversed"
    assert db.execute(
        "SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='reversal'"
    ).fetchone()["n"] > 0

    tb = c.get("/api/accounting/trial-balance").json()
    assert tb["balanced"], "the ledger is out of balance after a void"
