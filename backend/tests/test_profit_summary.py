"""The profit summary: one row per month or week.

What has to hold for an owner to trust it:

  * Sales are counted where they happened --- till, invoice, service job ---
    net of VAT, by the day they were issued.
  * Cost, expenses and salaries agree with the income statement: together
    they are exactly its total expenses for the same dates. The expenses
    LIST is not used, because it also carries stock purchases, payroll and
    depreciation, and summing it would count money twice.
  * Buying stock is not an expense. A hand-typed expense in a category that
    happens to post to the cost-of-goods account is an expense, not cost.
  * What is still owed on the period's sales comes off the cash profit.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical

TODAY = None


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _today():
    from datetime import date
    return date.today().isoformat()


def _report(client, **params):
    params.setdefault("start", _today()[:8] + "01")
    params.setdefault("end", _today())
    r = client.get("/api/reports/profit-summary", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _this_period(body):
    key = _today()[:7]
    return next(r for r in body["rows"] if r["period"] == key)


def _pos_sale(client, price=100, cost=40):
    client.post("/api/pos/session/open", json={"opening_float": 0})
    name = f"Item {uuid.uuid4().hex[:6]}"
    item = client.post("/api/inventory/", json={
        "name": name, "quantity": 5, "unit_cost": cost, "sale_price": price}).json()
    r = client.post("/api/pos/checkout", json={
        "items": [{"name": name, "inventory_id": item["id"],
                   "quantity": 1, "unit_price": price}],
        "payment_method": "Cash", "amount_tendered": price,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text


def _invoice(client, amount, paid=0, service=False, db=None):
    cid = client.post("/api/clients/", json={"name": "Client " + uuid.uuid4().hex[:5]}).json()["id"]
    inv = client.post("/api/invoices/", json={
        "client_id": cid, "items": [{"name": "Work", "quantity": 1, "unit_price": amount}]}).json()
    iid = inv.get("id") or inv.get("invoice_id")
    if paid:
        r = client.post(f"/api/invoices/{iid}/payments", json={
            "amount": paid, "currency": "USD", "method": "Cash",
            "idempotency_key": str(uuid.uuid4())})
        assert r.status_code == 200, r.text
    if service:
        # A service job's invoice carries its job. Completing a whole job is
        # not the point here; the link is what the report reads.
        job = client.post("/api/service/jobs", json={
            "client_id": cid, "job_type": "Repair", "reported_fault": "x", "items": []})
        assert job.status_code == 200, job.text
        db.execute("UPDATE invoices SET service_job_id = ? WHERE id = ?",
                   (job.json()["id"], iid))
        db.commit()
    return iid


def test_sales_are_split_by_where_they_happened(client, db):
    _pos_sale(client, price=100)
    _pos_sale(client, price=50)
    _invoice(client, 300, paid=300)
    _invoice(client, 200, paid=200, service=True, db=db)

    row = _this_period(_report(client))
    assert (row["pos_count"], row["pos_sales"]) == (2, pytest.approx(150))
    assert (row["invoice_count"], row["invoice_sales"]) == (1, pytest.approx(300))
    assert (row["service_count"], row["service_sales"]) == (1, pytest.approx(200))
    assert row["sales_count"] == 4 and row["sales"] == pytest.approx(650)


def test_cost_of_goods_and_gross_profit(client):
    _pos_sale(client, price=100, cost=40)
    row = _this_period(_report(client))
    assert row["cost"] == pytest.approx(40)
    assert row["gross_profit"] == pytest.approx(60)
    assert row["gross_margin_pct"] == pytest.approx(60.0)


def test_what_is_still_owed_comes_off_the_cash_profit(client):
    _invoice(client, 1000, paid=400)
    row = _this_period(_report(client))
    assert row["uncollected"] == pytest.approx(600)
    assert row["cash_profit"] == pytest.approx(row["net_profit"] - 600)


def test_buying_stock_is_not_an_expense(client):
    item = client.post("/api/inventory/", json={
        "name": "Stock " + uuid.uuid4().hex[:5], "quantity": 0, "unit_cost": 10}).json()["id"]
    r = client.post("/api/purchases/", json={
        "supplier": "Acme", "status": "Received",
        "items": [{"inventory_id": item, "product_name": "Stock",
                   "quantity": 10, "unit_cost": 10}]})
    assert r.status_code in (200, 201), r.text

    row = _this_period(_report(client))
    assert row["expenses"] == pytest.approx(0), "a stock purchase was counted as an expense"
    assert row["cost"] == pytest.approx(0), "unsold stock was counted as cost"
    assert row["purchases_count"] == 1 and row["purchases"] == pytest.approx(100)


def test_a_typed_expense_on_the_cost_account_is_an_expense_not_cost(client):
    # "Purchase" posts to the cost-of-goods account on the default chart.
    r = client.post("/api/finance/expenses", json={
        "category": "Purchase", "amount": 75, "description": "Cleaning supplies",
        "date": _today(), "payment_method": "Cash"})
    assert r.status_code == 200, r.text
    row = _this_period(_report(client))
    assert row["expenses"] == pytest.approx(75)
    assert row["cost"] == pytest.approx(0)


def test_cost_expenses_and_salaries_equal_the_income_statement(client):
    _pos_sale(client, price=100, cost=40)
    client.post("/api/finance/expenses", json={
        "category": "Rent", "amount": 500, "description": "Rent",
        "date": _today(), "payment_method": "Cash"})
    client.post("/api/finance/expenses", json={
        "category": "Purchase", "amount": 30, "description": "Supplies",
        "date": _today(), "payment_method": "Cash"})
    start, end = _today()[:8] + "01", _today()
    body = _report(client, start=start, end=end)
    t = body["totals"]
    inc = client.get("/api/accounting/income-statement",
                     params={"start": start, "end": end}).json()
    expense_total = inc["total_expense"]
    assert t["cost"] + t["expenses"] + t["salaries"] == pytest.approx(expense_total)


def test_every_period_is_listed_even_a_quiet_one(client):
    body = _report(client, start="2026-01-01", end="2026-03-31")
    assert [r["period"] for r in body["rows"]] == ["2026-01", "2026-02", "2026-03"]
    assert all(r["sales"] == 0 for r in body["rows"])


def test_weeks_start_on_monday(client):
    body = _report(client, start="2026-09-02", end="2026-09-16", group="week")
    assert [r["period"] for r in body["rows"]] == ["2026-08-31", "2026-09-07", "2026-09-14"]
    assert body["rows"][0]["end"] == "2026-09-06"


def test_totals_add_up_the_rows(client, db):
    _pos_sale(client, price=100)
    _invoice(client, 300, paid=100)
    body = _report(client)
    for k in ("sales", "cost", "expenses", "net_profit", "uncollected", "cash_profit"):
        assert body["totals"][k] == pytest.approx(sum(r[k] for r in body["rows"])), k


# ── who may read it ──────────────────────────────────────────────────────────
# Its own permission. Reports access alone (a Sales Manager has it) does not
# show the company's margin and net profit; whoever can open Accounting
# already sees the income statement, so they hold it by default.

def test_reports_access_alone_does_not_open_the_profit_summary(as_role):
    r = as_role("Sales Manager").get("/api/reports/profit-summary")
    assert r.status_code == 403
    # ...while the rest of Reports still works for them.
    assert as_role("Sales Manager").get("/api/reports/expenses").status_code == 200


def test_the_owner_and_accounting_roles_hold_it_by_default(as_role, db):
    for role in ("Accountant", "Finance Manager"):
        assert as_role(role).get("/api/reports/profit-summary").status_code == 200, role
    owner = db.execute(
        "SELECT rp.can_view FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
        " WHERE r.name = 'Business Owner' AND rp.module = 'profit_report'").fetchone()
    assert owner is not None and owner["can_view"] == 1


def test_the_permission_can_be_granted_to_a_role(as_role, db):
    db.execute(
        "INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, "
        " can_delete, can_approve) SELECT id, 'profit_report', 1, 0, 0, 0, 0 FROM roles "
        " WHERE name = 'Sales Manager'")
    db.commit()
    assert as_role("Sales Manager").get("/api/reports/profit-summary").status_code == 200


def test_it_is_a_permission_the_role_editor_offers():
    import permissions, capabilities, vendor_config
    assert "profit_report" in permissions.MODULES
    assert "profit_report" in capabilities.ALWAYS_ON
    assert "profit_report" in vendor_config._ALWAYS_ON
