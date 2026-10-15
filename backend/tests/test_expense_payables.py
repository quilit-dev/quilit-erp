"""Expenses that are owed, and paid off over time.

An expense used to be money already gone: recording it credited cash or the
bank on the spot. A bill on credit, a loan repayment schedule or anything paid
in instalments had nowhere to go, so the business could not see what it owed.

An expense recorded `on_credit` is a cost on its own date --- the reports have
always counted expenses by date, and still do --- but its ledger entry credits
Accounts Payable, and each payment later moves money out of cash or the bank
against that payable, on the day it is actually paid. These tests guard that
the expense row, its payments, the payable (2000), cash (1000) and the cash
drawer keep telling the same story.
"""
import pytest

from routers import cash as cash_router

AP, CASH = "2000", "1000"
TODAY = "2026-10-15"


def _gl(c, code):
    """Debit minus credit: a payable reads NEGATIVE while something is owed."""
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 2)
    return 0.0


def _expense(c, amount, **extra):
    body = {"category": "Rent", "amount": amount, "date": TODAY,
            "payment_method": "Cash", **extra}
    r = c.post("/api/finance/expenses", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _row(c, eid):
    rows = c.get("/api/finance/expenses").json()
    return next(r for r in rows if r["id"] == eid)


def _pay(c, eid, amount, **extra):
    return c.post(f"/api/finance/expenses/{eid}/payments",
                  json={"amount": amount, "paid_at": TODAY, **extra})


def test_a_paid_expense_is_unchanged(make_client):
    """Everything recorded the old way still credits cash and reads as Paid."""
    c = make_client("superadmin")
    cash0, ap0 = _gl(c, CASH), _gl(c, AP)
    eid = _expense(c, 100)
    assert _gl(c, CASH) - cash0 == -100
    assert _gl(c, AP) - ap0 == 0
    r = _row(c, eid)
    assert r["payment_status"] == "Paid" and r["outstanding"] == 0


def test_an_owed_expense_is_a_debt_not_cash_out(make_client):
    c = make_client("superadmin")
    cash0, ap0 = _gl(c, CASH), _gl(c, AP)
    eid = _expense(c, 1200, on_credit=True, payee="Landlord", due_date="2026-11-01")

    assert _gl(c, CASH) - cash0 == 0, "nothing has been paid yet"
    assert _gl(c, AP) - ap0 == -1200, "the whole amount is owed"
    r = _row(c, eid)
    assert r["payment_status"] == "Unpaid" and r["outstanding"] == 1200
    assert r["payee"] == "Landlord" and r["due_date"] == "2026-11-01"


def test_paid_off_in_instalments(make_client):
    c = make_client("superadmin")
    cash0, ap0 = _gl(c, CASH), _gl(c, AP)
    eid = _expense(c, 900, on_credit=True)

    assert _pay(c, eid, 300).status_code == 200
    r = _row(c, eid)
    assert r["payment_status"] == "Partially Paid" and r["outstanding"] == 600

    assert _pay(c, eid, 600).status_code == 200
    r = _row(c, eid)
    assert r["payment_status"] == "Paid" and r["outstanding"] == 0
    assert _gl(c, AP) - ap0 == 0, "the debt is settled"
    assert _gl(c, CASH) - cash0 == -900, "and cash shows exactly what was paid"

    listed = c.get(f"/api/finance/expenses/{eid}/payments").json()
    assert [p["amount"] for p in listed["payments"]] == [300, 600]


def test_part_paid_on_the_day_it_is_recorded(make_client):
    c = make_client("superadmin")
    cash0, ap0 = _gl(c, CASH), _gl(c, AP)
    eid = _expense(c, 500, on_credit=True, paid_now=200)
    r = _row(c, eid)
    assert r["payment_status"] == "Partially Paid" and r["outstanding"] == 300
    assert _gl(c, CASH) - cash0 == -200
    assert _gl(c, AP) - ap0 == -300


def test_payments_cannot_exceed_what_is_owed(make_client):
    c = make_client("superadmin")
    eid = _expense(c, 100, on_credit=True)
    assert _pay(c, eid, 150).status_code == 400
    assert _pay(c, eid, 100).status_code == 200
    assert _pay(c, eid, 1).status_code == 400, "already paid in full"
    assert c.post("/api/finance/expenses", json={
        "category": "Rent", "amount": 100, "on_credit": True, "paid_now": 101,
    }).status_code == 400


def test_an_expense_paid_when_recorded_takes_no_payments(make_client):
    c = make_client("superadmin")
    eid = _expense(c, 100)
    assert _pay(c, eid, 10).status_code == 400


def test_voiding_a_payment_puts_the_debt_back(make_client):
    c = make_client("superadmin")
    cash0, ap0 = _gl(c, CASH), _gl(c, AP)
    eid = _expense(c, 400, on_credit=True)
    pid = _pay(c, eid, 150).json()["id"]
    r = c.patch(f"/api/finance/expenses/{eid}/payments/{pid}/void", json={"reason": "typo"})
    assert r.status_code == 200, r.text
    assert _row(c, eid)["outstanding"] == 400
    assert _gl(c, CASH) - cash0 == 0
    assert _gl(c, AP) - ap0 == -400


def test_voiding_the_expense_takes_its_payments_with_it(make_client, db):
    c = make_client("superadmin")
    cash0, ap0 = _gl(c, CASH), _gl(c, AP)
    eid = _expense(c, 600, on_credit=True)
    _pay(c, eid, 250)
    r = c.patch(f"/api/finance/expenses/{eid}/void", json={"reason": "wrong bill"})
    assert r.status_code == 200, r.text
    assert _gl(c, AP) - ap0 == 0, "no debt is left behind"
    assert _gl(c, CASH) - cash0 == 0, "and the payment came back"
    live = db.execute("SELECT COUNT(*) AS n FROM expense_payments "
                      "WHERE expense_id=? AND voided_at IS NULL", (eid,)).fetchone()["n"]
    assert live == 0


def test_an_edit_cannot_drop_below_what_was_paid(make_client):
    c = make_client("superadmin")
    eid = _expense(c, 500, on_credit=True)
    _pay(c, eid, 300)
    body = {"category": "Rent", "amount": 200, "date": TODAY, "payment_method": "Cash"}
    assert c.put(f"/api/finance/expenses/{eid}", json=body).status_code == 400
    body["amount"] = 350
    assert c.put(f"/api/finance/expenses/{eid}", json=body).status_code == 200
    assert _row(c, eid)["outstanding"] == 50


def test_the_unpaid_filter_lists_only_what_is_owed(make_client):
    c = make_client("superadmin")
    owed = _expense(c, 300, on_credit=True)
    settled = _expense(c, 100, on_credit=True)
    _pay(c, settled, 100)
    paid = _expense(c, 50)
    ids = {r["id"] for r in c.get("/api/finance/expenses?unpaid=true").json()}
    assert owed in ids and settled not in ids and paid not in ids


def test_the_cash_drawer_sees_the_payment_not_the_debt(make_client, db):
    """An owed bill moved no cash when it was recorded; its cash payment did."""
    c = make_client("superadmin")
    drawer = db.execute(
        "SELECT id FROM cash_drawers WHERE auto_capture=1").fetchone()["id"]
    out0 = cash_router._auto_amounts(db, TODAY, drawer, True)["usd"]["out"]

    eid = _expense(c, 700, on_credit=True)
    db.commit()
    assert cash_router._auto_amounts(db, TODAY, drawer, True)["usd"]["out"] == out0

    _pay(c, eid, 200, payment_method="Cash")
    assert cash_router._auto_amounts(db, TODAY, drawer, True)["usd"]["out"] == \
        pytest.approx(out0 + 200)


def test_payments_show_on_the_expense_postings(make_client):
    c = make_client("superadmin")
    eid = _expense(c, 300, on_credit=True)
    _pay(c, eid, 100)
    r = c.get(f"/api/accounting/for/expense/{eid}")
    assert r.status_code == 200, r.text
    sources = {e.get("source_type") for e in r.json()["entries"]}
    assert {"expense", "expense_payment"} <= sources


def test_an_owed_expense_awaiting_approval_is_not_a_debt_yet(make_client):
    """Nothing is posted until approval, so nothing is owed and nothing can be
    paid: the up-front payment is deferred, and the row is not counted as owed
    or overdue."""
    c = make_client("superadmin")
    r = c.post("/api/approval-policies/", json={
        "name": "Owed expenses need a manager", "module": "expense",
        "trigger_action": "create", "condition_logic": "AND", "conditions": [],
        "approval_type": "single", "approver_roles": ["Manager"], "steps": [],
        "priority": 0, "is_active": True})
    assert r.status_code in (200, 201), r.text
    cash0, ap0 = _gl(c, CASH), _gl(c, AP)

    r = c.post("/api/finance/expenses", json={
        "category": "Rent", "amount": 800, "date": TODAY, "payment_method": "Cash",
        "on_credit": True, "paid_now": 100, "due_date": "2026-01-01"})
    assert r.status_code == 200, r.text
    assert r.json().get("payment_deferred") is True
    eid = r.json()["id"]

    row = _row(c, eid)
    assert row["outstanding"] == 0 and row["payment_status"] == "Pending Approval"
    assert eid not in {x["id"] for x in c.get("/api/finance/expenses?unpaid=true").json()}
    assert _pay(c, eid, 50).status_code == 400
    assert _gl(c, CASH) - cash0 == 0 and _gl(c, AP) - ap0 == 0
