"""
Cash & Daily Reconciliation — drawers, daily reconciliations, movements, variance.

Covers the auto-capture rule (the day's cash invoice payments and cash expenses
flow into the auto_capture drawer), manual movements, opening-balance carry, and
end-of-day variance.
"""
import uuid

import pytest


def _drawers(c):
    return c.get("/api/cash/drawers").json()


def _main_drawer(c):
    for d in _drawers(c):
        if d["auto_capture"]:
            return d["id"]
    return _drawers(c)[0]["id"]


def _cash_invoice_payment(c, amount=100, drawer_id=None):
    """Create a client + invoice and settle it with a USD cash payment.

    `drawer_id` tags the payment to a specific cash drawer.
    """
    cl = c.post("/api/clients/", json={"name": "Cash Client"})
    assert cl.status_code in (200, 201), cl.text
    inv = c.post("/api/invoices/", json={
        "client_id": cl.json()["id"],
        "items": [{"name": "Service", "quantity": 1, "unit_price": amount}],
    })
    assert inv.status_code in (200, 201), inv.text
    body = {"amount": amount, "method": "Cash", "idempotency_key": str(uuid.uuid4())}
    if drawer_id is not None:
        body["cash_drawer_id"] = drawer_id
    pay = c.post(f"/api/invoices/{inv.json()['id']}/payments", json=body)
    assert pay.status_code == 200, pay.text


def test_default_drawer_seeded(make_client):
    """A fresh install ships with a 'Main Till' that auto-captures business cash."""
    c = make_client("superadmin")
    drawers = _drawers(c)
    assert any(d["name"] == "Main Till" and d["auto_capture"] for d in drawers)


def test_only_one_auto_capture_drawer(make_client):
    """Marking a new drawer auto-capture clears the flag on every other drawer."""
    c = make_client("superadmin")
    r = c.post("/api/cash/drawers", json={"name": "Second Till", "auto_capture": True})
    assert r.status_code in (200, 201), r.text
    autos = [d for d in _drawers(c) if d["auto_capture"]]
    assert len(autos) == 1
    assert autos[0]["name"] == "Second Till"


def test_open_and_duplicate_day(make_client):
    """A drawer can open one reconciliation per day; a second is rejected (409)."""
    c = make_client("superadmin")
    drawer = _main_drawer(c)
    r1 = c.post("/api/cash/reconciliations",
                json={"drawer_id": drawer, "business_date": "2026-03-03"})
    assert r1.status_code in (200, 201), r1.text
    r2 = c.post("/api/cash/reconciliations",
                json={"drawer_id": drawer, "business_date": "2026-03-03"})
    assert r2.status_code == 409, r2.text


def test_manual_movements_affect_expected(make_client):
    """Manual cash-in/out movements adjust the expected drawer balance."""
    c = make_client("superadmin")
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations",
                 json={"drawer_id": drawer, "opening_balance": 100}).json()
    c.post(f"/api/cash/reconciliations/{rec['id']}/movements",
           json={"direction": "in", "amount": 50, "category": "Float"})
    c.post(f"/api/cash/reconciliations/{rec['id']}/movements",
           json={"direction": "out", "amount": 30, "category": "Payout"})
    detail = c.get(f"/api/cash/reconciliations/{rec['id']}").json()
    assert detail["figures"]["usd"]["manual_in"]  == pytest.approx(50)
    assert detail["figures"]["usd"]["manual_out"] == pytest.approx(30)
    assert detail["expected_cash"]         == pytest.approx(120)   # 100 + 50 − 30


def test_auto_capture_includes_cash_payment(make_client):
    """The auto_capture drawer picks up cash invoice payments dated that day."""
    c = make_client("superadmin")
    _cash_invoice_payment(c, 100)
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations",
                 json={"drawer_id": drawer, "opening_balance": 0}).json()
    detail = c.get(f"/api/cash/reconciliations/{rec['id']}").json()
    assert detail["figures"]["usd"]["auto_in"] == pytest.approx(100)
    assert detail["expected_cash"]      == pytest.approx(100)


def test_cash_expense_reduces_expected(make_client):
    """A cash-method expense is auto-captured as cash out."""
    c = make_client("superadmin")
    r = c.post("/api/finance/expenses",
               json={"category": "Other", "amount": 40, "payment_method": "Cash"})
    assert r.status_code in (200, 201), r.text
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations",
                 json={"drawer_id": drawer, "opening_balance": 200}).json()
    detail = c.get(f"/api/cash/reconciliations/{rec['id']}").json()
    assert detail["figures"]["usd"]["auto_out"] == pytest.approx(40)
    assert detail["expected_cash"]       == pytest.approx(160)     # 200 − 40


