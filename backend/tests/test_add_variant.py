"""
Adding one more variant to a product that already exists.

The builder creates every variant on the day the product is made. A size or
colour that turns up later had nowhere to go: a standalone item outside the
group, or rebuilding the product. `POST /api/products/{id}/variants` puts it
under the product, inheriting the template its siblings were set up with, so
it appears in the list's group and in the till's variant picker at once.
"""
import pytest

pytestmark = pytest.mark.critical


def _shirt(c, **extra):
    r = c.post("/api/products/", json={
        "name": "Cotton T-Shirt", "category": "Apparel", "sale_price": 20,
        "unit_cost": 8, "unit": "pcs", "min_stock": 2,
        "axes": [{"name": "Size", "values": ["S", "M"]}], **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _variants(c, pid):
    return c.get(f"/api/products/{pid}").json()["variants"]


def test_a_new_size_joins_the_product_and_inherits_its_template(make_client, db):
    c = make_client("superadmin")
    pid = _shirt(c)
    r = c.post(f"/api/products/{pid}/variants", json={"attributes": {"Size": "XL"}})
    assert r.status_code == 200, r.text
    assert r.json()["variant_label"] == "XL"

    vs = _variants(c, pid)
    assert sorted(v["variant_label"] for v in vs) == ["M", "S", "XL"]
    xl = next(v for v in vs if v["variant_label"] == "XL")
    assert xl["name"] == "Cotton T-Shirt — XL"
    assert xl["attributes"] == {"Size": "XL"}
    # Price, cost, unit, category and min stock come from the siblings.
    assert xl["sale_price"] == pytest.approx(20)
    assert xl["unit_cost"] == pytest.approx(8)
    assert xl["unit"] == "pcs"
    assert xl["category"] == "Apparel"
    assert xl["min_stock"] == pytest.approx(2)
    assert xl["quantity"] == 0


def test_its_own_price_barcode_and_opening_stock_when_given(make_client, db):
    c = make_client("superadmin")
    pid = _shirt(c)
    r = c.post(f"/api/products/{pid}/variants", json={
        "attributes": {"Size": "XXL"}, "sale_price": 24, "unit_cost": 9,
        "barcode": "TS-XXL", "initial_quantity": 5})
    assert r.status_code == 200, r.text
    item = c.get(f"/api/inventory/{r.json()['id']}").json()
    assert item["sale_price"] == pytest.approx(24)
    assert item["barcode"] == "TS-XXL"
    assert float(item["quantity"]) == 5
    # Opening stock is a real movement, as for any SKU.
    mv = db.execute("SELECT delta FROM stock_movements WHERE inventory_id=?",
                    (r.json()["id"],)).fetchone()
    assert mv and float(mv["delta"]) == 5


def test_the_same_combination_twice_is_refused(make_client):
    c = make_client("superadmin")
    pid = _shirt(c)
    r = c.post(f"/api/products/{pid}/variants", json={"attributes": {"Size": "M"}})
    assert r.status_code == 400
    assert "already exists" in r.text
    # Case and spacing do not make it new.
    r = c.post(f"/api/products/{pid}/variants", json={"label": " m "})
    assert r.status_code == 400


def test_a_used_barcode_is_refused(make_client):
    c = make_client("superadmin")
    pid = _shirt(c)
    c.post("/api/inventory/", json={"name": "Other", "quantity": 1, "barcode": "DUP-1"})
    r = c.post(f"/api/products/{pid}/variants",
               json={"attributes": {"Size": "L"}, "barcode": "DUP-1"})
    assert r.status_code == 400
    assert "barcode" in r.text.lower()


def test_a_variant_needs_a_value_or_a_label(make_client):
    c = make_client("superadmin")
    pid = _shirt(c)
    assert c.post(f"/api/products/{pid}/variants", json={}).status_code == 400
    assert c.post(f"/api/products/{pid}/variants",
                  json={"attributes": {"Size": "  "}}).status_code == 400


def test_a_plain_label_works_for_a_product_without_axes(make_client):
    c = make_client("superadmin")
    r = c.post("/api/products/", json={"name": "Poster", "sale_price": 5, "axes": []})
    pid = r.json()["id"]
    r = c.post(f"/api/products/{pid}/variants", json={"label": "A3"})
    assert r.status_code == 200, r.text
    assert sorted((v["variant_label"] or "") for v in _variants(c, pid)) == ["", "A3"]


def test_the_new_variant_is_in_the_till_and_sells(make_client):
    c = make_client("superadmin")
    pid = _shirt(c)
    r = c.post(f"/api/products/{pid}/variants",
               json={"attributes": {"Size": "XL"}, "initial_quantity": 3})
    item_id = r.json()["id"]
    rows = c.get("/api/pos/products", params={"search": "Cotton"}).json()
    hit = next(p for p in rows if p["id"] == item_id)
    assert hit["product_id"] == pid and hit["variant_label"] == "XL"


def test_needs_inventory_create(as_role):
    owner = as_role("superadmin")
    pid = _shirt(owner)
    r = as_role("Viewer").post(f"/api/products/{pid}/variants",
                               json={"attributes": {"Size": "XL"}})
    assert r.status_code == 403


def test_an_archived_or_missing_product_is_not_found(make_client):
    c = make_client("superadmin")
    pid = _shirt(c)
    assert c.patch(f"/api/products/{pid}/archive").status_code == 200
    assert c.post(f"/api/products/{pid}/variants",
                  json={"attributes": {"Size": "XL"}}).status_code == 404
    assert c.post("/api/products/999999/variants",
                  json={"attributes": {"Size": "XL"}}).status_code == 404
