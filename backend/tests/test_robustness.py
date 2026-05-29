"""
Robustness — the ERP must never throw a 500 under bad input or heavy load.

Two parts:
  * Fuzz: every write endpoint is hit with malformed / empty / non-existent /
    negative / oversized input and must answer with a CLEAN 4xx (400/404/409/
    422), never a 500 (an unhandled exception = a bug the user would hit).
  * Volume: thousands of rows are inserted, then the list / report / dashboard
    endpoints must still return 200 (no blow-ups, no timeouts).
"""
import uuid
import pytest

BAD = 999_999_999          # an id that never exists
BIG = "x" * 20_000         # oversized string


def _key():
    return str(uuid.uuid4())


# ── 1. Create endpoints — empty body must not 500 ───────────────────────────
CREATE_ENDPOINTS = [
    "/api/clients/", "/api/projects/", "/api/quotations/", "/api/invoices/",
    "/api/inventory/", "/api/purchases/", "/api/suppliers/",
    "/api/finance/expenses",
    "/api/crm/leads", "/api/crm/deals", "/api/crm/contacts", "/api/crm/activities",
    "/api/planning/projects", "/api/planning/tasks", "/api/planning/milestones",
    "/api/planning/events",
    "/api/hr/departments", "/api/hr/employees", "/api/hr/leave",
    "/api/manufacturing/boms", "/api/manufacturing/orders",
    "/api/assets", "/api/cash/drawers", "/api/cash/reconciliations",
    "/api/tax-rates/", "/api/roles/", "/api/users/", "/api/recurring-expenses",
    "/api/announcements/",
]


@pytest.mark.parametrize("path", CREATE_ENDPOINTS)
def test_create_empty_body_never_500(make_client, path):
    r = make_client("superadmin").post(path, json={})
    assert r.status_code < 500, f"POST {path} empty -> {r.status_code}: {r.text[:300]}"


# ── 2. Actions on a non-existent id must 404/400, never 500 ─────────────────
ID_ACTIONS = [
    ("put",    f"/api/invoices/{BAD}",                  {"amount": 1, "version": 1}),
    ("patch",  f"/api/invoices/{BAD}/void",             {"reason": "x"}),
    ("patch",  f"/api/invoices/{BAD}/archive",          {"reason": "x"}),
    ("patch",  f"/api/invoices/{BAD}/unarchive",        None),
    ("post",   f"/api/invoices/{BAD}/payments",         {"amount": 10, "method": "Cash", "idempotency_key": _key()}),
    ("delete", f"/api/invoices/{BAD}/payments/{BAD}",   None),
    ("put",    f"/api/quotations/{BAD}",                {"client_id": None, "items": []}),
    ("post",   f"/api/quotations/{BAD}/convert-to-invoice", None),
    ("post",   f"/api/quotations/{BAD}/convert-to-project", None),
    ("patch",  f"/api/quotations/{BAD}/cancel",         {"reason": "x"}),
    ("patch",  f"/api/projects/{BAD}/cancel",           {"reason": "x"}),
    ("patch",  f"/api/projects/{BAD}/status",           {"status": "Active"}),
    ("put",    f"/api/clients/{BAD}",                   {"name": "x"}),
    ("patch",  f"/api/clients/{BAD}/archive",           {"reason": "x"}),
    ("put",    f"/api/inventory/{BAD}",                 {"name": "x"}),
    ("patch",  f"/api/inventory/{BAD}/stock",           {"delta": 5, "type": "adjust"}),
    ("post",   f"/api/inventory/{BAD}/deduct-to-project", {"project_id": BAD, "quantity": 1}),
    ("patch",  f"/api/purchases/{BAD}/status",          {"status": "Received"}),
    ("patch",  f"/api/finance/expenses/{BAD}/void",     {"reason": "x"}),
    ("put",    f"/api/finance/expenses/{BAD}",          {"category": "Other", "amount": 1}),
    ("post",   f"/api/manufacturing/orders/{BAD}/confirm",  None),
    ("post",   f"/api/manufacturing/orders/{BAD}/start",    None),
    ("post",   f"/api/manufacturing/orders/{BAD}/complete", {}),
    ("post",   f"/api/manufacturing/orders/{BAD}/cancel",   {"reason": "x"}),
    ("post",   f"/api/assets/{BAD}/depreciate",         {}),
    ("post",   f"/api/assets/{BAD}/dispose",            {"disposal_proceeds": 1}),
    ("put",    f"/api/assets/{BAD}",                     {"name": "x", "acquisition_cost": 1, "acquisition_date": "2026-01-01"}),
    ("post",   f"/api/cash/reconciliations/{BAD}/close", {"counted_cash": 0}),
    ("post",   f"/api/cash/reconciliations/{BAD}/movements", {"direction": "in", "amount": 1}),
    ("post",   f"/api/pos/sales/{BAD}/return",          {"reason": "x"}),
    ("patch",  f"/api/crm/leads/{BAD}/archive",         None),
    ("post",   f"/api/crm/leads/{BAD}/convert",         {}),
    ("delete", f"/api/crm/contacts/{BAD}",              None),
    ("patch",  f"/api/planning/tasks/{BAD}/status",     {"status": "Done"}),
    ("delete", f"/api/planning/milestones/{BAD}",       None),
    ("delete", f"/api/users/{BAD}",                     None),
    ("delete", f"/api/roles/{BAD}",                     None),
    ("delete", f"/api/tax-rates/{BAD}",                 None),
    ("patch",  f"/api/archives/clients/{BAD}/unarchive", None),
    ("patch",  f"/api/archives/not_a_module/{BAD}/unarchive", None),
]


