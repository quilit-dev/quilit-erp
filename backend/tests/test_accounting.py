"""
Double-entry accounting — chart of accounts, automatic posting from business
events, manual entries, reversals, and the financial statements.

The headline guarantee: the GL Income Statement reconciles with the cash-basis
Finance dashboard, and every statement balances by construction.
"""
import uuid
import pytest


def _acct_map(c):
    rows = c.get("/api/accounting/accounts").json()
    return {a["code"]: a for a in rows}


def _make_paid_invoice(c, amount=1000.0):
    cl = c.post("/api/clients/", json={"name": "Ledger Co", "type": "Company"})
    assert cl.status_code in (200, 201), cl.text
    inv = c.post("/api/invoices/", json={
        "client_id": cl.json()["id"],
        "items": [{"name": "Service", "quantity": 1, "unit_price": amount}],
    })
    assert inv.status_code in (200, 201), inv.text
    inv_id = inv.json()["id"]
    pay = c.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": amount, "method": "Cash", "idempotency_key": str(uuid.uuid4()),
    })
    assert pay.status_code in (200, 201), pay.text
    return inv_id


def _today(c):
    # Use the trial-balance default (server 'now') range via explicit wide window.
    return None


def test_chart_of_accounts_seeded(make_client):
    c = make_client("superadmin")
    accts = _acct_map(c)
    for code in ("1000", "1510", "2000", "3000", "4000", "5000", "6000", "6300"):
        assert code in accts, f"missing seeded account {code}"
    assert accts["1000"]["is_system"] == 1
    assert accts["4000"]["type"] == "Income"
    assert accts["1510"]["normal_balance"] == "credit"   # contra-asset


def test_invoice_payment_posts_balanced_entry(make_client):
    c = make_client("superadmin")
    _make_paid_invoice(c, 1000)

    resp = c.get("/api/accounting/journal-entries?source_type=invoice_payment").json()
    # New paginated contract: {"rows": [...], "total": N, "source_types": [...]}
    entries = resp["rows"]
    assert resp["total"] == 1
    assert len(entries) == 1
    je = entries[0]
    # Four legs, not two. A payment against an invoice carrying a receivable
    # does two things at once: it turns the claim into cash, and it earns the
    # revenue that was being held in deferred. So the entry totals twice the
    # payment while still balancing, which is the property this test is named
    # for and the one that matters.
    assert je["total_debit"] == pytest.approx(je["total_credit"])
    assert je["total_debit"] == pytest.approx(2000)

    full = c.get(f"/api/accounting/journal-entries/{je['id']}").json()
    by_code = {l["account_code"]: l for l in full["lines"]}
    assert by_code["1000"]["debit"] == pytest.approx(1000)    # DR Cash
    assert by_code["4000"]["credit"] == pytest.approx(1000)   # CR Revenue
    assert by_code["1100"]["credit"] == pytest.approx(1000)   # CR Receivable settled
    assert by_code["2400"]["debit"] == pytest.approx(1000)    # DR Deferred, now earned


def test_trial_balance_and_balance_sheet_balance(make_client):
    c = make_client("superadmin")
    _make_paid_invoice(c, 1000)
    c.post("/api/finance/expenses", json={"category": "Rent", "amount": 300})

    tb = c.get("/api/accounting/trial-balance").json()
    assert tb["balanced"] is True
    assert tb["total_debit"] == pytest.approx(tb["total_credit"])

    bs = c.get("/api/accounting/balance-sheet").json()
    assert bs["balanced"] is True
    assert bs["total_assets"] == pytest.approx(bs["total_liabilities_equity"])
    # Cash 1000 − 300 = 700; net income 1000 − 300 = 700.
    assert bs["total_assets"] == pytest.approx(700)
    assert bs["net_income"] == pytest.approx(700)


