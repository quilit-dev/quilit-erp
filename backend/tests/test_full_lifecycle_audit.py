"""
GRAND LIFECYCLE AUDIT — one continuous business story through every module,
with the books checked after every phase.

This is the "diagnose the whole pipeline" suite: it drives the ERP the way a
real Lebanese SMB would use it for a trading year and proves that financial
data, taxes, stock and the general ledger stay mutually consistent at every
hand-off:

  1. trading cycle   capital → purchase (Ordered→Received→Paid) → manufacture
                     → POS sale → service invoice → expense → session close,
                     then: trial balance, balance sheet, income statement,
                     cash flow, finance summary and physical stock must ALL
                     agree, to the cent, with hand-computed expectations.
  2. VAT cycle       output VAT (invoice + POS, VAT-inclusive) and input VAT
                     (expense) reconcile in the VAT report; a POS return
                     removes the voided sale from the declaration.
  3. payroll + depreciation post once (idempotent) to the right accounts.
  4. fiscal close    rolls net income into Retained Earnings, locks the year
                     against every kind of back-posting, and reopens cleanly.
  5. exploit probes  overpayment, duplicate-submission replay, negative or
                     zero amounts, overselling stock, paying voided invoices,
                     unbalanced or single-line journal entries — all rejected
                     with NO side effects in the ledger.
  6. RBAC seams      a Sales user cannot post journal entries, close a year,
                     or run payroll.

Known deviations are encoded as @xfail(strict=True) so they document the
defect today and fail loudly the day they are fixed (forcing the marker to be
removed):

  FINDING-1  POS return voids the invoice and restocks the goods, but never
             reverses the sale's GL entries (revenue, cash, COGS, inventory)
             — the ledger drifts from Finance/VAT on every refund.
  FINDING-2  A taxed purchase debits Inventory (1200) at the VAT-INCLUSIVE
             gross, while cost layers carry the ex-VAT cost — the input-VAT
             portion is never relieved by COGS and accumulates in 1200.
  FINDING-3  trial_balance() computes each balance by account TYPE but
             presents it by normal_balance — for a contra account (1510
             Accumulated Depreciation: type Asset, normal credit) the two
             disagree, so after any depreciation the TB shows 1510 on the
             DEBIT side and reports balanced=False. Ledger + balance sheet
             are unaffected; it is a TB presentation defect.

Run just this file:
    cd backend && python -m pytest tests/test_full_lifecycle_audit.py -v
"""
import uuid

import pytest

CENT  = 0.01
WIDE  = {"start": "2000-01-01", "end": "2099-12-31"}
WIDE_Q = "start=2000-01-01&end=2099-12-31"


def _key():
    return str(uuid.uuid4())


def _enable_vat(c, rate="11"):
    assert c.put("/api/settings/", json={"tax_enabled": "1",
                                         "default_tax_rate": rate}).status_code == 200


def _default_rate(c):
    return next(r["id"] for r in c.get("/api/tax-rates/").json() if r["is_default"])


def _accounts(c):
    """Chart of accounts keyed by code."""
    return {a["code"]: a for a in c.get("/api/accounting/accounts").json()}


def _tb(c, as_of=None):
    """Trial balance keyed by code → (debit, credit). Missing code = (0, 0)."""
    params = {"as_of": as_of} if as_of else {}
    tb = c.get("/api/accounting/trial-balance", params=params).json()
    return tb, {r["code"]: (r["debit"], r["credit"]) for r in tb["rows"]}


