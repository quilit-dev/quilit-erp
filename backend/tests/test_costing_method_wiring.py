"""The costing method, from the setting to every path that moves stock.

`test_inventory_costing_method.py` proves the three methods value a stock-OUT
differently. This file asks the next question: is the setting actually WIRED to
the paths a business uses, and does the inventory it leaves behind hold together?

Three invariants carry it. Each one is silent when broken, which is why they are
asserted rather than assumed:

  * **Depth.** Under FIFO/LIFO the cost layers must account for exactly the
    quantity on hand. A path that moves stock without touching layers drifts,
    and the drift only surfaces later as a mis-priced sale.

  * **Valuation.** `quantity * unit_cost` must equal the layer value. `unit_cost`
    is what the inventory list, the valuation report and every non-layer reader
    use; when it stops tracking the layers those screens quietly disagree with
    the costing engine underneath them.

  * **The ledger.** Stock value must equal the inventory account's own balance.
    The GL is posted from the COGS the costing engine returns, so if the two
    ever part company, one of them is wrong about real money.

Two regressions found by these invariants are pinned at the bottom.
"""
import uuid

import pytest


# ── helpers ─────────────────────────────────────────────────────────────────
def _method(c, method):
    r = c.put("/api/settings/", json={"inventory_costing_method": method})
    assert r.status_code == 200, r.text
    assert r.json()["inventory_costing_method"] == method


def _item(c, name, qty=0, cost=0, price=100):
    r = c.post("/api/inventory/", json={
        "name": f"{name} {uuid.uuid4().hex[:6]}", "product_type": "finished",
        "quantity": qty, "unit_cost": cost, "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _receive(c, item, qty, cost):
    """Received AND paid, so the ledger carries the inventory debit too.

    A purchase left unpaid brings the goods in but posts nothing — the expense
    side is cash-basis — and the ledger invariants below would then be comparing
    stock against a half-written account."""
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item, "product_name": "Restock",
        "quantity": qty, "unit_cost": cost, "status": "Paid"})
    assert r.status_code in (200, 201), r.text


def _two_layers(c, name, price=100):
    """The standard shape: 10 @ $10 then 10 @ $20, a $15 average.

    Consuming 15 then separates the methods — FIFO 10x10+5x20 = 200,
    LIFO 10x20+5x10 = 250, weighted average 15x15 = 225.
    """
    item = _item(c, name, price=price)
    _receive(c, item, 10, 10)
    _receive(c, item, 10, 20)
    return item


def _stock(db, item):
    r = db.execute("SELECT quantity, unit_cost FROM inventory WHERE id=?",
                   (item,)).fetchone()
    return float(r["quantity"]), float(r["unit_cost"])


def _layers(db, item):
    r = db.execute(
        "SELECT COALESCE(SUM(qty_remaining),0) q, "
        "       COALESCE(SUM(qty_remaining*unit_cost),0) v "
        "FROM inventory_cost_layers WHERE inventory_id=? AND qty_remaining > 1e-9",
        (item,)).fetchone()
    return float(r["q"]), float(r["v"])


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 4)
    return 0.0


