"""Holding stock for someone, and the promise actually meaning something.

A reservation that does not stop the next sale is a note in a drawer. The
system has had `inventory.reserved_quantity` since manufacturing needed it, but
nothing outside manufacturing consulted it — so material committed to a
confirmed production order could still be sold over the counter, and the
factory found out when it went to build.

These tests cover both halves: that reserved stock is genuinely unavailable to
everyone else, and that a reservation knows WHO it is for, which a bare total
never could.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def cashier(client):
    client.post("/api/pos/session/open", json={"opening_float": 0})
    return client


@_pytest.fixture
def buyer(client):
    return client.post("/api/clients/", json={"name": "Reserving Buyer"}).json()["id"]


@_pytest.fixture
def other_buyer(client):
    return client.post("/api/clients/", json={"name": "Someone Else"}).json()["id"]


@_pytest.fixture
def widget(client):
    return client.post("/api/inventory/", json={
        "name": "Reserved Widget", "quantity": 10, "unit_price": 50,
        "unit_cost": 20, "category": "Goods"}).json()["id"]


def _hold(c, widget, qty, client_id, **kw):
    body = {"inventory_id": widget, "quantity": qty, "client_id": client_id}
    body.update(kw)
    return c.post("/api/inventory/reservations", json=body)


def _sell(c, widget, qty, *, client_id=None):
    return c.post("/api/pos/checkout", json={
        "client_id": client_id,
        "items": [{"name": "Reserved Widget", "inventory_id": widget,
                   "quantity": qty, "unit_price": 50}],
        "payment_method": "Cash", "currency": "USD",
        "amount_tendered": 50 * qty,
        "idempotency_key": str(uuid.uuid4()),
    })


def _item(c, widget):
    return c.get(f"/api/inventory/{widget}").json()


# ── A reservation holds the goods ────────────────────────────────────────────

def test_reserved_stock_cannot_be_sold_to_somebody_else(cashier, widget, buyer,
                                                        other_buyer):
    """The whole point. Ten on hand, eight held, and the counter may sell two."""
    _hold(cashier, widget, 8, buyer)

    r = _sell(cashier, widget, 3, client_id=other_buyer)

    assert r.status_code == 400
    assert "reserved" in r.text.lower() or "available" in r.text.lower()


def test_what_is_left_over_can_still_be_sold(cashier, widget, buyer, other_buyer):
    """A reservation must not freeze the whole item."""
    _hold(cashier, widget, 8, buyer)

    r = _sell(cashier, widget, 2, client_id=other_buyer)

    assert r.status_code == 200, r.text


def test_the_goods_stay_on_hand_while_they_are_held(cashier, widget, buyer):
    """Reserved is not sold. The stock is still in the building and still an
    asset — it is only spoken for."""
    before = _item(cashier, widget)["quantity"]

    _hold(cashier, widget, 8, buyer)

    assert _item(cashier, widget)["quantity"] == before


def test_the_item_reports_what_is_actually_available(cashier, widget, buyer):
    _hold(cashier, widget, 8, buyer)

    body = _item(cashier, widget)

    assert body["reserved_quantity"] == _pytest.approx(8)
    assert body["available_quantity"] == _pytest.approx(2)


def test_more_cannot_be_held_than_is_free(cashier, widget, buyer, other_buyer):
    _hold(cashier, widget, 8, buyer)

    r = _hold(cashier, widget, 5, other_buyer)

    assert r.status_code == 400


# ── A reservation knows who it is for ────────────────────────────────────────

def test_a_reservation_names_its_customer(cashier, widget, buyer):
    """A bare total cannot answer "whose is it?", which is the question asked
    every time somebody wants to release one."""
    rid = _hold(cashier, widget, 3, buyer).json()["id"]

    rows = cashier.get("/api/inventory/reservations",
                       params={"inventory_id": widget}).json()

    row = next(r for r in rows if r["id"] == rid)
    assert row["client_id"] == buyer
    assert row["client_name"] == "Reserving Buyer"
    assert row["status"] == "held"


def test_releasing_one_reservation_leaves_the_others_alone(cashier, widget,
                                                           buyer, other_buyer):
    """The failure a bare counter invites: releasing three units and taking
    them off somebody else's hold."""
    mine = _hold(cashier, widget, 3, buyer).json()["id"]
    _hold(cashier, widget, 4, other_buyer)

    cashier.patch(f"/api/inventory/reservations/{mine}/release", json={})

    assert _item(cashier, widget)["reserved_quantity"] == _pytest.approx(4)


def test_a_released_reservation_can_be_sold_again(cashier, widget, buyer,
                                                  other_buyer):
    rid = _hold(cashier, widget, 8, buyer).json()["id"]
    cashier.patch(f"/api/inventory/reservations/{rid}/release", json={})

    r = _sell(cashier, widget, 9, client_id=other_buyer)

    assert r.status_code == 200, r.text


def test_releasing_twice_does_not_free_the_stock_twice(cashier, widget, buyer):
    """The arithmetic bug a counter cannot defend against."""
    rid = _hold(cashier, widget, 4, buyer).json()["id"]

    cashier.patch(f"/api/inventory/reservations/{rid}/release", json={})
    cashier.patch(f"/api/inventory/reservations/{rid}/release", json={})

    assert _item(cashier, widget)["reserved_quantity"] == _pytest.approx(0)


# ── Collecting ───────────────────────────────────────────────────────────────

