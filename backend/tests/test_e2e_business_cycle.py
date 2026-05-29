"""
End-to-end business-cycle tests.

Unlike the granular invariant tests, each test here drives a *complete*
real-world workflow across multiple modules in one narrative, asserting the
hand-off between modules at every stage. These are the "does the whole machine
turn" checks:

  * order_to_cash  : client -> quotation -> invoice -> payments -> finance + VAT
  * procure_to_pay : supplier purchase -> stock receipt -> POS sale -> stock/ledger
  * project_billing: project -> invoice tied to project -> reporting

Run just these:
    cd backend && python -m pytest tests/test_e2e_business_cycle.py -v
"""
import uuid
import pytest

CENT = 0.01
WIDE = {"start": "2000-01-01", "end": "2100-12-31"}


def _key():
    return str(uuid.uuid4())


def _enable_vat(c, rate="11"):
    r = c.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": rate})
    assert r.status_code == 200, r.text


def _default_rate(c):
    return next(r["id"] for r in c.get("/api/tax-rates/").json() if r["is_default"])


# ───────────────────────────────────────────────────────────────────────────
# 1. Order-to-cash: quotation → invoice → payment → finance + VAT
# ───────────────────────────────────────────────────────────────────────────
def test_order_to_cash_full_cycle(make_client):
    """
    A taxed quotation becomes an invoice, gets paid in two instalments, and the
    money surfaces correctly in both the finance summary and the VAT report.
    """
    c = make_client("superadmin")
    _enable_vat(c)
    rid = _default_rate(c)

    # --- Sales: client + quotation -------------------------------------------
    client_id = c.post("/api/clients/", json={"name": "Cycle Co"}).json()["id"]
    q = c.post("/api/quotations/", json={
        "client_id": client_id,
        "items": [{"name": "Consulting", "quantity": 2, "unit_price": 50, "tax_rate_id": rid}],
    })
    assert q.status_code in (200, 201), q.text
    qid = q.json()["id"]

    qd = c.get(f"/api/quotations/{qid}").json()
    assert qd["tax_total"]      == pytest.approx(11, abs=CENT)    # 100 @ 11%
    assert qd["total_with_tax"] == pytest.approx(111, abs=CENT)

    # --- Convert to invoice: tax must carry over -----------------------------
    conv = c.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert conv.status_code in (200, 201), conv.text
    invoice_id = conv.json()["invoice_id"]
    inv = c.get(f"/api/invoices/{invoice_id}").json()
    assert inv["subtotal"]  == pytest.approx(100, abs=CENT)
    assert inv["tax_total"] == pytest.approx(11, abs=CENT)
    assert inv["amount"]    == pytest.approx(111, abs=CENT)
    assert inv["payment_status"] in ("Unpaid", "Pending", "Open", None) or inv["total_paid"] == 0

    # --- Collect cash in two parts: Partial then Paid ------------------------
    c.post(f"/api/invoices/{invoice_id}/payments",
           json={"amount": 11, "method": "Cash", "idempotency_key": _key()})
    half = c.get(f"/api/invoices/{invoice_id}").json()
    assert half["remaining"]      == pytest.approx(100, abs=CENT)
    assert half["payment_status"] == "Partial"

    c.post(f"/api/invoices/{invoice_id}/payments",
           json={"amount": 100, "method": "Cash", "idempotency_key": _key()})
    paid = c.get(f"/api/invoices/{invoice_id}").json()
    assert paid["remaining"]      == pytest.approx(0.0, abs=CENT)
    assert paid["payment_status"] == "Paid"

    # --- Finance: an expense, then a reconciling summary ---------------------
    c.post("/api/finance/expenses",
           json={"category": "Materials", "amount": 222, "tax_rate_id": rid})

    s = c.get("/api/finance/range-summary", params=WIDE).json()
    assert s["income"]   == pytest.approx(111, abs=CENT)        # all payments collected
    assert s["expenses"] == pytest.approx(222, abs=CENT)
    assert s["profit"]   == pytest.approx(111 - 222, abs=CENT)

    # --- VAT report: output (sales) minus input (expense) --------------------
    vat = c.get("/api/reports/vat").json()
    assert vat["vat_enabled"] is True
    assert vat["output"]["vat"] == pytest.approx(111 * 11 / 111, abs=CENT)   # ~11
    assert vat["input"]["vat"]  == pytest.approx(222 * 11 / 111, abs=CENT)   # ~22
    assert vat["net_vat"]       == pytest.approx(vat["output"]["vat"] - vat["input"]["vat"], abs=CENT)


