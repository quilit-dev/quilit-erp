"""
Lebanese VAT summary report — /api/reports/vat.

Covers: permission gating, the VAT-disabled state, and the output/input/net
VAT computation. Invoice amounts are VAT-inclusive, so VAT is extracted as
gross * rate / (100 + rate); expense amounts are stored as entered.
"""
import pytest


def _enable_vat(client, rate="11"):
    r = client.put(
        "/api/settings/", json={"tax_enabled": "1", "default_tax_rate": rate}
    )
    assert r.status_code == 200, r.text


@pytest.mark.rbac
def test_vat_report_requires_reports_view(make_client):
    """A user with no role cannot read the VAT report."""
    r = make_client("__norole__").get("/api/reports/vat")
    assert r.status_code != 500
    assert r.status_code == 403


def test_vat_report_disabled_when_tax_off(make_client):
    """Fresh DB has tax_enabled='0' — the report reports itself disabled."""
    body = make_client("superadmin").get("/api/reports/vat").json()
    assert body["vat_enabled"] is False
    assert body["output"]["vat"] == 0
    assert body["net_vat"] == 0


def test_vat_report_extracts_output_vat_from_invoice(make_client):
    """An 11% VAT invoice with a $1000 subtotal -> $1110 gross, ~$110 VAT."""
    c = make_client("superadmin")
    _enable_vat(c)

    cl = c.post("/api/clients/", json={"name": "VAT Co"})
    assert cl.status_code in (200, 201), cl.text
    inv = c.post("/api/invoices/", json={
        "client_id": cl.json()["id"], "project_id": None,
        "items": [{"name": "Service", "quantity": 1, "unit_price": 1000}],
    })
    assert inv.status_code in (200, 201), inv.text

    body = c.get("/api/reports/vat").json()
    assert body["vat_enabled"] is True
    assert body["rate"] == 11
    assert body["output"]["gross"] == pytest.approx(1110, abs=0.01)
    assert body["output"]["vat"] == pytest.approx(1110 * 11 / 111, abs=0.01)


def test_vat_report_net_is_output_minus_input(make_client):
    """Net VAT = output VAT (invoices) minus input VAT (tax-tagged expenses)."""
    c = make_client("superadmin")
    _enable_vat(c)

    rates = c.get("/api/tax-rates/").json()
    default_id = next(r["id"] for r in rates if r["is_default"])

    cl = c.post("/api/clients/", json={"name": "Net VAT Co"})
    c.post("/api/invoices/", json={
        "client_id": cl.json()["id"], "project_id": None,
        "items": [{"name": "Service", "quantity": 1, "unit_price": 1000}],
    })
    # An expense's amount is gross; tagging it with the 11% rate extracts VAT.
    exp = c.post("/api/finance/expenses", json={
        "category": "Materials", "amount": 555, "tax_rate_id": default_id,
    })
    assert exp.status_code in (200, 201), exp.text

    body = c.get("/api/reports/vat").json()
    assert body["input"]["vat"] == pytest.approx(555 * 11 / 111, abs=0.01)
    assert body["net_vat"] == pytest.approx(
        body["output"]["vat"] - body["input"]["vat"], abs=0.01)
    assert len(body["monthly"]) >= 1
