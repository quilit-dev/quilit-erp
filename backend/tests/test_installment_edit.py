"""Editing a schedule that is already running.

Terms get renegotiated. A customer three payments into a plan asks to stretch
the rest, or to move a date past a month they know will be thin. Until now the
only answer was no: `POST /plan` regenerates the whole schedule from a count and
a frequency, and because settlement is DERIVED from cumulative paid against
cumulative scheduled, regenerating re-reads what has already been settled —
three of twelve silently becomes one of five, and the customer's receipts stop
matching their statement. So the endpoint refused outright once any money had
arrived.

The edit states the rows instead of the shape to generate them from, and freezes
the part money has reached. Two properties carry the whole design:

  * the schedule still sums to the invoice, to the cent;
  * every instalment already paid against reads EXACTLY as it did before —
    same date, same amount, same allocation.

The second is the one worth guarding hardest, because it is silent when wrong.
Nothing here moves money: the schedule carries no accounting, which is precisely
why this is safe on a plan with payments where a rebuild is not.
"""
import json
import uuid

import pytest


def _invoice(c, amount=1200, paid=0):
    cl = c.post("/api/clients/", json={"name": f"IE {uuid.uuid4().hex[:6]}"}).json()["id"]
    inv = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "Job", "quantity": 1, "unit_price": amount}]})
    assert inv.status_code in (200, 201), inv.text
    invoice_id = inv.json()["id"]
    if paid:
        r = c.post(f"/api/invoices/{invoice_id}/payments", json={
            "amount": paid, "method": "Cash", "idempotency_key": str(uuid.uuid4())})
        assert r.status_code == 200, r.text
    return invoice_id


def _plan(c, invoice_id, count=4, start="2026-01-15", **extra):
    r = c.post(f"/api/invoices/{invoice_id}/plan",
               json={"count": count, "start_date": start, **extra})
    assert r.status_code == 200, r.text
    return r.json()["installments"]


def _get(c, invoice_id):
    r = c.get(f"/api/invoices/{invoice_id}/plan")
    assert r.status_code == 200, r.text
    return r.json()["installments"]


def _edit(c, invoice_id, rows):
    return c.patch(f"/api/invoices/{invoice_id}/plan",
                   json={"installments": rows})


def _same(plan):
    """A row as the customer reads it, allocation included."""
    return [(r["due_date"], r["amount"], r["paid"], r["remaining"], r["status"])
            for r in plan]


def _keep(rows):
    return [{"due_date": r["due_date"], "amount": r["amount"]} for r in rows]


# ── the ordinary case ───────────────────────────────────────────────────────
def test_a_date_can_be_moved(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1200)
    rows = _keep(_plan(c, inv, count=4))

    rows[2]["due_date"] = "2026-03-28"
    r = _edit(c, inv, rows)
    assert r.status_code == 200, r.text

    after = _get(c, inv)[2]
    assert (after["due_date"], after["amount"]) == ("2026-03-28", 300.0)


def test_the_remainder_can_be_reshaped_entirely(make_client):
    """Four payments become six, on new dates, for new amounts."""
    c = make_client("superadmin")
    inv = _invoice(c, 1200)
    _plan(c, inv, count=4)

    rows = [{"due_date": f"2026-{m:02d}-01", "amount": 200} for m in range(1, 7)]
    assert _edit(c, inv, rows).status_code == 200

    after = _get(c, inv)
    assert len(after) == 6
    assert [r["seq"] for r in after] == [1, 2, 3, 4, 5, 6]
    assert sum(r["amount"] for r in after) == pytest.approx(1200)


def test_a_note_rides_along(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)
    assert _edit(c, inv, [
        {"due_date": "2026-01-15", "amount": 500, "note": "agreed by phone"},
        {"due_date": "2026-02-15", "amount": 500}]).status_code == 200

    assert _get(c, inv)[0]["note"] == "agreed by phone"


# ── the part money has reached ──────────────────────────────────────────────
def test_a_settled_instalment_cannot_be_rewritten(make_client):
    """The receipt in the customer's hand has to go on matching the schedule."""
    c = make_client("superadmin")
    inv = _invoice(c, 1200, paid=300)          # instalment 1 of 4 settled
    plan = _plan(c, inv, count=4)
    assert plan[0]["status"] == "Paid"

    rows = _keep(plan)
    rows[0]["amount"] = 150
    rows[1]["amount"] = 450
    r = _edit(c, inv, rows)
    assert r.status_code == 400
    assert "already been paid against" in r.text


