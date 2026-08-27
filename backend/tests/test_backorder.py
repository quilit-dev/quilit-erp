"""Selling what is not on the shelf yet.

A customer wants five, there are two, the manager says the rest can be got, and
the customer pays for five and goes home. The two that exist leave at the till.
The three that do not are a promise — and a promise is not inventory.

The three things this must never do:

  * drive `inventory.quantity` negative, which stops the count being a count;
  * recognise revenue for goods the customer has not got, which shows a hundred
    per cent margin at the till and a cost with no sale against it weeks later;
  * let the next walk-in buy the units somebody has already paid for.
"""
import pytest

import commitments
import reservations


@pytest.fixture
def till(make_client):
    c = make_client("superadmin")
    c.post("/api/pos/session/open", json={"opening_float": 0})
    return c


@pytest.fixture
def buyer(till):
    return till.post("/api/clients/", json={"name": "Bakery Co"}).json()["id"]


def _item(c, name, qty, cost=4.0, price=10.0):
    return c.post("/api/inventory/", json={
        "name": name, "quantity": qty, "unit_cost": cost,
        "sale_price": price, "unit": "pcs"}).json()["id"]


def _sell(c, item, qty, client_id=None, **kw):
    body = {
        "client_id": client_id,
        "items": [{"name": "x", "inventory_id": item, "quantity": qty,
                   "unit_price": 10}],
        "payment_method": "Cash", "currency": "USD",
        "amount_tendered": qty * 10,
        "idempotency_key": "bo-%s-%s-%s" % (item, qty, kw.pop("key", "1")),
    }
    body.update(kw)
    return c.post("/api/pos/checkout", json=body)


def _stock(c, item):
    return c.get(f"/api/inventory/{item}").json()["quantity"]


# ── The refusal is still the default ─────────────────────────────────────────

def test_without_asking_for_it_a_short_sale_is_still_refused(till, buyer):
    """Nothing changes for a cashier who has not been told to promise stock."""
    item = _item(till, "Ink Tube", 2)

    r = _sell(till, item, 5, buyer)

    assert r.status_code == 400
    assert "Insufficient stock" in r.json()["detail"]
    assert _stock(till, item) == 2


def test_a_promise_needs_somebody_to_make_it_to(till):
    """A walk-in leaves an obligation nobody can discharge — the same rule the
    instalment path already enforces, for the same reason."""
    item = _item(till, "Ink Tube", 2)

    r = _sell(till, item, 5, None, allow_backorder=True)

    assert r.status_code == 400
    assert "customer" in r.json()["detail"].lower()


# ── The sale itself ─────────────────────────────────────────────────────────

def test_the_shelf_empties_and_never_goes_below_zero(till, buyer):
    item = _item(till, "Ink Tube", 2)

    r = _sell(till, item, 5, buyer, allow_backorder=True)

    assert r.status_code == 200, r.text
    assert _stock(till, item) == 0, "the two on the shelf left; nothing more"


def test_only_the_shortfall_is_promised(till, buyer):
    item = _item(till, "Ink Tube", 2)

    body = _sell(till, item, 5, buyer, allow_backorder=True).json()

    assert [c["quantity"] for c in body["commitments"]] == [3]
    assert body["total"] == pytest.approx(50)


def test_the_whole_order_can_be_promised(till, buyer):
    """Nothing on the shelf at all is the ordinary case, not a special one."""
    item = _item(till, "Ink Tube", 0)

    body = _sell(till, item, 4, buyer, allow_backorder=True).json()

    assert [c["quantity"] for c in body["commitments"]] == [4]
    assert _stock(till, item) == 0


def test_a_sale_with_enough_stock_promises_nothing(till, buyer):
    """The flag is permission to fall back, not an instruction to."""
    item = _item(till, "Ink Tube", 9)

    body = _sell(till, item, 4, buyer, allow_backorder=True).json()

    assert body["commitments"] == []
    assert body["deferred_total"] == 0
    assert _stock(till, item) == 5


# ── The money ───────────────────────────────────────────────────────────────

def _balance(c, code):
    """Debit less credit, from the trial balance — so a credit balance like
    deferred revenue reads negative and the direction is part of the claim."""
    body = c.get("/api/accounting/trial-balance").json()
    rows = body.get("rows") if isinstance(body, dict) else body
    for r in rows or []:
        if str(r.get("code")) == code:
            return round(float(r.get("debit") or 0) - float(r.get("credit") or 0), 2)
    return 0.0


