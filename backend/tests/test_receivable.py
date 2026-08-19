"""A credit sale creates a receivable, and the books have to show it.

Before this, raising an invoice posted NOTHING. A business that had delivered
$2,000 of goods and collected $100 reported total assets of $100: the $1,900 the
customer owed existed in the invoice record, the client's `outstanding` figure
and the aging report, but nowhere in the general ledger. Account 1100 was seeded
in the chart of accounts and never written to by any code path.

Recognition stays CASH-BASIS, which is deliberate (accounting.py's docstring).
So the credit side of the receivable is not revenue yet — it is a liability
until the cash arrives:

    invoice raised    DR 1100 Receivable      CR 2400 Deferred Revenue
    payment received  DR 1000 Cash            CR 1100 Receivable
                      DR 2400 Deferred Rev    CR 4000 Revenue (+ 2100 VAT)

The tests below pin both halves: the balance sheet is now complete at every
point, and the income statement and VAT position move EXACTLY as they did
before. The second half matters as much as the first — this change must not
restate a single figure anyone has already reported.
"""
import uuid

import pytest


TAX = 11.0


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Receivable Co"}).json()["id"]


def _invoice(client, acme, amount=2000, **kw):
    body = {"client_id": acme, "amount": 0,
            "items": [{"name": "Machine", "quantity": 1, "unit_price": amount}]}
    body.update(kw)
    created = client.post("/api/invoices/", json=body).json()
    return created.get("invoice_id") or created.get("id")


def _pay(client, inv_id, amount, key=None):
    return client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": amount, "currency": "USD", "method": "Cash",
        "idempotency_key": key or str(uuid.uuid4())})


def _tb(client):
    """{code: debit-positive balance} plus the balanced flag."""
    body = client.get("/api/accounting/trial-balance").json()
    return ({str(r["code"]): float(r["debit"] or 0) - float(r["credit"] or 0)
             for r in body["rows"]}, body["balanced"])


def _bal(client, code):
    return _tb(client)[0].get(code, 0.0)


# ── The headline: the claim reaches the books ────────────────────────────────

def test_raising_an_invoice_books_the_receivable(client, acme):
    _invoice(client, acme, 2000)

    bal, balanced = _tb(client)

    assert bal["1100"] == pytest.approx(2000)     # asset, debit-positive
    assert bal["2400"] == pytest.approx(-2000)    # liability, credit-positive
    assert balanced


def test_the_balance_sheet_no_longer_understates_the_business(client, acme):
    """The whole point. $2,000 delivered, $100 collected: assets are $2,000, not
    $100, because $1,900 is still owed by the customer."""
    inv = _invoice(client, acme, 2000)
    _pay(client, inv, 100)

    bs = client.get("/api/accounting/balance-sheet").json()
    ar = next((a for a in bs["assets"] if str(a["code"]) == "1100"), None)

    assert ar is not None, "no receivable on the balance sheet"
    assert ar["balance"] == pytest.approx(1900)
    assert bs["total_assets"] == pytest.approx(2000)
    assert bs["balanced"]


def test_a_payment_converts_the_claim_and_earns_the_revenue(client, acme):
    inv = _invoice(client, acme, 2000)

    _pay(client, inv, 100)

    bal, balanced = _tb(client)
    assert bal["1000"] == pytest.approx(100)      # cash in
    assert bal["1100"] == pytest.approx(1900)     # claim reduced
    assert bal["2400"] == pytest.approx(-1900)    # deferred released
    assert bal["4000"] == pytest.approx(-100)     # earned
    assert balanced


