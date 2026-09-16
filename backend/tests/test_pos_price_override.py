"""
Changing a stock item's price at the till, and the three guards around it.

Before this the register filled a stock line's price in from the inventory
record and the server took whatever arrived: `PosCartItem.unit_price` was
validated for `>= 0` and nothing else. The price was a default the screen
happened to show, not a rule anyone was held to. Making it editable is
therefore not opening a door; it is fitting one, and these tests are the
hinges:

  1. **A permission.** `pos_price_override` is a key in the role matrix.
     Without it a stock line must be rung at its list price --- the first
     time the server has enforced that at all. With it the cashier may name
     another price.
  2. **The list price is kept.** `pos_sale_items.list_price` records what the
     item was listed at on every stock line, so an override is a comparison
     anyone reading the sale can make, not a flag somebody set.
  3. **A floor.** Never below the item's cost; and not below
     `pos_price_floor_pct` per cent of list when the owner has set one.

An overridden line gets no promotion --- the override is the price.

Custom lines (no inventory_id) have no list price and are untouched by all of
it. Correcting a sale is the one carve-out: a price the original sale already
charged passes for anyone, because it is not a new decision.
"""
import os
import uuid

import pytest

pytestmark = pytest.mark.critical

_PG = os.environ.get("DB_BACKEND", "sqlite").lower() in ("postgres", "postgresql", "pg")

# Holds pos view/create/edit/delete and nothing about prices --- the person
# the guard exists for. (The seeded Cashier role has no test account.)
CASHIER = "Sales Manager"


def _key():
    return str(uuid.uuid4())


def _open(c):
    r = c.post("/api/pos/session/open", json={"opening_float": 0})
    assert r.status_code in (200, 409), r.text


