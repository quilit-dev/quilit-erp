"""Every transaction, on whichever chart the business is on.

A posting that names an account by constant gets the default chart's code
whatever chart the tenant keeps its books on. On Lebanon's plan that account is
retired, so a till sale credited revenue nobody uses any more — and did it
silently, because both sides posted consistently and the trial balance still
balanced. Nothing complains; the books are simply wrong.

So this runs one transaction of each kind on the Lebanese chart and asserts
that every account touched belongs to it.
"""
import uuid

import pytest as _pytest

import chart_lebanon as LB

pytestmark = _pytest.mark.critical

OURS = {a[0] for a in LB.all_accounts()}


@_pytest.fixture
def client(as_role):
    c = as_role("superadmin")
    r = c.post("/api/accounting/chart/lebanon/install", json={})
    assert r.status_code == 200, r.text
    return c


@_pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Wiring Co"}).json()["id"]


@_pytest.fixture
def widget(client):
    return client.post("/api/inventory/", json={
        "name": "Widget", "quantity": 100, "unit_price": 50,
        "unit_cost": 20, "category": "Goods"}).json()["id"]


def _codes(db, source_type=None):
    """Every account code posted to, optionally for one source."""
    q = ("SELECT a.code FROM journal_entry_lines l "
         "JOIN journal_entries je ON je.id = l.journal_entry_id "
         "JOIN chart_of_accounts a ON a.id = l.account_id")
    args = ()
    if source_type:
        q += " WHERE je.source_type = ?"
        args = (source_type,)
    return {r["code"] for r in db.execute(q, args).fetchall()}


def _off_chart(db, source_type=None):
    return sorted(c for c in _codes(db, source_type) if c not in OURS)


# ── Each source, one at a time ───────────────────────────────────────────────

def test_an_invoice_and_its_payment_stay_on_the_chart(client, acme, db):
    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 200}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 200, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    assert _off_chart(db) == []
    assert "7011" in _codes(db, "invoice_payment")     # sales
    assert "4111" in _codes(db, "invoice")             # customers


def test_a_till_sale_credits_the_charts_own_revenue(client, acme, widget, db):
    """It credited 4000 — the default chart's revenue, retired here."""
    client.post("/api/pos/session/open", json={"opening_float": 0})
    client.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": widget,
                   "quantity": 1, "unit_price": 50}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 50,
        "idempotency_key": str(uuid.uuid4())})

    assert _off_chart(db) == []
    assert "7011" in _codes(db, "invoice_payment")


def test_a_till_sales_cost_of_goods_stays_on_the_chart(client, widget, db):
    client.post("/api/pos/session/open", json={"opening_float": 0})
    client.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": widget,
                   "quantity": 2, "unit_price": 50}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 100,
        "idempotency_key": str(uuid.uuid4())})

    cogs = _codes(db, "pos_cogs")
    assert cogs, "no cost of goods was posted"
    assert cogs <= OURS, f"off-chart: {sorted(cogs - OURS)}"


def test_a_service_job_stays_on_the_chart(client, acme, widget, db):
    eq = client.post("/api/service/equipment", json={
        "client_id": acme, "name": "Machine"}).json()["id"]
    job = client.post("/api/service/jobs", json={
        "client_id": acme, "equipment_id": eq, "job_type": "Repair",
        "items": [{"line_type": "part", "name": "Widget",
                   "inventory_id": widget, "quantity": 1, "unit_price": 50},
                  {"line_type": "charge", "name": "Labour",
                   "quantity": 1, "unit_price": 80}]}).json()["id"]
    client.post(f"/api/service/jobs/{job}/start", json={})
    client.post(f"/api/service/jobs/{job}/complete", json={})

    assert _off_chart(db) == []


def test_an_expense_lands_on_a_charge_account_of_this_chart(client, db):
    """The category map is the default chart's codes. This plan has one
    "other external charges" where that one has rent as its own account."""
    client.post("/api/finance/expenses", json={
        "category": "Rent", "description": "Shop rent", "amount": 300,
        "date": "2026-03-01"})

    assert _off_chart(db, "expense") == []


def test_a_category_this_chart_has_no_mapping_for_still_lands_somewhere_real(
        client, db):
    """The safety net. Whatever is chosen has to be an account this chart
    actually has, or the expense lands on a retired one — silently."""
    client.post("/api/finance/expenses", json={
        "category": "Marketing", "description": "Ads", "amount": 90,
        "date": "2026-03-02"})

    assert _off_chart(db, "expense") == []


def test_the_owners_own_category_mapping_still_wins(client, db):
    """Settings → Categories is the authoritative answer, and it must beat
    whatever this chart's default map says."""
    # Rent is a seeded category, so this sets its account rather than
    # inserting a second row.
    db.execute("UPDATE categories SET account_code='661' "
               "WHERE domain='expense' AND name='Rent'")
    db.commit()

    client.post("/api/finance/expenses", json={
        "category": "Rent", "description": "Shop rent", "amount": 100,
        "date": "2026-03-03"})

    assert "661" in _codes(db, "expense")


# ── The sweep ────────────────────────────────────────────────────────────────