def test_the_customer_who_reserved_it_can_buy_it(cashier, widget, buyer):
    """Holding eight for someone and then refusing to sell them eight would be
    the reservation working against the person it was for."""
    _hold(cashier, widget, 8, buyer)

    r = _sell(cashier, widget, 8, client_id=buyer)

    assert r.status_code == 200, r.text


def test_collecting_consumes_the_hold(cashier, widget, buyer):
    """Otherwise the stock leaves and the reservation stays, so the item is
    permanently short by what was collected."""
    _hold(cashier, widget, 8, buyer)

    _sell(cashier, widget, 8, client_id=buyer)

    body = _item(cashier, widget)
    assert body["quantity"] == _pytest.approx(2)
    assert body["reserved_quantity"] == _pytest.approx(0)


def test_a_partial_collection_leaves_the_rest_held(cashier, widget, buyer):
    _hold(cashier, widget, 8, buyer)

    _sell(cashier, widget, 3, client_id=buyer)

    assert _item(cashier, widget)["reserved_quantity"] == _pytest.approx(5)


def test_cost_of_goods_is_recognised_when_the_goods_are_collected(cashier,
                                                                  widget, buyer):
    """Holding stock is not a sale, so nothing posts. Collecting it is."""
    _hold(cashier, widget, 8, buyer)
    before = cashier.get("/api/accounting/trial-balance").json()

    r = _sell(cashier, widget, 8, client_id=buyer)

    assert r.json()["cogs_total"] > 0
    assert before["balanced"] and cashier.get(
        "/api/accounting/trial-balance").json()["balanced"]


def test_holding_stock_posts_nothing_to_the_ledger(cashier, widget, buyer):
    """A reservation moves no value: the goods are still on hand and still
    ours. Posting anything here would invent a transaction."""
    before = len(cashier.get("/api/accounting/journal-entries").json()["rows"])

    _hold(cashier, widget, 8, buyer)

    after = len(cashier.get("/api/accounting/journal-entries").json()["rows"])
    assert after == before


# ── Manufacturing keeps working ──────────────────────────────────────────────

def test_material_reserved_by_production_cannot_be_sold_over_the_counter(
        cashier, widget, other_buyer, db):
    """This is the bug that was already there: the till never consulted
    reserved_quantity, so material committed to a confirmed order could be
    sold, and the factory found out when it went to build."""
    db.execute("UPDATE inventory SET reserved_quantity=9 WHERE id=?", (widget,))
    db.commit()

    r = _sell(cashier, widget, 5, client_id=other_buyer)

    assert r.status_code == 400


# ── Refusals ─────────────────────────────────────────────────────────────────

def test_a_reservation_needs_a_customer(cashier, widget):
    r = cashier.post("/api/inventory/reservations",
                     json={"inventory_id": widget, "quantity": 2})

    assert r.status_code in (400, 422)


def test_a_reservation_needs_a_positive_quantity(cashier, widget, buyer):
    assert _hold(cashier, widget, 0, buyer).status_code == 400
    assert _hold(cashier, widget, -3, buyer).status_code == 400


def test_an_archived_item_cannot_be_reserved(cashier, widget, buyer, db):
    db.execute("UPDATE inventory SET archived_at='2026-01-01' WHERE id=?", (widget,))
    db.commit()

    assert _hold(cashier, widget, 2, buyer).status_code == 400


def test_reserving_is_an_inventory_permission(as_role, widget, buyer):
    """Holding stock takes it off the shelf for everyone else, so it is an
    inventory decision rather than a sales one."""
    r = as_role("Sales").post("/api/inventory/reservations",
                              json={"inventory_id": widget, "quantity": 2,
                                    "client_id": buyer})

    assert r.status_code == 403


def test_reading_reservations_takes_only_inventory_view(as_role, cashier,
                                                        widget, buyer):
    """Seeing who is holding what must not require the right to change it —
    a salesperson answering "can I promise this?" needs to look."""
    _hold(cashier, widget, 2, buyer)

    r = as_role("Sales").get("/api/inventory/reservations",
                             params={"inventory_id": widget})

    assert r.status_code == 200
    assert len(r.json()) == 1


def test_collecting_never_eats_somebody_elses_hold(cashier, widget, buyer,
                                                   other_buyer):
    """The dangerous one. Holds are drawn oldest-first, so a customer
    collecting theirs must be matched on WHOSE it is and not merely on age —
    otherwise the first customer through the door consumes the reservation of
    whoever booked earliest, and that person arrives to find their goods sold.
    """
    theirs = _hold(cashier, widget, 4, other_buyer).json()["id"]   # booked first
    mine   = _hold(cashier, widget, 3, buyer).json()["id"]

    _sell(cashier, widget, 3, client_id=buyer)

    rows = {r["id"]: r for r in cashier.get(
        "/api/inventory/reservations",
        params={"inventory_id": widget, "status": "all"}).json()}
    assert rows[theirs]["status"] == "held"
    assert rows[theirs]["quantity"] == _pytest.approx(4)
    assert rows[mine]["status"] == "collected"


def test_a_walk_in_cannot_collect_a_reservation(cashier, widget, buyer):
    """No customer on the sale means no hold to draw from — the sale takes
    free stock only, and somebody's reservation is not free stock."""
    _hold(cashier, widget, 8, buyer)

    r = _sell(cashier, widget, 3)          # no client_id

    assert r.status_code == 400
    assert _item(cashier, widget)["reserved_quantity"] == _pytest.approx(8)