def test_non_auto_drawer_ignores_business_cash(make_client):
    """A drawer without auto_capture only reflects its opening + manual entries."""
    c = make_client("superadmin")
    _cash_invoice_payment(c, 100)
    petty = c.post("/api/cash/drawers",
                   json={"name": "Petty Cash", "auto_capture": False}).json()["id"]
    rec = c.post("/api/cash/reconciliations",
                 json={"drawer_id": petty, "opening_balance": 20}).json()
    detail = c.get(f"/api/cash/reconciliations/{rec['id']}").json()
    assert detail["figures"]["usd"]["auto_in"] == pytest.approx(0)
    assert detail["expected_cash"]      == pytest.approx(20)


def test_cash_payment_attributed_to_specific_drawer(make_client):
    """A cash payment tagged to a drawer counts for THAT drawer, not the default."""
    c = make_client("superadmin")
    petty = c.post("/api/cash/drawers",
                   json={"name": "Petty Cash", "auto_capture": False}).json()["id"]
    main = _main_drawer(c)
    _cash_invoice_payment(c, 80, drawer_id=petty)

    petty_rec = c.post("/api/cash/reconciliations",
                       json={"drawer_id": petty, "opening_balance": 0}).json()
    main_rec = c.post("/api/cash/reconciliations",
                      json={"drawer_id": main, "opening_balance": 0}).json()
    petty_detail = c.get(f"/api/cash/reconciliations/{petty_rec['id']}").json()
    main_detail  = c.get(f"/api/cash/reconciliations/{main_rec['id']}").json()
    assert petty_detail["figures"]["usd"]["auto_in"] == pytest.approx(80)   # tagged here
    assert main_detail["figures"]["usd"]["auto_in"]  == pytest.approx(0)     # not the default's


def test_cash_expense_attributed_to_specific_drawer(make_client):
    """A cash expense tagged to a drawer reduces THAT drawer, not the default."""
    c = make_client("superadmin")
    petty = c.post("/api/cash/drawers",
                   json={"name": "Petty Cash", "auto_capture": False}).json()["id"]
    main = _main_drawer(c)
    r = c.post("/api/finance/expenses", json={
        "category": "Other", "amount": 25, "payment_method": "Cash", "cash_drawer_id": petty})
    assert r.status_code in (200, 201), r.text

    petty_rec = c.post("/api/cash/reconciliations",
                       json={"drawer_id": petty, "opening_balance": 100}).json()
    main_rec = c.post("/api/cash/reconciliations",
                      json={"drawer_id": main, "opening_balance": 100}).json()
    assert c.get(f"/api/cash/reconciliations/{petty_rec['id']}").json(
        )["figures"]["usd"]["auto_out"] == pytest.approx(25)
    assert c.get(f"/api/cash/reconciliations/{main_rec['id']}").json(
        )["figures"]["usd"]["auto_out"] == pytest.approx(0)


def test_close_computes_variance(make_client):
    """Closing freezes the variance and locks the reconciliation."""
    c = make_client("superadmin")
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations",
                 json={"drawer_id": drawer, "opening_balance": 100}).json()
    r = c.post(f"/api/cash/reconciliations/{rec['id']}/close", json={"counted_cash": 95})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["expected_cash"] == pytest.approx(100)
    assert body["variance"]      == pytest.approx(-5)
    # A closed reconciliation rejects further movements.
    mv = c.post(f"/api/cash/reconciliations/{rec['id']}/movements",
                json={"direction": "in", "amount": 10})
    assert mv.status_code == 400, mv.text


def test_opening_balance_carries_forward(make_client):
    """Opening a new day with no balance carries the prior counted close."""
    c = make_client("superadmin")
    drawer = _main_drawer(c)
    r1 = c.post("/api/cash/reconciliations",
                json={"drawer_id": drawer, "business_date": "2026-01-01",
                      "opening_balance": 100}).json()
    c.post(f"/api/cash/reconciliations/{r1['id']}/close", json={"counted_cash": 130})
    r2 = c.post("/api/cash/reconciliations",
                json={"drawer_id": drawer, "business_date": "2026-01-02"}).json()
    detail = c.get(f"/api/cash/reconciliations/{r2['id']}").json()
    assert detail["opening_balance"] == pytest.approx(130)


