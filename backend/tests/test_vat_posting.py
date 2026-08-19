"""VAT is a liability, not income.

Tax collected on a sale is held on the authority's behalf and owed to them. It
was previously credited to revenue, which overstated turnover by the tax rate on
every sale and left the liability off the balance sheet entirely. Input VAT on
expenses was buried in the cost for the same reason.

The VAT return was never affected — it is computed from the invoice and expense
records, not the ledger — so nothing was ever misfiled. The error was confined to
the P&L and the balance sheet, which is exactly what these tests pin down.

One VAT CONTROL account is used for both directions: output VAT credits it,
input VAT debits it, so its balance IS the net position and can be compared
directly against the return.
"""
import pytest


TAX = 11.0


@pytest.fixture
def client(as_role):
    c = as_role("superadmin")
    c.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": str(TAX)})
    return c


@pytest.fixture
def vat_rate(client):
    rows = client.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    r = next((x for x in rows if float(x.get("rate") or 0) == TAX), None)
    assert r, "the 11% rate should be seeded"
    return r["id"]


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "VAT Test Ltd"}).json()["id"]


def _balance(client, code):
    """Debit-positive balance for one account."""
    body = client.get("/api/accounting/trial-balance").json()
    rows = body.get("rows") if isinstance(body, dict) else body
    for r in rows or []:
        if str(r.get("code")) == code:
            return float(r.get("debit") or 0) - float(r.get("credit") or 0)
    return 0.0


def _sell(client, acme, vat_rate, net, pay=None):
    """A taxed sale, paid. Returns the invoice record."""
    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": net,
                   "tax_rate_id": vat_rate}]}).json()
    inv_id = created.get("invoice_id") or created.get("id")
    full = client.get(f"/api/invoices/{inv_id}").json()
    amount = pay if pay is not None else full["amount"]
    r = client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": amount, "currency": "USD", "method": "Cash",
        "idempotency_key": f"vat-{inv_id}-{amount}"})
    assert r.status_code == 200, r.text
    return full


# ── Output VAT ───────────────────────────────────────────────────────────────

def test_a_taxed_sale_credits_revenue_net_of_vat(client, acme, vat_rate):
    """The headline fix: $100 of goods at 11% is $100 of revenue, not $111."""
    rev_before = _balance(client, "4000")
    vat_before = _balance(client, "2100")

    inv = _sell(client, acme, vat_rate, 100)

    assert inv["subtotal"] == pytest.approx(100)
    assert inv["tax_total"] == pytest.approx(11)
    # Revenue is a credit account, so its debit-positive balance moves negative.
    assert -(_balance(client, "4000") - rev_before) == pytest.approx(100)
    assert -(_balance(client, "2100") - vat_before) == pytest.approx(11)


def test_the_liability_appears_on_the_balance_sheet(client, acme, vat_rate):
    """It was previously absent: the business owed the authority and the books
    said nothing."""
    _sell(client, acme, vat_rate, 100)

    body = client.get("/api/accounting/balance-sheet").json()
    text = str(body)

    assert "2100" in text or "VAT" in text, "no VAT liability on the balance sheet"


def test_the_entry_still_balances(client, acme, vat_rate):
    """Carving a third line out of a two-line entry is where rounding breaks."""
    _sell(client, acme, vat_rate, 33.33)

    body = client.get("/api/accounting/trial-balance").json()
    totals = body.get("totals") if isinstance(body, dict) else None
    if totals:
        assert totals["debit"] == pytest.approx(totals["credit"])
    else:
        rows = body.get("rows") if isinstance(body, dict) else body
        d = sum(float(r.get("debit") or 0) for r in rows)
        c = sum(float(r.get("credit") or 0) for r in rows)
        assert d == pytest.approx(c)


def test_a_part_payment_owes_only_part_of_the_vat(client, acme, vat_rate):
    """Half an invoice paid owes half its VAT — the same proportional rule the
    revenue split already used."""
    rev_before = _balance(client, "4000")
    vat_before = _balance(client, "2100")

    _sell(client, acme, vat_rate, 100, pay=55.50)     # half of 111.00

    assert -(_balance(client, "2100") - vat_before) == pytest.approx(5.50)
    assert -(_balance(client, "4000") - rev_before) == pytest.approx(50.00)


