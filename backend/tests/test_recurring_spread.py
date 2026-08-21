"""A cost that buys several months is spread across those months.

Quarterly rent of $3,000 paid in January buys January, February and March.
Charging the whole payment to January made January look bad and February and
March look good, for no business reason — and the two months of occupancy the
business had already paid for appeared nowhere on the balance sheet.

Two things were wrong, and the second was the bigger one:

  * A quarterly template posted one $3,000 expense in the month it ran and
    nothing in the two months it also covered.
  * Recurring expenses never reached the general ledger AT ALL. They landed in
    the `expenses` table and stopped there, so the cash-basis Finance views
    counted them and the P&L, trial balance and balance sheet did not. Manually
    entered expenses posted correctly; only generated ones were missing.

Now an occurrence covering N months produces one expense row per month, and the
ledger holds the unexpired part in 1300 Prepaid Expenses:

    DR 1300 Prepaid       net         (payment date)
    DR 2100 VAT control   input VAT
      CR 1000 Cash               gross
    DR <expense account>  net/N       (once per covered month)
      CR 1300 Prepaid            net/N

Every Finance view already buckets expenses by their own date, so they report
the monthly share with no change to their queries.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _template(client, **kw):
    # `end_date` bounds the run to ONE occurrence. Without it _generate catches
    # up every occurrence due since start_date, so the row count would depend
    # on the real date the suite happens to run.
    body = {"name": "Office Rent", "category": "Rent", "amount": 3000,
            "frequency": "quarterly", "start_date": "2026-01-15",
            "end_date": "2026-01-31"}
    body.update(kw)
    r = client.post("/api/recurring-expenses/", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _run(client, tpl_id):
    r = client.post(f"/api/recurring-expenses/{tpl_id}/run")
    assert r.status_code == 200, r.text
    return r.json()


def _live_rows(client):
    """Every expense the list still counts. The endpoint returns voided rows
    too, so they are filtered here — a void that left them visible would make
    every assertion below pass for the wrong reason."""
    body = client.get("/api/finance/expenses?limit=200").json()
    rows = body if isinstance(body, list) else (body.get("rows") or body.get("expenses") or [])
    return [r for r in rows if not r.get("voided_at")]


def _expenses(client):
    """(date, amount) for every live generated expense, oldest first."""
    return sorted(((r["date"][:10], round(float(r["amount"]), 2))
                   for r in _live_rows(client)))


def _tb(client, as_of=None):
    body = client.get("/api/accounting/trial-balance"
                      + (f"?as_of={as_of}" if as_of else "")).json()
    return ({str(r["code"]): round(float(r["debit"] or 0) - float(r["credit"] or 0), 2)
             for r in body["rows"]}, body["balanced"])


# ── The question that started this ───────────────────────────────────────────

def test_quarterly_three_thousand_shows_as_a_thousand_a_month(client):
    """The headline. $3,000 quarterly is $1,000 of cost in each of the three
    months it covers, not $3,000 in one and nothing in the other two."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")

    _run(client, tpl)

    assert _expenses(client) == [("2026-01-15", 1000.0),
                                 ("2026-02-15", 1000.0),
                                 ("2026-03-15", 1000.0)]


def test_the_finance_monthly_view_reports_the_monthly_share(client):
    """What the owner actually looks at. The view needed no change — it buckets
    expenses by their own date, and the dates are now monthly."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)

    monthly = {r["month"]: round(r["expenses"], 2)
               for r in client.get("/api/finance/monthly").json()}

    assert monthly["2026-01"] == 1000.0
    assert monthly["2026-02"] == 1000.0
    assert monthly["2026-03"] == 1000.0


def test_an_annual_cost_is_spread_over_twelve_months(client):
    tpl = _template(client, name="Licence", category="Subscription",
                    amount=1200, frequency="annual", start_date="2026-01-10",
                    end_date="2026-01-31")

    _run(client, tpl)

    rows = _expenses(client)
    assert len(rows) == 12
    assert {a for _, a in rows} == {100.0}
    assert rows[0][0] == "2026-01-10"
    assert rows[-1][0] == "2026-12-10"


def test_a_monthly_template_is_unchanged(client):
    """Spreading must be invisible to the common case: one month of cost buys
    one month, so it stays one row."""
    tpl = _template(client, amount=1100, frequency="monthly",
                    start_date="2026-01-15", end_date="2026-01-31")

    _run(client, tpl)

    assert _expenses(client) == [("2026-01-15", 1100.0)]


def test_the_parts_always_sum_to_what_was_paid(client):
    """$1,000 over three does not divide. The residue has to land somewhere
    explicit or the prepaid account holds a cent for ever, on every template."""
    tpl = _template(client, amount=1000, frequency="quarterly",
                    start_date="2026-01-15")

    _run(client, tpl)

    rows = _expenses(client)
    assert [a for _, a in rows] == [333.33, 333.33, 333.34]
    assert sum(a for _, a in rows) == pytest.approx(1000, abs=0.001)


# ── The ledger, which recurring expenses never reached ───────────────────────

def test_a_recurring_expense_reaches_the_ledger_at_all(client):
    """The plain bug. Generated expenses landed in the expenses table and
    nowhere else, so the P&L and balance sheet simply did not know about them
    while the cash-basis Finance views did."""
    tpl = _template(client, amount=1100, frequency="monthly",
                    start_date="2026-01-15", end_date="2026-01-31")

    _run(client, tpl)

    bal, balanced = _tb(client)
    assert bal.get("6100", 0) == pytest.approx(1100)     # Rent expense
    assert bal.get("1000", 0) == pytest.approx(-1100)    # Cash out
    assert balanced


def test_the_unused_months_sit_on_the_balance_sheet(client):
    """Two months of rent already paid for is an asset until it is used."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)

    bs = client.get("/api/accounting/balance-sheet?as_of=2026-01-31").json()
    prepaid = next((a for a in bs["assets"] if str(a["code"]) == "1300"), None)

    assert prepaid is not None, "no prepaid asset on the balance sheet"
    assert prepaid["balance"] == pytest.approx(2000)


