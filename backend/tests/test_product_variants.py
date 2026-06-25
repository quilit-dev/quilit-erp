"""
Product variants + attributes.

A product groups variant SKUs that live in the existing `inventory` table, so a
variant must behave as a first-class item: it owns stock, sells through POS and
relieves its own COGS. These tests prove the cross-product generation, that
variants are real SKUs, that the simple-item path is untouched, and that the
attribute presets seed idempotently.
"""
import uuid
import pytest


def _key():
    return str(uuid.uuid4())


def _open_session(c, opening_float=100):
    return c.post("/api/pos/session/open", json={"opening_float": opening_float})


def test_create_product_generates_variant_crossproduct(make_client, db):
    c = make_client("superadmin")
    r = c.post("/api/products/", json={
        "name": "Cotton T-Shirt",
        "category": "Apparel",
        "sale_price": 20,
        "unit_cost": 8,
        "barcode_prefix": "TSHIRT-",
        "axes": [
            {"name": "Size",  "values": ["S", "M", "L"]},
            {"name": "Color", "values": ["Red", "Blue"]},
        ],
        "descriptors": {"Material": "Cotton"},
    })
    assert r.status_code in (200, 201), r.text
    body = r.json()
    # 3 sizes × 2 colors = 6 variants.
    assert body["variant_count"] == 6
    product_id = body["id"]

    prod = c.get(f"/api/products/{product_id}").json()
    assert len(prod["variants"]) == 6
    labels = sorted(v["variant_label"] for v in prod["variants"])
    assert labels == ["L / Blue", "L / Red", "M / Blue", "M / Red", "S / Blue", "S / Red"]

    # Each variant carries its resolved axis attributes and a unique barcode.
    one = prod["variants"][0]
    assert set(one["attributes"].keys()) == {"Size", "Color"}
    barcodes = [v["barcode"] for v in prod["variants"]]
    assert all(b and b.startswith("TSHIRT-") for b in barcodes)
    assert len(set(barcodes)) == 6
    # Product-level descriptor stored once on the product.
    assert prod["attributes"].get("Material") == "Cotton"
    # Every variant is a real inventory row linked to the product.
    n = db.execute("SELECT COUNT(*) AS n FROM inventory WHERE product_id=?", (product_id,)).fetchone()["n"]
    assert n == 6


def test_variant_sells_through_pos_and_relieves_its_own_stock(make_client, db):
    c = make_client("superadmin")
    r = c.post("/api/products/", json={
        "name": "Sneaker", "sale_price": 50, "unit_cost": 30,
        "initial_quantity": 10,
        "axes": [{"name": "Size", "values": ["40", "41"]}],
    })
    assert r.status_code in (200, 201), r.text
    variant_ids = r.json()["variant_ids"]
    sku = variant_ids[0]
    other = variant_ids[1]

    _open_session(c)
    sale = c.post("/api/pos/checkout", json={
        "items": [{"name": "Sneaker 40", "inventory_id": sku, "quantity": 2, "unit_price": 50}],
        "payment_method": "Cash", "amount_tendered": 100, "idempotency_key": _key(),
    })
    assert sale.status_code == 200, sale.text

    # Only the sold variant's stock moved; its sibling is untouched.
    sold_qty  = db.execute("SELECT quantity FROM inventory WHERE id=?", (sku,)).fetchone()["quantity"]
    other_qty = db.execute("SELECT quantity FROM inventory WHERE id=?", (other,)).fetchone()["quantity"]
    assert sold_qty == 8
    assert other_qty == 10

    # COGS was recognised for the sold variant (2 × 30 = 60).
    assert sale.json()["cogs_total"] == pytest.approx(60)


def test_no_axes_creates_single_variant(make_client):
    c = make_client("superadmin")
    r = c.post("/api/products/", json={"name": "Plain Mug", "sale_price": 5, "unit_cost": 2})
    assert r.status_code in (200, 201), r.text
    assert r.json()["variant_count"] == 1


def test_simple_item_path_unaffected(make_client, db):
    """A plain inventory item still has no product_id (back-compat)."""
    c = make_client("superadmin")
    r = c.post("/api/inventory/", json={"name": "Loose Bolt", "quantity": 5, "unit_cost": 1, "sale_price": 2})
    assert r.status_code in (200, 201), r.text
    item_id = r.json()["id"]
    row = db.execute("SELECT product_id, variant_label FROM inventory WHERE id=?", (item_id,)).fetchone()
    assert row["product_id"] is None
    assert row["variant_label"] is None


def test_attribute_presets_seed_idempotently(make_client, db):
    c = make_client("superadmin")
    r1 = c.post("/api/products/seed-presets?business_type=Apparel")
    assert r1.status_code == 200, r1.text
    n1 = db.execute(
        "SELECT COUNT(*) AS n FROM attribute_defs WHERE scope_type='business' AND scope_value='Apparel'"
    ).fetchone()["n"]
    assert n1 > 0
    # Re-seeding adds nothing.
    c.post("/api/products/seed-presets?business_type=Apparel")
    n2 = db.execute(
        "SELECT COUNT(*) AS n FROM attribute_defs WHERE scope_type='business' AND scope_value='Apparel'"
    ).fetchone()["n"]
    assert n2 == n1
    # Size is a variant axis with enum options.
    size = db.execute(
        "SELECT is_variant_axis, options FROM attribute_defs "
        "WHERE scope_type='business' AND scope_value='Apparel' AND name='Size'"
    ).fetchone()
    assert size["is_variant_axis"] == 1
    assert "M" in size["options"]


def test_too_many_variants_rejected(make_client):
    """A cross-product over the guard rail is refused, not silently created."""
    c = make_client("superadmin")
    axis = {"name": "N", "values": [str(i) for i in range(201)]}
    r = c.post("/api/products/", json={"name": "Huge", "axes": [axis]})
    assert r.status_code == 400
    assert "limit" in r.text.lower()