def test_a_business_not_charging_vat_is_unaffected(client, acme):
    """The change must be invisible to anyone who does not charge VAT: one
    credit to revenue, no VAT line, exactly as before.

    Tax has to be switched OFF for this — an invoice with no explicit rate
    still picks up the company default, which is why the previous version of
    this test saw VAT it did not ask for. Expenses behave the other way round
    and take no default at all (see resolve_expense_tax).
    """
    client.put("/api/settings/", json={"tax_enabled": "0"})
    rev_before = _balance(client, "4000")
    vat_before = _balance(client, "2100")

    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 100}]}).json()
    inv_id = created.get("invoice_id") or created.get("id")
    full = client.get(f"/api/invoices/{inv_id}").json()
    client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": full["amount"], "currency": "USD", "method": "Cash",
        "idempotency_key": "vat-none-1"})

    assert -(_balance(client, "4000") - rev_before) == pytest.approx(100)
    assert _balance(client, "2100") == pytest.approx(vat_before)


# ── Input VAT ────────────────────────────────────────────────────────────────

def test_an_expense_debits_cost_net_and_vat_separately(client, vat_rate):
    """An expense amount is tax-INCLUSIVE, so the VAT inside it is recoverable
    and is not a cost."""
    vat_before = _balance(client, "2100")

    r = client.post("/api/finance/expenses", json={
        "category": "Utilities", "amount": 200, "description": "Power",
        "date": "2026-08-18", "payment_method": "Cash", "tax_rate_id": vat_rate})
    assert r.status_code == 200, r.text

    # 200 gross at 11% inclusive = 180.18 net + 19.82 VAT.
    assert _balance(client, "6200") == pytest.approx(180.18, abs=0.02)
    assert _balance(client, "2100") - vat_before == pytest.approx(19.82, abs=0.02)


def test_an_untaxed_expense_is_unchanged(client):
    vat_before = _balance(client, "2100")

    client.post("/api/finance/expenses", json={
        "category": "Utilities", "amount": 200, "description": "Power",
        "date": "2026-08-18", "payment_method": "Cash"})

    assert _balance(client, "6200") == pytest.approx(200)
    assert _balance(client, "2100") == pytest.approx(vat_before)


# ── The whole point: the ledger and the return agree ─────────────────────────

def test_the_control_account_equals_the_vat_return(client, acme, vat_rate):
    """The reason for a single control account. Its balance is what is owed, and
    that must be the same number the return reports — otherwise reconciling the
    two is guesswork every quarter."""
    _sell(client, acme, vat_rate, 1000)                       # output VAT 110.00
    client.post("/api/finance/expenses", json={
        "category": "Utilities", "amount": 555, "description": "Power",
        "date": "2026-08-18", "payment_method": "Cash",
        "tax_rate_id": vat_rate})                             # input VAT 55.00

    vat_return = client.get("/api/reports/vat").json()
    owed_per_return = float(vat_return["net_vat"])
    # Liability: credit-positive, so negate the debit-positive balance.
    owed_per_ledger = -_balance(client, "2100")

    assert owed_per_return == pytest.approx(55.0, abs=0.05)
    assert owed_per_ledger == pytest.approx(owed_per_return, abs=0.05)


def test_purchase_input_vat_also_reaches_the_control_account(client, vat_rate):
    """Purchases already split the tax out, but debited it to Other Expenses —
    treating reclaimable VAT as a cost. Same error as the sales side, opposite
    direction, third posting site."""
    import routers.purchases as purchases_src
    import inspect

    src = inspect.getsource(purchases_src)
    assert "accounting.VAT_CONTROL" in src, "purchase VAT does not reach 2100"
    assert 'accounting.OTHER_EXPENSE, "debit": tax_part' not in src


def test_all_three_posting_sites_use_the_same_account():
    """Sales, expenses and purchases must agree, or the control account no
    longer equals the return and reconciling is guesswork."""
    import inspect
    import accounting
    import routers.finance as finance_src
    import routers.purchases as purchases_src

    assert accounting.VAT_CONTROL == "2100"
    assert "VAT_CONTROL" in inspect.getsource(accounting.revenue_split)
    assert "accounting.VAT_CONTROL" in inspect.getsource(finance_src)
    assert "accounting.VAT_CONTROL" in inspect.getsource(purchases_src)
