"""
Point of Sale — end-to-end coverage.

POS checkout is the highest-risk path: it must create an invoice, a payment and
stock movements in ONE atomic transaction. These tests prove that a sale
deducts stock correctly, that an over-sell rolls the whole transaction back,
and that returns restock inventory and void the invoice.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import uuid
from datetime import datetime

import pytest


def _key():
    return str(uuid.uuid4())


def _open_session(c, opening_float=100):
    return c.post("/api/pos/session/open", json={"opening_float": opening_float})


def _make_item(c, name="Widget", qty=20, cost=5, barcode=None, sale_price=0):
    body = {"name": name, "quantity": qty, "unit_cost": cost, "sale_price": sale_price}
    if barcode:
        body["barcode"] = barcode
    r = c.post("/api/inventory/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _enable_tax(db, rate=11):
    """Turn the tax system on with one default rate (fresh test DBs ship with tax off)."""
    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('tax_enabled','1')")
    db.execute(
        "INSERT INTO tax_rates(name,rate,tax_type,is_default,is_active,created_at) "
        "VALUES(?,?, 'standard',1,1,datetime('now'))",
        (f"VAT {rate}%", rate),
    )
    db.commit()


def test_checkout_requires_open_session(make_client):
    """A sale with no open register session is rejected with 409 — never 500."""
    c = make_client("superadmin")
    item = _make_item(c)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 1, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 10, "idempotency_key": _key(),
    })
    assert r.status_code == 409, r.text


def test_cannot_open_two_sessions(make_client):
    c = make_client("superadmin")
    assert _open_session(c).status_code == 200
    assert _open_session(c).status_code == 409


def test_checkout_creates_invoice_and_payment(make_client):
    """A completed sale produces a fully-paid POS invoice."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=5)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 3, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 20, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == pytest.approx(15)
    assert body["change_given"] == pytest.approx(5)
    assert body["payment_status"] == "Paid"

    inv = c.get(f"/api/invoices/{body['invoice_id']}").json()
    assert inv["payment_status"] == "Paid"
    assert inv["amount"] == pytest.approx(15)
    assert inv["invoice_number"].startswith("POS-")


def test_custom_priced_unregistered_item_sells(make_client, db):
    """A custom line (no inventory_id) with a cashier-typed price checks out as
    a service line — no stock touched, the typed price is what's charged."""
    c = make_client("superadmin")
    _open_session(c)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Unlisted gadget", "inventory_id": None,
                    "quantity": 2, "unit_price": 7.5, "line_type": "service"}],
        "payment_method": "Cash", "amount_tendered": 20, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == pytest.approx(15)        # 2 × 7.5 at the custom price
    assert body["cogs_total"] == pytest.approx(0)    # nothing relieved from stock


def test_pos_products_list_unbarcoded_first(make_client):
    """The cashier grid leads with items that have no barcode (quick-sell goods
    you can't scan), then barcoded items."""
    c = make_client("superadmin")
    _make_item(c, name="Zzz Barcoded", barcode="999111", qty=5)
    _make_item(c, name="Apple (loose)", qty=5)        # no barcode
    rows = c.get("/api/pos/products").json()
    names = [r["name"] for r in rows]
    # The loose (no-barcode) item precedes the barcoded one despite 'Z' > 'A'.
    assert names.index("Apple (loose)") < names.index("Zzz Barcoded")


def test_checkout_deducts_stock(make_client, db):
    """Checkout decrements inventory and writes a `sale` stock movement."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=5)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 8, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 40, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text

    qty = db.execute("SELECT quantity FROM inventory WHERE id=?", (item,)).fetchone()[0]
    assert qty == pytest.approx(12)

    mv = db.execute(
        "SELECT * FROM stock_movements WHERE inventory_id=? AND type='sale'", (item,)
    ).fetchone()
    assert mv is not None
    assert mv["delta"] == pytest.approx(-8)
    assert mv["reference"] == r.json()["invoice_number"]


def test_checkout_insufficient_stock_rolls_back(make_client, db):
    """An over-sell is rejected — and NOTHING is persisted (atomicity proof)."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=5, cost=5)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 10, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 100, "idempotency_key": _key(),
    })
    assert r.status_code == 400, r.text

    assert db.execute("SELECT COUNT(*) FROM pos_sales").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM invoices").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM invoice_payments").fetchone()[0] == 0
    assert db.execute(
        "SELECT COUNT(*) FROM stock_movements WHERE type='sale'"
    ).fetchone()[0] == 0
    assert db.execute(
        "SELECT quantity FROM inventory WHERE id=?", (item,)
    ).fetchone()[0] == pytest.approx(5)