def _item(c, name, ptype, qty=0, cost=0, price=0):
    r = c.post("/api/inventory/", json={"name": name, "product_type": ptype,
                                        "quantity": qty, "unit_cost": cost,
                                        "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _paid_invoice(c, amount, name="Service"):
    """A one-line, fully-paid invoice; returns the invoice id."""
    cl = c.post("/api/clients/", json={"name": f"AUD {name} {_key()[:8]}"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": name, "quantity": 1, "unit_price": amount}],
    }).json()["id"]
    p = c.post(f"/api/invoices/{iid}/payments",
               json={"amount": amount, "method": "Bank", "idempotency_key": _key()})
    assert p.status_code in (200, 201), p.text
    return iid


# ═══════════════════════════════════════════════════════════════════════════
# 1. The trading cycle — every statement agrees with the hand-computed books
# ═══════════════════════════════════════════════════════════════════════════
def test_trading_cycle_all_statements_reconcile(make_client, db):
    """
    Capital 5,000 → buy 100 raw @ $10 (paid) → make 10 finished (5 raw each)
    → POS-sell 4 @ $120 → invoice a $300 service (paid) → $100 rent.

    Expected ledger (no VAT anywhere, so every identity is exact):
        1000 Cash       5,000 − 1,000 + 480 + 300 − 100 = 4,680 DR
        1200 Inventory  1,000 − 200 (COGS of 4 × $50)   =   800 DR
        3000 Equity                                          5,000 CR
        4000 Revenue    480 + 300                       =   780 CR
        5000 COGS       4 × $50                         =   200 DR
        6100 Rent                                            100 DR
    """
    c = make_client("superadmin")
    accts = _accounts(c)

    # ── Phase 0: the owner funds the company (manual journal entry) ────────
    r = c.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-01-02", "memo": "Owner capital",
        "lines": [{"account_id": accts["1000"]["id"], "debit": 5000},
                  {"account_id": accts["3000"]["id"], "credit": 5000}],
    })
    assert r.status_code in (200, 201), r.text

    # ── Phase 1: procure — Ordered → Received (stock) → Paid (cash + GL) ───
    raw = _item(c, "AUD Steel", "raw_material")
    fin = _item(c, "AUD Widget", "finished", price=120)

    po = c.post("/api/purchases/", json={
        "supplier": "AUD Mill", "inventory_id": raw, "product_name": "AUD Steel",
        "quantity": 100, "unit_cost": 10,
    })
    assert po.status_code in (200, 201), po.text
    po_id = po.json()["id"]

    assert c.patch(f"/api/purchases/{po_id}/status",
                   json={"status": "Received"}).status_code == 200
    assert c.get(f"/api/inventory/{raw}").json()["quantity"] == pytest.approx(100)

    assert c.patch(f"/api/purchases/{po_id}/status",
                   json={"status": "Paid"}).status_code == 200
    # Backward transition must be refused — the books are already committed.
    assert c.patch(f"/api/purchases/{po_id}/status",
                   json={"status": "Ordered"}).status_code == 400

    _, bal = _tb(c)
    assert bal.get("1200", (0, 0))[0] == pytest.approx(1000, abs=CENT)  # DR Inventory
    assert bal.get("1000", (0, 0))[0] == pytest.approx(4000, abs=CENT)  # 5000 − 1000

    # ── Phase 2: manufacture — raw value moves WITHIN inventory, no P&L ────
    bom = c.post("/api/manufacturing/boms", json={
        "name": "AUD Widget BOM", "output_inventory_id": fin, "output_quantity": 1,
        "components": [{"component_inventory_id": raw, "quantity": 5}],
    })
    assert bom.status_code in (200, 201), bom.text
    order = c.post("/api/manufacturing/orders",
                   json={"bom_id": bom.json()["id"], "quantity": 10})
    assert order.status_code in (200, 201), order.text
    done = c.post(f"/api/manufacturing/orders/{order.json()['id']}/complete", json={})
    assert done.status_code in (200, 201), done.text

    assert c.get(f"/api/inventory/{raw}").json()["quantity"] == pytest.approx(50)
    fin_row = c.get(f"/api/inventory/{fin}").json()
    assert fin_row["quantity"] == pytest.approx(10)
    assert fin_row["unit_cost"] == pytest.approx(50, abs=CENT)   # 5 × $10 rolled up

    # Manufacturing must NOT touch the GL: value just changed shape (raw→FG).
    _, bal = _tb(c)
    assert bal.get("1200", (0, 0))[0] == pytest.approx(1000, abs=CENT)
    assert "5000" not in bal and "4000" not in bal   # no COGS, no revenue yet

    # ── Phase 3: POS — sell 4 finished units for cash ───────────────────────
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 100}).status_code == 200
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "AUD Widget", "inventory_id": fin,
                   "quantity": 4, "unit_price": 120}],
        "payment_method": "Cash", "amount_tendered": 480, "idempotency_key": _key(),
    })
    assert sale.status_code == 200, sale.text

    # The drawer must close on-count: opening 100 + cash 480, zero variance.
    closed = c.post("/api/pos/session/close", json={"closing_count": 580}).json()
    assert closed["expected_cash"] == pytest.approx(580, abs=CENT)
    assert closed["variance"] == pytest.approx(0, abs=CENT)

    # ── Phase 4: a paid service invoice + an office expense ────────────────
    _paid_invoice(c, 300, name="AUD Consulting")
    assert c.post("/api/finance/expenses",
                  json={"category": "Rent", "amount": 100}).status_code in (200, 201)

    # ── THE RECONCILIATION ──────────────────────────────────────────────────
    # (a) Trial balance: every account lands exactly where the story says.
    tb, bal = _tb(c)
    assert tb["balanced"] is True
    assert tb["total_debit"] == pytest.approx(tb["total_credit"], abs=CENT)
    assert bal["1000"][0] == pytest.approx(4680, abs=CENT)
    assert bal["1200"][0] == pytest.approx(800,  abs=CENT)
    assert bal["3000"][1] == pytest.approx(5000, abs=CENT)
    assert bal["4000"][1] == pytest.approx(780,  abs=CENT)
    assert bal["5000"][0] == pytest.approx(200,  abs=CENT)
    assert bal["6100"][0] == pytest.approx(100,  abs=CENT)

    # (b) Income statement (accrual P&L on the GL).
    isr = c.get(f"/api/accounting/income-statement?{WIDE_Q}").json()
    assert isr["total_income"]  == pytest.approx(780, abs=CENT)
    assert isr["total_expense"] == pytest.approx(300, abs=CENT)   # COGS 200 + rent 100
    assert isr["net_income"]    == pytest.approx(480, abs=CENT)

    # (c) Balance sheet: A = L + E + NI, and the totals match the story.
    bs = c.get("/api/accounting/balance-sheet").json()
    assert bs["balanced"] is True
    assert bs["total_assets"] == pytest.approx(5480, abs=CENT)        # 4680 + 800
    assert bs["net_income"]   == pytest.approx(480,  abs=CENT)
    assert bs["total_assets"] == pytest.approx(
        bs["total_liabilities"] + bs["total_equity"], abs=CENT)

    # (d) Cash flow: activities explain opening→closing exactly.
    cf = c.get(f"/api/accounting/cash-flow?{WIDE_Q}").json()
    assert cf["balanced"] is True
    assert cf["closing_cash"]    == pytest.approx(4680,  abs=CENT)
    assert cf["total_financing"] == pytest.approx(5000,  abs=CENT)
    assert cf["total_operating"] == pytest.approx(-320,  abs=CENT)  # 780−100−1000
    assert cf["net_change"] == pytest.approx(
        cf["closing_cash"] - cf["opening_cash"], abs=CENT)

    # (e) Cash-basis Finance dashboard: income = money in, expenses = money
    #     out (the purchase is an expense HERE, an asset on the GL — the two
    #     views legitimately differ by exactly the inventory still on hand).
    s = c.get("/api/finance/range-summary", params=WIDE).json()
    assert s["income"]   == pytest.approx(780,  abs=CENT)
    assert s["expenses"] == pytest.approx(1100, abs=CENT)           # 1000 PO + 100 rent
    assert s["profit"]   == pytest.approx(-320, abs=CENT)
    # GL net income − cash profit == inventory still on the shelf. Exact.
    assert isr["net_income"] - s["profit"] == pytest.approx(
        bal["1200"][0], abs=CENT)

    # (f) Physical stock == movement ledger == GL inventory value.
    for item_id, want in ((raw, 50), (fin, 6)):
        qty = c.get(f"/api/inventory/{item_id}").json()["quantity"]
        moved = db.execute(
            "SELECT COALESCE(SUM(delta),0) d FROM stock_movements WHERE inventory_id=?",
            (item_id,)).fetchone()["d"]
        assert qty == pytest.approx(want, abs=1e-6)
        assert qty == pytest.approx(moved, abs=1e-6)
    physical_value = (50 * 10) + (6 * 50)
    assert bal["1200"][0] == pytest.approx(physical_value, abs=CENT)

    # (g) Every step left an audit trail.
    n = db.execute("SELECT COUNT(*) n FROM audit_log").fetchone()["n"]
    assert n >= 8   # PO + 2 status changes + JE + POS open/close + payment + expense


