"""
End-to-end tax-engine regression suite.

This complements the focused unit tests in `test_tax_system.py` and
`test_vat_report.py` with cross-module scenarios that the refactored tax
engine must keep correct in perpetuity:

  * cent-perfect reconciliation:  SUM(line.tax_amount) == header.tax_total
  * mixed-rate documents          (standard + zero / exempt on the same invoice)
  * exclusive vs inclusive paths  (Invoice = exclusive, POS = inclusive, Expense = inclusive)
  * snapshot semantics            (changing a rate later does NOT rewrite history)
  * void & POS-return handling    (refunded sales drop out of output VAT)
  * recurring expense generation  (each occurrence uses the current rate)
  * purchase → expense bridge     (paid PO posts one expense row that carries
                                   the same tax snapshot → VAT report sees it
                                   exactly once as input VAT)
  * per-rate breakdown in the VAT report
  * Reports P&L exposes net-of-VAT income/expenses alongside cash totals
"""
import pytest


# ── helpers ─────────────────────────────────────────────────────────────────
def _enable_tax(c):
    assert c.put("/api/settings/", json={"tax_enabled": "1"}).status_code == 200


def _rates(c):
    rows = c.get("/api/tax-rates/").json()
    by_type = {r["tax_type"]: r["id"] for r in rows if r["is_active"]}
    return {
        "default":  next(r["id"] for r in rows if r["is_default"]),
        "zero":     by_type.get("zero"),
        "exempt":   by_type.get("exempt"),
        "all":      rows,
    }


def _make_client_account(c):
    return c.post("/api/clients/", json={"name": "Tax Co"}).json()["id"]


# ════════════════════════════════════════════════════════════════════════════
# 1. Cent-perfect reconciliation
# ════════════════════════════════════════════════════════════════════════════
def test_invoice_lines_reconcile_with_header_to_the_cent(make_client):
    """30 lines @ awkward prices — header tax must equal SUM(line.tax_amount)."""
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    client = _make_client_account(c)

    # 1/3, 2/3, ... cents — the pattern that previously caused 1¢ drift.
    items = [
        {"name": f"L{i}", "quantity": 1, "unit_price": 33.33 + (i % 7) * 0.07,
         "tax_rate_id": r["default"]}
        for i in range(30)
    ]
    inv = c.post("/api/invoices/", json={"client_id": client, "items": items})
    assert inv.status_code in (200, 201)
    d = c.get(f"/api/invoices/{inv.json()['id']}").json()
    line_tax_sum = round(sum(it["tax_amount"] for it in d["items"]), 2)
    assert d["tax_total"] == pytest.approx(line_tax_sum, abs=0.001)
    assert d["amount"]    == pytest.approx(d["subtotal"] + d["tax_total"], abs=0.001)


def test_pos_inclusive_pricing_reconciles(make_client):
    import uuid
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    inv = c.post("/api/inventory/", json={
        "name": "Widget", "quantity": 100, "unit_cost": 1, "sale_price": 11.11
    }).json()
    c.post("/api/pos/session/open", json={"opening_float": 0})
    sale = c.post("/api/pos/checkout", json={
        "items": [{
            "inventory_id": inv["id"], "name": "Widget",
            "quantity":     3, "unit_price": 11.11,
            "tax_rate_id":  r["default"],
        }],
        "payment_method": "Cash", "amount_tendered": 100,
        "idempotency_key": str(uuid.uuid4()),
    })
    assert sale.status_code == 200, sale.text
    body = sale.json()
    # 3 × $11.11 = $33.33 gross. VAT = 33.33 * 11 / 111 = 3.30
    assert body["tax_total"] == pytest.approx(3.30, abs=0.02)
    assert body["total"]     == pytest.approx(33.33, abs=0.02)
    assert body["subtotal"] + body["tax_total"] == pytest.approx(body["total"], abs=0.01)