def test_the_undelivered_part_is_a_liability_not_revenue(till, buyer):
    """Two of five delivered: two fifths earned, three fifths owed.

    Recognised in full it would show revenue for goods the customer has not
    got, with no cost against it — a hundred per cent margin at the till and a
    cost with no sale weeks later.
    """
    item = _item(till, "Ink Tube", 2)
    before_rev = _balance(till, "4000")
    before_def = _balance(till, "2400")

    _sell(till, item, 5, buyer, allow_backorder=True)

    # Both are credit balances, so the movement is negative.
    assert before_rev - _balance(till, "4000") == pytest.approx(20, abs=0.01)
    assert before_def - _balance(till, "2400") == pytest.approx(30, abs=0.01)


def test_the_till_still_took_all_of_it(till, buyer):
    item = _item(till, "Ink Tube", 2)
    before = _balance(till, "1000")

    _sell(till, item, 5, buyer, allow_backorder=True)

    assert _balance(till, "1000") - before == pytest.approx(50, abs=0.01)


def test_cost_is_recognised_only_for_what_left(till, buyer):
    """COGS follows the goods, not the money."""
    item = _item(till, "Ink Tube", 2, cost=4.0)

    body = _sell(till, item, 5, buyer, allow_backorder=True).json()

    assert body["cogs_total"] == pytest.approx(8), "two units at 4, not five"


# ── The promise is recorded ─────────────────────────────────────────────────

def test_the_promise_says_who_what_and_at_what_price(till, buyer, db):
    item = _item(till, "Ink Tube", 2)
    _sell(till, item, 5, buyer, allow_backorder=True)

    row = db.execute("SELECT * FROM sale_commitments").fetchone()

    assert row["client_id"] == buyer
    assert row["inventory_id"] == item
    assert row["quantity_ordered"] == pytest.approx(3)
    assert row["unit_price"] == pytest.approx(10)
    assert row["status"] == "awaiting"
    assert row["approved_by"] is not None, "who authorised it is part of the record"


def test_the_item_reports_what_it_owes_without_pretending_to_have_it(till, buyer, db):
    item = _item(till, "Ink Tube", 2)
    _sell(till, item, 5, buyer, allow_backorder=True)

    assert commitments.owed(db, item) == pytest.approx(3)
    # Availability is untouched: those three were never in the count, so
    # subtracting them would count the shortfall twice.
    assert reservations.available(db, item) == pytest.approx(0)


# ── What cannot be combined ─────────────────────────────────────────────────

def test_an_instalment_plan_and_a_promise_do_not_mix(till, buyer):
    """Two independent reasons to hold revenue back on one invoice. Each is
    understood alone; together they need a rule for which clears first."""
    till.put("/api/clients/%d" % buyer, json={"allow_installments": 1})
    item = _item(till, "Ink Tube", 1)

    r = _sell(till, item, 5, buyer, allow_backorder=True,
              installment_plan={"down_payment": 10, "count": 3})

    assert r.status_code == 400
    assert "instalment" in r.json()["detail"].lower()


# ── VAT ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def vat_rate(till):
    # Tax is off by default; a business that does not charge VAT is a real
    # configuration and the rest of this file runs in it.
    till.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11.0"})
    rows = till.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    r = next((x for x in rows if float(x.get("rate") or 0) == 11.0), None)
    assert r, "the 11% rate should be seeded"
    return r["id"]