# ═══════════════════════════════════════════════════════════════════════════
# 2. VAT — output and input reconcile; a POS return leaves the declaration
# ═══════════════════════════════════════════════════════════════════════════
def test_vat_output_input_and_pos_return_declaration(make_client, db):
    """
    Output VAT: $100-net invoice (+$11) and a VAT-inclusive POS sale of $12
    (VAT $1.19). Input VAT: a $222-gross expense (VAT $22). The declaration
    must show output 12.19 / input 22.00 / net −9.81, and after the POS sale
    is returned the output side must drop back to the invoice's $11 alone.
    """
    c = make_client("superadmin")
    _enable_vat(c)
    rid = _default_rate(c)

    # Output 1 — invoice: 2 × $50 net + 11% = $111 gross, fully paid.
    cl = c.post("/api/clients/", json={"name": "AUD VAT Co"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "Consulting", "quantity": 2, "unit_price": 50,
                   "tax_rate_id": rid}],
    }).json()["id"]
    inv = c.get(f"/api/invoices/{iid}").json()
    assert inv["tax_total"] == pytest.approx(11, abs=CENT)
    assert inv["amount"]    == pytest.approx(111, abs=CENT)
    c.post(f"/api/invoices/{iid}/payments",
           json={"amount": 111, "method": "Cash", "idempotency_key": _key()})

    # Output 2 — POS: 4 × $3 VAT-INCLUSIVE = $12 gross, VAT 12·11/111 = 1.19.
    soda = _item(c, "AUD Soda", "finished", qty=50, cost=1, price=3)
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 100}).status_code == 200
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "AUD Soda", "inventory_id": soda,
                   "quantity": 4, "unit_price": 3}],
        "payment_method": "Cash", "amount_tendered": 20, "idempotency_key": _key(),
    })
    assert sale.status_code == 200, sale.text
    pos_invoice = db.execute("SELECT subtotal, tax_total, amount FROM invoices WHERE id=?",
                             (sale.json()["invoice_id"],)).fetchone()
    assert pos_invoice["amount"]    == pytest.approx(12, abs=CENT)
    assert pos_invoice["tax_total"] == pytest.approx(1.19, abs=CENT)

    # Input — one $222-gross expense (VAT portion 222·11/111 = 22).
    assert c.post("/api/finance/expenses",
                  json={"category": "Materials", "amount": 222,
                        "tax_rate_id": rid}).status_code in (200, 201)

    vat = c.get("/api/reports/vat").json()
    assert vat["vat_enabled"] is True
    assert vat["output"]["vat"] == pytest.approx(11 + 1.19, abs=CENT)
    assert vat["input"]["vat"]  == pytest.approx(22, abs=CENT)
    assert vat["net_vat"] == pytest.approx(
        vat["output"]["vat"] - vat["input"]["vat"], abs=CENT)

    # ── Return the POS sale: declaration + stock must both walk it back ────
    sale_id = db.execute("SELECT id FROM pos_sales WHERE invoice_id=?",
                         (sale.json()["invoice_id"],)).fetchone()["id"]
    r = c.post(f"/api/pos/sales/{sale_id}/return", json={"reason": "Audit return"})
    assert r.status_code == 200, r.text
    # Returning twice must be refused.
    assert c.post(f"/api/pos/sales/{sale_id}/return",
                  json={"reason": "again"}).status_code == 400

    vat2 = c.get("/api/reports/vat").json()
    assert vat2["output"]["vat"] == pytest.approx(11, abs=CENT)   # POS sale excluded
    assert c.get(f"/api/inventory/{soda}").json()["quantity"] == pytest.approx(50)

    # Cash-basis income also excludes the voided sale (111 invoice only).
    s = c.get("/api/finance/range-summary", params=WIDE).json()
    assert s["income"] == pytest.approx(111, abs=CENT)