def test_paying_in_full_clears_both_control_accounts(client, acme):
    """A settled invoice must leave no receivable and no deferred revenue. A
    rounding residue here would accumulate across every invoice the business
    ever raises."""
    inv = _invoice(client, acme, 1000)

    _pay(client, inv, 333.33)
    _pay(client, inv, 333.33)
    _pay(client, inv, 333.34)

    bal, balanced = _tb(client)
    assert bal.get("1100", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("2400", 0) == pytest.approx(0, abs=0.005)
    assert bal["4000"] == pytest.approx(-1000)
    assert balanced


def test_the_ledger_balances_at_every_step_of_a_plan(client, acme):
    """Twenty instalments is twenty postings; an imbalance in any one of them
    would be invisible until an accountant tried to close the year."""
    inv = _invoice(client, acme, 2000)
    client.post(f"/api/invoices/{inv}/plan",
                json={"count": 20, "start_date": "2026-08-01"})

    for i in range(20):
        _pay(client, inv, 100, key=f"plan-{i}")
        _, balanced = _tb(client)
        assert balanced, f"unbalanced after instalment {i + 1}"

    bal, _ = _tb(client)
    assert bal.get("1100", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("2400", 0) == pytest.approx(0, abs=0.005)


# ── Nothing already reported may change ──────────────────────────────────────

def test_revenue_is_still_recognised_on_payment_only(client, acme):
    """Cash-basis recognition is deliberate and must be untouched: raising the
    invoice earns nothing, and the month reports only what was collected."""
    _invoice(client, acme, 2000)

    before = client.get(
        "/api/accounting/income-statement?start=2026-01-01&end=2030-12-31").json()
    assert before["net_income"] == pytest.approx(0)


def test_the_income_statement_reports_only_what_was_collected(client, acme):
    inv = _invoice(client, acme, 2000)
    _pay(client, inv, 100)

    isr = client.get(
        "/api/accounting/income-statement?start=2026-01-01&end=2030-12-31").json()

    assert isr["total_income"] == pytest.approx(100)
    assert isr["net_income"] == pytest.approx(100)


def test_deferred_revenue_is_a_liability_not_income(client, acme):
    """If 2400 were typed as Income, raising an invoice would inflate the P&L by
    the whole invoice — the exact error the VAT account had."""
    _invoice(client, acme, 2000)

    isr = client.get(
        "/api/accounting/income-statement?start=2026-01-01&end=2030-12-31").json()
    codes = [str(r["code"]) for r in isr["income"]] + [str(r["code"]) for r in isr["expense"]]

    assert "2400" not in codes
    bs = client.get("/api/accounting/balance-sheet").json()
    assert any(str(l["code"]) == "2400" for l in bs["liabilities"])


def test_cash_flow_still_shows_only_real_cash(client, acme):
    inv = _invoice(client, acme, 2000)
    _pay(client, inv, 100)

    cf = client.get(
        "/api/accounting/cash-flow?start=2026-01-01&end=2030-12-31").json()

    assert cf["closing_cash"] == pytest.approx(100)
    assert cf["balanced"]


# ── VAT timing is untouched ──────────────────────────────────────────────────

@pytest.fixture
def vat_rate(client):
    client.put("/api/settings/", json={"tax_enabled": "1",
                                       "default_tax_rate": str(TAX)})
    rows = client.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    r = next((x for x in rows if float(x.get("rate") or 0) == TAX), None)
    assert r, "the 11% rate should be seeded"
    return r["id"]


def test_the_receivable_is_the_gross_amount(client, acme, vat_rate):
    """The customer owes the tax too — a receivable net of VAT would understate
    the claim by the tax rate on every credit sale."""
    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 100,
                   "tax_rate_id": vat_rate}]}).json()
    inv = created.get("invoice_id") or created.get("id")

    bal, balanced = _tb(client)

    assert bal["1100"] == pytest.approx(111)
    assert bal["2400"] == pytest.approx(-111)
    assert balanced


def test_vat_is_still_recognised_on_payment(client, acme, vat_rate):
    """The VAT control account must move when the cash does, not when the
    invoice is raised — otherwise the ledger stops agreeing with the return."""
    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 100,
                   "tax_rate_id": vat_rate}]}).json()
    inv = created.get("invoice_id") or created.get("id")

    assert _bal(client, "2100") == pytest.approx(0), "VAT moved at invoice time"

    _pay(client, inv, 55.50)                      # half of 111.00

    bal, balanced = _tb(client)
    assert bal["2100"] == pytest.approx(-5.50)    # half the VAT
    assert bal["4000"] == pytest.approx(-50.00)   # half the net revenue
    assert bal["1100"] == pytest.approx(55.50)    # half the claim remains
    assert balanced


# ── Void, unvoid, edit ───────────────────────────────────────────────────────

