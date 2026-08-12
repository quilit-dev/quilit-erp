"""
Promotions on invoices and quotations.

The rule that matters most here is what does NOT happen: the quantity cap is
never consumed. POS meters "first N units" by bumping `used_quantity` inside the
sale transaction. An invoice can be drafted, edited and voided, and a quotation
may expire unaccepted — metering either would burn units of a promotion the
customer never receives, denying them to a real sale. POS stays the metered
channel.

The discount is snapshotted onto the line together with the promotion that
produced it, so ending or editing a promotion later cannot retroactively
reprice a document that was already issued.
"""
import sqlite3
import os


def _lines(table, fk, doc_id):
    con = sqlite3.connect(os.environ.get("DB_PATH", "erp.db"))
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        f"SELECT * FROM {table} WHERE {fk}=? ORDER BY id", (doc_id,))]
    con.close()
    return rows


def _used_quantity(promo_id):
    con = sqlite3.connect(os.environ.get("DB_PATH", "erp.db"))
    v = con.execute("SELECT used_quantity FROM promotions WHERE id=?",
                    (promo_id,)).fetchone()
    con.close()
    return (v[0] if v else None) or 0


def _setup(c, pct=10, max_qty=5):
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    item = c.post("/api/inventory/", json={
        "name": "Pump", "category": "Equipment", "quantity": 50,
        "unit_cost": 100, "sale_price": 200, "min_stock": 1}).json()
    promo = c.post("/api/promotions/", json={
        "name": "Test promo", "scope_type": "item", "scope_value": str(item["id"]),
        "discount_value": pct, "active": True, "max_quantity": max_qty}).json()
    return cl["id"], item["id"], promo["id"]


def test_invoice_line_gets_the_promotion_discount(make_client):
    c = make_client("superadmin")
    client_id, inv_id, promo_id = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 600,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    assert r.status_code == 200, r.text
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert line["discount"] == 60.0          # 10% of 3 x 200
    assert line["promotion_id"] == promo_id  # explainable in a dispute
    assert line["inventory_id"] == inv_id


def test_invoice_does_not_consume_the_quantity_cap(make_client):
    """The decision this module exists to protect. A draft that is later voided
    must not have burned promotional units."""
    c = make_client("superadmin")
    client_id, inv_id, promo_id = _setup(c)
    before = _used_quantity(promo_id)
    c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 600,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    assert _used_quantity(promo_id) == before, "an invoice consumed the cap"


def test_quotation_is_indicative_and_does_not_consume_the_cap(make_client):
    c = make_client("superadmin")
    client_id, inv_id, promo_id = _setup(c)
    before = _used_quantity(promo_id)
    r = c.post("/api/quotations/", json={
        "client_id": client_id,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    assert r.status_code in (200, 201), r.text
    line = _lines("quotation_items", "quotation_id", r.json()["id"])[0]
    assert line["discount"] == 60.0
    # `total` is the line NET of the promotion.
    assert round(float(line["total"]), 2) == 540.0
    assert _used_quantity(promo_id) == before, "a quotation consumed the cap"


def test_a_typed_discount_beats_the_promotion(make_client):
    """Someone entering a number has made a decision; an automatic rule must not
    overwrite it."""
    c = make_client("superadmin")
    client_id, inv_id, _ = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 450,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id, "discount": 150}]})
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert line["discount"] == 150.0
    assert line["promotion_id"] is None


def test_a_line_with_no_stock_link_gets_nothing(make_client):
    """A hand-typed service line has no inventory id, so no promotion can apply.
    Matching on the name instead would misprice the moment an item is renamed."""
    c = make_client("superadmin")
    client_id, _, _ = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 500,
        "items": [{"name": "Consulting", "quantity": 1, "unit_price": 500}]})
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert (line["discount"] or 0) == 0
    assert line["inventory_id"] is None
    assert line["promotion_id"] is None


def test_tax_is_charged_on_the_discounted_net(make_client):
    """The promotion changes what the customer owes, so tax follows the actual
    consideration — not the pre-discount sticker price."""
    c = make_client("superadmin")
    client_id, inv_id, _ = _setup(c)
    r = c.post("/api/invoices/", json={
        "client_id": client_id, "amount": 600,
        "items": [{"name": "Pump", "quantity": 3, "unit_price": 200,
                   "inventory_id": inv_id}]})
    full = c.get(f"/api/invoices/{r.json()['id']}").json()
    # 600 gross - 60 promo = 540 net.
    assert round(float(full["subtotal"]), 2) == 540.0