# FINDING-1 ──────────────────────────────────────────────────────────────────
@pytest.mark.xfail(
    strict=True,
    reason="FINDING-1: POS return voids the invoice and restocks the goods "
           "but never reverses the sale's GL entries — revenue, cash, COGS "
           "and inventory all stay on the ledger after the refund, so the GL "
           "drifts from Finance/VAT on every POS return.")
def test_pos_return_reverses_the_general_ledger(make_client, db):
    """DESIRED behaviour: after a full POS return the ledger shows no trace
    of the sale — revenue 0, COGS 0, cash back out, inventory restored."""
    c = make_client("superadmin")
    item = _item(c, "AUD Gadget", "finished", qty=10, cost=4, price=10)
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 50}).status_code == 200
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "AUD Gadget", "inventory_id": item,
                   "quantity": 2, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 20, "idempotency_key": _key(),
    })
    assert sale.status_code == 200, sale.text
    _, bal = _tb(c)
    assert bal["4000"][1] == pytest.approx(20, abs=CENT)
    assert bal["5000"][0] == pytest.approx(8,  abs=CENT)

    sale_id = db.execute("SELECT id FROM pos_sales WHERE invoice_id=?",
                         (sale.json()["invoice_id"],)).fetchone()["id"]
    assert c.post(f"/api/pos/sales/{sale_id}/return",
                  json={"reason": "ledger check"}).status_code == 200

    # The refund must leave NO net revenue, COGS, or cash from this sale.
    _, bal = _tb(c)
    assert bal.get("4000", (0, 0))[1] == pytest.approx(0, abs=CENT)
    assert bal.get("5000", (0, 0))[0] == pytest.approx(0, abs=CENT)
    assert bal.get("1000", (0, 0))[0] == pytest.approx(0, abs=CENT)
    assert bal.get("1200", (0, 0))[0] == pytest.approx(0, abs=CENT)