def _item(c, name="Widget", cost=4.0, sale_price=10.0, **extra):
    r = c.post("/api/inventory/", json={"name": name, "quantity": 50,
                                        "unit_cost": cost, "sale_price": sale_price,
                                        **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _line(item_id, price, qty=1, name="Widget"):
    return {"name": name, "inventory_id": item_id, "quantity": qty,
            "unit_price": price}


def _sell(c, lines, **extra):
    total = sum(l["quantity"] * l["unit_price"] for l in lines)
    return c.post("/api/pos/checkout", json={
        "items": lines, "payment_method": "Cash", "amount_tendered": total,
        "idempotency_key": _key(), **extra})


def _grant(db, role=CASHIER):
    db.execute("INSERT INTO role_permissions "
               "(role_id, module, can_view, can_create, can_edit, can_delete, can_approve) "
               "VALUES ((SELECT id FROM roles WHERE name = ?), 'pos_price_override', "
               "        1, 0, 0, 0, 0)", (role,))
    db.commit()


def _revoke(db, role):
    db.execute("DELETE FROM role_permissions WHERE module = 'pos_price_override' "
               "  AND role_id = (SELECT id FROM roles WHERE name = ?)", (role,))
    db.commit()


def _set(c, key, value):
    r = c.put("/api/settings/", json={key: str(value)})
    assert r.status_code == 200, r.text


def _items_of(c, sale_id):
    r = c.get(f"/api/pos/sales/{sale_id}")
    assert r.status_code == 200, r.text
    return r.json()["items"]


# ── 1. the permission ────────────────────────────────────────────────────────
def test_the_no_op_a_cashier_at_list_price_sells_as_before(as_role):
    """What every till does today keeps working, and the list price lands on
    the line equal to what was charged."""
    owner = as_role("superadmin")
    item = _item(owner, sale_price=10)
    cashier = as_role(CASHIER)
    _open(cashier)

    r = _sell(cashier, [_line(item, 10)])
    assert r.status_code == 200, r.text
    (row,) = _items_of(owner, r.json()["id"])
    assert row["unit_price"] == pytest.approx(10)
    assert row["list_price"] == pytest.approx(10)


def test_without_the_permission_another_price_is_refused(as_role):
    owner = as_role("superadmin")
    item = _item(owner, sale_price=10)
    cashier = as_role(CASHIER)
    _open(cashier)

    for price in (9.0, 12.0, 0.0):
        r = _sell(cashier, [_line(item, price)])
        assert r.status_code == 403, (price, r.text)
        assert "price" in r.text.lower()


def test_a_rate_tick_is_not_an_override(as_role):
    """Half a per cent off list is the exchange rate moving between the
    screen loading and the sale; it must not fail the sale."""
    owner = as_role("superadmin")
    item = _item(owner, sale_price=100)
    cashier = as_role(CASHIER)
    _open(cashier)

    r = _sell(cashier, [_line(item, 99.5)])
    assert r.status_code == 200, r.text
    # And it is not recorded as a change either.
    sales = owner.get("/api/pos/sales").json()
    assert not sales[0]["has_override"]


def test_an_lbp_priced_item_is_held_to_its_converted_list_price(as_role):
    """List price for an LBP item is sale_price / rate, to the cent --- the
    register's own arithmetic --- so a cashier sending exactly that passes
    and one sending something else does not."""
    owner = as_role("superadmin")
    r = owner.post("/api/settings/exchange-rate", json={"rate": 90000})
    assert r.status_code == 200, r.text
    item = _item(owner, sale_price=900000, price_currency="LBP", cost=5)
    cashier = as_role(CASHIER)
    _open(cashier)

    assert _sell(cashier, [_line(item, 10.0)]).status_code == 200
    assert _sell(cashier, [_line(item, 8.0)]).status_code == 403


def test_a_custom_line_has_no_list_price_and_no_guard(as_role):
    cashier = as_role(CASHIER)
    _open(cashier)
    r = _sell(cashier, [{"name": "Delivery", "inventory_id": None,
                         "quantity": 1, "unit_price": 7.5}])
    assert r.status_code == 200, r.text
    (row,) = _items_of(as_role("superadmin"), r.json()["id"])
    assert row["list_price"] is None


# ── 2. the list price is kept ────────────────────────────────────────────────
def test_with_the_permission_the_override_is_accepted_and_the_list_price_kept(as_role, db):
    owner = as_role("superadmin")
    item = _item(owner, sale_price=10, cost=4)
    _grant(db)
    cashier = as_role(CASHIER)
    _open(cashier)

    r = _sell(cashier, [_line(item, 8)])
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(8)
    (row,) = _items_of(owner, r.json()["id"])
    assert row["unit_price"] == pytest.approx(8)
    assert row["list_price"] == pytest.approx(10)


def test_the_history_flags_a_sale_with_a_changed_price(as_role, db):
    owner = as_role("superadmin")
    item = _item(owner, sale_price=10, cost=4)
    _grant(db)
    cashier = as_role(CASHIER)
    _open(cashier)
    plain = _sell(cashier, [_line(item, 10)]).json()["id"]
    changed = _sell(cashier, [_line(item, 8)]).json()["id"]

    flags = {s["id"]: bool(s["has_override"]) for s in owner.get("/api/pos/sales").json()}
    assert flags[changed] is True
    assert flags[plain] is False


def test_the_audit_row_names_the_override(as_role, db):
    owner = as_role("superadmin")
    item = _item(owner, name="Lamp", sale_price=10, cost=4)
    _grant(db)
    cashier = as_role(CASHIER)
    _open(cashier)
    sale = _sell(cashier, [_line(item, 8, name="Lamp")]).json()

    row = db.execute(
        "SELECT detail FROM audit_log WHERE module='pos' AND action='create' "
        "AND record_id=? ORDER BY id DESC LIMIT 1", (sale["id"],)).fetchone()
    assert row, "the sale must leave an audit row"
    assert "Lamp" in row["detail"]
    assert "overrides" in row["detail"]


# ── 3. the floor ─────────────────────────────────────────────────────────────
def test_below_cost_is_refused_even_with_the_permission(as_role, db):
    owner = as_role("superadmin")
    item = _item(owner, sale_price=10, cost=6)
    _grant(db)
    cashier = as_role(CASHIER)
    _open(cashier)

    r = _sell(cashier, [_line(item, 5)])
    assert r.status_code == 400, r.text
    assert "cost" in r.text.lower()
    # At cost is allowed: the rule is "not below".
    assert _sell(cashier, [_line(item, 6)]).status_code == 200


def test_the_percentage_floor_applies_on_top_of_cost(as_role, db):
    owner = as_role("superadmin")
    _set(owner, "pos_price_floor_pct", 80)
    item = _item(owner, sale_price=100, cost=10)
    _grant(db)
    cashier = as_role(CASHIER)
    _open(cashier)

    r = _sell(cashier, [_line(item, 79)])
    assert r.status_code == 400, r.text
    assert "80%" in r.text
    assert _sell(cashier, [_line(item, 80)]).status_code == 200


def test_a_floor_of_zero_means_only_the_cost_rule(as_role, db):
    owner = as_role("superadmin")
    _set(owner, "pos_price_floor_pct", 0)
    item = _item(owner, sale_price=100, cost=10)
    _grant(db)
    cashier = as_role(CASHIER)
    _open(cashier)
    assert _sell(cashier, [_line(item, 10)]).status_code == 200


# ── promotions ───────────────────────────────────────────────────────────────
def _promo(c, item_id, pct=10):
    r = c.post("/api/promotions/", json={
        "name": "Ten off", "scope_type": "item", "scope_value": str(item_id),
        "discount_value": pct, "active": True})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_a_promotion_does_not_stack_on_an_overridden_price(as_role, db):
    owner = as_role("superadmin")
    item = _item(owner, sale_price=100, cost=10)
    promo = _promo(owner, item)
    _grant(db)
    cashier = as_role(CASHIER)
    _open(cashier)

    # At list: the promotion applies.
    r = _sell(cashier, [_line(item, 100)])
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(90)
    (row,) = _items_of(owner, r.json()["id"])
    assert row["promotion_id"] == promo

    # Overridden: the override is the price, full stop.
    r = _sell(cashier, [_line(item, 95)])
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(95)
    (row,) = _items_of(owner, r.json()["id"])
    assert row["promotion_id"] is None
    assert row["discount"] == pytest.approx(0)


# ── correcting a sale ────────────────────────────────────────────────────────
def test_a_correction_may_keep_the_price_the_sale_already_had(as_role, db):
    """The owner rang an override; the cashier fixes the quantity. The price
    the sale already carried is not a new decision."""
    owner = as_role("superadmin")
    item = _item(owner, sale_price=10, cost=4)
    _open(owner)
    sale = _sell(owner, [_line(item, 8, qty=2)]).json()
    assert sale["total"] == pytest.approx(16)

    cashier = as_role(CASHIER)
    _open(cashier)
    r = cashier.post(f"/api/pos/sales/{sale['id']}/amend", json={
        "items": [_line(item, 8, qty=1)], "payment_method": "Cash",
        "amount_tendered": 0, "idempotency_key": _key()})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(8)
    # Still an overridden line: the history says so and, had there been a
    # promotion, it would not have stacked.
    (row,) = _items_of(owner, r.json()["id"])
    assert row["list_price"] == pytest.approx(10)
    assert [s for s in owner.get("/api/pos/sales").json()
            if s["id"] == r.json()["id"]][0]["has_override"]

    # But not a third price.
    r = cashier.post(f"/api/pos/sales/{r.json()['id']}/amend", json={
        "items": [_line(item, 7, qty=1)], "payment_method": "Cash",
        "amount_tendered": 0, "idempotency_key": _key()})
    assert r.status_code == 403, r.text


# ── the grant ────────────────────────────────────────────────────────────────
def test_only_the_owner_holds_it_after_the_seed(db):
    rows = db.execute(
        "SELECT r.name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
        "WHERE rp.module = 'pos_price_override' AND rp.can_view = 1").fetchall()
    assert {r["name"] for r in rows} == {"Business Owner"}


def test_the_upgrade_grants_the_owner_once_and_never_again(db):
    """Same shape as 183c: the grant is marker-guarded, so an owner who unticks
    it does not get it back on the next boot."""
    import database
    db.execute("DELETE FROM role_permissions WHERE module = 'pos_price_override'")
    db.execute("DELETE FROM schema_migrations "
               " WHERE name = '186b_pos_price_override_capability'")
    db.commit()
    if _PG:
        pytest.skip("SQLite chain only here; the mirror is exercised below")
    database._run_migrations(db, db.cursor())
    db.commit()
    rows = db.execute("SELECT r.name FROM role_permissions rp JOIN roles r "
                      "ON r.id = rp.role_id WHERE rp.module='pos_price_override'").fetchall()
    assert {r["name"] for r in rows} == {"Business Owner"}

    # The owner unticks it. The next boot must leave it unticked.
    db.execute("DELETE FROM role_permissions WHERE module = 'pos_price_override'")
    db.commit()
    database._run_migrations(db, db.cursor())
    db.commit()
    assert db.execute("SELECT COUNT(*) AS n FROM role_permissions "
                      "WHERE module='pos_price_override'").fetchone()["n"] == 0


@pytest.mark.skipif(not _PG, reason="the Postgres mirror")
def test_the_pg_mirror_grants_the_owner_once_and_never_again():
    """The path the live tenants take: upgrade_all_tenant_schemas runs
    _ensure_pg_post_baseline and nothing else. Talks to DATABASE_URL directly,
    as test_foreign_purchases does, because the db fixture is a per-test clone."""
    import psycopg
    from psycopg.rows import dict_row

    import database

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as raw:
        cur = raw.cursor()
        cur.execute("DELETE FROM role_permissions WHERE module = 'pos_price_override'")
        cur.execute("DELETE FROM schema_migrations "
                    " WHERE name = '186b_pos_price_override_capability'")
        raw.commit()

        database._ensure_pg_post_baseline(raw)
        cur.execute("SELECT r.name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
                    " WHERE rp.module = 'pos_price_override'")
        assert {r["name"] for r in cur.fetchall()} == {"Business Owner"}

        # The owner unticks it; the next boot must leave it unticked.
        cur.execute("DELETE FROM role_permissions WHERE module = 'pos_price_override'")
        raw.commit()
        database._ensure_pg_post_baseline(raw)
        cur.execute("SELECT COUNT(*) AS n FROM role_permissions "
                    " WHERE module = 'pos_price_override'")
        assert cur.fetchone()["n"] == 0