def test_an_inactive_promotion_is_ignored(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    item = c.post("/api/inventory/", json={
        "name": "Widget", "category": "Parts", "quantity": 10,
        "unit_cost": 10, "sale_price": 20, "min_stock": 1}).json()
    c.post("/api/promotions/", json={
        "name": "Off", "scope_type": "item", "scope_value": str(item["id"]),
        "discount_value": 50, "active": False})
    r = c.post("/api/invoices/", json={
        "client_id": cl["id"], "amount": 20,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 20,
                   "inventory_id": item["id"]}]})
    line = _lines("invoice_items", "invoice_id", r.json()["id"])[0]
    assert (line["discount"] or 0) == 0


# ── the form preview ────────────────────────────────────────────────────────
#
# The form computes its own running totals. Without a preview it showed a
# discount of zero while the server was about to apply one, so the figure the
# operator quoted was contradicted by the document that got saved.

def _promo_setup(c, pct=20):
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    it = c.post("/api/inventory/", json={"name": "Promo Widget", "quantity": 100,
                                         "unit_cost": 40, "sale_price": 100}).json()
    c.post("/api/promotions/", json={"name": "Preview Promo", "scope_type": "item",
                                     "scope_value": str(it["id"]),
                                     "discount_value": pct, "active": True})
    return cl["id"], it["id"]


def test_preview_matches_what_gets_saved(make_client):
    """The whole point. A preview that disagrees with the save is worse than no
    preview, because it is believed."""
    c = make_client("superadmin")
    client_id, iid = _promo_setup(c)
    line = {"name": "Promo Widget", "quantity": 2, "unit_price": 100,
            "discount": 0, "inventory_id": iid}

    previewed = c.post("/api/promotions/preview",
                       json={"lines": [line]}).json()["lines"][0]
    inv = c.post("/api/invoices/", json={"client_id": client_id,
                                         "items": [line]}).json()
    saved = c.get(f"/api/invoices/{inv['id']}").json()["items"][0]

    assert float(previewed["discount"]) == float(saved["discount"])
    assert previewed["promotion_name"] == "Preview Promo"


def test_preview_leaves_a_typed_discount_alone(make_client):
    c = make_client("superadmin")
    _, iid = _promo_setup(c)
    r = c.post("/api/promotions/preview", json={"lines": [
        {"inventory_id": iid, "quantity": 2, "unit_price": 100, "discount": 15}]}).json()
    assert r["lines"][0]["discount"] == 15
    assert r["lines"][0]["source"] == "manual"
    assert r["lines"][0]["promotion_id"] is None


def test_preview_ignores_lines_with_no_stock_link(make_client):
    """A hand-typed line has no inventory id, so no promotion can reach it."""
    c = make_client("superadmin")
    _promo_setup(c)
    r = c.post("/api/promotions/preview", json={"lines": [
        {"inventory_id": None, "quantity": 1, "unit_price": 50, "discount": 0}]}).json()
    assert r["lines"][0]["discount"] == 0
    assert r["lines"][0]["promotion_id"] is None


def test_preview_never_meters_the_cap(make_client):
    """Previewing is reading. Calling it repeatedly must not consume a promotion
    the customer has not been given."""
    c = make_client("superadmin")
    _, iid = _promo_setup(c)
    line = {"inventory_id": iid, "quantity": 3, "unit_price": 100, "discount": 0}
    for _ in range(5):
        c.post("/api/promotions/preview", json={"lines": [line]})
    promos = c.get("/api/promotions/").json()
    rows = promos if isinstance(promos, list) else promos.get("items", [])
    assert all((p.get("used_quantity") or 0) == 0 for p in rows)


def test_preview_requires_a_relevant_permission(make_client):
    """Display-only, but still business data: an anonymous caller gets nothing."""
    anon = make_client()
    r = anon.post("/api/promotions/preview", json={"lines": []})
    assert r.status_code in (401, 403)