def test_reopen_reconciliation(make_client):
    """A closed reconciliation can be reopened."""
    c = make_client("superadmin")
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations",
                 json={"drawer_id": drawer, "opening_balance": 50}).json()
    c.post(f"/api/cash/reconciliations/{rec['id']}/close", json={"counted_cash": 50})
    r = c.post(f"/api/cash/reconciliations/{rec['id']}/reopen")
    assert r.status_code == 200, r.text
    assert c.get(f"/api/cash/reconciliations/{rec['id']}").json()["status"] == "open"


def test_summary_lists_drawers(make_client):
    """The daily summary returns every active drawer for the date."""
    c = make_client("superadmin")
    s = c.get("/api/cash/summary")
    assert s.status_code == 200, s.text
    body = s.json()
    assert "drawers" in body and len(body["drawers"]) >= 1


def _lbp_cash_payment(c, lbp_amount, rate=90000, drawer_id=None):
    """Settle an invoice with an LBP cash payment (LBP physically tendered)."""
    cl = c.post("/api/clients/", json={"name": "LBP Client"})
    assert cl.status_code in (200, 201), cl.text
    usd = round(lbp_amount / rate, 2)
    inv = c.post("/api/invoices/", json={
        "client_id": cl.json()["id"],
        "items": [{"name": "Service", "quantity": 1, "unit_price": usd}],
    })
    assert inv.status_code in (200, 201), inv.text
    body = {"amount": lbp_amount, "currency": "LBP", "exchange_rate": rate,
            "method": "Cash", "idempotency_key": str(uuid.uuid4())}
    if drawer_id is not None:
        body["cash_drawer_id"] = drawer_id
    pay = c.post(f"/api/invoices/{inv.json()['id']}/payments", json=body)
    assert pay.status_code == 200, pay.text


def test_lbp_cash_payment_auto_captured(make_client):
    """LBP cash sales flow into the drawer's LBP balance — separate from USD."""
    c = make_client("superadmin")
    _lbp_cash_payment(c, 9_000_000, rate=90000)        # = $100
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations", json={"drawer_id": drawer}).json()
    detail = c.get(f"/api/cash/reconciliations/{rec['id']}").json()
    assert detail["figures"]["lbp"]["auto_in"] == pytest.approx(9_000_000)
    assert detail["figures"]["usd"]["auto_in"] == pytest.approx(0)
    assert detail["expected_cash_lbp"]         == pytest.approx(9_000_000)
    assert detail["expected_cash"]             == pytest.approx(0)


def test_lbp_manual_movement_separate_from_usd(make_client):
    """A USD and an LBP balance live in one drawer and are never summed."""
    c = make_client("superadmin")
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations", json={
        "drawer_id": drawer, "opening_balance": 300, "opening_balance_lbp": 1_000_000,
    }).json()
    c.post(f"/api/cash/reconciliations/{rec['id']}/movements",
           json={"direction": "in", "currency": "LBP", "amount": 500_000, "category": "Float"})
    c.post(f"/api/cash/reconciliations/{rec['id']}/movements",
           json={"direction": "out", "currency": "USD", "amount": 40, "category": "Payout"})
    detail = c.get(f"/api/cash/reconciliations/{rec['id']}").json()
    assert detail["figures"]["lbp"]["manual_in"]  == pytest.approx(500_000)
    assert detail["figures"]["usd"]["manual_out"] == pytest.approx(40)
    assert detail["expected_cash"]     == pytest.approx(260)        # 300 − 40
    assert detail["expected_cash_lbp"] == pytest.approx(1_500_000)  # 1,000,000 + 500,000


def test_close_dual_currency_variance(make_client):
    """Closing reconciles USD and LBP separately — two counts, two variances."""
    c = make_client("superadmin")
    drawer = _main_drawer(c)
    rec = c.post("/api/cash/reconciliations", json={
        "drawer_id": drawer, "opening_balance": 100, "opening_balance_lbp": 2_000_000,
    }).json()
    r = c.post(f"/api/cash/reconciliations/{rec['id']}/close",
               json={"counted_cash": 95, "counted_cash_lbp": 2_050_000})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["variance"]     == pytest.approx(-5)       # USD short $5
    assert body["variance_lbp"] == pytest.approx(50_000)   # LBP over 50,000


def test_viewer_cannot_open_reconciliation(make_client):
    """A read-only role can view cash but cannot open a reconciliation."""
    c = make_client("Viewer")
    drawers = _drawers(c)
    assert drawers, "Viewer should be able to read drawers"
    r = c.post("/api/cash/reconciliations", json={"drawer_id": drawers[0]["id"]})
    assert r.status_code == 403, r.text
