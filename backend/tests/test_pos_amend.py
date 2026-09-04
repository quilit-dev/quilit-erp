"""
Correcting a till sale that is already complete.

An amendment is not an edit. The sale is taken back off the books in full —
goods, money, ledger, promises — and the corrected one is rung in the same
transaction, reusing the reversal that returns already rely on and the checkout
that sales already rely on. These tests exist to prove that composition holds:
that nothing is undone twice, nothing is left behind, and that the four records
a sale touches still agree afterwards.

The one thing the composition does NOT give for free is the drawer. A void is
counted as cash refunded against the session that rang the sale up, so an
amendment that recorded the full new total as tender would inflate both
sessions by the original amount. Only the difference crosses the counter, and
that is asserted here directly.
"""
import uuid

import pytest


def _key():
    return str(uuid.uuid4())


def _open(c, opening_float=0):
    r = c.post("/api/pos/session/open", json={"opening_float": opening_float})
    assert r.status_code in (200, 409), r.text
    return r


def _item(c, name="Widget", qty=50, cost=4, sale_price=10):
    r = c.post("/api/inventory/", json={"name": name, "quantity": qty,
                                        "unit_cost": cost, "sale_price": sale_price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _qty(c, item_id):
    return float(c.get(f"/api/inventory/{item_id}").json()["quantity"])


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 4)
    return 0.0


def _sell(c, lines, tendered=None, **extra):
    total = sum(l["quantity"] * l["unit_price"] for l in lines)
    body = {"items": lines, "payment_method": "Cash",
            "amount_tendered": total if tendered is None else tendered,
            "idempotency_key": _key(), **extra}
    r = c.post("/api/pos/checkout", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _amend(c, sale_id, lines, tendered=0, **extra):
    body = {"items": lines, "payment_method": "Cash",
            "amount_tendered": tendered, "idempotency_key": _key(), **extra}
    return c.post(f"/api/pos/sales/{sale_id}/amend", json=body)


def _line(item_id, qty, price, name="Widget"):
    return {"name": name, "inventory_id": item_id,
            "quantity": qty, "unit_price": price}


# ── The correction itself ─────────────────────────────────────────────────
def test_a_mistyped_price_is_corrected(make_client):
    """The headline case: the cashier keyed 5 instead of 50."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c)
    sale = _sell(c, [_line(item, 2, 5)])
    assert sale["total"] == pytest.approx(10)

    r = _amend(c, sale["id"], [_line(item, 2, 50)], tendered=90)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == pytest.approx(100)
    assert body["previous_total"] == pytest.approx(10)
    assert body["difference"] == pytest.approx(90)
    assert body["collect"] == pytest.approx(90)
    assert body["refund"] == pytest.approx(0)


def test_an_item_can_be_added(make_client):
    """The reason this was asked for: a line missed at the till."""
    c = make_client("superadmin")
    _open(c)
    a, b = _item(c, "A"), _item(c, "B")
    sale = _sell(c, [_line(a, 1, 10, "A")])

    r = _amend(c, sale["id"], [_line(a, 1, 10, "A"), _line(b, 2, 5, "B")],
               tendered=10)
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(20)
    assert _qty(c, b) == pytest.approx(48)


def test_an_item_can_be_removed_and_its_stock_comes_back(make_client):
    c = make_client("superadmin")
    _open(c)
    a, b = _item(c, "A"), _item(c, "B")
    _sell(c, [_line(a, 1, 10, "A"), _line(b, 3, 5, "B")])
    sale_id = c.get("/api/pos/sales").json()[0]["id"]
    assert _qty(c, b) == pytest.approx(47)

    r = _amend(c, sale_id, [_line(a, 1, 10, "A")])
    assert r.status_code == 200, r.text
    # The three units of B were never really sold.
    assert _qty(c, b) == pytest.approx(50)
    assert _qty(c, a) == pytest.approx(49)
    assert r.json()["refund"] == pytest.approx(15)


def test_stock_lands_where_it_should_when_the_quantity_changes(make_client):
    """Two down to one: the shelf must show exactly one sold, not two, not none."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 2, 10)])
    assert _qty(c, item) == pytest.approx(48)

    assert _amend(c, sale["id"], [_line(item, 1, 10)]).status_code == 200
    assert _qty(c, item) == pytest.approx(49)


def test_the_goods_are_not_restocked_twice(make_client):
    """The reversal and the re-ring compose; they must not both act on stock."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 4, 10)])
    assert _amend(c, sale["id"], [_line(item, 4, 10)]).status_code == 200
    # Identical cart: the shelf is exactly where it was after the first sale.
    assert _qty(c, item) == pytest.approx(46)


# ── The ledger ────────────────────────────────────────────────────────────
def test_the_ledger_moves_by_the_difference_only(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50, cost=4)
    sale = _sell(c, [_line(item, 2, 5)])
    cash_before, rev_before = _gl(c, "1000"), _gl(c, "4000")

    assert _amend(c, sale["id"], [_line(item, 2, 50)],
                  tendered=90).status_code == 200
    assert _gl(c, "1000") - cash_before == pytest.approx(90, abs=1e-4)
    assert _gl(c, "4000") - rev_before == pytest.approx(-90, abs=1e-4)


def test_cogs_and_inventory_follow_a_quantity_change(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50, cost=4)
    sale = _sell(c, [_line(item, 5, 10)])
    cogs_before, inv_before = _gl(c, "5000"), _gl(c, "1200")

    assert _amend(c, sale["id"], [_line(item, 3, 10)]).status_code == 200
    # Two units' worth of cost comes back out of COGS and into Inventory.
    assert _gl(c, "5000") - cogs_before == pytest.approx(-8, abs=1e-4)
    assert _gl(c, "1200") - inv_before == pytest.approx(8, abs=1e-4)


def test_a_correction_that_changes_nothing_leaves_the_books_where_they_were(make_client):
    """The strongest statement of the composition: unwind + re-ring is a no-op."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50, cost=4)
    sale = _sell(c, [_line(item, 3, 10)])
    before = {code: _gl(c, code) for code in ("1000", "4000", "5000", "1200")}

    assert _amend(c, sale["id"], [_line(item, 3, 10)]).status_code == 200
    for code, was in before.items():
        assert _gl(c, code) == pytest.approx(was, abs=1e-4), code


# ── The drawer ────────────────────────────────────────────────────────────
def test_only_the_difference_counts_as_cash_taken(make_client):
    """The session close reads `amount_tendered - change_given` as cash in, and
    counts a voided sale as cash back out. Recording the full new total would
    make the drawer expect the original amount twice over."""
    c = make_client("superadmin")
    _open(c, opening_float=100)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 2, 5)])          # $10 in the drawer
    r = _amend(c, sale["id"], [_line(item, 2, 50)], tendered=90)
    assert r.status_code == 200, r.text

    close = c.post("/api/pos/session/close", json={"closing_count": 200}).json()
    # 100 float + 10 + 90 collected = 200, and nothing counted twice.
    assert close["expected_cash"] == pytest.approx(200)
    assert close["variance"] == pytest.approx(0)