def test_nor_can_its_date_move(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1200, paid=300)
    rows = _keep(_plan(c, inv, count=4))

    rows[0]["due_date"] = "2026-06-01"
    assert _edit(c, inv, rows).status_code == 400


def test_a_partly_paid_instalment_is_frozen_too(make_client):
    """Money has reached it, so it is a record, not still an offer."""
    c = make_client("superadmin")
    inv = _invoice(c, 1200, paid=400)          # 1 settled, a third of 2
    plan = _plan(c, inv, count=4)
    assert plan[1]["paid"] == pytest.approx(100)

    rows = _keep(plan)
    rows[1]["amount"] = 200
    rows[3]["amount"] = 400
    assert _edit(c, inv, rows).status_code == 400


def test_the_instalments_still_to_come_can_be_reshaped(make_client):
    """The whole point: renegotiate the future, leave the past alone."""
    c = make_client("superadmin")
    inv = _invoice(c, 1200, paid=300)
    plan = _plan(c, inv, count=4)

    rows = _keep(plan[:1])
    rows += [{"due_date": f"2026-{m:02d}-20", "amount": 150} for m in range(5, 11)]
    r = _edit(c, inv, rows)
    assert r.status_code == 200, r.text

    after = _get(c, inv)
    assert len(after) == 7
    assert sum(x["amount"] for x in after) == pytest.approx(1200)


def test_what_was_settled_reads_the_same_afterwards(make_client):
    """The invariant the whole design exists to protect.

    Not merely that the frozen rows kept their numbers — that their ALLOCATION
    is unchanged, which is what the customer sees and what the arrears sweep
    reads.
    """
    c = make_client("superadmin")
    inv = _invoice(c, 1200, paid=600)          # two of four settled
    plan = _plan(c, inv, count=4)
    before = plan[:2]
    assert [r["status"] for r in before] == ["Paid", "Paid"]

    rows = _keep(before) + [{"due_date": "2026-09-30", "amount": 200},
                            {"due_date": "2026-10-31", "amount": 200},
                            {"due_date": "2026-11-30", "amount": 200}]
    assert _edit(c, inv, rows).status_code == 200

    assert _same(_get(c, inv)[:2]) == _same(before)


def test_the_paid_instalments_cannot_be_dropped(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1200, paid=600)
    _plan(c, inv, count=4)

    r = _edit(c, inv, [{"due_date": "2026-12-01", "amount": 1200}])
    assert r.status_code == 400
    assert "cannot be removed" in r.text


# ── it still has to add up ──────────────────────────────────────────────────
def test_the_plan_must_sum_to_the_invoice(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1200)
    _plan(c, inv, count=4)

    r = _edit(c, inv, [{"due_date": "2026-01-01", "amount": 500},
                       {"due_date": "2026-02-01", "amount": 500}])
    assert r.status_code == 400
    assert "1,000.00" in r.text and "1,200.00" in r.text


def test_a_cent_of_rounding_is_tolerated_but_a_dollar_is_not(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=3)

    thirds = [{"due_date": "2026-01-01", "amount": 333.33},
              {"due_date": "2026-02-01", "amount": 333.33},
              {"due_date": "2026-03-01", "amount": 333.34}]
    assert _edit(c, inv, thirds).status_code == 200
    thirds[2]["amount"] = 334.34
    assert _edit(c, inv, thirds).status_code == 400


@pytest.mark.parametrize("amount", [0, -50])
def test_an_instalment_must_be_for_something(make_client, amount):
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)

    r = _edit(c, inv, [{"due_date": "2026-01-01", "amount": 1000 - amount},
                       {"due_date": "2026-02-01", "amount": amount}])
    assert r.status_code == 400
    assert "more than zero" in r.text


def test_an_empty_schedule_is_not_an_edit(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)
    assert _edit(c, inv, []).status_code == 400
    assert len(_get(c, inv)) == 2