# ════════════════════════════════════════════════════════════════════════════
# 2. Mixed-rate document
# ════════════════════════════════════════════════════════════════════════════
def test_invoice_mixed_rates(make_client):
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    client = _make_client_account(c)
    inv = c.post("/api/invoices/", json={
        "client_id": client,
        "items": [
            {"name": "Taxed",  "quantity": 1, "unit_price": 100, "tax_rate_id": r["default"]},
            {"name": "Zero",   "quantity": 1, "unit_price":  50, "tax_rate_id": r["zero"]},
            {"name": "Exempt", "quantity": 1, "unit_price":  25, "tax_rate_id": r["exempt"]},
        ],
    }).json()
    d = c.get(f"/api/invoices/{inv['id']}").json()
    assert d["subtotal"]  == pytest.approx(175, abs=0.01)
    assert d["tax_total"] == pytest.approx(11,  abs=0.01)
    by = {it["name"]: it for it in d["items"]}
    assert by["Taxed" ]["tax_amount"] == pytest.approx(11, abs=0.01)
    assert by["Zero"  ]["tax_amount"] == 0
    assert by["Exempt"]["tax_amount"] == 0


# ════════════════════════════════════════════════════════════════════════════
# 3. Snapshot semantics — editing a rate must NOT rewrite history
# ════════════════════════════════════════════════════════════════════════════
def test_rate_change_does_not_rewrite_historical_documents(make_client):
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    client = _make_client_account(c)
    inv = c.post("/api/invoices/", json={
        "client_id": client,
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100, "tax_rate_id": r["default"]}],
    }).json()
    inv_id = inv["id"]
    before = c.get(f"/api/invoices/{inv_id}").json()
    snap_rate = before["items"][0]["tax_rate"]
    snap_amt  = before["items"][0]["tax_amount"]

    # Edit the rate value to something else — historical doc must stay frozen.
    c.put(f"/api/tax-rates/{r['default']}", json={
        "name": "VAT 18% (changed)", "rate": 18, "is_default": True, "is_active": True,
    })
    after = c.get(f"/api/invoices/{inv_id}").json()
    assert after["items"][0]["tax_rate"]   == snap_rate
    assert after["items"][0]["tax_amount"] == snap_amt
    assert after["tax_total"]              == before["tax_total"]


# ════════════════════════════════════════════════════════════════════════════
# 4. POS refund / invoice void → drops from output VAT
# ════════════════════════════════════════════════════════════════════════════
def test_pos_refund_excluded_from_vat_report(make_client):
    import uuid
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    inv = c.post("/api/inventory/", json={
        "name": "Widget", "quantity": 100, "unit_cost": 1, "sale_price": 111
    }).json()
    c.post("/api/pos/session/open", json={"opening_float": 0})
    sale = c.post("/api/pos/checkout", json={
        "items":          [{"inventory_id": inv["id"], "name": "Widget",
                            "quantity": 1, "unit_price": 111,
                            "tax_rate_id": r["default"]}],
        "payment_method": "Cash", "amount_tendered": 111,
        "idempotency_key": str(uuid.uuid4()),
    }).json()
    vat_before = c.get("/api/reports/vat").json()
    assert vat_before["output"]["vat"] == pytest.approx(11, abs=0.02)

    # Refund the sale — the linked invoice is voided.
    rr = c.post(f"/api/pos/sales/{sale['id']}/return", json={"reason": "wrong size"})
    assert rr.status_code in (200, 201), rr.text

    vat_after = c.get("/api/reports/vat").json()
    assert vat_after["output"]["vat"] == 0
    assert vat_after["net_vat"] == 0