def test_money_comes_back_out_of_the_drawer_when_the_sale_shrinks(make_client):
    c = make_client("superadmin")
    _open(c, opening_float=100)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 4, 10)])          # $40 in
    assert _amend(c, sale["id"], [_line(item, 1, 10)]).status_code == 200

    close = c.post("/api/pos/session/close", json={"closing_count": 110}).json()
    assert close["expected_cash"] == pytest.approx(110)
    assert close["variance"] == pytest.approx(0)


def test_a_correction_in_a_later_session_leaves_the_first_drawer_square(make_client):
    """The original session physically took the money and never gave it back."""
    c = make_client("superadmin")
    _open(c, opening_float=100)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 2, 10)])          # $20 into session 1
    first = c.post("/api/pos/session/close", json={"closing_count": 120}).json()
    assert first["variance"] == pytest.approx(0)

    _open(c, opening_float=50)
    assert _amend(c, sale["id"], [_line(item, 3, 10)], tendered=10).status_code == 200
    second = c.post("/api/pos/session/close", json={"closing_count": 60}).json()
    assert second["expected_cash"] == pytest.approx(60)
    assert second["variance"] == pytest.approx(0)


def test_change_is_given_when_more_than_the_difference_is_tendered(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 2, 5)])
    r = _amend(c, sale["id"], [_line(item, 2, 50)], tendered=100)
    assert r.status_code == 200, r.text
    assert r.json()["change_given"] == pytest.approx(10)


