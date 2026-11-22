"""The Payment Plans report.

One page a collections manager can run the instalment book from: every plan,
how far along it is, what is late and by how long, and what is coming in. The
figures are derived exactly as the plan panels derive them (oldest instalment
settled first), so the report can never disagree with the customer's own page.
"""
import uuid
from datetime import date, timedelta

import pytest as _pytest

import installments


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


TODAY = date.today()


def iso(d):
    return d.isoformat()


def _customer(client, name, plans=False):
    return client.post("/api/clients/", json={"name": name, "allow_installments": plans}).json()["id"]


def _invoice(client, cid, amount):
    r = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": iso(TODAY),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": amount}]}).json()
    return r.get("invoice_id") or r.get("id")


def _pay_invoice(client, inv, amount):
    r = client.post(f"/api/invoices/{inv}/payments", json={
        "amount": amount, "currency": "USD", "method": "Cash", "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text


def _report(client, **params):
    params.setdefault("start", iso(TODAY - timedelta(days=365)))
    params.setdefault("end", iso(TODAY + timedelta(days=365)))
    r = client.get("/api/reports/payment-plans", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _plan(report, key):
    return next((p for p in report["plans"] if p["key"] == key), None)


def _late_plan(client, name="Late Co"):
    """1,200 in four monthly payments that began 45 days ago: the first two
    have fallen due. 450 paid settles the first and half the second."""
    cid = _customer(client, name)
    inv = _invoice(client, cid, 1200)
    first = TODAY - timedelta(days=45)
    r = client.post(f"/api/invoices/{inv}/plan", json={"count": 4, "start_date": iso(first)})
    assert r.status_code == 200, r.text
    _pay_invoice(client, inv, 450)
    return cid, inv


def test_a_late_plan_shows_its_arrears_and_its_next_payment(client):
    _cid, inv = _late_plan(client)
    p = _plan(_report(client), f"invoice-{inv}")

    assert p["status"] == "late"
    assert p["kind"] == "invoice" and p["frequency"] == "monthly"
    assert (p["count"], p["paid_count"]) == (4, 1)
    assert (p["total"], p["paid"], p["remaining"]) == (1200, 450, 750)
    assert p["overdue"] == 150 and p["overdue_count"] == 1, "half of the second instalment"
    assert 1 <= p["days_late"] <= 31
    assert p["next_due_date"] > iso(TODAY) and p["next_due_amount"] == 300
    assert p["progress"] == 37.5
    assert [i["status"] for i in p["installments"]] == ["Paid", "Overdue", "Due", "Due"]


def test_the_cards_add_up_the_book(client):
    _late_plan(client)
    rep = _report(client)
    s = rep["summary"]
    assert s["plans"] == 1 and s["late"] == 1 and s["on_track"] == 0
    assert (s["scheduled"], s["collected"], s["outstanding"]) == (1200, 450, 750)
    assert s["overdue"] == 150 and s["overdue_installments"] == 1
    assert s["collection_rate"] == 75.0, "450 paid of the 600 fallen due"
    assert rep["aging"]["1_30"] == {"count": 1, "total": 150}
    assert rep["aging"]["current"] == {"count": 2, "total": 600}


def test_the_forecast_lists_what_falls_due_month_by_month(client):
    _late_plan(client)
    rep = _report(client, start=iso(TODAY), end=iso(TODAY + timedelta(days=120)))
    assert sum(f["due"] for f in rep["forecast"]) == 600, "the two instalments still to come"
    assert all(f["count"] == 1 for f in rep["forecast"])
    assert rep["summary"]["due_in_period"] == 600


def test_a_paid_off_plan_moves_to_completed(client):
    cid = _customer(client, "Paid Co")
    inv = _invoice(client, cid, 400)
    client.post(f"/api/invoices/{inv}/plan", json={"count": 2, "start_date": iso(TODAY + timedelta(days=10))})
    _pay_invoice(client, inv, 400)

    assert _plan(_report(client), f"invoice-{inv}") is None, "open plans only, by default"
    done = _plan(_report(client, status="completed"), f"invoice-{inv}")
    assert done["status"] == "completed" and done["remaining"] == 0


def test_a_plan_running_to_schedule_is_on_track(client):
    cid = _customer(client, "Fine Co")
    inv = _invoice(client, cid, 900)
    client.post(f"/api/invoices/{inv}/plan", json={"count": 3, "start_date": iso(TODAY + timedelta(days=5)),
                                                   "frequency": "quarterly"})
    p = _plan(_report(client), f"invoice-{inv}")
    assert p["status"] == "on_track" and p["overdue"] == 0 and p["frequency"] == "quarterly"


def test_a_voided_invoice_takes_its_plan_with_it(client):
    cid = _customer(client, "Void Co")
    inv = _invoice(client, cid, 600)
    client.post(f"/api/invoices/{inv}/plan", json={"count": 2, "start_date": iso(TODAY + timedelta(days=5))})
    client.patch(f"/api/invoices/{inv}/void", json={"reason": "cancelled"})
    assert _plan(_report(client, status="all"), f"invoice-{inv}") is None


def test_account_plans_are_listed_and_a_cancelled_one_stays_findable(client):
    cid = _customer(client, "Account Co", plans=True)
    _invoice(client, cid, 800)
    r = client.post(f"/api/clients/{cid}/plan", json={"count": 4, "start_date": iso(TODAY + timedelta(days=7))})
    assert r.status_code == 200, r.text
    plan_id = r.json()["plan"]["id"]

    p = _plan(_report(client), f"account-{plan_id}")
    assert p["kind"] == "account" and p["status"] == "on_track" and p["total"] == 800
    assert p["frequency"] == "monthly"

    client.delete(f"/api/clients/{cid}/plan")
    assert _plan(_report(client), f"account-{plan_id}") is None
    gone = _plan(_report(client, status="cancelled"), f"account-{plan_id}")
    assert gone["status"] == "cancelled"
    assert _report(client)["summary"]["outstanding"] == 0, "a cancelled plan is not part of the book"


def test_the_period_picks_the_plans_running_in_it_and_keeps_the_late_ones(client):
    _cid, late = _late_plan(client)
    cid = _customer(client, "Later Co")
    future = _invoice(client, cid, 500)
    client.post(f"/api/invoices/{future}/plan",
                json={"count": 2, "start_date": iso(TODAY + timedelta(days=200))})

    window = _report(client, start=iso(TODAY + timedelta(days=60)), end=iso(TODAY + timedelta(days=90)))
    keys = {p["key"] for p in window["plans"]}
    assert f"invoice-{late}" in keys, "still in arrears, so it stays on the list"
    assert f"invoice-{future}" not in keys, "nothing of it falls due in the window"

    later = _report(client, start=iso(TODAY + timedelta(days=190)), end=iso(TODAY + timedelta(days=215)))
    assert _plan(later, f"invoice-{future}")["due_in_period"] == 250


def test_the_worst_arrears_come_first(client):
    cid = _customer(client, "Fine First Co")
    fine = _invoice(client, cid, 300)
    client.post(f"/api/invoices/{fine}/plan", json={"count": 3, "start_date": iso(TODAY + timedelta(days=3))})
    _late_plan(client, "Behind Co")
    assert _report(client)["plans"][0]["client_name"] == "Behind Co"


def test_the_frequency_is_read_back_from_the_dates():
    assert installments  # imported for the derivation the report relies on
    from plan_report import _frequency
    assert _frequency(["2026-01-15", "2026-02-15", "2026-03-15"]) == "monthly"
    assert _frequency(["2026-01-15", "2026-04-15"]) == "quarterly"
    assert _frequency(["2026-01-15", "2027-01-15"]) == "yearly"
    assert _frequency(["2026-01-15", "2026-01-20", "2026-02-20"]) == "custom"


# ── Plans on the whole account ─────────────────────────────────────────────
def _account_plan(client, name, amount=800, count=4, days=5):
    cid = _customer(client, name, plans=True)
    inv = _invoice(client, cid, amount)
    r = client.post(f"/api/clients/{cid}/plan",
                    json={"count": count, "start_date": iso(TODAY + timedelta(days=days))})
    assert r.status_code == 200, r.text
    return cid, inv, r.json()["plan"]["id"]


def test_a_payment_taken_on_an_invoice_counts_towards_the_account_plan(client):
    """The customer paid at the counter against one invoice rather than as an
    account payment. Their balance went down, so their plan moved on — on the
    customer's own page and in the report alike."""
    cid, inv, plan_id = _account_plan(client, "Counter Co")
    _pay_invoice(client, inv, 200)

    assert client.get(f"/api/clients/{cid}/plan").json()["plan"]["paid"] == 200
    p = _plan(_report(client), f"account-{plan_id}")
    assert (p["paid"], p["remaining"], p["paid_count"]) == (200, 600, 1)


def test_an_account_payment_counts_towards_the_account_plan(client):
    cid, _inv, plan_id = _account_plan(client, "Account Pay Co")
    r = client.post(f"/api/clients/{cid}/payments", json={
        "amount": 300, "method": "Cash", "currency": "USD", "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    assert _plan(_report(client), f"account-{plan_id}")["paid"] == 300


def test_paying_an_invoice_raised_after_the_plan_does_not_advance_it(client):
    cid, _inv, plan_id = _account_plan(client, "Later Invoice Co")
    later = _invoice(client, cid, 500)
    _pay_invoice(client, later, 500)
    assert _plan(_report(client), f"account-{plan_id}")["paid"] == 0


def test_an_account_plan_over_an_invoice_plan_counts_the_debt_once(client):
    """An invoice already on its own plan, then the whole account put on terms:
    the account plan is the newer agreement and covers that invoice. The
    customer owes 600, not 1,200."""
    cid = _customer(client, "Both Co", plans=True)
    inv = _invoice(client, cid, 600)
    client.post(f"/api/invoices/{inv}/plan", json={"count": 3, "start_date": iso(TODAY + timedelta(days=5))})
    plan_id = client.post(f"/api/clients/{cid}/plan",
                          json={"count": 2, "start_date": iso(TODAY + timedelta(days=5))}).json()["plan"]["id"]

    rep = _report(client, status="all")
    assert rep["summary"]["outstanding"] == 600
    assert _plan(rep, f"invoice-{inv}")["status"] == "covered"
    assert _plan(rep, f"invoice-{inv}")["covered_by"] == f"Account plan #{plan_id}"
    assert _plan(rep, f"account-{plan_id}")["covers"] == [_plan(rep, f"invoice-{inv}")["reference"]]
    assert _plan(_report(client), f"invoice-{inv}") is None, "not on the open list: it is not owed separately"

    client.delete(f"/api/clients/{cid}/plan")
    back = _report(client)
    assert _plan(back, f"invoice-{inv}")["status"] == "on_track", "the account plan ended, so it counts again"
    assert back["summary"]["outstanding"] == 600
