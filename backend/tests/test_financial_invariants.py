"""
Financial invariants — proves money is both calculated AND recorded
consistently across documents, so every report reconciles with the ledger.

Each test drives real data through the API and asserts cent-exact identities:
  * invoice.amount == subtotal + tax_total, and tax_total == Σ line tax
  * invoice balance: remaining == amount − total_paid, and a full
    settlement reaches exactly 0.00 / "Paid"
  * finance range-summary income/expenses == the underlying ledger sums
  * stock: item.quantity == Σ stock_movements.delta, and never negative
  * POS sale: invoice.amount == subtotal + tax_total == pos_sales.total_usd
"""
import uuid
import pytest

from utils import money

CENT = 0.005
WIDE = {"start": "2000-01-01", "end": "2100-12-31"}


def _key():
    return str(uuid.uuid4())


def _enable_vat(c):
    assert c.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"}).status_code == 200


def _default_rate(c):
    return next(r["id"] for r in c.get("/api/tax-rates/").json() if r["is_default"])


def test_invoice_amount_equals_subtotal_plus_tax(make_client, db):
    """Header total is exactly subtotal + tax, and tax_total == Σ line tax."""
    c = make_client("superadmin")
    _enable_vat(c)
    rid = _default_rate(c)
    cl = c.post("/api/clients/", json={"name": "Inv Co"}).json()["id"]
    assert c.post("/api/invoices/", json={"client_id": cl, "items": [
        {"name": "A", "quantity": 3, "unit_price": 33.33, "tax_rate_id": rid},
        {"name": "B", "quantity": 2, "unit_price": 12.50, "tax_rate_id": rid},
    ]}).status_code in (200, 201)

    for inv in db.execute("SELECT id, amount, subtotal, tax_total FROM invoices").fetchall():
        items = db.execute(
            "SELECT quantity, unit_price, tax_amount FROM invoice_items WHERE invoice_id=?",
            (inv["id"],)).fetchall()
        exp_subtotal = money(sum(money(it["quantity"] * it["unit_price"]) for it in items))
        exp_tax      = money(sum(it["tax_amount"] for it in items))
        assert inv["subtotal"]  == pytest.approx(exp_subtotal, abs=CENT)
        assert inv["tax_total"] == pytest.approx(exp_tax, abs=CENT)
        assert inv["amount"]    == pytest.approx(inv["subtotal"] + inv["tax_total"], abs=CENT)


def test_invoice_balance_reconciles_and_closes_to_zero(make_client):
    """remaining == amount − paid; a full settlement is exactly Paid."""
    c = make_client("superadmin")                       # tax off -> amount == net
    cl = c.post("/api/clients/", json={"name": "Bal Co"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl, "items": [{"name": "X", "quantity": 1, "unit_price": 1000}]}).json()["id"]

    c.post(f"/api/invoices/{iid}/payments",
           json={"amount": 400, "method": "Cash", "idempotency_key": _key()})

    d = c.get(f"/api/invoices/{iid}").json()
    assert d["amount"]    == pytest.approx(1000, abs=CENT)
    assert d["remaining"] == pytest.approx(d["amount"] - d["total_paid"], abs=CENT)
    assert d["remaining"] == pytest.approx(600, abs=CENT)
    assert d["payment_status"] == "Partial"

    # Settle the rest — must land on exactly 0.00 and flip to Paid (P-02 guarantee).
    c.post(f"/api/invoices/{iid}/payments",
           json={"amount": 600, "method": "Cash", "idempotency_key": _key()})
    d = c.get(f"/api/invoices/{iid}").json()
    assert d["remaining"] == pytest.approx(0.0, abs=CENT)
    assert d["payment_status"] == "Paid"