def test_less_than_the_difference_is_refused(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 2, 5)])
    r = _amend(c, sale["id"], [_line(item, 2, 50)], tendered=10)
    assert r.status_code == 400
    assert "still to collect" in r.json()["detail"]


# ── The invoice the customer is holding ───────────────────────────────────
def test_the_corrected_sale_keeps_the_customer_s_number(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    was = sale["invoice_number"]

    r = _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10)
    assert r.status_code == 200, r.text
    assert r.json()["invoice_number"] == was
    assert r.json()["previous_number"] == was + "-V1"


def test_the_superseded_invoice_is_voided_and_stamped(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    assert _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10).status_code == 200

    old = c.get(f"/api/invoices/{sale['invoice_id']}").json()
    assert old["voided_at"]
    assert old["invoice_number"].endswith("-V1")


def test_correcting_twice_numbers_each_revision(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    first = _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10)
    assert first.status_code == 200, first.text
    second = _amend(c, first.json()["id"], [_line(item, 1, 30)], tendered=10)
    assert second.status_code == 200, second.text
    assert second.json()["previous_number"].endswith("-V2")
    # And the live invoice still carries the number the customer was given.
    assert second.json()["invoice_number"] == sale["invoice_number"]


# ── How it reads afterwards ───────────────────────────────────────────────
def test_the_replaced_sale_is_shown_as_superseded_not_paid(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    assert _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10).status_code == 200

    rows = {r["id"]: r for r in c.get("/api/pos/sales").json()}
    assert rows[sale["id"]]["payment_status"] == "Superseded"


def test_the_two_sales_point_at_each_other(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    new_id = _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10).json()["id"]

    old = c.get(f"/api/pos/sales/{sale['id']}").json()
    new = c.get(f"/api/pos/sales/{new_id}").json()
    assert old["amended_by"]["id"] == new_id
    assert new["amended_from"] == sale["id"]
    assert new["amended_from_sale"]["id"] == sale["id"]


# ── What it refuses ───────────────────────────────────────────────────────
def test_a_returned_sale_cannot_be_corrected(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    assert c.post(f"/api/pos/sales/{sale['id']}/return",
                  json={"reason": "x"}).status_code == 200

    r = _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10)
    assert r.status_code == 400
    assert "returned" in r.json()["detail"].lower()


def test_a_superseded_sale_cannot_be_corrected_again(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    assert _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10).status_code == 200

    r = _amend(c, sale["id"], [_line(item, 1, 30)], tendered=10)
    assert r.status_code == 400
    assert "already been corrected" in r.json()["detail"]


def test_a_correction_needs_an_open_register(make_client):
    """Money moves, so a drawer has to be open to move it out of."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    c.post("/api/pos/session/close", json={"closing_count": 10})

    r = _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10)
    assert r.status_code == 409


def test_a_voided_invoice_has_nothing_to_correct(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "x"}).status_code == 200

    r = _amend(c, sale["id"], [_line(item, 1, 20)], tendered=10)
    assert r.status_code == 400


def test_a_correction_cannot_switch_the_currency_it_settles_in(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])

    r = _amend(c, sale["id"], [_line(item, 1, 20)], tendered=2_000_000,
               currency="LBP", exchange_rate=90_000)
    assert r.status_code == 400
    assert "same currency" in r.json()["detail"]


def test_a_missing_sale_is_a_404(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    assert _amend(c, 999_999, [_line(item, 1, 10)]).status_code == 404


def test_an_empty_cart_is_refused(make_client):
    """A correction that removes everything is a return, and says so."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])
    r = _amend(c, sale["id"], [])
    assert r.status_code == 400


