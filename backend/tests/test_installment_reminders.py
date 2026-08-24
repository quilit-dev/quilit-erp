"""Being told an instalment is due — on the day, not a month after it lapsed.

Arrears were already chased. Nothing said anything BEFORE a date, which is the
half that is worth having: a customer rung two days out usually pays, and one
rung two weeks late is a debt to be collected. Both events exist here, and they
are separate notifications because they are separate jobs for separate people.

An account plan produced nothing at all. It hangs off no invoice, so the
invoice sweep could not see it, and the dates a customer had agreed to were
never mentioned again by the system that agreed them.
"""
from datetime import date, timedelta
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={
        "name": "Reminder Co", "allow_installments": True}).json()["id"]


def _invoice(client, cid, amount=900, due=None):
    r = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "due_date": due or (date.today() + timedelta(days=365)).isoformat(),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": amount}]}).json()
    return r.get("invoice_id") or r.get("id")


def _plan(client, inv, *, count, start):
    return client.post(f"/api/invoices/{inv}/plan", json={
        "count": count, "start_date": start, "frequency": "monthly"})


def _account_plan(client, cid, *, count, start):
    return client.post(f"/api/clients/{cid}/plan", json={
        "count": count, "start_date": start, "frequency": "monthly"})


def _notifications(client, type=None):
    body = client.get("/api/notifications/").json()
    rows = body if isinstance(body, list) else (
        body.get("rows") or body.get("notifications") or [])
    return [n for n in rows if type is None or n.get("type") == type]


def _in(days):
    """A date `days` from the SERVER's today, not this process's.

    The server stamps every date in UTC, as it does everywhere else in this
    system. For the few hours a night when UTC and local disagree, a schedule
    built from the local date is one day out from the one the reminder sweep
    is reading — and the test fails for a reason that has nothing to do with
    reminders.
    """
    from utils import _today
    base = date.fromisoformat(_today()[:10])
    return (base + timedelta(days=days)).isoformat()


# ── An invoice plan, before the date ─────────────────────────────────────────

def test_an_instalment_due_today_is_raised(client, acme):
    inv = _invoice(client, acme)
    _plan(client, inv, count=3, start=_in(0))

    due = _notifications(client, "installment_due_soon")

    assert len(due) == 1, "the one falling due today"
    assert due[0]["entity_type"] == "invoice_installment"
    assert "due today" in (due[0]["body"] or "")


def test_it_links_to_the_invoice_it_is_on(client, acme):
    inv = _invoice(client, acme)
    _plan(client, inv, count=3, start=_in(0))

    assert _notifications(client, "installment_due_soon")[0]["link"] \
        == f"/invoices/{inv}"


def test_an_instalment_a_couple_of_days_out_is_raised(client, acme):
    """A customer rung two days out usually pays."""
    inv = _invoice(client, acme)
    _plan(client, inv, count=3, start=_in(2))

    due = _notifications(client, "installment_due_soon")

    assert len(due) == 1
    assert "in 2d" in (due[0]["body"] or "")


def test_one_still_weeks_away_is_left_alone(client, acme):
    """A reminder three weeks early is noise by the time it matters."""
    inv = _invoice(client, acme)
    _plan(client, inv, count=3, start=_in(21))

    assert _notifications(client, "installment_due_soon") == []


def test_a_date_that_has_passed_is_a_different_notification(client, acme):
    """Coming up is a phone call; passed is a debt. Collapsing them into one
    alert leaves nobody knowing which they are looking at."""
    inv = _invoice(client, acme)
    _plan(client, inv, count=1, start=_in(-5))

    assert len(_notifications(client, "installment_overdue")) == 1
    assert _notifications(client, "installment_due_soon") == []


def test_a_settled_instalment_is_not_chased(client, acme):
    inv = _invoice(client, acme, amount=900)
    _plan(client, inv, count=3, start=_in(0))
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 300, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    assert _notifications(client, "installment_due_soon") == []


def test_the_same_reminder_is_not_raised_twice_in_a_day(client, acme):
    inv = _invoice(client, acme)
    _plan(client, inv, count=3, start=_in(0))

    _notifications(client)
    _notifications(client)

    assert len(_notifications(client, "installment_due_soon")) == 1


# ── An account plan, which nothing used to see ───────────────────────────────

def test_an_account_plan_instalment_due_today_is_raised(client, acme):
    _invoice(client, acme, amount=4000)
    _account_plan(client, acme, count=8, start=_in(0))

    due = _notifications(client, "account_plan_due_soon")

    assert len(due) == 1
    assert due[0]["entity_type"] == "client_plan_installment"


def test_it_links_to_the_customer_whose_account_it_is(client, acme):
    """There is no invoice to send them to: the plan is against the account."""
    _invoice(client, acme, amount=4000)
    _account_plan(client, acme, count=8, start=_in(0))

    assert _notifications(client, "account_plan_due_soon")[0]["link"] \
        == f"/clients/{acme}"


def test_an_account_plan_in_arrears_is_chased_per_instalment(client, acme):
    _invoice(client, acme, amount=4000)
    _account_plan(client, acme, count=8, start=_in(-70))

    late = _notifications(client, "account_plan_overdue")

    assert len(late) == 3, "three dates have passed"


def test_paying_stops_the_oldest_being_chased(client, acme):
    """Which instalments are settled is derived from what has been paid, so a
    payment silences the reminder without anything marking a row."""
    _invoice(client, acme, amount=4000)
    _account_plan(client, acme, count=8, start=_in(-70))
    client.post(f"/api/clients/{acme}/payments", json={
        "amount": 500, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    assert len(_notifications(client, "account_plan_overdue")) == 2


def test_a_cancelled_plan_stops_reminding(client, acme):
    """The agreement ended. Chasing dates nobody is on any more is how a
    customer gets rung about a schedule that was torn up."""
    _invoice(client, acme, amount=4000)
    _account_plan(client, acme, count=8, start=_in(0))
    client.delete(f"/api/clients/{acme}/plan")

    assert _notifications(client, "account_plan_due_soon") == []


# ── Reading it ───────────────────────────────────────────────────────────────

def test_the_reminder_says_which_instalment_and_how_much(client, acme):
    inv = _invoice(client, acme, amount=900)
    _plan(client, inv, count=3, start=_in(0))

    n = _notifications(client, "installment_due_soon")[0]

    assert "1" in n["title"]
    assert "300" in (n["body"] or "")


def test_it_reads_in_arabic(client, acme):
    """Stored English is the fallback; the list re-renders from the message
    key, and a reminder that arrives in English for an Arabic operator is one
    they have to decode before acting on."""
    inv = _invoice(client, acme)
    _plan(client, inv, count=3, start=_in(0))
    client.get("/api/notifications/")

    body = client.get("/api/notifications/", params={"lang": "ar"}).json()
    rows = body if isinstance(body, list) else (
        body.get("rows") or body.get("notifications") or [])
    n = next(r for r in rows if r["type"] == "installment_due_soon")

    assert any("؀" <= ch <= "ۿ" for ch in n["title"])