@pytest.mark.parametrize("method,path,body", ID_ACTIONS, ids=[a[1] for a in ID_ACTIONS])
def test_bad_id_action_never_500(make_client, method, path, body):
    c = make_client("superadmin")
    fn = getattr(c, method)
    r = fn(path, json=body) if body is not None else fn(path)
    assert r.status_code < 500, f"{method.upper()} {path} -> {r.status_code}: {r.text[:300]}"


# ── 3. Bad foreign keys & nasty numbers must be rejected, not crash ─────────
def test_invoice_with_nonexistent_client_and_project(make_client):
    c = make_client("superadmin")
    r = c.post("/api/invoices/", json={
        "client_id": BAD, "project_id": BAD,
        "items": [{"name": "X", "quantity": 1, "unit_price": 10}]})
    assert r.status_code < 500, r.text


def test_planning_task_with_nonexistent_project(make_client):
    c = make_client("superadmin")
    r = c.post("/api/planning/tasks", json={"name": "Orphan", "project_id": BAD})
    assert r.status_code < 500, r.text


def test_crm_deal_with_nonexistent_client(make_client):
    c = make_client("superadmin")
    r = c.post("/api/crm/deals", json={"title": "D", "client_id": BAD})
    assert r.status_code < 500, r.text


def test_expense_with_nonexistent_project(make_client):
    c = make_client("superadmin")
    r = c.post("/api/finance/expenses", json={"category": "Other", "amount": 10, "project_id": BAD})
    assert r.status_code < 500, r.text


def test_negative_and_oversized_numbers_never_500(make_client):
    c = make_client("superadmin")
    cases = [
        ("/api/inventory/",       {"name": "Neg", "quantity": -5, "unit_cost": -10, "sale_price": -1}),
        ("/api/finance/expenses", {"category": "Other", "amount": -100}),
        ("/api/finance/expenses", {"category": "Other", "amount": 1e308}),
        ("/api/assets",           {"name": "A", "acquisition_cost": -1, "acquisition_date": "2026-01-01"}),
        ("/api/clients/",         {"name": BIG}),
    ]
    for path, body in cases:
        r = c.post(path, json=body)
        assert r.status_code < 500, f"POST {path} {list(body)} -> {r.status_code}: {r.text[:200]}"


def test_exchange_rate_zero_or_negative_never_500(make_client):
    c = make_client("superadmin")
    for rate in (0, -1, "abc"):
        r = c.post("/api/settings/exchange-rate", json={"rate": rate})
        assert r.status_code < 500, f"rate={rate!r} -> {r.status_code}: {r.text[:200]}"


