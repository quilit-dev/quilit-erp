"""Meeting the promise, and giving up on it.

The sale and the allocation are covered in test_backorder.py. This is what
happens afterwards: the customer comes in for goods they paid for weeks ago,
or the supplier says the item is discontinued and the money has to go back.

The money is the point. It has been sitting in deferred revenue since the till
— never income, always owed — and there are only two ways out of that account:
the goods are handed over, or the cash is.
"""
import pytest

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


def _sell(c, item, qty, client_id, key="1"):
    return c.post("/api/pos/checkout", json={
        "client_id": client_id, "allow_backorder": True,
        "items": [{"name": "x", "inventory_id": item, "quantity": qty,
                   "unit_price": 10}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": qty * 10,
        "idempotency_key": f"bod-{item}-{qty}-{key}"})


def _receive(c, item, qty, cost=4.0):
    r = c.post("/api/purchases/", json={
        "supplier": "Acme Supply", "inventory_id": item,
        "product_name": "Ink Tube", "quantity": qty, "unit_cost": cost,
        "status": "Received"})
    assert r.status_code == 200, r.text


def _stock(c, item):
    return c.get(f"/api/inventory/{item}").json()["quantity"]


def _balance(c, code):
    body = c.get("/api/accounting/trial-balance").json()
    rows = body.get("rows") if isinstance(body, dict) else body
    for r in rows or []:
        if str(r.get("code")) == code:
            return round(float(r.get("debit") or 0) - float(r.get("credit") or 0), 2)
    return 0.0


def _open(c):
    return c.get("/api/commitments/").json()


# ── Handing it over ─────────────────────────────────────────────────────────

def test_the_customer_collects_and_the_money_is_finally_earned(till, buyer):
    """The point of having waited: revenue and its cost land together."""
    item = _item(till, "Ink Tube", 0, cost=4.0)
    _sell(till, item, 3, buyer)
    _receive(till, item, 3, cost=4.0)
    cid = _open(till)[0]["id"]

    rev_before = _balance(till, "4000")
    def_before = _balance(till, "2400")
    cogs_before = _balance(till, "5000")

    r = till.post(f"/api/commitments/{cid}/deliver", json={})

    assert r.status_code == 200, r.text
    assert rev_before - _balance(till, "4000") == pytest.approx(30, abs=0.02)
    assert _balance(till, "2400") - def_before == pytest.approx(30, abs=0.02)
    assert _balance(till, "5000") - cogs_before == pytest.approx(12, abs=0.02)


def test_collecting_takes_the_goods_off_the_shelf(till, buyer, db):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer)
    _receive(till, item, 3)
    cid = _open(till)[0]["id"]

    till.post(f"/api/commitments/{cid}/deliver", json={})

    assert _stock(till, item) == pytest.approx(0)
    assert reservations.held_for(db, item, buyer) == pytest.approx(0)


def test_the_promise_closes_when_it_is_met(till, buyer, db):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer)
    _receive(till, item, 3)
    cid = _open(till)[0]["id"]

    till.post(f"/api/commitments/{cid}/deliver", json={})

    row = db.execute("SELECT status FROM sale_commitments WHERE id=?",
                     (cid,)).fetchone()
    assert row["status"] == "fulfilled"
    assert _open(till) == []


def test_nothing_can_be_handed_over_before_it_arrives(till, buyer):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer)
    cid = _open(till)[0]["id"]

    r = till.post(f"/api/commitments/{cid}/deliver", json={})

    assert r.status_code == 400
    assert "still to come" in r.json()["detail"]


def test_a_commitment_can_be_met_in_two_visits(till, buyer, db):
    """Two of three on Tuesday, the last on Friday."""
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer)
    _receive(till, item, 2)
    cid = _open(till)[0]["id"]

    first = till.post(f"/api/commitments/{cid}/deliver", json={})
    assert first.status_code == 200, first.text
    assert first.json()["outstanding"] == pytest.approx(1)

    _receive(till, item, 1)
    second = till.post(f"/api/commitments/{cid}/deliver", json={})

    assert second.status_code == 200, second.text
    assert second.json()["outstanding"] == pytest.approx(0)
    rows = db.execute("SELECT quantity FROM commitment_deliveries "
                      "WHERE commitment_id=? ORDER BY id", (cid,)).fetchall()
    assert [r["quantity"] for r in rows] == [pytest.approx(2), pytest.approx(1)]


