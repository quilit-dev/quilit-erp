"""A payment plan against the customer's ACCOUNT.

A customer owing 4,000 who agrees to eight payments of 500 has agreed one
thing. The plan is theirs, not their invoices': it tracks the account balance,
and each payment against it is an ordinary account payment allocated
oldest-first across whatever is open at the time.

That separation is the whole design, and it is what makes it survive contact
with a real ledger. An invoice raised after the plan is part of the balance the
plan is working down. One voided does not tear a hole in a schedule. And the
customer can be shown the eight payments they agreed to, because that is what
is stored.

Two different things still go by "instalments": a plan on ONE invoice is a
negotiation about one document and is available to anybody. This is the other,
and the customer's own setting decides who may have it.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _client(client, name="Account Co", **kw):
    body = {"name": name, "allow_installments": True}
    body.update(kw)
    return client.post("/api/clients/", json=body).json()["id"]


def _invoice(client, cid, amount, due):
    r = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": due,
        "items": [{"name": "Goods", "quantity": 1, "unit_price": amount}]}).json()
    return r.get("invoice_id") or r.get("id")


def _pay(client, cid, amount, plan=None):
    body = {"amount": amount, "method": "Cash", "currency": "USD",
            "idempotency_key": str(uuid.uuid4())}
    if plan is not None:
        body["installment_plan"] = plan
    return client.post(f"/api/clients/{cid}/payments", json=body)


def _plan(client, cid):
    return client.get(f"/api/clients/{cid}/plan").json()


def _owing(client, inv):
    return client.get(f"/api/invoices/{inv}").json()["remaining"]


FAR = "2099-01-01"      # terms agreed for dates still to come


# ── The example from the brief ───────────────────────────────────────────────

def test_four_thousand_over_eight_payments_of_five_hundred(client):
    """The customer owes 4,000 and agrees to eight of 500. That is what is
    stored and that is what they are shown."""
    cid = _client(client)
    _invoice(client, cid, 2500, "2026-01-31")
    _invoice(client, cid, 1500, "2026-02-28")

    r = _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})
    assert r.status_code == 200, r.text

    plan = _plan(client, cid)["plan"]
    assert plan["count"] == 8
    assert plan["total"] == _pytest.approx(3999.99, abs=0.02)
    assert all(i["amount"] == _pytest.approx(500, abs=0.02)
               for i in plan["installments"])


def test_the_plan_is_against_the_account_not_the_invoices(client):
    """No invoice carries a schedule. The plan is the customer's."""
    cid = _client(client)
    a = _invoice(client, cid, 2500, "2026-01-31")
    b = _invoice(client, cid, 1500, "2026-02-28")

    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    for inv in (a, b):
        assert client.get(f"/api/invoices/{inv}/plan").json()["installments"] == []


def test_paying_an_instalment_is_allocated_oldest_first(client):
    """Each payment behaves exactly like any other account payment."""
    cid = _client(client)
    a = _invoice(client, cid, 300, "2026-01-31")
    b = _invoice(client, cid, 700, "2026-02-28")
    _pay(client, cid, 0.01, plan={"count": 4, "start_date": FAR})

    _pay(client, cid, 500)

    assert _owing(client, a) == _pytest.approx(0, abs=0.02)
    assert _owing(client, b) == _pytest.approx(500, abs=0.02)


def test_the_plan_tracks_what_has_been_paid_against_it(client):
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    _pay(client, cid, 500)
    _pay(client, cid, 500)

    plan = _plan(client, cid)["plan"]
    assert plan["paid"] == _pytest.approx(1000.01, abs=0.02)
    assert plan["remaining"] == _pytest.approx(2999.98, abs=0.05)


def test_settled_instalments_are_derived_from_the_payments(client):
    """Nothing marks an instalment paid, so nothing can disagree with the
    money. A thousand settles the first two."""
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    _pay(client, cid, 1000)

    rows = _plan(client, cid)["plan"]["installments"]
    assert [r["status"] for r in rows[:2]] == ["Paid", "Paid"]
    assert rows[2]["status"] == "Due"


def test_a_part_payment_leaves_that_instalment_partial(client):
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    _pay(client, cid, 700)

    rows = _plan(client, cid)["plan"]["installments"]
    assert rows[0]["status"] == "Paid"
    assert rows[1]["status"] == "Partial"


def test_the_next_payment_due_is_named(client):
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})
    _pay(client, cid, 500)

    nxt = _plan(client, cid)["plan"]["next_due"]

    assert nxt["seq"] == 2


# ── The account and the plan are two figures ─────────────────────────────────

def test_an_invoice_raised_after_the_plan_is_outstanding_but_not_scheduled(client):
    """The case that makes conflating them wrong. The customer owes more than
    the plan covers, and the screen has to be able to say so."""
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    _invoice(client, cid, 600, "2026-06-30")

    body = _plan(client, cid)
    assert body["plan"]["total"] == _pytest.approx(3999.99, abs=0.02)
    assert body["outstanding"] == _pytest.approx(4599.99, abs=0.02)