# FINDING-2 ──────────────────────────────────────────────────────────────────
@pytest.mark.xfail(
    strict=True,
    reason="FINDING-2: a taxed purchase debits Inventory (1200) at the VAT-"
           "INCLUSIVE gross while cost layers carry the ex-VAT landed cost — "
           "the input-VAT portion is never relieved by COGS and accumulates "
           "in the GL inventory account forever.")
def test_taxed_purchase_gl_inventory_matches_physical_value(make_client):
    """DESIRED behaviour: after buying 10 @ $10 + 11% VAT and selling all 10,
    GL Inventory returns to zero (input VAT belongs in a VAT-receivable
    account, not in stock)."""
    c = make_client("superadmin")
    _enable_vat(c)
    rid = _default_rate(c)
    item = _item(c, "AUD Taxed", "finished", price=20)

    po = c.post("/api/purchases/", json={
        "supplier": "AUD Tax Mill", "inventory_id": item, "product_name": "AUD Taxed",
        "quantity": 10, "unit_cost": 10, "tax_rate_id": rid,
    })
    assert po.status_code in (200, 201), po.text
    assert c.patch(f"/api/purchases/{po.json()['id']}/status",
                   json={"status": "Paid"}).status_code == 200

    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code == 200
    assert c.post("/api/pos/checkout", json={
        "items": [{"name": "AUD Taxed", "inventory_id": item,
                   "quantity": 10, "unit_price": 20}],
        "payment_method": "Cash", "amount_tendered": 250, "idempotency_key": _key(),
    }).status_code == 200

    # Zero units on hand ⇒ the GL inventory account must also be zero.
    assert c.get(f"/api/inventory/{item}").json()["quantity"] == pytest.approx(0)
    _, bal = _tb(c)
    assert bal.get("1200", (0, 0))[0] == pytest.approx(0, abs=CENT)


