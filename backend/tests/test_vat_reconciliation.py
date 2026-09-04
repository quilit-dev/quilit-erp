"""
VAT report exact-reconciliation — proves /api/reports/vat is precise.

Builds a multi-rate dataset (standard 11%, reduced 5%, zero-rated) on both the
output side (invoices) and the input side (direct expenses + a paid purchase
that posts an input-VAT expense), plus a voided and an archived invoice that
MUST be excluded. Then asserts, to the cent, that:

  * the report's output/input/net VAT equal the frozen tax snapshots in the DB,
  * per-rate buckets sum exactly to the headline,
  * every invoice's header tax_total equals SUM(its line tax_amount),
  * voided + archived documents are excluded (checked against an independent
    hand-computed expectation, not just the report's own filter).

`abs=0.005` is half a cent — i.e. exact at cent granularity.
"""
import pytest

CENT = 0.005


def _enable_vat(c):
    r = c.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    assert r.status_code == 200, r.text


def _rate_ids(c):
    rates = c.get("/api/tax-rates/").json()
    default_id = next(r["id"] for r in rates if r["is_default"])
    zero_id    = next(r["id"] for r in rates if r["tax_type"] == "zero")
    r = c.post("/api/tax-rates/", json={"name": "Reduced 5%", "rate": 5,
                                        "tax_type": "standard", "is_default": False})
    assert r.status_code in (200, 201), r.text
    return default_id, r.json()["id"], zero_id


def _inv(c, client_id, items):
    r = c.post("/api/invoices/", json={"client_id": client_id, "project_id": None, "items": items})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_vat_report_reconciles_to_the_cent(make_client, db):
    c = make_client("superadmin")
    _enable_vat(c)
    default_id, reduced_id, zero_id = _rate_ids(c)
    cl = c.post("/api/clients/", json={"name": "VAT Recon Co"}).json()["id"]

    # ── Output side — mixed rates (exclusive: tax added on top of net) ──────
    a = _inv(c, cl, [
        {"name": "L1", "quantity": 2, "unit_price": 100, "tax_rate_id": default_id},  # 200 -> 22.00
        {"name": "L2", "quantity": 1, "unit_price": 50,  "tax_rate_id": default_id},  # 50  -> 5.50
    ])
    _inv(c, cl, [{"name": "Reduced", "quantity": 1, "unit_price": 300, "tax_rate_id": reduced_id}])  # 15.00
    _inv(c, cl, [{"name": "Zero",    "quantity": 1, "unit_price": 400, "tax_rate_id": zero_id}])     #  0.00

    # ── Excluded — must NOT appear anywhere in the report ───────────────────
    v = _inv(c, cl, [{"name": "Void me",    "quantity": 1, "unit_price": 999, "tax_rate_id": default_id}])
    assert c.patch(f"/api/invoices/{v}/void",    json={"reason": "t"}).status_code == 200
    # Archived but NOT voided, deliberately: the report has two independent
    # filters and this is the one that proves `archived_at` is doing work of
    # its own. Voiding it first would make it excluded either way and the test
    # would pass without testing anything. The endpoint now requires a void, so
    # the row is written directly — which is also the shape every tenant holds
    # from before that rule.
    ar = _inv(c, cl, [{"name": "Archive me", "quantity": 1, "unit_price": 777, "tax_rate_id": default_id}])
    db.execute("UPDATE invoices SET archived_at = '2026-01-01 00:00:00' WHERE id = ?", (ar,))
    db.commit()

    # ── Input side — direct expenses (inclusive) + a paid purchase ──────────
    assert c.post("/api/finance/expenses",
                  json={"category": "Materials", "amount": 555, "tax_rate_id": default_id}
                  ).status_code in (200, 201)                                   # 555 incl 11% -> 55.00
    assert c.post("/api/finance/expenses",
                  json={"category": "Other", "amount": 105, "tax_rate_id": reduced_id}
                  ).status_code in (200, 201)                                   # 105 incl 5%  ->  5.00
    item = c.post("/api/inventory/", json={"name": "Widget", "quantity": 0, "unit_cost": 0}).json()["id"]
    assert c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item, "product_name": "Widget",
        "quantity": 10, "unit_cost": 20, "tax_rate_id": default_id, "status": "Paid",
    }).status_code in (200, 201)                                                # 200 net + 11% -> 22.00 input VAT

    rep = c.get("/api/reports/vat").json()

    # ── Report equals the frozen snapshots in the DB, to the cent ───────────
    out_db = db.execute(
        "SELECT COALESCE(SUM(amount),0) g, COALESCE(SUM(tax_total),0) v FROM invoices "
        "WHERE voided_at IS NULL AND archived_at IS NULL").fetchone()
    inp_db = db.execute(
        "SELECT COALESCE(SUM(amount),0) g, COALESCE(SUM(tax_amount),0) v FROM expenses "
        "WHERE voided_at IS NULL AND archived_at IS NULL").fetchone()

    assert rep["output"]["vat"]   == pytest.approx(out_db["v"], abs=CENT)
    assert rep["output"]["gross"] == pytest.approx(out_db["g"], abs=CENT)
    assert rep["input"]["vat"]    == pytest.approx(inp_db["v"], abs=CENT)
    assert rep["input"]["gross"]  == pytest.approx(inp_db["g"], abs=CENT)
    assert rep["net_vat"]         == pytest.approx(round(out_db["v"] - inp_db["v"], 2), abs=CENT)

    # ── Independent hand-computed expectations (exclusions proven here) ──────
    assert rep["output"]["vat"] == pytest.approx(27.50 + 15.00 + 0.00, abs=CENT)   # void/archived absent
    assert rep["input"]["vat"]  == pytest.approx(55.00 + 5.00 + 22.00, abs=CENT)

    # ── Anchor: invoice A is exactly 22.00 + 5.50, and header == Σ lines ────
    arow  = db.execute("SELECT tax_total FROM invoices WHERE id=?", (a,)).fetchone()
    asum  = db.execute("SELECT COALESCE(SUM(tax_amount),0) s FROM invoice_items WHERE invoice_id=?", (a,)).fetchone()
    assert arow["tax_total"] == pytest.approx(27.50, abs=CENT)
    assert arow["tax_total"] == pytest.approx(asum["s"], abs=CENT)

    # ── Header == Σ lines for every non-excluded invoice (engine invariant) ─
    for row in db.execute(
        "SELECT id, tax_total FROM invoices WHERE voided_at IS NULL AND archived_at IS NULL"
    ).fetchall():
        s = db.execute("SELECT COALESCE(SUM(tax_amount),0) s FROM invoice_items WHERE invoice_id=?",
                       (row["id"],)).fetchone()["s"]
        assert row["tax_total"] == pytest.approx(s, abs=CENT), f"invoice {row['id']} header/line mismatch"

    # ── Per-rate buckets reconcile exactly to the headline ──────────────────
    assert sum(r["vat"] for r in rep["output_by_rate"]) == pytest.approx(rep["output"]["vat"], abs=CENT)
    assert sum(r["vat"] for r in rep["input_by_rate"])  == pytest.approx(rep["input"]["vat"],  abs=CENT)
