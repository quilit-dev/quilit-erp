"""Putting a customer's whole account on terms.

Two different things go by "instalments" and the customer setting only governs
one of them.

A plan on ONE invoice is a negotiation about one document — splitting a large
sale into agreed dates — and is available for anybody. A plan on the ACCOUNT is
a standing credit arrangement: the customer owes several bills and agrees to
clear the lot over N payments. That is the one the checkbox decides.

The schedule is built once over the combined balance and walked across the
invoices oldest first, so each ends up with rows the rest of the system already
understands. Nothing downstream learns a new concept.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _client(client, name="Account Co", **kw):
    body = {"name": name}
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


PLAN = {"count": 4, "frequency": "monthly", "start_date": "2026-04-01"}


# ── The setting governs the account, not the invoice ─────────────────────────

def test_an_unapproved_customer_cannot_put_their_account_on_terms(client):
    cid = _client(client, name="Unapproved Ltd", allow_installments=False)
    _invoice(client, cid, 400, "2026-01-31")

    r = _pay(client, cid, 100, plan=PLAN)

    assert r.status_code == 400
    assert "Unapproved Ltd" in r.text
    assert "not approved" in r.text.lower()


def test_the_refusal_leaves_no_payment_behind(client, db):
    """Checked before anything is written. A refusal that had already taken
    the money would be worse than one that took the plan."""
    cid = _client(client, allow_installments=False)
    _invoice(client, cid, 400, "2026-01-31")

    _pay(client, cid, 100, plan=PLAN)

    n = db.execute("SELECT COUNT(*) AS n FROM invoice_payments").fetchone()["n"]
    assert n == 0


def test_an_unapproved_customer_can_still_just_pay(client):
    """The setting is about terms, not about taking their money."""
    cid = _client(client, allow_installments=False)
    _invoice(client, cid, 400, "2026-01-31")

    assert _pay(client, cid, 100).status_code == 200


def test_an_approved_customer_can(client):
    cid = _client(client, allow_installments=True)
    _invoice(client, cid, 400, "2026-01-31")

    r = _pay(client, cid, 100, plan=PLAN)

    assert r.status_code == 200, r.text
    assert r.json()["plan"]["instalments"] == 4


# ── What the schedule actually covers ────────────────────────────────────────

def test_it_schedules_what_is_left_after_the_payment(client):
    """They paid 100 of 400, so 300 goes on the dates."""
    cid = _client(client, allow_installments=True)
    _invoice(client, cid, 400, "2026-01-31")

    body = _pay(client, cid, 100, plan=PLAN).json()

    assert body["plan"]["total"] == _pytest.approx(300)


def test_one_schedule_spans_several_invoices(client):
    """The customer agreed four payments for everything they owe, not four
    payments per bill."""
    cid = _client(client, allow_installments=True)
    a = _invoice(client, cid, 300, "2026-01-31")
    b = _invoice(client, cid, 500, "2026-02-28")

    body = _pay(client, cid, 100, plan=PLAN).json()

    assert body["plan"]["total"] == _pytest.approx(700)
    assert {i["invoice_id"] for i in body["plan"]["invoices"]} == {a, b}


def test_each_invoice_reads_back_through_the_ordinary_plan_screen(client):
    """One plan model. The invoice screen, the statement and arrears reporting
    all read this without knowing it came from the account."""
    cid = _client(client, allow_installments=True)
    inv = _invoice(client, cid, 400, "2026-01-31")
    _pay(client, cid, 100, plan=PLAN)

    body = client.get(f"/api/invoices/{inv}/plan").json()

    assert body["installments"]
    assert body["next_due"] is not None


def test_a_part_paid_invoice_opens_with_what_is_already_settled(client):
    """The engine decides which instalments are covered by comparing
    cumulative paid against cumulative scheduled. A schedule that ignored the
    money already received would show settled instalments as outstanding for
    ever."""
    cid = _client(client, allow_installments=True)
    inv = _invoice(client, cid, 400, "2026-01-31")
    _pay(client, cid, 100, plan=PLAN)

    rows = client.get(f"/api/invoices/{inv}/plan").json()["installments"]

    assert rows[0]["amount"] == _pytest.approx(100)
    assert rows[0]["status"] == "Paid"
    assert sum(r["amount"] for r in rows) == _pytest.approx(400)


def test_the_rows_of_each_invoice_add_up_to_its_total(client):
    """Anything less and the invoice carries a plan that cannot settle it."""
    cid = _client(client, allow_installments=True)
    a = _invoice(client, cid, 300, "2026-01-31")
    b = _invoice(client, cid, 500, "2026-02-28")
    _pay(client, cid, 200, plan=PLAN)

    for inv, total in ((a, 300), (b, 500)):
        rows = client.get(f"/api/invoices/{inv}/plan").json()["installments"]
        assert sum(r["amount"] for r in rows) == _pytest.approx(total), inv


def test_an_instalment_can_finish_one_invoice_and_start_the_next(client):
    """Which is what happens when the money arrives and is allocated oldest
    first, so the schedule should say so."""
    cid = _client(client, allow_installments=True)
    a = _invoice(client, cid, 100, "2026-01-31")
    b = _invoice(client, cid, 900, "2026-02-28")

    body = _pay(client, cid, 50,
                plan={"count": 2, "start_date": "2026-04-01"}).json()

    assert body["plan"]["instalments"] == 2
    # 950 outstanding over two payments: the first covers the rest of A and
    # spills into B.
    assert len(client.get(f"/api/invoices/{a}/plan").json()["installments"]) >= 1
    assert client.get(f"/api/invoices/{b}/plan").json()["installments"]


# ── Refusals ─────────────────────────────────────────────────────────────────

def test_a_customer_with_nothing_outstanding_cannot_be_scheduled(client):
    cid = _client(client, allow_installments=True)
    _invoice(client, cid, 100, "2026-01-31")

    r = _pay(client, cid, 100, plan=PLAN)

    assert r.status_code == 400
    assert "nothing outstanding" in r.text.lower()


def test_an_agreement_already_being_kept_is_not_overwritten(client):
    """A plan with money against it is an agreement in progress. Replacing it
    silently would re-interpret what the customer has already settled."""
    cid = _client(client, allow_installments=True)
    inv = _invoice(client, cid, 400, "2026-01-31")
    client.post(f"/api/invoices/{inv}/plan", json={"count": 4, "start_date": "2026-02-01"})
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 50, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    r = _pay(client, cid, 25, plan=PLAN)

    assert r.status_code == 400
    assert "already on a plan" in r.text.lower()


def test_the_books_still_balance_afterwards(client):
    """A schedule is a set of dates, not an accounting event. Nothing about
    the ledger should move because one was agreed."""
    cid = _client(client, allow_installments=True)
    _invoice(client, cid, 400, "2026-01-31")
    before = client.get("/api/accounting/trial-balance").json()

    _pay(client, cid, 100, plan=PLAN)

    after = client.get("/api/accounting/trial-balance").json()
    assert after["balanced"] and before["balanced"]
    # The trial balance nets each account, so its total does not grow — what
    # changes is where the money sits. Cash arrived and the claim shrank.
    def bal(tb, code):
        r = next((x for x in tb["rows"] if x["code"] == code), None)
        return 0 if not r else round(float(r["debit"]) - float(r["credit"]), 2)
    assert bal(after, "1000") == _pytest.approx(bal(before, "1000") + 100, abs=0.01)
    assert bal(after, "1100") == _pytest.approx(bal(before, "1100") - 100, abs=0.01)


def test_agreeing_terms_is_written_to_the_audit_trail(client, db):
    cid = _client(client, allow_installments=True)
    _invoice(client, cid, 400, "2026-01-31")

    _pay(client, cid, 100, plan=PLAN)

    row = db.execute("SELECT * FROM audit_log WHERE action='plan' "
                     "AND module='client' ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None
    assert "instalments" in (row["detail"] or "")