# ════════════════════════════════════════════════════════════════════════════
# 5. Per-rate breakdown in the VAT report
# ════════════════════════════════════════════════════════════════════════════
def test_vat_report_per_rate_breakdown(make_client):
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    # Add a custom 5% rate so we get two distinct non-zero buckets.
    c.post("/api/tax-rates/", json={"name": "VAT 5%", "rate": 5})
    rates = _rates(c)
    rate_by_value = {row["rate"]: row["id"] for row in rates["all"]}
    rid_11 = rate_by_value[11]
    rid_5  = rate_by_value[5]

    client = _make_client_account(c)
    c.post("/api/invoices/", json={
        "client_id": client,
        "items": [
            {"name": "A", "quantity": 1, "unit_price": 100, "tax_rate_id": rid_11},
            {"name": "B", "quantity": 1, "unit_price": 200, "tax_rate_id": rid_5},
            {"name": "C", "quantity": 1, "unit_price":  50, "tax_rate_id": rates["zero"]},
        ],
    })
    body = c.get("/api/reports/vat").json()
    by_rate = {row["rate"]: row for row in body["output_by_rate"]}
    assert by_rate[11.0]["base"] == pytest.approx(100, abs=0.01)
    assert by_rate[11.0]["vat"]  == pytest.approx(11,  abs=0.01)
    assert by_rate[5.0 ]["base"] == pytest.approx(200, abs=0.01)
    assert by_rate[5.0 ]["vat"]  == pytest.approx(10,  abs=0.01)
    assert by_rate[0.0 ]["base"] == pytest.approx(50,  abs=0.01)
    assert by_rate[0.0 ]["vat"]  == 0


# ════════════════════════════════════════════════════════════════════════════
# 6. Purchase → expense bridge — input VAT counted exactly once
# ════════════════════════════════════════════════════════════════════════════
def test_paid_purchase_input_vat_appears_once(make_client):
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    p = c.post("/api/purchases/", json={
        "supplier": "Acme", "product_name": "Widgets",
        "quantity": 10, "unit_cost": 10, "additional_costs": 0,
        "tax_rate_id": r["default"], "status": "Paid",
    }).json()
    body = c.get("/api/reports/vat").json()
    # The Paid PO posts ONE expense row carrying the same tax snapshot ($11).
    assert body["input"]["vat"] == pytest.approx(11, abs=0.01)
    # The PO's own tax_amount must NOT be summed again — sanity-check the bucket.
    inp_buckets = {row["rate"]: row for row in body["input_by_rate"]}
    assert inp_buckets[11.0]["vat"] == pytest.approx(11, abs=0.01)


# ════════════════════════════════════════════════════════════════════════════
# 7. Recurring expense generator picks up the current rate each run
# ════════════════════════════════════════════════════════════════════════════
def test_recurring_expense_generates_with_current_rate(make_client):
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    tpl = c.post("/api/recurring-expenses", json={
        "name": "Rent", "category": "Rent", "amount": 1110,
        "frequency": "monthly", "start_date": "2026-01-01",
        "tax_rate_id": r["default"],
    }).json()
    res = c.post(f"/api/recurring-expenses/{tpl['id']}/run").json()
    assert res["generated_count"] >= 1
    exps = c.get("/api/finance/expenses").json()
    posted = [e for e in exps if e.get("recurring_expense_id") == tpl["id"]]
    assert posted
    # Each posting = $1110 gross → $110 VAT.
    for e in posted:
        assert e["tax_amount"] == pytest.approx(110, abs=0.05)
        assert e["tax_rate"]   == pytest.approx(11,  abs=0.01)


# ════════════════════════════════════════════════════════════════════════════
# 8. Net-of-VAT view on the Financial report
# ════════════════════════════════════════════════════════════════════════════
def test_financial_report_exposes_net_of_vat_view(make_client):
    c = make_client("superadmin")
    _enable_tax(c)
    r = _rates(c)
    client = _make_client_account(c)
    c.post("/api/invoices/", json={
        "client_id": client,
        "items": [{"name": "Service", "quantity": 1, "unit_price": 1000,
                   "tax_rate_id": r["default"]}],
    })
    c.post("/api/finance/expenses", json={
        "category": "Materials", "amount": 222, "tax_rate_id": r["default"],
    })
    body = c.get("/api/reports/financial").json()
    # invoiced_net = subtotal (no VAT)
    assert body["invoiced_net"] == pytest.approx(1000, abs=0.01)
    assert body["invoiced_vat"] == pytest.approx(110,  abs=0.01)
    # expenses_net = amount - tax_amount; 222 - (222 * 11/111) = 200
    assert body["expenses_net"] == pytest.approx(200, abs=0.05)
    assert body["expenses_vat"] == pytest.approx(22,  abs=0.05)