def test_income_statement_reconciles_with_finance_dashboard(make_client):
    """GL net income must equal the cash-basis Finance profit for the period."""
    c = make_client("superadmin")
    _make_paid_invoice(c, 1500)
    c.post("/api/finance/expenses", json={"category": "Utilities", "amount": 200})
    c.post("/api/finance/expenses", json={"category": "Labour", "amount": 100})

    # Wide window that includes 'today'.
    start, end = "2000-01-01", "2099-12-31"
    isr = c.get(f"/api/accounting/income-statement?start={start}&end={end}").json()
    fin = c.get(f"/api/finance/range-summary?start={start}&end={end}").json()

    assert isr["total_income"] == pytest.approx(fin["income"])
    assert isr["total_expense"] == pytest.approx(fin["expenses"])
    assert isr["net_income"] == pytest.approx(fin["profit"])
    assert isr["net_income"] == pytest.approx(1500 - 300)


def test_manual_journal_entry_balanced_ok_unbalanced_rejected(make_client):
    c = make_client("superadmin")
    accts = _acct_map(c)
    cash, equity = accts["1000"]["id"], accts["3000"]["id"]

    ok = c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-01-05", "memo": "Owner capital injection",
        "lines": [
            {"account_id": cash, "debit": 5000},
            {"account_id": equity, "credit": 5000},
        ],
    })
    assert ok.status_code in (200, 201), ok.text

    bad = c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-01-05", "memo": "broken",
        "lines": [{"account_id": cash, "debit": 100}, {"account_id": equity, "credit": 50}],
    })
    assert bad.status_code == 400

    one = c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-01-05", "memo": "one-sided",
        "lines": [{"account_id": cash, "debit": 100}],
    })
    assert one.status_code == 400


def test_reverse_manual_entry_keeps_books_balanced(make_client):
    c = make_client("superadmin")
    accts = _acct_map(c)
    je = c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-02-01", "memo": "Accrual",
        "lines": [
            {"account_id": accts["6900"]["id"], "debit": 400},
            {"account_id": accts["2000"]["id"], "credit": 400},
        ],
    }).json()

    rev = c.post(f"/api/accounting/journal-entries/{je['id']}/reverse")
    assert rev.status_code in (200, 201), rev.text

    original = c.get(f"/api/accounting/journal-entries/{je['id']}").json()
    assert original["status"] == "reversed"
    # Net effect zero → trial balance still balances and that expense nets out.
    tb = c.get("/api/accounting/trial-balance").json()
    assert tb["balanced"] is True


def test_void_expense_reverses_ledger(make_client):
    c = make_client("superadmin")
    exp = c.post("/api/finance/expenses", json={"category": "Rent", "amount": 500})
    expense_id = exp.json()["id"]

    isr = c.get("/api/accounting/income-statement?start=2000-01-01&end=2099-12-31").json()
    assert isr["total_expense"] == pytest.approx(500)

    v = c.patch(f"/api/finance/expenses/{expense_id}/void", json={"reason": "duplicate"})
    assert v.status_code == 200, v.text

    isr2 = c.get("/api/accounting/income-statement?start=2000-01-01&end=2099-12-31").json()
    assert isr2["total_expense"] == pytest.approx(0)
    tb = c.get("/api/accounting/trial-balance").json()
    assert tb["balanced"] is True


def test_depreciation_posts_to_accumulated_depreciation(make_client):
    c = make_client("superadmin")
    asset = c.post("/api/assets", json={
        "name": "Test Laptop", "category": "Equipment",
        "acquisition_cost": 1200, "salvage_value": 0,
        "useful_life_months": 12,
        "acquisition_date": "2026-01-01", "in_service_date": "2026-01-01",
        "depreciation_method": "straight_line",
    })
    assert asset.status_code in (200, 201), asset.text
    aid = asset.json()["id"]

    dep = c.post(f"/api/assets/{aid}/depreciate", json={"period": "2026-01"})
    assert dep.status_code in (200, 201), dep.text

    entries = c.get("/api/accounting/journal-entries?source_type=depreciation").json()["rows"]
    assert len(entries) >= 1
    full = c.get(f"/api/accounting/journal-entries/{entries[0]['id']}").json()
    by_code = {l["account_code"]: l for l in full["lines"]}
    assert "6300" in by_code and by_code["6300"]["debit"] > 0     # DR Depreciation Expense
    assert "1510" in by_code and by_code["1510"]["credit"] > 0    # CR Accumulated Depreciation