def test_voiding_an_invoice_does_not_damage_the_schedule(client):
    """Under the old shape the schedule lived on the invoices, so this tore a
    hole in it."""
    cid = _client(client)
    a = _invoice(client, cid, 1000, "2026-01-31")
    _invoice(client, cid, 3000, "2026-02-28")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    client.patch(f"/api/invoices/{a}/void", json={"reason": "cancelled"})

    plan = _plan(client, cid)["plan"]
    assert plan["count"] == 8
    assert plan["total"] == _pytest.approx(3999.99, abs=0.02)


# ── Who may have one ─────────────────────────────────────────────────────────

def test_an_unapproved_customer_cannot_put_their_account_on_terms(client):
    cid = _client(client, name="Unapproved Ltd", allow_installments=False)
    _invoice(client, cid, 4000, "2026-01-31")

    r = _pay(client, cid, 100, plan={"count": 8})

    assert r.status_code == 400
    assert "Unapproved Ltd" in r.text
    assert "not approved" in r.text.lower()


def test_the_refusal_leaves_no_payment_behind(client, db):
    cid = _client(client, allow_installments=False)
    _invoice(client, cid, 4000, "2026-01-31")

    _pay(client, cid, 100, plan={"count": 8})

    assert db.execute("SELECT COUNT(*) AS n FROM invoice_payments").fetchone()["n"] == 0


def test_an_unapproved_customer_can_still_just_pay(client):
    """The setting is about terms, not about taking their money."""
    cid = _client(client, allow_installments=False)
    _invoice(client, cid, 4000, "2026-01-31")

    assert _pay(client, cid, 100).status_code == 200


def test_a_plan_on_one_invoice_is_still_available_to_anybody(client):
    """The other kind of instalment, and a different decision."""
    cid = _client(client, allow_installments=False)
    inv = _invoice(client, cid, 4000, "2026-01-31")

    r = client.post(f"/api/invoices/{inv}/plan",
                    json={"count": 4, "start_date": "2026-03-01"})

    assert r.status_code == 200, r.text


# ── Refusals and lifecycle ───────────────────────────────────────────────────

def test_two_live_plans_are_refused(client):
    """Two agreements about one balance is not something anybody agreed to."""
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    r = _pay(client, cid, 100, plan={"count": 4, "start_date": FAR})

    assert r.status_code == 400
    assert "already on a payment plan" in r.text.lower()


def test_a_payment_that_clears_the_account_leaves_nothing_to_schedule(client):
    cid = _client(client)
    _invoice(client, cid, 400, "2026-01-31")

    r = _pay(client, cid, 400, plan={"count": 4})

    assert r.status_code == 400
    assert "nothing left to schedule" in r.text.lower()


def test_cancelling_leaves_the_payments_alone(client):
    """Every payment was allocated to invoices when it was taken. The terms
    lapsing does not undo that."""
    cid = _client(client)
    inv = _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})
    _pay(client, cid, 500)
    owed = _owing(client, inv)

    r = client.delete(f"/api/clients/{cid}/plan")

    assert r.status_code == 200, r.text
    assert _plan(client, cid)["plan"] is None
    assert _owing(client, inv) == _pytest.approx(owed)


def test_a_new_plan_can_be_agreed_after_cancelling(client):
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})
    client.delete(f"/api/clients/{cid}/plan")

    r = _pay(client, cid, 100, plan={"count": 4, "start_date": FAR})

    assert r.status_code == 200, r.text
    assert _plan(client, cid)["plan"]["count"] == 4


def test_cancelling_when_there_is_no_plan_says_so(client):
    cid = _client(client)

    assert client.delete(f"/api/clients/{cid}/plan").status_code == 404


def test_a_customer_with_no_plan_reads_back_cleanly(client):
    cid = _client(client)
    _invoice(client, cid, 400, "2026-01-31")

    body = _plan(client, cid)

    assert body["plan"] is None
    assert body["outstanding"] == _pytest.approx(400)


def test_agreeing_terms_posts_nothing_beyond_the_payment(client):
    """A schedule is a set of dates. Only the payment moved money."""
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")
    before = len(client.get("/api/accounting/journal-entries").json()["rows"])

    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    after = client.get("/api/accounting/journal-entries").json()["rows"]
    assert len(after) == before + 1
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_agreeing_terms_is_written_to_the_audit_trail(client, db):
    cid = _client(client)
    _invoice(client, cid, 4000, "2026-01-31")

    _pay(client, cid, 0.01, plan={"count": 8, "start_date": FAR})

    row = db.execute("SELECT * FROM audit_log WHERE action='plan' "
                     "AND module='client' ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None