# ═══════════════════════════════════════════════════════════════════════════
# 3. Payroll and depreciation — posted once, to the right accounts
# ═══════════════════════════════════════════════════════════════════════════
def test_payroll_and_depreciation_post_once_to_correct_accounts(make_client, db):
    c = make_client("superadmin")

    # ── Payroll: 2,000 + 3,000 → one run → DR 6000 / CR 1000 of 5,000 ─────
    for name, sal in (("AUD Emp A", 2000), ("AUD Emp B", 3000)):
        assert c.post("/api/hr/employees", json={
            "full_name": name, "job_title": "Tech", "employment_type": "Full-time",
            "status": "Active", "salary": sal}).status_code == 200
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2026-05-01", "period_end": "2026-05-31"})
    assert run.status_code == 200, run.text
    run_id = run.json()["id"]
    assert c.post(f"/api/hr/payroll/runs/{run_id}/approve").status_code == 200
    first = c.post(f"/api/hr/payroll/runs/{run_id}/mark-paid")
    assert first.status_code == 200, first.text
    # Paying the same run twice is an idempotent no-op: same expense id back,
    # and NO second expense row or ledger entry below.
    again = c.post(f"/api/hr/payroll/runs/{run_id}/mark-paid")
    assert again.status_code == 200
    assert again.json()["expense_id"] == first.json()["expense_id"]

    _, bal = _tb(c)
    assert bal["6000"][0] == pytest.approx(5000, abs=CENT)
    n_payroll_jes = db.execute(
        "SELECT COUNT(*) n FROM journal_entries WHERE source_type='payroll'"
    ).fetchone()["n"]
    assert n_payroll_jes == 1
    n_payroll_exp = db.execute(
        "SELECT COUNT(*) n FROM expenses WHERE category='Payroll'"
    ).fetchone()["n"]
    assert n_payroll_exp == 1

    # ── Depreciation: $1,200 / 12 months → one $100 charge for 2026-01 ─────
    asset = c.post("/api/assets", json={
        "name": "AUD Laptop", "category": "Equipment",
        "acquisition_cost": 1200, "salvage_value": 0, "useful_life_months": 12,
        "acquisition_date": "2026-01-01", "in_service_date": "2026-01-01",
        "depreciation_method": "straight_line",
    })
    assert asset.status_code in (200, 201), asset.text
    aid = asset.json()["id"]
    assert c.post(f"/api/assets/{aid}/depreciate",
                  json={"period": "2026-01"}).status_code in (200, 201)
    # Re-running the same period must not double the charge.
    c.post(f"/api/assets/{aid}/depreciate", json={"period": "2026-01"})

    # Assert the LEDGER itself (the journal lines are the source of truth;
    # the trial-balance VIEW of 1510 is broken — see FINDING-3 below).
    _, bal = _tb(c)
    assert bal["6300"][0] == pytest.approx(100, abs=CENT)   # Depreciation Expense
    dep_lines = db.execute(
        """SELECT a.code, l.debit, l.credit
           FROM journal_entry_lines l
           JOIN journal_entries je ON je.id = l.journal_entry_id
           JOIN chart_of_accounts a ON a.id = l.account_id
           WHERE je.source_type='depreciation'""").fetchall()
    by_code = {r["code"]: r for r in dep_lines}
    assert by_code["6300"]["debit"]  == pytest.approx(100, abs=CENT)
    assert by_code["1510"]["credit"] == pytest.approx(100, abs=CENT)
    n_dep_jes = db.execute(
        "SELECT COUNT(*) n FROM journal_entries WHERE source_type='depreciation'"
    ).fetchone()["n"]
    assert n_dep_jes == 1

    # Both flow into the P&L, and the balance sheet still balances (it sums
    # by account type, so the contra-asset nets off correctly there).
    isr = c.get(f"/api/accounting/income-statement?{WIDE_Q}").json()
    assert isr["total_expense"] == pytest.approx(5100, abs=CENT)
    bs = c.get("/api/accounting/balance-sheet").json()
    assert bs["balanced"] is True


# FINDING-3 ──────────────────────────────────────────────────────────────────
@pytest.mark.xfail(
    strict=True,
    reason="FINDING-3: trial_balance() computes balances by account TYPE but "
           "presents them by normal_balance — contra accounts (1510, type "
           "Asset / normal credit) flip to the wrong side, so the TB shows "
           "Accumulated Depreciation as a DEBIT and reports balanced=False "
           "after any depreciation posting.")
def test_trial_balance_presents_contra_assets_on_the_credit_side(make_client):
    """DESIRED behaviour: a $100 depreciation charge shows 6300 debit 100 and
    1510 CREDIT 100, and the trial balance stays balanced."""
    c = make_client("superadmin")
    asset = c.post("/api/assets", json={
        "name": "AUD TB Machine", "category": "Equipment",
        "acquisition_cost": 1200, "salvage_value": 0, "useful_life_months": 12,
        "acquisition_date": "2026-01-01", "in_service_date": "2026-01-01",
        "depreciation_method": "straight_line",
    })
    assert asset.status_code in (200, 201), asset.text
    assert c.post(f"/api/assets/{asset.json()['id']}/depreciate",
                  json={"period": "2026-01"}).status_code in (200, 201)

    tb, bal = _tb(c)
    assert bal["1510"][1] == pytest.approx(100, abs=CENT)   # credit side
    assert bal["1510"][0] == pytest.approx(0,   abs=CENT)   # nothing on debit
    assert tb["balanced"] is True
    assert tb["total_debit"] == pytest.approx(tb["total_credit"], abs=CENT)