def test_same_item_twice_aggregated_for_stock(make_client):
    """The same product on two cart lines is checked against the combined qty."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=5, cost=5)
    r = c.post("/api/pos/checkout", json={
        "items": [
            {"name": "Widget", "inventory_id": item, "quantity": 3, "unit_price": 5},
            {"name": "Widget", "inventory_id": item, "quantity": 3, "unit_price": 5},
        ],
        "payment_method": "Cash", "amount_tendered": 100, "idempotency_key": _key(),
    })
    assert r.status_code == 400, r.text


def test_checkout_idempotent(make_client, db):
    """Re-submitting a sale with the same idempotency key is rejected (409)."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=5)
    payload = {
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 1, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 5, "idempotency_key": _key(),
    }
    assert c.post("/api/pos/checkout", json=payload).status_code == 200
    assert c.post("/api/pos/checkout", json=payload).status_code == 409
    assert db.execute("SELECT COUNT(*) FROM pos_sales").fetchone()[0] == 1


def test_service_line_no_inventory(make_client, db):
    """A free-text service line checks out and produces no stock movement."""
    c = make_client("superadmin")
    _open_session(c)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Repair service", "quantity": 1, "unit_price": 30, "line_type": "service"}],
        "payment_method": "Cash", "amount_tendered": 30, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    assert r.json()["total"] == pytest.approx(30)
    assert db.execute(
        "SELECT COUNT(*) FROM stock_movements WHERE type='sale'"
    ).fetchone()[0] == 0


def test_cash_must_cover_total(make_client):
    """A cash sale where the tendered amount is short is rejected."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=10)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 2, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 15, "idempotency_key": _key(),
    })
    assert r.status_code == 400, r.text


def test_lbp_checkout(make_client):
    """A sale tendered in LBP records the USD invoice value and LBP change."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=10)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 2, "unit_price": 10}],
        "payment_method": "Cash", "currency": "LBP", "exchange_rate": 89000,
        "amount_tendered": 2_000_000, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == pytest.approx(20)               # USD grand total
    assert body["change_given"] == pytest.approx(220000)    # 2,000,000 − 1,780,000 LBP

    inv = c.get(f"/api/invoices/{body['invoice_id']}").json()
    pay = inv["payments"][0]
    assert pay["paid_currency"] == "LBP"
    assert pay["amount"] == pytest.approx(20)


def test_barcode_lookup(make_client):
    """The register product search resolves an exact barcode match."""
    c = make_client("superadmin")
    _make_item(c, name="Scanned Item", qty=5, barcode="5012345678900")
    r = c.get("/api/pos/products", params={"search": "5012345678900"})
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["name"] == "Scanned Item"


def test_return_restocks_and_voids(make_client, db):
    """A return restocks inventory and voids the originating invoice."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=5)
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 4, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 20, "idempotency_key": _key(),
    }).json()
    assert db.execute(
        "SELECT quantity FROM inventory WHERE id=?", (item,)
    ).fetchone()[0] == pytest.approx(16)

    r = c.post(f"/api/pos/sales/{sale['id']}/return", json={"reason": "Customer changed mind"})
    assert r.status_code == 200, r.text

    assert db.execute(
        "SELECT quantity FROM inventory WHERE id=?", (item,)
    ).fetchone()[0] == pytest.approx(20)
    inv = c.get(f"/api/invoices/{sale['invoice_id']}").json()
    assert inv["voided_at"] is not None
    assert db.execute(
        "SELECT status FROM pos_sales WHERE id=?", (sale["id"],)
    ).fetchone()[0] == "returned"

    # A second return on the same sale is rejected.
    assert c.post(f"/api/pos/sales/{sale['id']}/return", json={}).status_code == 400


def test_session_close_variance_balanced(make_client):
    """Closing with the exact expected cash yields zero variance."""
    c = make_client("superadmin")
    _open_session(c, opening_float=100)
    item = _make_item(c, qty=20, cost=10)
    c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 5, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 50, "idempotency_key": _key(),
    })
    r = c.post("/api/pos/session/close", json={"closing_count": 150})
    assert r.status_code == 200, r.text
    assert r.json()["expected_cash"] == pytest.approx(150)   # 100 float + 50 sale
    assert r.json()["variance"] == pytest.approx(0)


def test_session_close_variance_short(make_client):
    """A short drawer count produces a negative variance."""
    c = make_client("superadmin")
    _open_session(c, opening_float=100)
    item = _make_item(c, qty=20, cost=10)
    c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 5, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 50, "idempotency_key": _key(),
    })
    r = c.post("/api/pos/session/close", json={"closing_count": 140})
    assert r.status_code == 200, r.text
    assert r.json()["variance"] == pytest.approx(-10)


def test_session_dual_currency_close(make_client):
    """A register session reconciles USD and LBP cash separately."""
    c = make_client("superadmin")
    r = c.post("/api/pos/session/open",
               json={"opening_float": 100, "opening_float_lbp": 1_000_000})
    assert r.status_code == 200, r.text
    item = _make_item(c, qty=20, cost=10)
    # One LBP cash sale: 2 × $10 = $20 → 1,780,000 LBP at rate 89,000.
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 2, "unit_price": 10}],
        "payment_method": "Cash", "currency": "LBP", "exchange_rate": 89000,
        "amount_tendered": 1_780_000, "idempotency_key": _key(),
    })
    assert sale.status_code == 200, sale.text
    res = c.post("/api/pos/session/close",
                 json={"closing_count": 100, "closing_count_lbp": 2_780_000})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["expected_cash"]     == pytest.approx(100)        # no USD cash sales
    assert body["expected_cash_lbp"] == pytest.approx(2_780_000)  # 1,000,000 float + 1,780,000
    assert body["variance"]          == pytest.approx(0)
    assert body["variance_lbp"]      == pytest.approx(0)


def test_viewer_cannot_checkout(make_client):
    """A read-only role is denied checkout with 403 — not a 500."""
    c = make_client("Viewer")
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "X", "quantity": 1, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 5, "idempotency_key": _key(),
    })
    assert r.status_code == 403, r.text


def test_period_locked_blocks_checkout(make_client):
    """A sale into a locked accounting period is rejected."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=5)
    now = datetime.utcnow()
    lr = c.post(f"/api/finance/periods/{now.year}/{now.month}/lock")
    assert lr.status_code == 200, lr.text
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 1, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 5, "idempotency_key": _key(),
    })
    assert r.status_code == 400, r.text