def test_the_second_delivery_is_not_mistaken_for_the_first(till, buyer):
    """Each posting is keyed on the DELIVERY, not the commitment.

    Keyed on the commitment, the second entry would look like a re-run of the
    first and be dropped: the goods would leave and the revenue would never be
    earned.
    """
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer)
    _receive(till, item, 2)
    cid = _open(till)[0]["id"]
    till.post(f"/api/commitments/{cid}/deliver", json={})
    _receive(till, item, 1)

    rev_before = _balance(till, "4000")
    till.post(f"/api/commitments/{cid}/deliver", json={})

    assert rev_before - _balance(till, "4000") == pytest.approx(10, abs=0.02)


def test_the_price_is_the_one_they_paid(till, buyer):
    """Whatever the price does between the sale and the goods arriving."""
    item = _item(till, "Ink Tube", 0, price=10.0)
    _sell(till, item, 2, buyer)
    till.put(f"/api/inventory/{item}", json={"sale_price": 99})
    _receive(till, item, 2)
    cid = _open(till)[0]["id"]

    rev_before = _balance(till, "4000")
    till.post(f"/api/commitments/{cid}/deliver", json={})

    assert rev_before - _balance(till, "4000") == pytest.approx(20, abs=0.02)


# ── Giving up on it ─────────────────────────────────────────────────────────

def test_cancelling_hands_the_money_back(till, buyer):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer)
    cid = _open(till)[0]["id"]

    def_before = _balance(till, "2400")
    cash_before = _balance(till, "1000")
    r = till.post(f"/api/commitments/{cid}/cancel",
                  json={"reason": "supplier cannot get it"})

    assert r.status_code == 200, r.text
    # The liability clears and the cash goes out. It was never income.
    assert _balance(till, "2400") - def_before == pytest.approx(30, abs=0.02)
    assert cash_before - _balance(till, "1000") == pytest.approx(30, abs=0.02)


def test_cancelling_gives_allocated_stock_back_to_the_shelf(till, buyer, db):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 3, buyer)
    _receive(till, item, 3)
    cid = _open(till)[0]["id"]

    r = till.post(f"/api/commitments/{cid}/cancel", json={"reason": "changed mind"})

    assert r.json()["released_to_stock"] == pytest.approx(3)
    assert reservations.available(db, item) == pytest.approx(3), "free for anybody"
    assert _stock(till, item) == pytest.approx(3), "still physically here"


def test_a_cancelled_hold_says_released_not_collected(till, buyer, db):
    """Nobody collected anything. A row that says otherwise misreports the day."""
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 2, buyer)
    _receive(till, item, 2)
    cid = _open(till)[0]["id"]

    till.post(f"/api/commitments/{cid}/cancel", json={})

    statuses = [r["status"] for r in db.execute(
        "SELECT status FROM stock_reservations").fetchall()]
    assert "released" in statuses
    assert "collected" not in statuses


def test_a_cancelled_promise_cannot_then_be_delivered(till, buyer):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 2, buyer)
    cid = _open(till)[0]["id"]
    till.post(f"/api/commitments/{cid}/cancel", json={})

    r = till.post(f"/api/commitments/{cid}/deliver", json={})

    assert r.status_code == 409


def test_refund_can_be_withheld_when_it_stays_on_account(till, buyer):
    """A shop that has already banked the money often leaves it as credit."""
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 2, buyer)
    cid = _open(till)[0]["id"]
    cash_before = _balance(till, "1000")

    r = till.post(f"/api/commitments/{cid}/cancel", json={"refund": False})

    assert r.json()["refunded"] == 0
    assert _balance(till, "1000") == pytest.approx(cash_before, abs=0.01)


# ── The list the salesperson works from ─────────────────────────────────────

def test_the_list_says_who_is_waiting_and_what_is_ready(till, buyer):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 5, buyer)
    _receive(till, item, 2)

    row = _open(till)[0]

    assert row["client_name"] == "Bakery Co"
    assert row["item_name"] == "Ink Tube"
    assert row["outstanding"] == pytest.approx(5)
    assert row["ready"] == pytest.approx(2), "come and collect two of them"
    assert row["sold_by"], "somebody has to be able to ask who sold it"


def test_the_badge_counts_what_needs_acting_on(till, buyer):
    item = _item(till, "Ink Tube", 0)
    _sell(till, item, 2, buyer, key="p")
    other = _item(till, "Toner", 0)
    _sell(till, other, 1, buyer, key="q")
    _receive(till, item, 2)

    body = till.get("/api/commitments/count").json()

    assert body["open"] == 2
    assert body["ready"] == 1