# ═══════════════════════════════════════════════════════════════════════════
# 4. Fiscal-year close — rolls up, locks everything dated in-year, reopens
# ═══════════════════════════════════════════════════════════════════════════
def test_fiscal_close_rolls_up_locks_and_reopens(make_client):
    c = make_client("superadmin")
    accts = _accounts(c)

    open_iid = _paid_invoice(c, 1000, name="AUD Year Rev")   # income 1,000
    assert c.post("/api/finance/expenses",
                  json={"category": "Rent", "amount": 400}).status_code in (200, 201)

    r = c.post("/api/accounting/fiscal-years/2026/close")
    assert r.status_code == 200, r.text
    assert r.json()["net_income"] == pytest.approx(600, abs=CENT)
    # Closing twice must be refused.
    assert c.post("/api/accounting/fiscal-years/2026/close").status_code == 400

    # P&L accounts are zeroed into Retained Earnings; the TB still balances.
    # (The closing entry is dated 2026-12-31, so read the TB as of year-end.)
    tb, bal = _tb(c, as_of="2026-12-31")
    assert tb["balanced"] is True
    assert bal["3900"][1] == pytest.approx(600, abs=CENT)
    assert bal.get("4000", (0, 0))[1] == pytest.approx(0, abs=CENT)

    # The income statement still reports the year's OPERATING result.
    isr = c.get("/api/accounting/income-statement"
                "?start=2026-01-01&end=2026-12-31").json()
    assert isr["net_income"] == pytest.approx(600, abs=CENT)

    bs = c.get("/api/accounting/balance-sheet", params={"as_of": "2026-12-31"}).json()
    assert bs["balanced"] is True

    # ── Everything dated in the closed year is now locked ──────────────────
    blocked = [
        c.post("/api/finance/expenses",                       # new expense (today)
               json={"category": "Rent", "amount": 10}),
        c.post("/api/accounting/journal-entries", json={      # manual JE in-year
            "entry_date": "2026-06-01", "memo": "late entry",
            "lines": [{"account_id": accts["1000"]["id"], "debit": 5},
                      {"account_id": accts["3000"]["id"], "credit": 5}]}),
        c.post(f"/api/invoices/{open_iid}/payments",          # payment (today)
               json={"amount": 1, "method": "Cash", "idempotency_key": _key()}),
    ]
    for resp in blocked:
        assert resp.status_code == 400, f"{resp.request.url} → {resp.status_code}: {resp.text}"
        assert "clos" in resp.text.lower() or "lock" in resp.text.lower(), resp.text

    # ── Reopen: the lock lifts and the closing entry is reversed ───────────
    assert c.post("/api/accounting/fiscal-years/2026/reopen").status_code == 200
    assert c.post("/api/finance/expenses",
                  json={"category": "Rent", "amount": 10}).status_code in (200, 201)
    tb, bal = _tb(c, as_of="2026-12-31")
    assert tb["balanced"] is True
    assert bal.get("3900", (0, 0))[1] == pytest.approx(0, abs=CENT)   # RE reversed out