# ── Retail pricing features ─────────────────────────────────────────────────

def test_product_returns_sale_price(make_client):
    """The register product lookup exposes the item's retail sale price."""
    c = make_client("superadmin")
    c.post("/api/inventory/", json={"name": "Priced Item", "quantity": 5,
                                    "unit_cost": 3, "sale_price": 9.99})
    r = c.get("/api/pos/products", params={"search": "Priced"})
    assert r.status_code == 200, r.text
    assert r.json()[0]["sale_price"] == pytest.approx(9.99)


def test_inclusive_tax_is_extracted(make_client, db):
    """POS treats the price as VAT-inclusive — tax is extracted, not added on top."""
    _enable_tax(db, 11)
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=5)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 1, "unit_price": 111}],
        "payment_method": "Cash", "amount_tendered": 111, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # 111 inclusive @ 11% → VAT 11, net 100, customer still pays 111.
    assert body["total"]     == pytest.approx(111)
    assert body["tax_total"] == pytest.approx(11, abs=0.01)
    assert body["subtotal"]  == pytest.approx(100, abs=0.01)


def test_line_discount_reduces_total(make_client):
    """A per-line markdown comes straight off the line total."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=2)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 2,
                   "unit_price": 10, "discount": 5}],
        "payment_method": "Cash", "amount_tendered": 50, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"]          == pytest.approx(15)   # 2×10 − 5
    assert body["discount_total"] == pytest.approx(5)


def test_line_discount_cannot_exceed_line(make_client):
    """A discount larger than the line total is rejected."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=2)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 1,
                   "unit_price": 10, "discount": 20}],
        "payment_method": "Cash", "amount_tendered": 50, "idempotency_key": _key(),
    })
    assert r.status_code == 400, r.text


def test_order_discount_distributed(make_client):
    """An order-level discount reduces the grand total."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=2)
    r = c.post("/api/pos/checkout", json={
        "items": [
            {"name": "A", "inventory_id": item, "quantity": 1, "unit_price": 60},
            {"name": "B", "quantity": 1, "unit_price": 40, "line_type": "service"},
        ],
        "order_discount": 10,
        "payment_method": "Cash", "amount_tendered": 100, "idempotency_key": _key(),
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"]          == pytest.approx(90)   # 100 − 10
    assert body["discount_total"] == pytest.approx(10)


def test_cogs_recorded_on_sale(make_client):
    """Each sale records cost of goods sold (cost × qty) and a margin."""
    c = make_client("superadmin")
    _open_session(c)
    item = _make_item(c, qty=20, cost=4)
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 3, "unit_price": 10}],
        "payment_method": "Cash", "amount_tendered": 30, "idempotency_key": _key(),
    }).json()
    assert sale["cogs_total"] == pytest.approx(12)        # cost 4 × qty 3

    detail = c.get(f"/api/pos/sales/{sale['id']}").json()
    assert detail["cogs_total"] == pytest.approx(12)
    assert detail["margin"]     == pytest.approx(18)      # net 30 − COGS 12
    assert detail["items"][0]["unit_cost"] == pytest.approx(4)
