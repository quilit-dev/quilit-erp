"""
Emptying a tenant's inventory.

The most destructive thing the system can be told to do to one module, so
the tests are about what it REFUSES as much as what it removes:

  * superadmin only, with the tenant's own name typed;
  * refused outright --- nothing removed --- if any record outside the item's
    own stock rows refers to any item; the referencing tables are read from
    the schema, not a hand-written list;
  * removes items, variants, product groups and the items' own stock rows,
    and nothing else: suppliers, categories, warehouses, documents stay.
"""
import uuid

import pytest

import inventory_wipe

pytestmark = pytest.mark.critical


def _item(c, name="Widget", qty=5, **extra):
    r = c.post("/api/inventory/", json={"name": name, "quantity": qty, "unit_cost": 2,
                                        "sale_price": 5, **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _count(db, table):
    return db.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]


def _named(c, name="Demo Co"):
    """A single-tenant install confirms against its company name; the test
    database starts without one, and without one the wipe refuses."""
    r = c.put("/api/settings/", json={"company_name": name})
    assert r.status_code == 200, r.text


# ── who may, and how ─────────────────────────────────────────────────────────
def test_only_a_vendor_superadmin_may_even_look(as_role):
    for role in ("Branch Manager", "Manager", "Inventory"):
        assert as_role(role).get("/api/inventory/wipe/plan").status_code == 403
        assert as_role(role).post("/api/inventory/wipe", json={"confirm": "x"}).status_code == 403


def test_the_tenant_name_must_be_typed(as_role, db):
    owner = as_role("superadmin")
    _item(owner)
    # No name on the install: nothing to confirm against, so it refuses.
    assert owner.post("/api/inventory/wipe", json={"confirm": ""}).status_code == 400
    _named(owner)
    phrase = owner.get("/api/inventory/wipe/plan").json()["confirmation_phrase"]
    assert phrase == "Demo Co"
    for wrong in ("", "nope", phrase + "x"):
        r = owner.post("/api/inventory/wipe", json={"confirm": wrong})
        assert r.status_code == 400, r.text
    assert _count(db, "inventory") == 1
    # Case does not matter; whitespace does not matter.
    r = owner.post("/api/inventory/wipe", json={"confirm": f"  {phrase.upper()} "})
    assert r.status_code == 200, r.text
    assert _count(db, "inventory") == 0


# ── what goes ────────────────────────────────────────────────────────────────
def test_items_variants_products_and_their_stock_rows_go_and_nothing_else(as_role, db):
    owner = as_role("superadmin")
    _named(owner)
    _item(owner, "Plain", qty=5)
    _item(owner, "Lotted", qty=3, lot_tracked=True)
    r = owner.post("/api/products/", json={"name": "Shirt", "sale_price": 9, "initial_quantity": 2,
                                           "axes": [{"name": "Size", "values": ["S", "M"]}]})
    assert r.status_code in (200, 201), r.text
    sup = owner.post("/api/suppliers/", json={"name": "Acme"})
    assert sup.status_code in (200, 201), sup.text
    cat = owner.post("/api/categories", json={"domain": "inventory", "name": "Keep me"})
    assert cat.status_code in (200, 201), cat.text

    before = {t: _count(db, t) for t in ("suppliers", "categories", "warehouses", "invoices", "expenses")}
    plan = owner.get("/api/inventory/wipe/plan").json()
    assert plan["items"] == 4 and plan["products"] == 1 and plan["can_run"] is True
    assert plan["blockers"] == {}
    assert plan["own_rows"]["stock_movements"] >= 4

    r = owner.post("/api/inventory/wipe", json={"confirm": plan["confirmation_phrase"]})
    assert r.status_code == 200, r.text
    for t in ("inventory", "products", "product_attributes", "item_attributes",
              "inventory_stock", "stock_movements", "inventory_cost_layers",
              "inventory_lots", "lot_consumption"):
        assert _count(db, t) == 0, t
    for t, n in before.items():
        assert _count(db, t) == n, f"{t} was touched"
    # The trail says what went.
    row = db.execute("SELECT detail FROM audit_log WHERE action='wipe' AND module='inventory' "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row and '"items": 4' in row["detail"]


def test_archived_items_go_too(as_role, db):
    owner = as_role("superadmin")
    _named(owner)
    item = _item(owner, qty=0)
    assert owner.patch(f"/api/inventory/{item}/archive").status_code == 200
    plan = owner.get("/api/inventory/wipe/plan").json()
    assert plan["archived_items"] == 1
    owner.post("/api/inventory/wipe", json={"confirm": plan["confirmation_phrase"]})
    assert _count(db, "inventory") == 0


# ── what stops it ────────────────────────────────────────────────────────────
def test_an_item_on_an_invoice_blocks_the_whole_thing(as_role, db):
    owner = as_role("superadmin")
    _named(owner)
    item = _item(owner)
    free = _item(owner, "Free")
    cl = owner.post("/api/clients/", json={"name": "C"}).json()
    r = owner.post("/api/invoices/", json={"client_id": cl["id"], "amount": 5,
                                           "items": [{"name": "Widget", "quantity": 1,
                                                      "unit_price": 5, "inventory_id": item}]})
    assert r.status_code == 200, r.text

    plan = owner.get("/api/inventory/wipe/plan").json()
    assert plan["can_run"] is False
    assert plan["blockers"].get("invoice_items.inventory_id") == 1

    r = owner.post("/api/inventory/wipe", json={"confirm": plan["confirmation_phrase"]})
    assert r.status_code == 409, r.text
    assert "invoice_items" in r.text
    # Nothing at all was removed --- not even the item nothing refers to.
    assert _count(db, "inventory") == 2
    assert db.execute("SELECT 1 FROM inventory WHERE id=?", (free,)).fetchone()


def test_a_till_sale_blocks_it(as_role, db):
    owner = as_role("superadmin")
    _named(owner)
    item = _item(owner, qty=10)
    owner.post("/api/pos/session/open", json={"opening_float": 0})
    r = owner.post("/api/pos/checkout", json={
        "items": [{"name": "Widget", "inventory_id": item, "quantity": 1, "unit_price": 5}],
        "payment_method": "Cash", "amount_tendered": 5, "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    plan = owner.get("/api/inventory/wipe/plan").json()
    assert "pos_sale_items.inventory_id" in plan["blockers"]
    assert owner.post("/api/inventory/wipe",
                      json={"confirm": plan["confirmation_phrase"]}).status_code == 409


def test_a_purchase_line_blocks_it(as_role, db):
    owner = as_role("superadmin")
    _named(owner)
    item = _item(owner)
    r = owner.post("/api/purchases/", json={"supplier": "Acme", "inventory_id": item,
                                            "product_name": "Widget", "quantity": 2, "unit_cost": 2})
    assert r.status_code in (200, 201), r.text
    plan = owner.get("/api/inventory/wipe/plan").json()
    assert any(k.startswith("purchase_items.") for k in plan["blockers"]), plan["blockers"]


def test_the_blocking_tables_come_from_the_schema_not_a_list(db):
    """Every foreign key that points at inventory is either one of the item's
    own stock rows or a reason to refuse. A new table with such a key is
    caught the day it is added, without anybody editing this module."""
    cols = inventory_wipe.referencing_columns(db)
    names = {f"{t}.{c}" for t, c in cols}
    for must in ("invoice_items.inventory_id", "pos_sale_items.inventory_id",
                 "purchase_items.inventory_id", "bom_components.component_inventory_id",
                 "stock_reservations.inventory_id", "sale_commitments.inventory_id",
                 "service_job_lines.inventory_id"):
        assert must in names, must
    for t, c in inventory_wipe.OWN_ROWS:
        assert (t, c) in cols, f"{t}.{c} is listed as the item's own but has no key to inventory"