def test_voiding_removes_the_claim(client, acme):
    """A voided invoice is not owed. Leaving the receivable would keep asserting
    an asset the business no longer has."""
    inv = _invoice(client, acme, 2000)
    _pay(client, inv, 100)

    client.patch(f"/api/invoices/{inv}/void", json={"reason": "Cancelled"})

    bal, balanced = _tb(client)
    assert bal.get("1100", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("2400", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("4000", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("1000", 0) == pytest.approx(0, abs=0.005)
    assert balanced


def test_unvoiding_restores_the_claim_exactly_once(client, acme):
    """The receivable must be restored BEFORE the payments are re-posted, or
    they take the legacy shape and leave the claim standing unrelieved."""
    inv = _invoice(client, acme, 2000)
    _pay(client, inv, 100)
    client.patch(f"/api/invoices/{inv}/void", json={"reason": "Mistake"})

    client.patch(f"/api/invoices/{inv}/unvoid")

    bal, balanced = _tb(client)
    assert bal["1100"] == pytest.approx(1900), "claim not restored to its net position"
    assert bal["2400"] == pytest.approx(-1900)
    assert bal["1000"] == pytest.approx(100)
    assert bal["4000"] == pytest.approx(-100)
    assert balanced


def test_editing_the_amount_restates_the_claim(client, acme):
    """Editing a $2,000 invoice down to $500 must not leave a $2,000 asset on
    the balance sheet for ever."""
    inv = _invoice(client, acme, 2000)

    client.put(f"/api/invoices/{inv}", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Machine", "quantity": 1, "unit_price": 500}]})

    bal, balanced = _tb(client)
    assert bal["1100"] == pytest.approx(500)
    assert bal["2400"] == pytest.approx(-500)
    assert balanced


def test_deleting_a_payment_puts_the_claim_back(client, acme):
    inv = _invoice(client, acme, 2000)
    _pay(client, inv, 100)
    pay_id = client.get(f"/api/invoices/{inv}").json()["payments"][0]["id"]

    client.delete(f"/api/invoices/{inv}/payments/{pay_id}")

    bal, balanced = _tb(client)
    assert bal["1100"] == pytest.approx(2000)
    assert bal["2400"] == pytest.approx(-2000)
    assert bal.get("4000", 0) == pytest.approx(0, abs=0.005)
    assert balanced


def test_a_zero_value_invoice_posts_nothing(client, acme, db):
    """There is no claim to record, and post_entry rejects an all-zero entry —
    so the guard has to come first or raising one would 500.

    The API refuses a zero-value invoice outright (400), so this exercises the
    guard directly; it exists because build_invoice is called from service jobs
    and quotation conversion too, not only from that endpoint.
    """
    import accounting

    assert client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Free sample", "quantity": 1, "unit_price": 0}]
    }).status_code == 400

    assert accounting.post_receivable(
        db, 999_999, invoice_number="INV-ZERO", amount=0,
        entry_date="2026-08-19") is None

    bal, balanced = _tb(client)
    assert bal.get("1100", 0) == pytest.approx(0, abs=0.005)
    assert balanced


# ── What must NOT gain a receivable ──────────────────────────────────────────

def test_a_till_sale_has_no_receivable(client):
    """A POS sale is settled at the counter — nobody owes anything. POS inserts
    its own invoice row rather than going through build_invoice, and this pins
    that it stays that way: a receivable here would double-count the sale as
    both cash and a claim."""
    client.post("/api/pos/session/open", json={"opening_float": 100})
    item = client.post("/api/inventory/", json={
        "name": "Widget", "quantity": 20, "unit_cost": 5, "sale_price": 10}).json()["id"]

    r = client.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item,
                   "quantity": 2, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 20,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text

    bal, balanced = _tb(client)
    assert bal.get("1100", 0) == pytest.approx(0, abs=0.005), "till sale booked a receivable"
    assert bal.get("2400", 0) == pytest.approx(0, abs=0.005)
    assert bal["1000"] == pytest.approx(20)
    assert balanced


def test_an_invoice_raised_before_the_change_keeps_the_old_shape(client, acme, db):
    """Existing invoices were never given a receivable, so a payment against one
    must still post DR Cash / CR Revenue. Crediting a receivable that was never
    debited would push 1100 negative and drift the trial balance.

    Simulated by reversing the receivable, which is exactly the state a
    pre-change invoice is in: no live entry for source ('invoice', id).
    """
    import accounting

    inv = _invoice(client, acme, 2000)
    accounting.reverse_source(db, "invoice", inv, memo="simulate legacy invoice")
    db.commit()
    assert _bal(client, "1100") == pytest.approx(0, abs=0.005)

    _pay(client, inv, 100)

    bal, balanced = _tb(client)
    assert bal["1000"] == pytest.approx(100)
    assert bal["4000"] == pytest.approx(-100)
    assert bal.get("1100", 0) == pytest.approx(0, abs=0.005), "credited a claim that never existed"
    assert bal.get("2400", 0) == pytest.approx(0, abs=0.005)
    assert balanced


# ── Reconciliation ───────────────────────────────────────────────────────────

def test_the_ledger_receivable_ties_to_the_unpaid_invoices(client, acme):
    """The check an accountant performs first: does account 1100 agree with the
    sum of what customers actually still owe?

    If these two ever disagree the receivable is no longer evidence of anything,
    and the aging report and the balance sheet start telling different stories
    about the same money.
    """
    a = _invoice(client, acme, 2000)
    b = _invoice(client, acme, 750)
    c_ = _invoice(client, acme, 500)
    _pay(client, a, 100)
    _pay(client, b, 750)                      # settled in full
    client.patch(f"/api/invoices/{c_}/void", json={"reason": "Cancelled"})

    ledger_ar = _bal(client, "1100")
    owed = sum(float(r["remaining"]) for r in
               client.get("/api/reports/invoice-aging").json()["invoices"])

    assert ledger_ar == pytest.approx(1900)
    assert ledger_ar == pytest.approx(owed, abs=0.01)


def test_deferred_revenue_equals_the_uncollected_balance(client, acme):
    """The mirror check. Deferred revenue is what has been invoiced and not yet
    earned, so it must equal the receivable while no invoice is overpaid."""
    a = _invoice(client, acme, 2000)
    b = _invoice(client, acme, 1200)
    _pay(client, a, 500)
    _pay(client, b, 200)

    assert -_bal(client, "2400") == pytest.approx(_bal(client, "1100"))
    assert -_bal(client, "2400") == pytest.approx(2500)
