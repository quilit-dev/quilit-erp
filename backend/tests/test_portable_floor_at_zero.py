"""Counters that must never go negative, written so both engines accept them.

Four places walk a running total back and clamp it at zero: a project's actual
cost when an expense is voided or re-pointed, a component's reservation when a
production order releases it, and a campaign's used allowance when a promoted
line comes back. All four were written `MAX(0, x)`, which is SQLite's SCALAR
max — PostgreSQL has only the aggregate and rejects the call, so every one of
them passed the whole suite here and raised on a hosted tenant.

`test_sqlite_only_sql.py` is what stops that spelling coming back. These tests
are the other half: proof that the portable `CASE WHEN` rewrite still does what
the original meant. The clamp is the part worth testing, because it is the
branch that only runs when the numbers have already drifted — and it is exactly
the branch a careless rewrite drops.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import uuid

import pytest


def _key():
    return str(uuid.uuid4())


def _project(c, name="Floor Test"):
    r = c.post("/api/projects/", json={"name": name, "status": "In Progress"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _cost(c, pid):
    return float(c.get(f"/api/projects/{pid}").json()["actual_cost"] or 0)


def _expense(c, pid, amount, category="Materials"):
    r = c.post("/api/finance/expenses", json={
        "project_id": pid, "category": category, "amount": amount,
        "description": "floor test", "payment_method": "Cash"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


# ── A project's actual cost ───────────────────────────────────────────────
def test_voiding_an_expense_takes_its_cost_back_off_the_project(make_client):
    c = make_client("superadmin")
    pid = _project(c)
    eid = _expense(c, pid, 250)
    assert _cost(c, pid) == pytest.approx(250)

    r = c.patch(f"/api/finance/expenses/{eid}/void", json={"reason": "wrong"})
    assert r.status_code == 200, r.text
    assert _cost(c, pid) == pytest.approx(0)


def test_the_project_cost_is_clamped_rather_than_going_negative(make_client, db):
    """The branch the whole rewrite exists for. If the stored cost has drifted
    below what the expense contributed — which is what a historical void or a
    hand-edited row leaves behind — reversing it must land on zero, not on a
    negative cost that would then read as a credit on the project."""
    c = make_client("superadmin")
    pid = _project(c)
    eid = _expense(c, pid, 500)
    # Drift: the running total no longer covers the expense about to come off.
    db.execute("UPDATE projects SET actual_cost = 120 WHERE id = ?", (pid,))
    db.commit()

    r = c.patch(f"/api/finance/expenses/{eid}/void", json={"reason": "drifted"})
    assert r.status_code == 200, r.text
    assert _cost(c, pid) == pytest.approx(0)


def test_editing_an_expense_moves_the_cost_between_projects(make_client):
    c = make_client("superadmin")
    a, b = _project(c, "From"), _project(c, "To")
    eid = _expense(c, a, 300)
    assert _cost(c, a) == pytest.approx(300)

    r = c.put(f"/api/finance/expenses/{eid}", json={
        "project_id": b, "category": "Materials", "amount": 300,
        "description": "moved", "payment_method": "Cash"})
    assert r.status_code == 200, r.text
    assert _cost(c, a) == pytest.approx(0)
    assert _cost(c, b) == pytest.approx(300)


def test_a_repointed_expense_clamps_the_old_project_too(make_client, db):
    c = make_client("superadmin")
    a, b = _project(c, "From2"), _project(c, "To2")
    eid = _expense(c, a, 400)
    db.execute("UPDATE projects SET actual_cost = 90 WHERE id = ?", (a,))
    db.commit()

    r = c.put(f"/api/finance/expenses/{eid}", json={
        "project_id": b, "category": "Materials", "amount": 400,
        "description": "moved", "payment_method": "Cash"})
    assert r.status_code == 200, r.text
    assert _cost(c, a) == pytest.approx(0)


def test_a_reduced_amount_still_lands_on_the_right_total(make_client):
    """Not a clamp — the ordinary path, asserted so the rewrite cannot quietly
    floor a perfectly good subtraction at zero."""
    c = make_client("superadmin")
    pid = _project(c)
    _expense(c, pid, 300)
    eid = _expense(c, pid, 200)
    assert _cost(c, pid) == pytest.approx(500)

    r = c.put(f"/api/finance/expenses/{eid}", json={
        "project_id": pid, "category": "Materials", "amount": 50,
        "description": "corrected", "payment_method": "Cash"})
    assert r.status_code == 200, r.text
    # 500 − 200 + 50. A clamp firing here would read 50.
    assert _cost(c, pid) == pytest.approx(350)


# ── A campaign's used allowance ───────────────────────────────────────────
def test_returning_a_promoted_sale_hands_the_allowance_back(make_client, db):
    c = make_client("superadmin")
    assert c.post("/api/pos/session/open", json={"opening_float": 0}
                  ).status_code in (200, 409)
    it = c.post("/api/inventory/", json={"name": "Promo Item", "quantity": 20,
                                         "unit_cost": 2, "sale_price": 10})
    item = it.json()["id"]
    p = c.post("/api/promotions/", json={
        "name": "Ten off", "discount_type": "percent", "discount_value": 10,
        "inventory_id": item, "max_quantity": 50})
    assert p.status_code in (200, 201), p.text
    pid = p.json()["id"]

    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Promo Item", "inventory_id": item,
                   "quantity": 3, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 30,
        "idempotency_key": _key()})
    assert sale.status_code == 200, sale.text
    used = db.execute("SELECT used_quantity FROM promotions WHERE id=?",
                      (pid,)).fetchone()["used_quantity"]
    assert used > 0

    r = c.post(f"/api/pos/sales/{sale.json()['id']}/return", json={"reason": "back"})
    assert r.status_code == 200, r.text
    back = db.execute("SELECT used_quantity FROM promotions WHERE id=?",
                      (pid,)).fetchone()["used_quantity"]
    assert back == 0


def test_the_allowance_is_clamped_rather_than_going_negative(make_client, db):
    """A campaign whose counter has already been walked back — by an earlier
    return, or by the known over-credit where the cap truncated a line — must
    settle at zero rather than lending itself negative allowance."""
    c = make_client("superadmin")
    assert c.post("/api/pos/session/open", json={"opening_float": 0}
                  ).status_code in (200, 409)
    it = c.post("/api/inventory/", json={"name": "Promo Item 2", "quantity": 20,
                                         "unit_cost": 2, "sale_price": 10})
    item = it.json()["id"]
    p = c.post("/api/promotions/", json={
        "name": "Ten off again", "discount_type": "percent", "discount_value": 10,
        "inventory_id": item, "max_quantity": 50})
    pid = p.json()["id"]

    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Promo Item 2", "inventory_id": item,
                   "quantity": 4, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 40,
        "idempotency_key": _key()})
    assert sale.status_code == 200, sale.text
    # Drift: the counter no longer covers what is about to come off it.
    db.execute("UPDATE promotions SET used_quantity = 1 WHERE id = ?", (pid,))
    db.commit()

    r = c.post(f"/api/pos/sales/{sale.json()['id']}/return", json={"reason": "back"})
    assert r.status_code == 200, r.text
    back = db.execute("SELECT used_quantity FROM promotions WHERE id=?",
                      (pid,)).fetchone()["used_quantity"]
    assert back == 0