def test_nothing_anywhere_posts_off_the_installed_chart(client, acme, widget, db):
    """One of everything, then look at every account touched."""
    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 200}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 200, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    client.post("/api/pos/session/open", json={"opening_float": 0})
    client.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": widget,
                   "quantity": 1, "unit_price": 50}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 50,
        "idempotency_key": str(uuid.uuid4())})
    client.post("/api/finance/expenses", json={
        "category": "Utilities", "description": "Power", "amount": 60,
        "date": "2026-03-04"})

    stray = _off_chart(db)
    assert stray == [], f"these posted off the installed chart: {stray}"
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_no_posting_names_an_account_by_constant(client):
    """The static half. A constant freezes the default chart's code into the
    posting, which is how every one of these went wrong in the first place."""
    import inspect
    import importlib

    offenders = []
    for name in ("routers.pos", "routers.service", "routers.purchases",
                 "routers.finance", "routers.recurring", "routers.assets",
                 "routers.cash", "routers.hr"):
        src = inspect.getsource(importlib.import_module(name))
        for const in ("REVENUE", "SERVICE_REVENUE", "COGS", "INVENTORY",
                      "CASH_LBP", "CASH_EUR", "VAT_CONTROL", "PREPAID",
                      "SALARIES", "DEPRECIATION", "ACC_DEP",
                      "CASH_SHORT_OVER", "FX_GAIN", "FX_LOSS"):
            if f"accounting.{const}" in src:
                offenders.append(f"{name}.{const}")
    assert offenders == [], offenders


# ── The whole business, in one sweep ─────────────────────────────────────────
# The tests above take one source at a time. This runs everything that posts,
# on the Lebanese chart, and then asks a single question of the ledger: is
# every account touched one of this chart's own? A gap anywhere shows up here
# whether or not somebody remembered to write a test for that module.

def test_every_kind_of_transaction_posts_on_the_installed_chart(
        client, acme, widget, db):
    import uuid as _uuid
    from datetime import date, timedelta

    bank = client.post("/api/banks/",
                       json={"name": "Byblos", "currency": "USD"}).json()

    # Sales: an invoice settled by transfer.
    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0, "due_date": "2026-12-31",
        "items": [{"name": "Widget", "inventory_id": widget,
                   "quantity": 1, "unit_price": 200}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 200, "currency": "USD", "method": "Bank Transfer",
        "bank_account_id": bank["id"], "idempotency_key": str(_uuid.uuid4())})

    # The till, on a card.
    client.post("/api/pos/session/open", json={"opening_float": 0})
    client.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": widget,
                   "quantity": 1, "unit_price": 50}],
        "payment_method": "Card", "currency": "USD", "amount_tendered": 50,
        "bank_account_id": bank["id"], "idempotency_key": str(_uuid.uuid4())})

    # A bill, and a supplier paid.
    client.post("/api/finance/expenses", json={
        "category": "Rent", "amount": 60, "date": str(date.today()),
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]})
    po = client.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": widget, "product_name": "Widget",
        "quantity": 2, "unit_cost": 20, "status": "Ordered"}).json()["id"]
    client.patch(f"/api/purchases/{po}/status", json={
        "status": "Paid", "payment_method": "Bank Transfer",
        "bank_account_id": bank["id"]})

    # An asset bought, worn down and sold.
    asset = client.post("/api/assets/", json={
        "name": "Truck", "acquisition_cost": 30000,
        "acquisition_date": (date.today() - timedelta(days=365)).isoformat(),
        "depreciation_method": "straight_line", "useful_life_months": 60,
        "salvage_value": 6000, "payment_method": "Bank Transfer",
        "bank_account_id": bank["id"]}).json()
    client.post(f"/api/assets/{asset['id']}/depreciate", json={})
    client.post(f"/api/assets/{asset['id']}/dispose", json={
        "disposal_proceeds": 27000, "payment_method": "Bank Transfer",
        "bank_account_id": bank["id"]})

    # And the staff paid.
    client.post("/api/hr/employees", json={
        "full_name": "Sami", "salary": 500, "hire_date": "2026-01-01"})
    start = date.today().replace(day=1)
    run = client.post("/api/hr/payroll/runs", json={
        "period_start": str(start),
        "period_end": str(start + timedelta(days=27))}).json()["id"]
    client.post(f"/api/hr/payroll/runs/{run}/approve", json={})
    client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={
        "payment_method": "Bank Transfer", "bank_account_id": bank["id"]})

    # A bank account's own leaf is a child of this chart, opened under whatever
    # the `bank` role points at, so it counts as ours.
    theirs = OURS | {r["account_code"] for r in db.execute(
        "SELECT account_code FROM bank_accounts").fetchall()}

    posted = db.execute(
        "SELECT DISTINCT je.source_type, a.code, a.name "
        "  FROM journal_entry_lines l "
        "  JOIN journal_entries je ON je.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id").fetchall()
    stray = sorted({(r["source_type"], r["code"], r["name"]) for r in posted
                    if r["code"] not in theirs})

    assert stray == [], f"these posted off the Lebanese chart: {stray}"
    # Every module that moves money is represented, so a silent gap cannot
    # pass by simply never posting.
    kinds = {r["source_type"] for r in posted}
    for expected in ("invoice", "invoice_payment", "expense", "purchase",
                     "payroll", "depreciation", "asset_acquisition",
                     "asset_disposal", "pos_cogs"):
        assert expected in kinds, f"{expected} posted nothing"
    assert client.get("/api/accounting/trial-balance").json()["balanced"]
