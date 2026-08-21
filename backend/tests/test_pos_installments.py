"""A till sale the customer takes away today and pays for over time.

That is what an instalment sale is here: the goods leave at the counter, and
the balance becomes a claim on the customer. So the stock path is untouched —
these tests pin that — and everything new is about the money.

Nothing new was invented to post it. An instalment sale raises a receivable
exactly as a credit invoice does, and the deposit then travels the ordinary
payment path, which already knows how to turn a receivable into cash and earn
only the revenue actually received. The tests care most about that: the books
after a plan must be the same shape as the books after any credit sale.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def cashier(client):
    """An open register session, which every sale requires."""
    client.post("/api/pos/session/open", json={"opening_float": 0})
    return client


@_pytest.fixture
def buyer(client):
    return client.post("/api/clients/", json={"name": "Instalment Buyer"}).json()["id"]


@_pytest.fixture
def widget(client):
    return client.post("/api/inventory/", json={
        "name": "Widget", "quantity": 10, "unit_price": 300,
        "unit_cost": 100, "category": "Goods"}).json()["id"]


def _sell(c, buyer, widget, *, plan=None, tendered=None, qty=1, price=300):
    body = {
        "client_id": buyer,
        "items": [{"name": "Widget", "inventory_id": widget,
                   "quantity": qty, "unit_price": price}],
        "payment_method": "Cash", "currency": "USD",
        "amount_tendered": price * qty if tendered is None else tendered,
        "idempotency_key": str(uuid.uuid4()),
    }
    if plan is not None:
        body["installment_plan"] = plan
    return c.post("/api/pos/checkout", json=body)


def _stock(c, widget):
    return c.get(f"/api/inventory/{widget}").json()["quantity"]


PLAN = {"down_payment": 100, "count": 4, "frequency": "monthly",
        "start_date": "2026-04-01"}


# ── The goods leave, exactly as they always did ──────────────────────────────

def test_the_customer_takes_the_goods_away(cashier, buyer, widget):
    """An instalment sale is not a reservation. The stock path must not change."""
    before = _stock(cashier, widget)

    r = _sell(cashier, buyer, widget, plan=PLAN, tendered=100)

    assert r.status_code == 200, r.text
    assert _stock(cashier, widget) == before - 1


def test_cost_of_goods_is_recognised_at_the_till(cashier, buyer, widget):
    """The goods are gone, so their cost is gone with them — regardless of how
    much of the price has been collected."""
    r = _sell(cashier, buyer, widget, plan=PLAN, tendered=100)

    assert r.json()["cogs_total"] > 0


# ── The money ────────────────────────────────────────────────────────────────

def test_only_the_deposit_is_taken(cashier, buyer, widget):
    r = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()

    assert r["paid_now"] == 100
    assert r["balance"] == 200
    assert r["payment_status"] == "Partial"


def test_the_invoice_shows_the_balance_still_owed(cashier, buyer, widget):
    inv = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()["invoice_id"]

    body = cashier.get(f"/api/invoices/{inv}").json()

    assert body["remaining"] == _pytest.approx(200)


def test_the_schedule_is_the_deposit_plus_the_instalments_agreed(cashier, buyer, widget):
    """"$100 down then four monthly" is five rows. The deposit does not eat an
    instalment."""
    r = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()

    rows = r["installments"]
    assert len(rows) == 5
    assert rows[0]["amount"] == 100
    assert sum(i["amount"] for i in rows) == _pytest.approx(300)


def test_the_plan_reads_back_through_the_ordinary_invoice_screen(cashier, buyer, widget):
    """One plan model. A POS plan must be readable by everything that already
    reads plans, without knowing it came from a till."""
    inv = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()["invoice_id"]

    body = cashier.get(f"/api/invoices/{inv}/plan").json()

    assert len(body["installments"]) == 5
    assert body["next_due"] is not None


# ── The books ────────────────────────────────────────────────────────────────

def test_the_ledger_balances(cashier, buyer, widget):
    _sell(cashier, buyer, widget, plan=PLAN, tendered=100)

    assert cashier.get("/api/accounting/trial-balance").json()["balanced"]


def test_the_unpaid_balance_is_a_receivable(cashier, buyer, widget):
    """The whole point: the customer owes money, and the balance sheet has to
    say so. An ordinary till sale has no receivable at all."""
    inv = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()["invoice_id"]

    entries = cashier.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]

    assert any(e["source_type"] == "invoice" for e in entries), \
        "an instalment sale must raise a receivable"


def test_an_ordinary_till_sale_still_posts_exactly_as_before(cashier, buyer, widget):
    """The regression that would matter most: every cash sale in the shop."""
    inv = _sell(cashier, buyer, widget).json()["invoice_id"]

    entries = cashier.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]

    assert not any(e["source_type"] == "invoice" for e in entries)
    assert cashier.get("/api/accounting/trial-balance").json()["balanced"]


def test_only_the_deposit_is_earned_as_revenue(cashier, buyer, widget):
    """Revenue is recognised on receipt. Selling on a plan must not recognise
    three hundred dollars of revenue for one hundred dollars received."""
    _sell(cashier, buyer, widget, plan=PLAN, tendered=100)

    income = cashier.get("/api/accounting/income-statement",
                         params={"start": "2000-01-01", "end": "2099-12-31"}).json()

    assert income["total_income"] == _pytest.approx(100), income


def test_paying_an_instalment_later_earns_the_rest(cashier, buyer, widget):
    inv = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()["invoice_id"]

    cashier.post(f"/api/invoices/{inv}/payments", json={
        "amount": 50, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    income = cashier.get("/api/accounting/income-statement",
                         params={"start": "2000-01-01", "end": "2099-12-31"}).json()
    assert income["total_income"] == _pytest.approx(150)
    assert cashier.get("/api/accounting/trial-balance").json()["balanced"]


# ── Refusals ─────────────────────────────────────────────────────────────────

def test_an_anonymous_walk_in_cannot_buy_on_credit(cashier, widget):
    """A receivable owed by nobody is not a receivable."""
    r = cashier.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": widget,
                   "quantity": 1, "unit_price": 300}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 100,
        "idempotency_key": str(uuid.uuid4()),
        "installment_plan": PLAN})

    assert r.status_code == 400
    assert "customer" in r.text.lower()


def test_a_deposit_covering_the_whole_sale_is_refused(cashier, buyer, widget):
    r = _sell(cashier, buyer, widget,
              plan={**PLAN, "down_payment": 300}, tendered=300)

    assert r.status_code == 400
    assert "ordinary sale" in r.text


def test_a_plan_needs_at_least_one_instalment(cashier, buyer, widget):
    r = _sell(cashier, buyer, widget, plan={**PLAN, "count": 0}, tendered=100)

    assert r.status_code == 400


def test_the_till_still_refuses_short_payment_of_the_deposit(cashier, buyer, widget):
    r = _sell(cashier, buyer, widget, plan=PLAN, tendered=40)

    assert r.status_code == 400
    assert "tendered" in r.text.lower()


# ── Returning one ────────────────────────────────────────────────────────────

def test_returning_an_instalment_sale_clears_the_receivable(cashier, buyer, widget):
    """Otherwise the books keep a claim on someone who handed the goods back,
    and the deferred revenue behind it never clears."""
    sale = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()

    r = cashier.post(f"/api/pos/sales/{sale['id']}/return", json={"reason": "changed mind"})

    assert r.status_code == 200, r.text
    assert cashier.get("/api/accounting/trial-balance").json()["balanced"]
    entries = cashier.get(f"/api/accounting/for/invoice/{sale['invoice_id']}").json()["entries"]
    live = [e for e in entries if e["source_type"] == "invoice"
            and e["status"] != "reversed"]
    assert live == []


def test_a_returned_sale_stops_being_chased_for_instalments(cashier, buyer, widget):
    """The arrears sweep walks unpaid instalments by date. A returned sale
    would be chased every month forever."""
    sale = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()

    cashier.post(f"/api/pos/sales/{sale['id']}/return", json={"reason": "changed mind"})

    plan = cashier.get(f"/api/invoices/{sale['invoice_id']}/plan").json()
    assert plan["installments"] == []


def test_the_goods_come_back_on_a_return(cashier, buyer, widget):
    before = _stock(cashier, widget)
    sale = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()

    cashier.post(f"/api/pos/sales/{sale['id']}/return", json={"reason": "changed mind"})

    assert _stock(cashier, widget) == before


def test_the_drawer_expects_the_deposit_not_the_sale_price(cashier, buyer, widget):
    """The register close counts cash. An instalment sale puts only the deposit
    in the till, so expecting the full price would show a $200 shortage on
    every plan the shop writes."""
    _sell(cashier, buyer, widget, plan=PLAN, tendered=100)

    body = cashier.post("/api/pos/session/close",
                        json={"closing_count": 100}).json()

    assert body["expected_cash"] == _pytest.approx(100)
    assert body["variance"] == _pytest.approx(0)


def test_change_is_given_against_the_deposit(cashier, buyer, widget):
    """A customer handing over $120 for a $100 deposit gets $20 back, not a
    refusal and not $20 short."""
    r = _sell(cashier, buyer, widget, plan=PLAN, tendered=120).json()

    assert r["change_given"] == _pytest.approx(20)
    assert r["paid_now"] == _pytest.approx(100)


def test_the_sales_history_does_not_call_an_unpaid_sale_paid(cashier, buyer, widget):
    """The history hardcoded Paid for anything not returned, so a sale still
    owing $200 sat on the owner's end-of-day screen claiming to be settled."""
    sale = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()

    row = next(s for s in cashier.get("/api/pos/sales").json()
               if s["id"] == sale["id"])

    assert row["payment_status"] == "Partial"
    assert row["balance"] == _pytest.approx(200)


def test_the_history_catches_up_when_the_customer_pays(cashier, buyer, widget):
    """The balance comes from the invoice, not the till: an instalment sale
    keeps being paid long after the register closed."""
    sale = _sell(cashier, buyer, widget, plan=PLAN, tendered=100).json()
    cashier.post(f"/api/invoices/{sale['invoice_id']}/payments", json={
        "amount": 200, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    row = next(s for s in cashier.get("/api/pos/sales").json()
               if s["id"] == sale["id"])

    assert row["payment_status"] == "Paid"
    assert row["balance"] == _pytest.approx(0)


def test_an_ordinary_sale_still_reads_as_paid(cashier, buyer, widget):
    sale = _sell(cashier, buyer, widget).json()

    row = next(s for s in cashier.get("/api/pos/sales").json()
               if s["id"] == sale["id"])

    assert row["payment_status"] == "Paid"
    assert row["balance"] == _pytest.approx(0)