def test_a_correction_cannot_oversell(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=5)
    sale = _sell(c, [_line(item, 2, 10)])
    r = _amend(c, sale["id"], [_line(item, 40, 10)], tendered=400)
    assert r.status_code == 400
    assert "Insufficient stock" in r.json()["detail"]


def test_a_refused_correction_leaves_the_original_standing(make_client):
    """The unwind and the re-ring share one transaction, so a rejection in the
    second half must not leave the sale half-undone."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=5)
    sale = _sell(c, [_line(item, 2, 10)])
    assert _amend(c, sale["id"], [_line(item, 40, 10)],
                  tendered=400).status_code == 400

    assert _qty(c, item) == pytest.approx(3)
    still = c.get(f"/api/pos/sales/{sale['id']}").json()
    assert still["status"] == "completed"
    assert not c.get(f"/api/invoices/{sale['invoice_id']}").json()["voided_at"]


def test_viewer_cannot_correct_a_sale(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])

    v = make_client("Viewer")
    r = v.post(f"/api/pos/sales/{sale['id']}/amend",
               json={"items": [_line(item, 1, 20)], "payment_method": "Cash",
                     "amount_tendered": 10, "idempotency_key": _key()})
    assert r.status_code == 403


def test_a_sale_at_another_branch_cannot_be_corrected(make_client, db):
    """A filtered list proves nothing on its own. Every by-id endpoint has to
    carry the branch guard itself, or knowing an id is enough to reach across
    branches — and this one moves money."""
    import datetime as _dt
    # Arrange the branch first: SQLite gives one writer, and reaching for the
    # fixture connection while a request is in flight simply deadlocks.
    now = _dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    db.execute("INSERT INTO warehouses (code, name, type, is_active, is_default, "
               "created_at) VALUES ('BR9','Branch Nine','Branch',1,0,?)", (now,))
    other = db.execute("SELECT id FROM warehouses WHERE code='BR9'").fetchone()["id"]
    db.execute("UPDATE users SET branch_id=? WHERE role='Manager'", (other,))
    db.commit()

    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    sale = _sell(c, [_line(item, 1, 10)])

    mgr = make_client("Manager")
    r = mgr.post(f"/api/pos/sales/{sale['id']}/amend",
                 json={"items": [_line(item, 1, 20)], "payment_method": "Cash",
                       "amount_tendered": 10, "idempotency_key": _key()})
    # 404, not 403 — a scoped user must not be able to probe which ids exist.
    assert r.status_code == 404, r.text
    # And nothing was touched on the way to refusing.
    assert c.get(f"/api/pos/sales/{sale['id']}").json()["status"] == "completed"


# ── Sales that are more than a till sale ──────────────────────────────────
def test_a_sale_paid_down_since_is_refused(make_client):
    """An instalment plan with a payment against it: unwinding would reverse
    money the customer handed over on a later day."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    cl = c.post("/api/clients/", json={"name": "Buyer", "allow_installments": 1})
    assert cl.status_code in (200, 201), cl.text
    client_id = cl.json()["id"]
    sale = _sell(c, [_line(item, 4, 100)], tendered=100, client_id=client_id,
                 installment_plan={"down_payment": 100, "count": 3})
    assert c.post(f"/api/invoices/{sale['invoice_id']}/payments",
                  json={"amount": 50, "method": "Cash",
                        "idempotency_key": _key()}).status_code in (200, 201)

    r = _amend(c, sale["id"], [_line(item, 4, 120)], tendered=80,
               client_id=client_id,
               installment_plan={"down_payment": 100, "count": 3})
    assert r.status_code == 400
    assert "paid down" in r.json()["detail"]