def test_the_dates_must_run_forwards(make_client):
    """Out of order, the schedule disagrees with the order it is settled in."""
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)

    r = _edit(c, inv, [{"due_date": "2026-06-01", "amount": 500},
                       {"due_date": "2026-02-01", "amount": 500}])
    assert r.status_code == 400
    assert "date order" in r.text


def test_a_date_that_is_not_a_date_is_refused(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)
    r = _edit(c, inv, [{"due_date": "next tuesday", "amount": 500},
                       {"due_date": "2026-02-01", "amount": 500}])
    assert r.status_code == 400


# ── the invoice it belongs to ───────────────────────────────────────────────
def test_there_must_be_a_plan_to_edit(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    r = _edit(c, inv, [{"due_date": "2026-01-01", "amount": 1000}])
    assert r.status_code == 404
    assert "no payment plan" in r.text


def test_a_voided_invoice_carries_no_plan(make_client):
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)
    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "test"}).status_code == 200

    r = _edit(c, inv, [{"due_date": "2026-01-01", "amount": 1000}])
    assert r.status_code == 400


def test_a_missing_invoice_is_a_404(make_client):
    c = make_client("superadmin")
    assert _edit(c, 999999,
                 [{"due_date": "2026-01-01", "amount": 10}]).status_code == 404


# ── nothing else moved ──────────────────────────────────────────────────────
def test_no_money_moves(make_client):
    """The schedule carries no accounting; an edit must prove it."""
    c = make_client("superadmin")
    inv = _invoice(c, 1200, paid=300)
    plan = _plan(c, inv, count=4)

    def snapshot():
        tb = c.get("/api/accounting/trial-balance").json()["rows"]
        body = c.get(f"/api/invoices/{inv}").json()
        return ({r["code"]: (r["debit"], r["credit"]) for r in tb},
                body["total_paid"], body["amount"])

    before = snapshot()
    rows = _keep(plan[:1]) + [{"due_date": "2027-01-01", "amount": 900}]
    assert _edit(c, inv, rows).status_code == 200
    assert snapshot() == before


def test_the_invoice_due_date_follows_the_last_instalment(make_client):
    """As on creation — so anything reading a single date says when it ends."""
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)
    assert _edit(c, inv, [{"due_date": "2026-03-01", "amount": 400},
                          {"due_date": "2027-07-19", "amount": 600}]).status_code == 200

    assert c.get(f"/api/invoices/{inv}").json()["due_date"][:10] == "2027-07-19"


def test_the_edit_is_logged_with_both_shapes(make_client, db):
    """A renegotiation is exactly the kind of change somebody asks about later."""
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)
    assert _edit(c, inv,
                 [{"due_date": "2026-05-01", "amount": 1000}]).status_code == 200

    row = db.execute(
        "SELECT action, detail FROM audit_log WHERE module='invoice' "
        "AND record_id=? AND action='plan_edited' ORDER BY id DESC LIMIT 1",
        (inv,)).fetchone()
    assert row is not None, "the edit left no audit trail"
    details = json.loads(row["detail"])
    assert len(details["was"]) == 2, "the schedule it replaced was not recorded"
    assert details["now"] == [{"due_date": "2026-05-01", "amount": 1000.0}]


def test_removing_the_plan_afterwards_still_behaves(make_client):
    """The DELETE guard reads payments, not the schedule, and is unaffected."""
    c = make_client("superadmin")
    inv = _invoice(c, 1000)
    _plan(c, inv, count=2)
    assert _edit(c, inv,
                 [{"due_date": "2026-05-01", "amount": 1000}]).status_code == 200
    assert c.delete(f"/api/invoices/{inv}/plan").status_code == 200
    assert _get(c, inv) == []


# ── the pure rules, without a database ──────────────────────────────────────
def test_frozen_count_walks_the_prefix():
    import installments
    rows = [{"amount": 100}, {"amount": 100}, {"amount": 100}]
    assert installments.frozen_count(rows, 0) == 0
    assert installments.frozen_count(rows, 50) == 1
    assert installments.frozen_count(rows, 100) == 1
    assert installments.frozen_count(rows, 100.004) == 1
    assert installments.frozen_count(rows, 150) == 2
    assert installments.frozen_count(rows, 300) == 3


def test_frozen_count_never_runs_past_the_schedule():
    """An overpayment must not index off the end."""
    import installments
    assert installments.frozen_count([{"amount": 100}], 5000) == 1