def test_the_prepayment_runs_down_to_nothing(client):
    """By the end of the period the asset is fully consumed. A residue here
    would accumulate on every quarterly template the business runs."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)

    bal, balanced = _tb(client)
    assert bal.get("1300", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("6100", 0) == pytest.approx(3000)
    assert bal.get("1000", 0) == pytest.approx(-3000)
    assert balanced


def test_cash_leaves_once_not_once_a_month(client):
    """The business paid $3,000 in January. Spreading changes when the COST is
    recognised, never when the money moved."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)

    cf = client.get(
        "/api/accounting/cash-flow?start=2026-01-01&end=2026-01-31").json()

    assert cf["closing_cash"] == pytest.approx(-3000)


def test_the_ledger_balances_across_several_occurrences(client):
    """Catching up a year of quarterly bills is several payments and three
    releases each. Asserted as relationships rather than fixed totals: how many
    occurrences are due depends on the date the suite runs."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15", end_date="2026-12-31")

    _run(client, tpl)

    rows = _expenses(client)
    assert len(rows) >= 6, "expected at least two caught-up occurrences"
    assert len(rows) % 3 == 0, "every occurrence should produce three months"

    # Read from beyond the last release. As of TODAY prepaid is legitimately
    # non-zero: the most recent quarterly bill covers months that have not
    # happened yet, and that unexpired part is exactly what the asset is for.
    bal, balanced = _tb(client, as_of="2027-12-31")
    assert balanced
    assert bal.get("1300", 0) == pytest.approx(0, abs=0.005), "prepaid not fully released"
    assert bal.get("6100", 0) == pytest.approx(sum(a for _, a in rows), abs=0.02)


# ── Tax ──────────────────────────────────────────────────────────────────────

def test_input_vat_is_reclaimed_when_paid_not_spread(client):
    """VAT is recoverable on the bill, not as the months are used up. Spreading
    it would delay the reclaim by two months on every quarterly bill."""
    client.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    rates = client.get("/api/tax-rates/").json()
    rates = rates if isinstance(rates, list) else rates.get("rows", [])
    rid = next(r["id"] for r in rates if float(r.get("rate") or 0) == 11.0)

    tpl = _template(client, amount=3330, frequency="quarterly",
                    start_date="2026-01-15", tax_rate_id=rid)
    _run(client, tpl)

    bal, balanced = _tb(client)
    # 3330 gross at 11% inclusive = 3000 net + 330 VAT.
    assert bal.get("2100", 0) == pytest.approx(330, abs=0.02)   # reclaimable, debit
    assert bal.get("6100", 0) == pytest.approx(3000, abs=0.02)  # net, spread
    assert bal.get("1000", 0) == pytest.approx(-3330, abs=0.02)
    assert balanced


def test_the_recorded_total_still_equals_the_bill(client):
    """Spreading must not invent or lose money: the expense rows together are
    exactly what was paid."""
    client.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    rates = client.get("/api/tax-rates/").json()
    rates = rates if isinstance(rates, list) else rates.get("rows", [])
    rid = next(r["id"] for r in rates if float(r.get("rate") or 0) == 11.0)

    tpl = _template(client, amount=3330, frequency="quarterly",
                    start_date="2026-01-15", tax_rate_id=rid)
    _run(client, tpl)

    assert sum(a for _, a in _expenses(client)) == pytest.approx(3330, abs=0.02)


# ── Voiding ──────────────────────────────────────────────────────────────────

def _void(client, expense_id, reason="mistake"):
    r = client.patch(f"/api/finance/expenses/{expense_id}/void",
                     json={"reason": reason})
    assert r.status_code == 200, r.text
    return r.json()


def _expense_ids(client):
    return [r["id"] for r in sorted(_live_rows(client), key=lambda r: r["date"])]


def test_voiding_one_month_undoes_the_whole_payment(client):
    """A quarterly bill is ONE payment split across the months it buys. Voiding
    a single month is not a real operation — the money moved once."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)
    ids = _expense_ids(client)
    assert len(ids) == 3

    body = _void(client, ids[1])          # the MIDDLE month

    assert body["voided_count"] == 3
    assert _expenses(client) == []


