"""
Per-item currency for sale price and supplier cost (USD + LBP).

Model (see docs/finance/multi-currency.md):
  * SALE PRICE may be quoted natively in LBP — stored as-is with price_currency,
    and converted to USD at *sale time* (the float happens client-side in POS,
    so here we assert the API stores/exposes the native price + currency).
  * UNIT COST may be *typed* in LBP but is locked to USD at entry, because
    inventory is carried at historical USD cost and the costing engine owns
    inventory.unit_cost. So an LBP cost is converted immediately and stored USD.
"""
import uuid
import pytest


def _key():
    return str(uuid.uuid4())


def _set_rate(c, rate=89_000):
    r = c.post("/api/settings/exchange-rate", json={"rate": rate, "note": "test"})
    assert r.status_code == 200, r.text


def _get_item(c, item_id):
    rows = c.get("/api/inventory/").json()
    rows = rows if isinstance(rows, list) else rows.get("items", rows)
    match = [i for i in rows if i["id"] == item_id]
    assert match, f"item {item_id} not found in list"
    return match[0]


# ── Sale price: native LBP, preserved ────────────────────────────────────────

def test_lbp_sale_price_stored_native(make_client):
    """An LBP sale price is stored as the native LBP number + price_currency."""
    c = make_client("superadmin")
    _set_rate(c)
    r = c.post("/api/inventory/", json={
        "name": "LBP-priced widget", "quantity": 0,
        "sale_price": 5_000_000, "price_currency": "LBP",
    })
    assert r.status_code in (200, 201), r.text
    item = _get_item(c, r.json()["id"])
    assert item["price_currency"] == "LBP"
    assert item["sale_price"] == pytest.approx(5_000_000)


def test_pos_products_expose_price_currency(make_client):
    """The POS product feed carries price_currency so the cashier UI can convert
    an LBP shelf price to a USD cart line at the current rate."""
    c = make_client("superadmin")
    _set_rate(c)
    iid = c.post("/api/inventory/", json={
        "name": "Floaty", "quantity": 3, "sale_price": 890_000, "price_currency": "LBP",
    }).json()["id"]
    prods = c.get("/api/pos/products?search=Floaty").json()
    row = [p for p in prods if p["id"] == iid][0]
    assert row["price_currency"] == "LBP"
    assert row["sale_price"] == pytest.approx(890_000)


def test_default_price_currency_is_usd(make_client):
    """Omitting price_currency keeps the item USD — existing behaviour unchanged."""
    c = make_client("superadmin")
    item = _get_item(c, c.post("/api/inventory/", json={
        "name": "Plain", "quantity": 0, "sale_price": 12.5,
    }).json()["id"])
    assert item["price_currency"] == "USD"
    assert item["sale_price"] == pytest.approx(12.5)


# ── Unit cost: typed in LBP, locked to USD ───────────────────────────────────

def test_lbp_unit_cost_locked_to_usd(make_client):
    """An LBP unit cost converts to USD at entry; the stored cost is USD."""
    c = make_client("superadmin")
    _set_rate(c, 89_000)
    iid = c.post("/api/inventory/", json={
        "name": "Imported part", "quantity": 10,
        "unit_cost": 8_900_000, "cost_currency": "LBP", "exchange_rate": 89_000,
    }).json()["id"]
    item = _get_item(c, iid)
    # 8,900,000 LBP / 89,000 = $100 stored as USD historical cost.
    assert item["unit_cost"] == pytest.approx(100, abs=0.01)


def test_lbp_unit_cost_requires_rate(make_client):
    """LBP cost with no configured rate and no override is rejected 400 (not 500)."""
    c = make_client("superadmin")
    r = c.post("/api/inventory/", json={
        "name": "No rate", "quantity": 1,
        "unit_cost": 8_900_000, "cost_currency": "LBP",
    })
    assert r.status_code < 500
    assert r.status_code == 400


# ── Purchases: LBP supplier cost locked to USD at entry ───────────────────────

def test_purchase_lbp_cost_converts_to_usd(make_client):
    """A PO whose unit cost is entered in LBP stores USD; on receive the
    inventory's weighted-average cost is USD historical cost."""
    c = make_client("superadmin")
    _set_rate(c, 90_000)
    r = c.post("/api/purchases/", json={
        "supplier": "LBP Supplier", "product_name": "Bolt",
        "category": "Materials", "quantity": 100,
        "unit_cost": 90_000, "cost_currency": "LBP", "exchange_rate": 90_000,
        "status": "Received",
    })
    assert r.status_code in (200, 201), r.text
    po = c.get("/api/purchases/").json()
    po = po if isinstance(po, list) else po.get("items", po)
    row = [p for p in po if p["id"] == r.json()["id"]][0]
    # 90,000 LBP / 90,000 = $1.00 unit cost, recorded in USD. The cost is a
    # property of the LINE; the currency it was typed in belongs to the
    # document, because a supplier invoice is written in one currency.
    line = row["items"][0]
    assert line["unit_cost"] == pytest.approx(1.0, abs=0.001)
    assert row["cost_currency"] == "LBP"
    iid = line["inventory_id"]
    item = _get_item(c, iid)
    assert item["unit_cost"] == pytest.approx(1.0, abs=0.001)


def test_purchase_usd_cost_unchanged(make_client):
    """A normal USD PO behaves exactly as before (cost_currency defaults USD)."""
    c = make_client("superadmin")
    r = c.post("/api/purchases/", json={
        "supplier": "USD Supplier", "product_name": "Nut",
        "category": "Materials", "quantity": 10, "unit_cost": 2.5,
        "status": "Received",
    })
    assert r.status_code in (200, 201), r.text
    po = c.get("/api/purchases/").json()
    po = po if isinstance(po, list) else po.get("items", po)
    row = [p for p in po if p["id"] == r.json()["id"]][0]
    assert row["items"][0]["unit_cost"] == pytest.approx(2.5)
    assert row["cost_currency"] == "USD"
