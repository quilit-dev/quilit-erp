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


def test_bulk_purchase_raises_one_po_per_variant_and_receives_to_right_sku(make_client, db):
    """Ordering several variants in one action creates a PO per variant and,
    when received, credits each variant's own stock at its own cost."""
    c = make_client("superadmin")
    prod = c.post("/api/products/", json={
        "name": "iPhone 15", "category": "Electronics", "sale_price": 1000, "unit_cost": 0,
        "axes": [
            {"name": "Storage", "values": ["128GB", "256GB"]},
            {"name": "Color",   "values": ["Black", "White"]},
        ],
    })
    assert prod.status_code in (200, 201), prod.text
    variant_ids = prod.json()["variant_ids"]      # 2 × 2 = 4 SKUs
    assert len(variant_ids) == 4

    # Order 3 of the 4 variants, each a different quantity/cost, received at once.
    order = [
        {"inventory_id": variant_ids[0], "quantity": 5, "unit_cost": 700},
        {"inventory_id": variant_ids[1], "quantity": 3, "unit_cost": 750},
        {"inventory_id": variant_ids[2], "quantity": 2, "unit_cost": 800},
    ]
    r = c.post("/api/purchases/bulk", json={
        "supplier": "Apple Distributor", "status": "Received", "lines": order,
    })
    assert r.status_code in (200, 201), r.text
    assert r.json()["created"] == 3

    # One PO per line, all to the same supplier.
    pos = [p for p in c.get("/api/purchases/").json() if p["supplier"] == "Apple Distributor"]
    assert len(pos) == 3

    # Each ordered variant's stock rose by exactly its line qty; the unordered
    # 4th variant stayed at zero — proving per-SKU routing.
    def qty(i):
        return db.execute("SELECT quantity FROM inventory WHERE id=?", (i,)).fetchone()["quantity"]
    assert qty(variant_ids[0]) == 5
    assert qty(variant_ids[1]) == 3
    assert qty(variant_ids[2]) == 2
    assert qty(variant_ids[3]) == 0
    # Cost landed on the right SKU (weighted-avg of a single receipt = unit cost).
    uc0 = db.execute("SELECT unit_cost FROM inventory WHERE id=?", (variant_ids[0],)).fetchone()["unit_cost"]
    assert uc0 == pytest.approx(700)


def test_bulk_purchase_rejects_empty_order(make_client):
    c = make_client("superadmin")
    r = c.post("/api/purchases/bulk", json={"supplier": "X", "lines": []})
    assert r.status_code == 400


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


# ── Slice 3: report, import, setup ──────────────────────────────────────────
def test_inventory_by_attribute_report(make_client):
    c = make_client("superadmin")
    c.post("/api/products/", json={
        "name": "Tee", "sale_price": 10, "unit_cost": 4, "initial_quantity": 3,
        "axes": [{"name": "Size", "values": ["S", "M"]}],
    })
    r = c.get("/api/reports/inventory-by-attribute?attribute=Size")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "Size" in body["attributes"]
    assert body["selected"] == "Size"
    vals = {row["attr_value"]: row for row in body["rows"]}
    assert set(vals) == {"S", "M"}
    assert vals["S"]["qty_total"] == 3
    # Value = qty × unit_cost (3 × 4) per size.
    assert vals["S"]["value_usd"] == pytest.approx(12)


def test_variant_aware_import_groups_products(make_client, db):
    c = make_client("superadmin")
    rows = [
        {"name": "Polo Red S",  "product": "Polo Shirt", "Size": "S", "Color": "Red",  "sale_price": 15, "quantity": 2},
        {"name": "Polo Red M",  "product": "Polo Shirt", "Size": "M", "Color": "Red",  "sale_price": 15, "quantity": 4},
        {"name": "Polo Blue M", "product": "Polo Shirt", "Size": "M", "Color": "Blue", "sale_price": 15, "quantity": 1},
    ]
    res = c.post("/api/imports/inventory/commit", json={"rows": rows})
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 3

    prod = db.execute("SELECT id FROM products WHERE name='Polo Shirt'").fetchone()
    assert prod is not None
    # All three rows linked to the one product, each carrying its own attributes.
    n = db.execute("SELECT COUNT(*) AS n FROM inventory WHERE product_id=?", (prod["id"],)).fetchone()["n"]
    assert n == 3
    first = db.execute(
        "SELECT id, variant_label FROM inventory WHERE product_id=? ORDER BY id", (prod["id"],)
    ).fetchone()
    assert first["variant_label"] == "S / Red"
    attrs = {a["name"]: a["value"] for a in db.execute(
        "SELECT name, value FROM item_attributes WHERE inventory_id=?", (first["id"],)
    ).fetchall()}
    assert attrs == {"Size": "S", "Color": "Red"}


def test_plain_inventory_import_has_no_product(make_client, db):
    """A row with no product/attribute columns stays a simple item."""
    c = make_client("superadmin")
    res = c.post("/api/imports/inventory/commit", json={"rows": [
        {"name": "Plain Nail", "sale_price": 1, "quantity": 100},
    ]})
    assert res.status_code == 200, res.text
    row = db.execute("SELECT product_id, variant_label FROM inventory WHERE name='Plain Nail'").fetchone()
    assert row["product_id"] is None and row["variant_label"] is None


def test_attribute_def_crud(make_client):
    """The owner-defined Inventory Fields manager rides on this CRUD: create a
    global field, see it listed, update it, delete it."""
    c = make_client("superadmin")
    r = c.post("/api/products/attribute-defs", json={
        "scope_type": "global", "name": "Warranty", "input_type": "enum",
        "options": ["6mo", "1yr", "2yr"], "is_variant_axis": False, "sort_order": 1,
    })
    assert r.status_code in (200, 201), r.text
    def_id = r.json()["id"]

    listed = c.get("/api/products/attribute-defs?scope_type=global").json()
    warranty = next((d for d in listed if d["name"] == "Warranty"), None)
    assert warranty is not None
    assert warranty["options"] == ["6mo", "1yr", "2yr"]
    assert warranty["is_variant_axis"] is False

    assert c.put(f"/api/products/attribute-defs/{def_id}", json={
        "scope_type": "global", "name": "Warranty", "input_type": "enum",
        "options": ["1yr", "2yr"], "is_variant_axis": False, "sort_order": 2,
    }).status_code == 200
    assert c.delete(f"/api/products/attribute-defs/{def_id}").status_code == 200
    after = c.get("/api/products/attribute-defs?scope_type=global").json()
    assert all(d["name"] != "Warranty" for d in after)


def test_setting_business_type_seeds_presets(make_client, db):
    """Choosing a business type (the path the Setup wizard also uses) seeds that
    vertical's attribute presets."""
    c = make_client("superadmin")
    r = c.put("/api/settings/", json={"business_type": "Electronics"})
    assert r.status_code == 200, r.text
    assert r.json().get("business_type") == "Electronics"
    n = db.execute(
        "SELECT COUNT(*) AS n FROM attribute_defs WHERE scope_type='business' AND scope_value='Electronics'"
    ).fetchone()["n"]
    assert n > 0