# ═══════════════════════════════════════════════════════════════════════════
# 5. Exploit probes — every dirty trick is rejected with NO ledger side-effect
# ═══════════════════════════════════════════════════════════════════════════
def test_money_exploits_are_rejected_without_side_effects(make_client, db):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "AUD Exploit Co"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "X", "quantity": 1, "unit_price": 100}],
    }).json()["id"]

    # Overpayment: 60 OK, then 50 must bounce (only 40 remains).
    assert c.post(f"/api/invoices/{iid}/payments",
                  json={"amount": 60, "method": "Cash",
                        "idempotency_key": _key()}).status_code in (200, 201)
    r = c.post(f"/api/invoices/{iid}/payments",
               json={"amount": 50, "method": "Cash", "idempotency_key": _key()})
    assert r.status_code == 400 and "exceeds" in r.text.lower()

    # Duplicate-submission replay: same idempotency key → 409, ONE payment,
    # ONE ledger entry.
    dup = _key()
    assert c.post(f"/api/invoices/{iid}/payments",
                  json={"amount": 10, "method": "Cash",
                        "idempotency_key": dup}).status_code in (200, 201)
    assert c.post(f"/api/invoices/{iid}/payments",
                  json={"amount": 10, "method": "Cash",
                        "idempotency_key": dup}).status_code == 409
    n_pay = db.execute("SELECT COUNT(*) n FROM invoice_payments WHERE idempotency_key=?",
                       (dup,)).fetchone()["n"]
    assert n_pay == 1
    n_jes = db.execute(
        "SELECT COUNT(*) n FROM journal_entries WHERE source_type='invoice_payment'"
    ).fetchone()["n"]
    assert n_jes == 2          # the $60 and the $10 — nothing for the rejects

    # Negative / zero payments.
    for bad in (-5, 0):
        assert c.post(f"/api/invoices/{iid}/payments",
                      json={"amount": bad, "method": "Cash",
                            "idempotency_key": _key()}).status_code in (400, 422)

    # Paying a voided invoice.
    void_iid = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "V", "quantity": 1, "unit_price": 50}],
    }).json()["id"]
    assert c.patch(f"/api/invoices/{void_iid}/void",
                   json={"reason": "audit"}).status_code == 200
    r = c.post(f"/api/invoices/{void_iid}/payments",
               json={"amount": 50, "method": "Cash", "idempotency_key": _key()})
    assert r.status_code == 400 and "void" in r.text.lower()

    # POS: overselling, negative quantity, negative price.
    item = _item(c, "AUD Scarce", "finished", qty=2, cost=1, price=10)
    assert c.post("/api/pos/session/open",
                  json={"opening_float": 0}).status_code == 200
    for items in (
        [{"name": "AUD Scarce", "inventory_id": item, "quantity": 3,  "unit_price": 10}],
        [{"name": "AUD Scarce", "inventory_id": item, "quantity": -1, "unit_price": 10}],
        [{"name": "AUD Scarce", "inventory_id": item, "quantity": 1,  "unit_price": -10}],
    ):
        r = c.post("/api/pos/checkout", json={
            "items": items, "payment_method": "Cash",
            "amount_tendered": 100, "idempotency_key": _key()})
        assert r.status_code in (400, 422), f"{items} → {r.status_code}"
    assert c.get(f"/api/inventory/{item}").json()["quantity"] == pytest.approx(2)

    # Manual journal entries: unbalanced, negative line, single line → 400.
    accts = _accounts(c)
    cash, eq = accts["1000"]["id"], accts["3000"]["id"]
    bad_jes = [
        {"entry_date": "2026-06-01", "memo": "unbalanced",
         "lines": [{"account_id": cash, "debit": 100},
                   {"account_id": eq, "credit": 90}]},
        {"entry_date": "2026-06-01", "memo": "negative",
         "lines": [{"account_id": cash, "debit": -100},
                   {"account_id": eq, "credit": -100}]},
        {"entry_date": "2026-06-01", "memo": "single-sided",
         "lines": [{"account_id": cash, "debit": 100}]},
    ]
    for je in bad_jes:
        assert c.post("/api/accounting/journal-entries",
                      json=je).status_code in (400, 422), je["memo"]

    # Negative expense.
    assert c.post("/api/finance/expenses",
                  json={"category": "Rent", "amount": -10}).status_code in (400, 422)

    # After every rejected probe the books are still balanced.
    tb, _ = _tb(c)
    assert tb["balanced"] is True


# ═══════════════════════════════════════════════════════════════════════════
# 6. RBAC seams — a Sales user cannot touch the books
# ═══════════════════════════════════════════════════════════════════════════
def test_sales_role_cannot_touch_the_books(make_client):
    admin = make_client("superadmin")
    sales = make_client("Sales")
    accts = _accounts(admin)

    # Post a manual journal entry → forbidden.
    r = sales.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-06-01", "memo": "sneaky",
        "lines": [{"account_id": accts["1000"]["id"], "debit": 5},
                  {"account_id": accts["3000"]["id"], "credit": 5}]})
    assert r.status_code == 403

    # Close the fiscal year → forbidden.
    assert sales.post("/api/accounting/fiscal-years/2026/close").status_code == 403

    # Run payroll → forbidden.
    assert sales.post("/api/hr/payroll/runs",
                      json={"period_start": "2026-05-01",
                            "period_end": "2026-05-31"}).status_code == 403