def test_voiding_leaves_no_stranded_prepayment(client):
    """The whole point. Reversing only the clicked month would leave the
    prepayment on the balance sheet with nothing left to release it, and the
    books would keep asserting an asset the business no longer has."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)

    _void(client, _expense_ids(client)[0])

    bal, balanced = _tb(client, as_of="2027-12-31")
    assert bal.get("1300", 0) == pytest.approx(0, abs=0.005), "prepayment stranded"
    assert bal.get("6100", 0) == pytest.approx(0, abs=0.005), "cost still recognised"
    assert balanced


def test_voiding_gives_the_money_back(client):
    """Cash left once, so it has to come back once."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)

    _void(client, _expense_ids(client)[2])   # the LAST month

    bal, _ = _tb(client, as_of="2027-12-31")
    assert bal.get("1000", 0) == pytest.approx(0, abs=0.005)


def test_voiding_a_monthly_expense_is_unchanged(client):
    """One month of cost buys one month, so there is no occurrence to unwind
    and the original single-row behaviour must be untouched."""
    tpl = _template(client, amount=1100, frequency="monthly",
                    start_date="2026-01-15", end_date="2026-01-31")
    _run(client, tpl)

    body = _void(client, _expense_ids(client)[0])

    assert body["voided_count"] == 1
    bal, balanced = _tb(client)
    assert bal.get("6100", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("1000", 0) == pytest.approx(0, abs=0.005)
    assert balanced


def test_voiding_one_occurrence_leaves_the_others_alone(client):
    """Catching up several quarters then voiding one must unwind that payment
    only — the sibling lookup is scoped to the occurrence, not the template."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15", end_date="2026-12-31")
    _run(client, tpl)
    before = _expenses(client)
    assert len(before) >= 6

    _void(client, _expense_ids(client)[0])    # first month of the FIRST quarter

    after = _expenses(client)
    assert len(after) == len(before) - 3
    bal, balanced = _tb(client, as_of="2027-12-31")
    assert bal.get("6100", 0) == pytest.approx(sum(a for _, a in after), abs=0.02)
    assert bal.get("1300", 0) == pytest.approx(0, abs=0.005)
    assert balanced


def test_the_void_reverses_the_input_vat_too(client):
    """The VAT was reclaimed on the payment, so unwinding the payment gives it
    back — otherwise the control account stops agreeing with the return."""
    client.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    rates = client.get("/api/tax-rates/").json()
    rates = rates if isinstance(rates, list) else rates.get("rows", [])
    rid = next(r["id"] for r in rates if float(r.get("rate") or 0) == 11.0)
    tpl = _template(client, amount=3330, frequency="quarterly",
                    start_date="2026-01-15", tax_rate_id=rid)
    _run(client, tpl)

    _void(client, _expense_ids(client)[0])

    bal, balanced = _tb(client, as_of="2027-12-31")
    assert bal.get("2100", 0) == pytest.approx(0, abs=0.02)
    assert balanced


def test_an_archived_month_is_still_unwound(client):
    """Archiving hides a row from the lists but leaves its ledger entry live.
    Skipping archived siblings would reverse the payment while one month's cost
    stayed on the books, and the trial balance would not come back to nil."""
    tpl = _template(client, amount=3000, frequency="quarterly",
                    start_date="2026-01-15")
    _run(client, tpl)
    ids = _expense_ids(client)
    assert client.patch(f"/api/finance/expenses/{ids[2]}/archive",
                        json={"reason": "tidy"}).status_code == 200

    _void(client, ids[0])

    bal, balanced = _tb(client, as_of="2027-12-31")
    assert bal.get("6100", 0) == pytest.approx(0, abs=0.005), "archived month left on the books"
    assert bal.get("1300", 0) == pytest.approx(0, abs=0.005)
    assert bal.get("1000", 0) == pytest.approx(0, abs=0.005)
    assert balanced