def test_an_instalment_sale_with_only_its_deposit_can_be_corrected(make_client):
    """Nothing has been paid since the till, so there is nothing to unpick."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    cl = c.post("/api/clients/", json={"name": "Buyer2", "allow_installments": 1})
    client_id = cl.json()["id"]
    sale = _sell(c, [_line(item, 4, 100)], tendered=100, client_id=client_id,
                 installment_plan={"down_payment": 100, "count": 3})

    r = _amend(c, sale["id"], [_line(item, 4, 120)], tendered=0,
               client_id=client_id,
               installment_plan={"down_payment": 100, "count": 3})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(480)
    assert len(r.json()["installments"]) == 4      # the deposit plus three


def test_the_old_plan_does_not_survive_the_correction(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=50)
    cl = c.post("/api/clients/", json={"name": "Buyer3", "allow_installments": 1})
    client_id = cl.json()["id"]
    sale = _sell(c, [_line(item, 2, 100)], tendered=50, client_id=client_id,
                 installment_plan={"down_payment": 50, "count": 4})
    assert len(sale["installments"]) == 5          # the deposit plus four

    # Dropping the plan means the balance falls due at the till: the $50
    # deposit already in the drawer counts, so $150 is collected now.
    new = _amend(c, sale["id"], [_line(item, 2, 100)], tendered=150,
                 client_id=client_id)
    assert new.status_code == 200, new.text
    # Paid in full now, no plan at all — and the old schedule went with the
    # invoice it belonged to.
    assert new.json()["installments"] == []
    assert c.get(f"/api/invoices/{sale['invoice_id']}").json()["voided_at"]


def test_goods_already_handed_over_are_refused(make_client):
    """A back-order that has been partly collected cannot be re-rung: the
    re-ring cannot know the customer already has them."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=2)
    cl = c.post("/api/clients/", json={"name": "Waiting"})
    client_id = cl.json()["id"]
    sale = _sell(c, [_line(item, 5, 10)], tendered=50, client_id=client_id,
                 allow_backorder=True)
    assert sale["commitments"], sale
    # Restock and hand the promised units over.
    assert c.patch(f"/api/inventory/{item}/stock",
                   json={"delta": 10, "note": "restock"}).status_code in (200, 201)
    a = c.post(f"/api/commitments/allocate/{item}")
    assert a.status_code in (200, 201), a.text
    cid = sale["commitments"][0]["id"]
    d = c.post(f"/api/commitments/{cid}/deliver", json={"quantity": 3})
    assert d.status_code in (200, 201), d.text

    r = _amend(c, sale["id"], [_line(item, 5, 12)], tendered=10,
               client_id=client_id, allow_backorder=True)
    assert r.status_code == 400
    assert "handed over" in r.json()["detail"]


def test_an_uncollected_back_order_can_still_be_corrected(make_client):
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=2)
    cl = c.post("/api/clients/", json={"name": "Waiting2"})
    client_id = cl.json()["id"]
    sale = _sell(c, [_line(item, 5, 10)], tendered=50, client_id=client_id,
                 allow_backorder=True)

    r = _amend(c, sale["id"], [_line(item, 5, 12)], tendered=10,
               client_id=client_id, allow_backorder=True)
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(60)
    # Exactly one open promise for the three that are still not there.
    listing = c.get("/api/commitments/")      # defaults to the open ones
    assert listing.status_code == 200, listing.text
    open_rows = [x for x in listing.json()
                 if x["invoice_id"] == r.json()["invoice_id"]]
    assert sum(float(x["quantity_ordered"]) for x in open_rows) == pytest.approx(3)


# ── An ordinary checkout is untouched by the split ────────────────────────
def test_a_plain_sale_still_behaves_exactly_as_before(make_client):
    """`checkout` was split into an endpoint and `_ring_sale`; this is the
    guard that the split changed nothing for the path everybody uses."""
    c = make_client("superadmin")
    _open(c)
    item = _item(c, qty=20, cost=5)
    body = _sell(c, [_line(item, 3, 5)], tendered=20)
    assert body["total"] == pytest.approx(15)
    assert body["change_given"] == pytest.approx(5)
    assert body["due_at_till"] == pytest.approx(15)
    assert body["payment_status"] == "Paid"
    assert _qty(c, item) == pytest.approx(17)