def test_finance_summary_matches_ledger(make_client, db):
    """range-summary income/expenses equal the non-void ledger sums to the cent."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Fin Co"}).json()["id"]
    i1 = c.post("/api/invoices/", json={
        "client_id": cl, "items": [{"name": "S", "quantity": 1, "unit_price": 1000}]}).json()["id"]
    c.post(f"/api/invoices/{i1}/payments",
           json={"amount": 600, "method": "Cash", "idempotency_key": _key()})
    c.post(f"/api/invoices/{i1}/payments",
           json={"amount": 150.25, "method": "Cash", "idempotency_key": _key()})
    assert c.post("/api/finance/expenses",
                  json={"category": "Materials", "amount": 250.50}).status_code in (200, 201)
    assert c.post("/api/finance/expenses",
                  json={"category": "Transport", "amount": 99.99}).status_code in (200, 201)

    s = c.get("/api/finance/range-summary", params=WIDE).json()
    inc = db.execute(
        "SELECT COALESCE(SUM(ip.amount),0) t FROM invoice_payments ip "
        "JOIN invoices i ON ip.invoice_id=i.id "
        "WHERE i.voided_at IS NULL AND i.archived_at IS NULL").fetchone()["t"]
    exp = db.execute(
        "SELECT COALESCE(SUM(amount),0) t FROM expenses "
        "WHERE voided_at IS NULL AND archived_at IS NULL").fetchone()["t"]
    assert s["income"]   == pytest.approx(inc, abs=CENT)
    assert s["expenses"] == pytest.approx(exp, abs=CENT)
    assert s["profit"]   == pytest.approx(inc - exp, abs=CENT)


def test_stock_reconciles_with_movements_and_never_negative(make_client, db):
    """Every quantity change is logged: item.quantity == Σ movement deltas, >= 0."""
    c = make_client("superadmin")
    item = c.post("/api/inventory/",
                  json={"name": "Gadget", "quantity": 0, "unit_cost": 0, "sale_price": 50}).json()["id"]
    # Receive 100 via a purchase, then sell 4 via POS.
    assert c.post("/api/purchases/", json={
        "supplier": "S", "inventory_id": item, "product_name": "Gadget",
        "quantity": 100, "unit_cost": 10, "status": "Received"}).status_code in (200, 201)
    assert c.post("/api/pos/session/open", json={"opening_float": 100}).status_code == 200
    assert c.post("/api/pos/checkout", json={
        "items": [{"name": "Gadget", "inventory_id": item, "quantity": 4, "unit_price": 50}],
        "payment_method": "Cash", "amount_tendered": 500, "idempotency_key": _key(),
    }).status_code == 200

    qty   = db.execute("SELECT quantity FROM inventory WHERE id=?", (item,)).fetchone()["quantity"]
    delta = db.execute("SELECT COALESCE(SUM(delta),0) d FROM stock_movements WHERE inventory_id=?",
                       (item,)).fetchone()["d"]
    assert qty == pytest.approx(96, abs=1e-6)
    assert qty == pytest.approx(delta, abs=1e-6)              # nothing mutated stock without a movement
    neg = db.execute("SELECT COUNT(*) n FROM inventory WHERE quantity < 0").fetchone()["n"]
    assert neg == 0


def test_pos_sale_invoice_reconciles(make_client, db):
    """POS invoice.amount == subtotal + tax_total == pos_sales.total_usd == Σ line gross."""
    c = make_client("superadmin")
    _enable_vat(c)
    item = c.post("/api/inventory/",
                  json={"name": "Soda", "quantity": 50, "unit_cost": 1, "sale_price": 3}).json()["id"]
    assert c.post("/api/pos/session/open", json={"opening_float": 100}).status_code == 200
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Soda", "inventory_id": item, "quantity": 4, "unit_price": 3}],
        "payment_method": "Cash", "amount_tendered": 20, "idempotency_key": _key()})
    assert r.status_code == 200, r.text
    sale = r.json()

    inv = db.execute("SELECT amount, subtotal, tax_total FROM invoices WHERE id=?",
                     (sale["invoice_id"],)).fetchone()
    assert inv["amount"] == pytest.approx(inv["subtotal"] + inv["tax_total"], abs=CENT)
    assert inv["amount"] == pytest.approx(12.0, abs=CENT)              # 4 × $3 VAT-inclusive

    ps = db.execute("SELECT total_usd FROM pos_sales WHERE invoice_id=?",
                    (sale["invoice_id"],)).fetchone()
    assert ps["total_usd"] == pytest.approx(inv["amount"], abs=CENT)

    line_gross = db.execute(
        "SELECT COALESCE(SUM(quantity*unit_price + tax_amount),0) g "
        "FROM invoice_items WHERE invoice_id=?", (sale["invoice_id"],)).fetchone()["g"]
    assert inv["amount"] == pytest.approx(line_gross, abs=CENT)