def test_lbp_payment_zero_rate_never_500(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "FX"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl, "items": [{"name": "S", "quantity": 1, "unit_price": 100}]}).json()["id"]
    r = c.post(f"/api/invoices/{iid}/payments", json={
        "amount": 100, "currency": "LBP", "exchange_rate": 0,
        "method": "Cash", "idempotency_key": _key()})
    assert r.status_code < 500 and r.status_code == 400, r.text


def test_pos_checkout_garbage_never_500(make_client, db):
    c = make_client("superadmin")
    c.post("/api/pos/session/open", json={"opening_float": 0})
    cases = [
        {"items": [], "payment_method": "Cash", "amount_tendered": 0, "idempotency_key": _key()},
        {"items": [{"name": "X", "quantity": -1, "unit_price": 5}], "payment_method": "Cash",
         "amount_tendered": 0, "idempotency_key": _key()},
        {"items": [{"name": "X", "quantity": 1, "unit_price": 5}], "payment_method": "Cash",
         "amount_tendered": 1, "idempotency_key": _key()},   # tendered < total
    ]
    for body in cases:
        r = c.post("/api/pos/checkout", json=body)
        assert r.status_code < 500, f"{body} -> {r.status_code}: {r.text[:200]}"


# ── 4. Volume — reads stay healthy with thousands of rows ───────────────────
def test_reports_and_lists_under_volume(make_client, db):
    """Bulk-insert a realistic volume directly, then every read endpoint must 200."""
    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('tax_enabled','1')")
    cur = db.cursor()
    # 800 clients, 1500 invoices + items + payments, 1200 expenses, 600 inventory.
    for i in range(800):
        cur.execute("INSERT INTO clients (name, created_at) VALUES (?, datetime('now'))", (f"Client {i}",))
    for i in range(600):
        cur.execute("INSERT INTO inventory (name, quantity, unit_cost, sale_price, created_at) "
                    "VALUES (?,?,?,?, datetime('now'))", (f"Item {i}", i % 50, 1.0 + i % 7, 5.0 + i % 9))
    for i in range(1500):
        cur.execute(
            "INSERT INTO invoices (invoice_number, client_id, amount, subtotal, tax_total, "
            " due_date, created_at, version) VALUES (?,?,?,?,?, date('now'), datetime('now'), 1)",
            (f"INV-V-{i:05d}", (i % 800) + 1, 111.0, 100.0, 11.0))
        iid = cur.lastrowid
        cur.execute("INSERT INTO invoice_items (invoice_id, name, quantity, unit_price, "
                    " tax_rate, tax_amount) VALUES (?,?,?,?,?,?)", (iid, "Line", 1, 100.0, 11.0, 11.0))
        if i % 2 == 0:
            cur.execute("INSERT INTO invoice_payments (invoice_id, amount, method, paid_at, paid_currency) "
                        "VALUES (?,?, 'Cash', datetime('now'), 'USD')", (iid, 50.0))
    for i in range(1200):
        cur.execute("INSERT INTO expenses (category, description, amount, date, created_at, status, "
                    " tax_rate, tax_amount) VALUES ('Materials', ?, ?, date('now'), datetime('now'), "
                    " 'Recorded', 11.0, ?)", (f"Exp {i}", 55.0, 5.45))
    db.commit()

    c = make_client("superadmin")
    reads = [
        "/api/clients/", "/api/invoices/", "/api/inventory/", "/api/finance/expenses",
        "/api/dashboard/", "/api/finance/summary",
        "/api/finance/range-summary?start=2000-01-01&end=2100-12-31",
        "/api/reports/financial", "/api/reports/vat", "/api/reports/invoice-aging",
        "/api/reports/clients", "/api/reports/expenses", "/api/search/?q=Client",
    ]
    for path in reads:
        r = c.get(path)
        assert r.status_code == 200, f"GET {path} -> {r.status_code}: {r.text[:200]}"