def _sell(c, item, qty, unit_price=100, client_id=None):
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code in (200, 409)
    body = {"items": [{"name": "Line", "inventory_id": item,
                       "quantity": qty, "unit_price": unit_price}],
            "payment_method": "Cash", "amount_tendered": qty * unit_price,
            "idempotency_key": str(uuid.uuid4())}
    if client_id:
        body["client_id"] = client_id
    r = c.post("/api/pos/checkout", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _assert_holds_together(db, item, *, method):
    """Depth and valuation, the two invariants that live on the item itself."""
    qty, unit_cost = _stock(db, item)
    if method in ("fifo", "lifo"):
        lay_qty, lay_val = _layers(db, item)
        assert lay_qty == pytest.approx(qty, abs=1e-6), (
            f"cost layers hold {lay_qty} but {qty} is on hand")
        assert qty * unit_cost == pytest.approx(lay_val, abs=1e-4), (
            f"unit_cost values the stock at {qty * unit_cost} but the layers "
            f"say {lay_val}")


# ── the setting reaches the paths that move stock ───────────────────────────
@pytest.mark.parametrize("method,expected", [("fifo", 200.0), ("lifo", 250.0),
                                             ("weighted_avg", 225.0)])
def test_a_till_sale_is_costed_by_the_configured_method(make_client, db,
                                                        method, expected):
    """The busiest stock path in the system, and the one that posts COGS."""
    c = make_client("superadmin")
    _method(c, method)
    item = _two_layers(c, "POS")

    before = _gl(c, "5000")
    _sell(c, item, 15)

    assert _gl(c, "5000") - before == pytest.approx(expected, abs=1e-4)
    _assert_holds_together(db, item, method=method)


@pytest.mark.parametrize("method,expected", [("fifo", 200.0), ("lifo", 250.0),
                                             ("weighted_avg", 225.0)])
def test_a_service_job_is_costed_by_the_configured_method(make_client, db,
                                                          method, expected):
    c = make_client("superadmin")
    _method(c, method)
    item = _two_layers(c, "SVC")
    cl = c.post("/api/clients/", json={"name": "Cost Client"}).json()["id"]

    j = c.post("/api/service/jobs", json={
        "client_id": cl, "job_type": "Repair",
        "items": [{"line_type": "part", "inventory_id": item, "name": "Part",
                   "quantity": 15, "unit_price": 50}]})
    assert j.status_code in (200, 201), j.text
    r = c.post(f"/api/service/jobs/{j.json()['id']}/complete", json={})
    assert r.status_code == 200, r.text

    assert r.json()["parts_cost"] == pytest.approx(expected, abs=1e-4)
    _assert_holds_together(db, item, method=method)


@pytest.mark.parametrize("method,expected", [("fifo", 200.0), ("lifo", 250.0),
                                             ("weighted_avg", 225.0)])
def test_a_stock_adjustment_draws_the_same_layers(make_client, db, method, expected):
    """An adjustment posts no COGS, but it must still deplete the right layers
    or the next sale is priced from stock that is no longer there."""
    c = make_client("superadmin")
    _method(c, method)
    item = _two_layers(c, "ADJ")

    r = c.patch(f"/api/inventory/{item}/stock",
                json={"delta": -15, "type": "adjustment"})
    assert r.status_code == 200, r.text

    qty, unit_cost = _stock(db, item)
    assert qty == pytest.approx(5)
    # What is LEFT is the mirror of what the method consumed.
    left = {"fifo": 20.0, "lifo": 10.0, "weighted_avg": 15.0}[method]
    assert unit_cost == pytest.approx(left, abs=1e-6)
    _assert_holds_together(db, item, method=method)


# ── the ledger and the stock agree ──────────────────────────────────────────
@pytest.mark.parametrize("method", ["fifo", "lifo", "weighted_avg"])
def test_stock_value_matches_the_inventory_account(make_client, db, method):
    """Receive, sell, void, sell again — the ledger must still describe the
    same warehouse the inventory list does."""
    c = make_client("superadmin")
    _method(c, method)
    # Before this item exists, so the delta covers its whole life. The account
    # is company-wide, so only a delta around one item's history is meaningful.
    gl_before = _gl(c, "1200")
    item = _two_layers(c, "GL")
    _receive(c, item, 10, 30)           # a third price, so an average must move

    sale = _sell(c, item, 12)
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200
    _sell(c, item, 8)

    qty, unit_cost = _stock(db, item)
    # A few cents of tolerance, and only that: the ledger holds whole cents
    # while the valuation carries six decimals, so each posting can round by up
    # to half a cent. That is the only difference allowed — the failures this
    # test exists to catch were tens and hundreds of dollars.
    assert qty * unit_cost == pytest.approx(_gl(c, "1200") - gl_before, abs=0.05), (
        "the inventory list and the ledger disagree about what stock is worth")
    _assert_holds_together(db, item, method=method)


# ── switching the method ────────────────────────────────────────────────────
def test_switching_away_and_back_rebases_rather_than_drifting(make_client, db):
    """Layers are not maintained under weighted_avg, so coming back to FIFO
    must rebase from on-hand stock rather than trust what it left behind."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _two_layers(c, "SWITCH")

    _method(c, "weighted_avg")
    _sell(c, item, 10)                  # layers go stale: no longer maintained
    stale_qty, _ = _layers(db, item)
    assert stale_qty == pytest.approx(20), "weighted_avg touched the layers"

    _method(c, "fifo")
    qty, unit_cost = _stock(db, item)
    lay_qty, lay_val = _layers(db, item)
    assert lay_qty == pytest.approx(qty), "layers were not rebased on-hand"
    assert lay_val == pytest.approx(qty * unit_cost, abs=1e-4)
    _assert_holds_together(db, item, method="fifo")


def test_the_method_survives_a_round_trip_through_the_api(make_client):
    c = make_client("superadmin")
    for m in ("fifo", "lifo", "weighted_avg"):
        _method(c, m)
        assert c.get("/api/settings/").json()["inventory_costing_method"] == m


# ── regression: a void put stock back without re-pricing it ─────────────────
@pytest.mark.parametrize("method", ["fifo", "lifo", "weighted_avg"])
def test_a_void_re_prices_the_stock_it_returns(make_client, db, method):
    """Goods come back at the cost they left at, and that has to move the
    average.

    Sell at $10 while the average is $10, then receive at $20 so the average
    climbs to $15, then void the sale. The returned units are worth $10, so the
    average must fall back below $15 — it used to stay at $15, valuing stock at
    a price it no longer had and putting the inventory list $25 above the
    ledger.
    """
    c = make_client("superadmin")
    _method(c, method)
    gl_before = _gl(c, "1200")          # before the item exists — see above
    item = _item(c, "VOID")
    _receive(c, item, 10, 10)

    sale = _sell(c, item, 5)
    _receive(c, item, 5, 20)
    _, avg = _stock(db, item)
    assert avg == pytest.approx(15.0, abs=1e-6), "setup: the average should climb"

    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    qty, unit_cost = _stock(db, item)
    assert qty == pytest.approx(15)
    # 5 @ $10 left over + 5 @ $20 received + 5 @ $10 returned = $200 over 15.
    assert unit_cost == pytest.approx(200.0 / 15.0, abs=1e-4), (
        "returned stock did not move the average")
    assert qty * unit_cost == pytest.approx(_gl(c, "1200") - gl_before, abs=0.05)
    _assert_holds_together(db, item, method=method)


# ── regression: a reopened job returned every part at one blended cost ──────
def test_reopening_a_job_returns_each_part_at_its_own_cost(make_client, db):
    """A $500 component and a $1 washer are not worth the same on the way back.

    The reopen valued everything at the job's total parts cost spread over the
    quantity returned, so returning both priced each at $46.36: the washers came
    back worth 46x what they cost, and the component at a tenth. Nothing
    complained, because the job's TOTAL was right.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    cheap = _item(c, "washer", qty=100, cost=1, price=3)
    dear  = _item(c, "board", qty=100, cost=500, price=1500)
    cl = c.post("/api/clients/", json={"name": "Reopen Client"}).json()["id"]

    j = c.post("/api/service/jobs", json={
        "client_id": cl, "job_type": "Repair",
        "items": [{"line_type": "part", "inventory_id": cheap, "name": "washer",
                   "quantity": 10, "unit_price": 3},
                  {"line_type": "part", "inventory_id": dear, "name": "board",
                   "quantity": 1, "unit_price": 1500}]})
    assert j.status_code in (200, 201), j.text
    job = j.json()["id"]

    done = c.post(f"/api/service/jobs/{job}/complete", json={})
    assert done.status_code == 200, done.text
    assert done.json()["parts_cost"] == pytest.approx(510.0)

    invoice_id = done.json()["invoice"]["invoice_id"]
    assert c.patch(f"/api/invoices/{invoice_id}/void",
                   json={"reason": "test"}).status_code == 200
    r = c.post(f"/api/service/jobs/{job}/reopen", json={})
    assert r.status_code == 200, r.text

    for item, cost in ((cheap, 1.0), (dear, 500.0)):
        qty, unit_cost = _stock(db, item)
        assert qty == pytest.approx(100)
        assert unit_cost == pytest.approx(cost, abs=1e-4)
        lay_qty, lay_val = _layers(db, item)
        assert lay_val == pytest.approx(100 * cost, abs=1e-3), (
            f"parts came back at the wrong cost: {lay_val} for {100 * cost}")
        _assert_holds_together(db, item, method="fifo")


def test_the_cost_of_each_part_is_recorded_as_it_is_consumed(make_client, db):
    """The snapshot the reopen depends on. The column was declared for it and
    never written, which is how the blended fallback became the only option."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _two_layers(c, "SNAP")
    cl = c.post("/api/clients/", json={"name": "Snap Client"}).json()["id"]

    j = c.post("/api/service/jobs", json={
        "client_id": cl, "job_type": "Repair",
        "items": [{"line_type": "part", "inventory_id": item, "name": "Part",
                   "quantity": 15, "unit_price": 50}]})
    job = j.json()["id"]
    assert c.post(f"/api/service/jobs/{job}/complete", json={}).status_code == 200

    row = db.execute(
        "SELECT unit_cost, consumed_at FROM service_job_lines "
        "WHERE job_id=? AND line_type='part'", (job,)).fetchone()
    # FIFO consumed 10 @ $10 + 5 @ $20 = $200 over 15 units.
    assert float(row["unit_cost"]) == pytest.approx(200.0 / 15.0, abs=1e-4)
    assert row["consumed_at"], "the consumption marker was left unset"


def test_reopening_clears_the_consumption_marker(make_client, db):
    """The parts are back on the shelf, so the lines are not consumed.

    A marker left standing is worse than one never written: it says stock and
    the ledger were touched for a line whose goods are in the warehouse.
    """
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "MARKER", qty=50, cost=6, price=20)
    cl = c.post("/api/clients/", json={"name": "Marker Client"}).json()["id"]

    j = c.post("/api/service/jobs", json={
        "client_id": cl, "job_type": "Repair",
        "items": [{"line_type": "part", "inventory_id": item, "name": "Part",
                   "quantity": 5, "unit_price": 20}]})
    job = j.json()["id"]
    done = c.post(f"/api/service/jobs/{job}/complete", json={})
    assert done.status_code == 200, done.text

    def marker():
        r = db.execute("SELECT unit_cost, consumed_at FROM service_job_lines "
                       "WHERE job_id=? AND line_type='part'", (job,)).fetchone()
        return r["unit_cost"], r["consumed_at"]

    assert all(x is not None for x in marker()), "the close set no marker"

    invoice_id = done.json()["invoice"]["invoice_id"]
    assert c.patch(f"/api/invoices/{invoice_id}/void",
                   json={"reason": "test"}).status_code == 200
    assert c.post(f"/api/service/jobs/{job}/reopen", json={}).status_code == 200

    assert marker() == (None, None), "the line still claims to be consumed"

    # And closing it again re-establishes it, so the cycle is repeatable.
    assert c.post(f"/api/service/jobs/{job}/complete", json={}).status_code == 200
    assert marker()[0] == pytest.approx(6.0, abs=1e-4)


def test_a_job_closed_before_the_snapshot_still_reopens(make_client, db):
    """Live jobs closed under the old code have no per-line cost. They must
    still give their parts back, on the old blended basis, rather than fail."""
    c = make_client("superadmin")
    _method(c, "fifo")
    item = _item(c, "LEGACY", qty=100, cost=4, price=12)
    cl = c.post("/api/clients/", json={"name": "Legacy Client"}).json()["id"]

    j = c.post("/api/service/jobs", json={
        "client_id": cl, "job_type": "Repair",
        "items": [{"line_type": "part", "inventory_id": item, "name": "Part",
                   "quantity": 10, "unit_price": 12}]})
    job = j.json()["id"]
    done = c.post(f"/api/service/jobs/{job}/complete", json={})
    assert done.status_code == 200, done.text

    # Rewind to the pre-fix shape: consumed, but with nothing on the line.
    db.execute("UPDATE service_job_lines SET unit_cost=NULL, consumed_at=NULL "
               "WHERE job_id=?", (job,))
    db.commit()

    invoice_id = done.json()["invoice"]["invoice_id"]
    assert c.patch(f"/api/invoices/{invoice_id}/void",
                   json={"reason": "test"}).status_code == 200
    r = c.post(f"/api/service/jobs/{job}/reopen", json={})
    assert r.status_code == 200, r.text

    qty, unit_cost = _stock(db, item)
    assert qty == pytest.approx(100)
    assert unit_cost == pytest.approx(4.0, abs=1e-4)


# ── the blend itself, without a database ────────────────────────────────────
def test_the_blend_is_the_moving_average():
    import costing

    class _FakeDB:
        def __init__(self, cost):
            self.cost, self.written = cost, None

        def execute(self, sql, params=()):
            if sql.startswith("SELECT"):
                return _Row({"unit_cost": self.cost})
            self.written = params[0]
            return None

    class _Row:
        def __init__(self, d):
            self.d = d

        def fetchone(self):
            return self.d

    db = _FakeDB(20.0)
    # 5 on hand at $20, 15 arriving at $13.3333 -> $15.
    assert costing.blend_stock_in(db, 1, qty_before=5, qty_in=15,
                                  unit_cost_in=200.0 / 15.0) == pytest.approx(15.0, abs=1e-4)


def test_the_blend_declines_impossible_inputs():
    import costing

    class _Nothing:
        def execute(self, sql, params=()):
            return self

        def fetchone(self):
            return None

    # Nothing arriving is nothing to blend, and it must not touch the average.
    assert costing.blend_stock_in(_Nothing(), 1, qty_before=5, qty_in=0,
                                  unit_cost_in=10) is None
    # An item that is not there cannot be re-priced.
    assert costing.blend_stock_in(_Nothing(), 1, qty_before=5, qty_in=5,
                                  unit_cost_in=10) is None