def test_system_account_cannot_be_deleted(make_client):
    c = make_client("superadmin")
    accts = _acct_map(c)
    r = c.delete(f"/api/accounting/accounts/{accts['1000']['id']}")
    assert r.status_code == 400


def test_create_custom_account(make_client):
    c = make_client("superadmin")
    r = c.post("/api/accounting/accounts", json={
        "code": "6950", "name": "Marketing", "type": "Expense",
    })
    assert r.status_code in (200, 201), r.text
    assert "6950" in _acct_map(c)


# ── Cash Flow Statement ───────────────────────────────────────────────────────
_WIDE = "start=2000-01-01&end=2099-12-31"


def test_cash_flow_classifies_activities_and_ties_out(make_client):
    """Cash flow is GL-derived and bucketed by the non-cash side of each
    cash-touching entry: operating (working capital / P&L), investing (fixed
    assets), financing (equity/loans). It must reconcile opening→closing."""
    c = make_client("superadmin")
    accts = _acct_map(c)
    cash, equity, fixed = accts["1000"]["id"], accts["3000"]["id"], accts["1500"]["id"]

    # Operating: collect a paid invoice (+1000) and pay rent in cash (−300).
    _make_paid_invoice(c, 1000)
    c.post("/api/finance/expenses", json={"category": "Rent", "amount": 300})
    # Financing: owner injects 5000 cash.
    c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-01-05", "memo": "Owner capital",
        "lines": [{"account_id": cash, "debit": 5000}, {"account_id": equity, "credit": 5000}],
    })
    # Investing: buy equipment for 2000 cash.
    c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-01-06", "memo": "Buy equipment",
        "lines": [{"account_id": fixed, "debit": 2000}, {"account_id": cash, "credit": 2000}],
    })

    cf = c.get(f"/api/accounting/cash-flow?{_WIDE}").json()
    assert cf["total_operating"] == pytest.approx(700)     # +1000 AR − 300 rent
    assert cf["total_financing"] == pytest.approx(5000)
    assert cf["total_investing"] == pytest.approx(-2000)
    assert cf["net_change"]   == pytest.approx(3700)
    assert cf["opening_cash"] == pytest.approx(0)
    assert cf["closing_cash"] == pytest.approx(3700)
    assert cf["balanced"] is True
    # The headline reconciliation: activities sum to the change in cash.
    assert cf["closing_cash"] - cf["opening_cash"] == pytest.approx(cf["net_change"])
    # Sub-lines reference the real driving accounts.
    assert "3000" in {r["code"] for r in cf["financing"]}
    assert "1500" in {r["code"] for r in cf["investing"]}


def test_cash_flow_internal_cash_transfer_is_neutral(make_client):
    """Moving money between two cash accounts (USD till → LBP till) is not a cash
    flow — it must not appear in any activity or change total cash."""
    c = make_client("superadmin")
    accts = _acct_map(c)
    usd, lbp = accts["1000"]["id"], accts["1010"]["id"]
    c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-03-01", "memo": "Move USD to LBP till",
        "lines": [{"account_id": lbp, "debit": 500}, {"account_id": usd, "credit": 500}],
    })

    cf = c.get(f"/api/accounting/cash-flow?{_WIDE}").json()
    assert cf["total_operating"] == pytest.approx(0)
    assert cf["total_investing"] == pytest.approx(0)
    assert cf["total_financing"] == pytest.approx(0)
    assert cf["net_change"]   == pytest.approx(0)
    assert cf["closing_cash"] == pytest.approx(0)
    assert cf["balanced"] is True