# ───────────────────────────────────────────────────────────────────────────
# 2. Procure-to-pay → sell: purchase receipt raises stock, POS sale lowers it
# ───────────────────────────────────────────────────────────────────────────
def test_procure_to_pay_to_sale_cycle(make_client, db):
    """
    Buy 100 units (stock up), sell 4 over POS (stock down), and prove the
    inventory level, the stock-movement ledger and the POS invoice all agree.
    """
    c = make_client("superadmin")

    item_id = c.post("/api/inventory/", json={
        "name": "Widget", "quantity": 0, "unit_cost": 0, "sale_price": 50,
    }).json()["id"]

    # Receive stock through a purchase
    pr = c.post("/api/purchases/", json={
        "supplier": "Acme Supplies", "inventory_id": item_id, "product_name": "Widget",
        "quantity": 100, "unit_cost": 10, "status": "Received",
    })
    assert pr.status_code in (200, 201), pr.text
    after_receipt = c.get(f"/api/inventory/{item_id}").json()
    assert after_receipt["quantity"] == pytest.approx(100, abs=1e-6)

    # Sell 4 through POS
    assert c.post("/api/pos/session/open", json={"opening_float": 100}).status_code == 200
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item_id, "quantity": 4, "unit_price": 50}],
        "payment_method": "Cash", "amount_tendered": 500, "idempotency_key": _key(),
    })
    assert sale.status_code == 200, sale.text

    # Stock fell to 96 and the ledger matches the on-hand exactly
    final = c.get(f"/api/inventory/{item_id}").json()
    assert final["quantity"] == pytest.approx(96, abs=1e-6)
    delta = db.execute(
        "SELECT COALESCE(SUM(delta),0) d FROM stock_movements WHERE inventory_id=?",
        (item_id,)).fetchone()["d"]
    assert final["quantity"] == pytest.approx(delta, abs=1e-6)

    # The POS sale produced a self-consistent invoice
    inv = db.execute("SELECT amount, subtotal, tax_total FROM invoices WHERE id=?",
                     (sale.json()["invoice_id"],)).fetchone()
    assert inv["amount"] == pytest.approx(inv["subtotal"] + inv["tax_total"], abs=CENT)
    assert inv["amount"] == pytest.approx(200, abs=CENT)        # 4 × $50, tax off


# ───────────────────────────────────────────────────────────────────────────
# 3. Project billing: an invoice tied to a project flows to finance
# ───────────────────────────────────────────────────────────────────────────
def test_project_to_invoice_to_finance(make_client):
    """A project-linked invoice is billed, paid, and shows up as income."""
    c = make_client("superadmin")
    client_id = c.post("/api/clients/", json={"name": "Project Client"}).json()["id"]

    proj = c.post("/api/projects/", json={
        "name": "Office Fit-out", "client_id": client_id, "status": "active",
    })
    assert proj.status_code in (200, 201), proj.text
    project_id = proj.json()["id"]

    inv = c.post("/api/invoices/", json={
        "client_id": client_id, "project_id": project_id,
        "items": [{"name": "Phase 1", "quantity": 1, "unit_price": 5000}],
    })
    assert inv.status_code in (200, 201), inv.text
    invoice_id = inv.json()["id"]

    d = c.get(f"/api/invoices/{invoice_id}").json()
    assert d.get("project_id") == project_id
    assert d["amount"] == pytest.approx(5000, abs=CENT)

    c.post(f"/api/invoices/{invoice_id}/payments",
           json={"amount": 5000, "method": "Bank", "idempotency_key": _key()})
    paid = c.get(f"/api/invoices/{invoice_id}").json()
    assert paid["payment_status"] == "Paid"

    s = c.get("/api/finance/range-summary", params=WIDE).json()
    assert s["income"] >= 5000 - CENT


# ───────────────────────────────────────────────────────────────────────────
# 4. Cross-role: a Sales user raises a quotation an Accountant can bill
# ───────────────────────────────────────────────────────────────────────────
def test_three_role_sales_to_cash_handoff(make_client):
    """
    Real org hand-off across THREE users, each acting within their RBAC scope:
      * Sales         — owns clients + quotations (can create a quote, NOT bill)
      * Sales Manager — can convert a quotation into an invoice
      * Accountant    — can record the payment (invoices.create)

    Proves the permission seams allow a legitimate collaborative flow end to end.
    (The matrix deliberately blocks an Accountant from converting a quote — they
    only have 'view' on quotations — so conversion is the Sales Manager's job.)
    """
    sales    = make_client("Sales")
    sales_mgr = make_client("Sales Manager")
    acct     = make_client("Accountant")

    # Sales: capture the client and raise the quotation
    client_id = sales.post("/api/clients/", json={"name": "Handoff Co"}).json()["id"]
    q = sales.post("/api/quotations/", json={
        "client_id": client_id,
        "items": [{"name": "Design", "quantity": 1, "unit_price": 1200}],
    })
    assert q.status_code in (200, 201), q.text
    qid = q.json()["id"]

    # Accountant cannot convert: they have only 'view' on quotations.
    assert acct.post(f"/api/quotations/{qid}/convert-to-invoice").status_code == 403

    # Sales Manager: convert the quotation into an invoice
    conv = sales_mgr.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert conv.status_code in (200, 201), conv.text
    invoice_id = conv.json()["invoice_id"]

    # Accountant: collect the cash and close the invoice
    pay = acct.post(f"/api/invoices/{invoice_id}/payments",
                    json={"amount": 1200, "method": "Cash", "idempotency_key": _key()})
    assert pay.status_code in (200, 201), pay.text
    assert acct.get(f"/api/invoices/{invoice_id}").json()["payment_status"] == "Paid"
