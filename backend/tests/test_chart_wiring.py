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