def test_the_till_stops_calling_vat_turnover(till, buyer, vat_rate):
    """A pre-existing hole, found on the way through and closed here.

    Every other posting site carves the tax out and credits the control
    account. The till credited the WHOLE gross to revenue — so turnover was
    overstated by the tax rate on every sale and the liability was missing
    from the balance sheet. The VAT return was never affected: it is computed
    from the invoice records, not the ledger.
    """
    item = _item(till, "Ink Tube", 10)
    rev_before = _balance(till, "4000")
    vat_before = _balance(till, "2100")

    till.post("/api/pos/checkout", json={
        "client_id": buyer,
        "items": [{"name": "Ink Tube", "inventory_id": item, "quantity": 1,
                   "unit_price": 111, "tax_rate_id": vat_rate}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 111,
        "idempotency_key": "vat-till-1"})

    # POS prices are VAT-inclusive: 111 gross is 100 of goods and 11 of tax.
    assert rev_before - _balance(till, "4000") == pytest.approx(100, abs=0.02)
    assert vat_before - _balance(till, "2100") == pytest.approx(11, abs=0.02)


def test_tax_on_goods_to_follow_is_still_owed_today(till, buyer, vat_rate):
    """The invoice was issued and the money was taken, which is what makes the
    tax due. Only the revenue waits for the goods."""
    item = _item(till, "Ink Tube", 0)
    vat_before = _balance(till, "2100")
    def_before = _balance(till, "2400")

    till.post("/api/pos/checkout", json={
        "client_id": buyer, "allow_backorder": True,
        "items": [{"name": "Ink Tube", "inventory_id": item, "quantity": 1,
                   "unit_price": 111, "tax_rate_id": vat_rate}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 111,
        "idempotency_key": "vat-till-2"})

    assert vat_before - _balance(till, "2100") == pytest.approx(11, abs=0.02)
    assert def_before - _balance(till, "2400") == pytest.approx(100, abs=0.02)


# ── The goods arrive ────────────────────────────────────────────────────────

def _receive(c, item, qty, cost=4.0):
    """Buy the missing stock in, the ordinary way."""
    r = c.post("/api/purchases/", json={
        "supplier": "Acme Supply", "inventory_id": item, "product_name": "Ink Tube",
        "quantity": qty, "unit_cost": cost, "status": "Received"})
    assert r.status_code == 200, r.text
    return r.json()


def test_arriving_stock_goes_to_whoever_paid_for_it(till, buyer, db):
    """Without this the next walk-in buys what somebody already owns."""
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer, allow_backorder=True)

    _receive(till, item, 5)

    # Three are now spoken for; two are free for anybody.
    assert reservations.held_for(db, item, buyer) == pytest.approx(3)
    assert reservations.available(db, item) == pytest.approx(2)
    assert _stock(till, item) == pytest.approx(5)


def test_a_walk_in_cannot_buy_what_is_waiting_to_be_collected(till, buyer):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer, allow_backorder=True)
    _receive(till, item, 3)

    # Every unit is somebody's. Another customer gets the ordinary refusal.
    other = till.post("/api/clients/", json={"name": "Someone Else"}).json()["id"]
    r = _sell(till, item, 1, other, key="walkin")

    assert r.status_code == 400
    assert "Insufficient stock" in r.json()["detail"]


def test_a_part_delivery_leaves_the_rest_owed(till, buyer, db):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 5, buyer, allow_backorder=True)

    _receive(till, item, 2)

    row = db.execute("SELECT * FROM sale_commitments").fetchone()
    assert row["quantity_allocated"] == pytest.approx(2)
    assert row["status"] == "awaiting", "three are still owed"
    assert commitments.owed(db, item) == pytest.approx(5), "nothing handed over yet"


def test_the_oldest_promise_is_met_first(till, db):
    """The rule a customer expects, and the only one that needs no explaining."""
    item = _item(till, "Ink Tube", 0)
    first = till.post("/api/clients/", json={"name": "First In"}).json()["id"]
    second = till.post("/api/clients/", json={"name": "Second In"}).json()["id"]
    _sell(till, item, 2, first, allow_backorder=True, key="a")
    _sell(till, item, 2, second, allow_backorder=True, key="b")

    _receive(till, item, 3)      # not enough for both

    assert reservations.held_for(db, item, first) == pytest.approx(2)
    assert reservations.held_for(db, item, second) == pytest.approx(1)


def test_two_promises_from_one_customer_do_not_share_an_allocation(till, buyer, db):
    """The trap: reading the customer's holds instead of the row would let the
    second commitment see the first one's stock as already its own."""
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 2, buyer, allow_backorder=True, key="one")
    _sell(till, item, 2, buyer, allow_backorder=True, key="two")

    _receive(till, item, 4)

    rows = db.execute("SELECT quantity_allocated FROM sale_commitments "
                      "ORDER BY id").fetchall()
    assert [r["quantity_allocated"] for r in rows] == [pytest.approx(2),
                                                       pytest.approx(2)]

