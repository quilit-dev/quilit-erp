"""
Tax system — configurable tax rates and per-line-item tax on documents.

Covers: the seeded tax-rates table, admin-only rate management, and that
invoices / quotations / purchases / expenses store the tax that was applied.
"""
import pytest


def _enable_tax(c):
    assert c.put("/api/settings/", json={"tax_enabled": "1"}).status_code == 200


def _rates(c):
    rows = c.get("/api/tax-rates/").json()
    default_id = next(r["id"] for r in rows if r["is_default"])
    zero_id    = next(r["id"] for r in rows if r["rate"] == 0)
    return rows, default_id, zero_id


def test_tax_rates_seeded(make_client):
    """A fresh install ships with a default standard rate plus 0% options."""
    rows = make_client("superadmin").get("/api/tax-rates/").json()
    assert len(rows) >= 3
    assert sum(1 for r in rows if r["is_default"]) == 1


@pytest.mark.rbac
@pytest.mark.parametrize("role", ["Viewer", "Sales", "Accountant", "Manager"])
def test_non_admin_cannot_create_tax_rate(role, make_client):
    r = make_client(role).post("/api/tax-rates/", json={"name": "Hack", "rate": 5})
    assert r.status_code != 500
    assert r.status_code == 403


def test_admin_creates_and_default_is_exclusive(make_client):
    """Creating a rate with is_default demotes the previous default."""
    c = make_client("superadmin")
    r = c.post("/api/tax-rates/", json={"name": "Reduced 5%", "rate": 5, "is_default": True})
    assert r.status_code == 200, r.text
    rows = c.get("/api/tax-rates/").json()
    assert sum(1 for x in rows if x["is_default"]) == 1
    assert next(x for x in rows if x["is_default"])["name"] == "Reduced 5%"


def test_cannot_delete_default_rate(make_client):
    c = make_client("superadmin")
    _, default_id, _ = _rates(c)
    r = c.delete(f"/api/tax-rates/{default_id}")
    assert r.status_code < 500
    assert r.status_code == 400


@pytest.mark.parametrize("bad", [-1, 150])
def test_invalid_rate_rejected(bad, make_client):
    r = make_client("superadmin").post("/api/tax-rates/", json={"name": "Bad", "rate": bad})
    assert r.status_code < 500
    assert r.status_code == 400


def test_invoice_per_line_tax(make_client):
    """Two lines at different rates roll up to a correct subtotal / tax / total."""
    c = make_client("superadmin")
    _enable_tax(c)
    _, default_id, zero_id = _rates(c)

    cl = c.post("/api/clients/", json={"name": "Tax Lines Co"})
    inv = c.post("/api/invoices/", json={
        "client_id": cl.json()["id"], "project_id": None,
        "items": [
            {"name": "Taxed",   "quantity": 1, "unit_price": 100, "tax_rate_id": default_id},
            {"name": "Exempt",  "quantity": 1, "unit_price": 200, "tax_rate_id": zero_id},
        ],
    })
    assert inv.status_code in (200, 201), inv.text

    d = c.get(f"/api/invoices/{inv.json()['id']}").json()
    assert d["subtotal"]  == pytest.approx(300, abs=0.01)
    assert d["tax_total"] == pytest.approx(11, abs=0.01)   # 100 @ 11% only
    assert d["amount"]    == pytest.approx(311, abs=0.01)
    by_name = {it["name"]: it for it in d["items"]}
    assert by_name["Taxed"]["tax_amount"]  == pytest.approx(11, abs=0.01)
    assert by_name["Exempt"]["tax_amount"] == pytest.approx(0, abs=0.01)


def test_invoice_no_tax_when_disabled(make_client):
    """With tax disabled, a line's tax_rate_id is ignored — no tax is added."""
    c = make_client("superadmin")
    _, default_id, _ = _rates(c)
    cl = c.post("/api/clients/", json={"name": "No Tax Co"})
    inv = c.post("/api/invoices/", json={
        "client_id": cl.json()["id"], "project_id": None,
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100, "tax_rate_id": default_id}],
    })
    d = c.get(f"/api/invoices/{inv.json()['id']}").json()
    assert d["tax_total"] == pytest.approx(0, abs=0.01)
    assert d["amount"]    == pytest.approx(100, abs=0.01)


def test_quotation_per_line_tax_carries_to_invoice(make_client):
    """A quotation's per-line tax is preserved when converted to an invoice."""
    c = make_client("superadmin")
    _enable_tax(c)
    _, default_id, _ = _rates(c)

    cl = c.post("/api/clients/", json={"name": "Quote Tax Co"})
    q = c.post("/api/quotations/", json={
        "client_id": cl.json()["id"],
        "items": [{"name": "Work", "quantity": 2, "unit_price": 50, "tax_rate_id": default_id}],
    })
    assert q.status_code in (200, 201), q.text
    qid = q.json()["id"]
    qd = c.get(f"/api/quotations/{qid}").json()
    assert qd["tax_total"]      == pytest.approx(11, abs=0.01)   # 100 @ 11%
    assert qd["total_with_tax"] == pytest.approx(111, abs=0.01)

    conv = c.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert conv.status_code in (200, 201), conv.text
    inv = c.get(f"/api/invoices/{conv.json()['invoice_id']}").json()
    assert inv["tax_total"] == pytest.approx(11, abs=0.01)
    assert inv["amount"]    == pytest.approx(111, abs=0.01)


def test_purchase_tax_recorded(make_client):
    """A purchase computes tax on the goods value (quantity x unit_cost)."""
    c = make_client("superadmin")
    _enable_tax(c)
    _, default_id, _ = _rates(c)
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "product_name": "Widgets",
        "quantity": 10, "unit_cost": 10, "additional_costs": 0,
        "tax_rate_id": default_id, "status": "Ordered",
    })
    assert r.status_code in (200, 201), r.text
    d = c.get(f"/api/purchases/{r.json()['id']}").json()
    assert d["tax_amount"]  == pytest.approx(11, abs=0.01)   # 100 @ 11%
    assert d["grand_total"] == pytest.approx(111, abs=0.01)


def test_expense_tax_extracted_from_gross(make_client):
    """An expense amount is gross; the chosen rate extracts the VAT portion."""
    c = make_client("superadmin")
    _enable_tax(c)
    _, default_id, _ = _rates(c)
    r = c.post("/api/finance/expenses", json={
        "category": "Materials", "amount": 111, "tax_rate_id": default_id,
    })
    assert r.status_code in (200, 201), r.text
    exp = c.get("/api/finance/expenses").json()
    row = next(e for e in exp if e["id"] == r.json()["id"])
    assert row["tax_amount"] == pytest.approx(11, abs=0.05)  # 111 * 11/111
