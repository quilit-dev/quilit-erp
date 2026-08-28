"""Deleting an inventory item, and refusing to when it would rewrite history.

Archive was the only way to get rid of an item, which is right for one that has
been traded and wrong for one created by mistake: a typo, a duplicate, a test
row. Those leave an archived ghost in the list forever.

The line between the two is whether anything refers to it. An item on an
invoice, a purchase order or a stock movement cannot be deleted at any price —
the document naming it has to go on making sense for as long as it is kept, and
a line item pointing at a row that no longer exists is not a tidier database,
it is a record nobody can explain. That item gets archived, and the refusal
says so.
"""
import uuid

import pytest


def _item(c, name, qty=0, cost=0, price=0):
    r = c.post("/api/inventory/", json={"name": name, "quantity": qty,
                                        "unit_cost": cost, "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _names(c):
    r = c.get("/api/inventory/").json()
    rows = r if isinstance(r, list) else r.get("items", r.get("data", []))
    return [i["name"] for i in rows]


# ── the case this exists for ────────────────────────────────────────────────
def test_an_unused_item_can_be_deleted(make_client, db):
    c = make_client("superadmin")
    keep = _item(c, "ID Keep")
    oops = _item(c, "ID Typpo")

    r = c.delete(f"/api/inventory/{oops}")
    assert r.status_code == 200, r.text

    assert db.execute("SELECT COUNT(*) n FROM inventory WHERE id=?",
                      (oops,)).fetchone()["n"] == 0
    # Gone entirely, not archived: an archived row would still be listed under
    # the archive filter, which is exactly what the operator did not want.
    assert "ID Typpo" not in _names(c)
    assert db.execute("SELECT COUNT(*) n FROM inventory WHERE id=?",
                      (keep,)).fetchone()["n"] == 1


def test_the_deletion_is_recorded(make_client, db):
    """It is irreversible, so who did it and what it was must survive it."""
    c = make_client("superadmin")
    item = _item(c, "ID Audited", cost=7, price=19)
    assert c.delete(f"/api/inventory/{item}").status_code == 200

    row = db.execute(
        "SELECT * FROM audit_log WHERE module='inventory' AND action='delete' "
        "AND record_id=?", (item,)).fetchone()
    assert row is not None, "a deletion with no audit record"
    assert "ID Audited" in str(row["record_ref"])
    assert row["username"], "the deletion must name who did it"


# ── the refusals ────────────────────────────────────────────────────────────
def test_an_item_on_an_invoice_cannot_be_deleted(make_client):
    c = make_client("superadmin")
    item = _item(c, "ID Sold", price=10)
    cl = c.post("/api/clients/", json={"name": "ID Client"}).json()["id"]
    assert c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "ID Sold", "quantity": 1, "unit_price": 10,
                   "inventory_id": item}]}).status_code in (200, 201)

    r = c.delete(f"/api/inventory/{item}")
    assert r.status_code == 409, r.text
    # The message has to name the obstacle and the way round it, or the
    # operator just tries again.
    assert "invoice" in r.text.lower()
    assert "archive" in r.text.lower()


def test_an_item_with_stock_cannot_be_deleted(make_client):
    c = make_client("superadmin")
    item = _item(c, "ID InStock", qty=5, cost=2)

    r = c.delete(f"/api/inventory/{item}")
    assert r.status_code == 400, r.text
    assert "stock" in r.text.lower()


def test_a_purchased_item_cannot_be_deleted(make_client):
    """Bought and sold back down to zero still leaves a paper trail."""
    c = make_client("superadmin")
    item = _item(c, "ID Traded")
    po = c.post("/api/purchases/", json={
        "supplier": "ID Mill", "inventory_id": item, "product_name": "ID Traded",
        "quantity": 4, "unit_cost": 3})
    assert po.status_code in (200, 201), po.text
    assert c.patch(f"/api/purchases/{po.json()['id']}/status",
                   json={"status": "Paid"}).status_code == 200
    # Take the stock back out so only the history stands in the way.
    z = c.patch(f"/api/inventory/{item}/stock",
                json={"delta": -4, "note": "test"})
    assert z.status_code == 200, z.text

    r = c.delete(f"/api/inventory/{item}")
    assert r.status_code == 409, r.text
    assert "archive" in r.text.lower()


def test_deleting_a_missing_item_is_a_404(make_client):
    c = make_client("superadmin")
    assert c.delete("/api/inventory/999999").status_code == 404


def test_delete_needs_the_delete_permission(make_client):
    """The same permission archive asks for — not a lesser one."""
    c = make_client("superadmin")
    item = _item(c, "ID Guarded")
    viewer = make_client("Auditor")     # read-only by design
    r = viewer.delete(f"/api/inventory/{item}")
    assert r.status_code in (401, 403), r.text


# ── the screen asks first ───────────────────────────────────────────────────
def test_usage_reports_what_is_in_the_way(make_client):
    c = make_client("superadmin")
    free = _item(c, "ID Free")
    used = _item(c, "ID Used", price=10)
    cl = c.post("/api/clients/", json={"name": "ID C2"}).json()["id"]
    c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "ID Used", "quantity": 1, "unit_price": 10,
                   "inventory_id": used}]})

    assert c.get(f"/api/inventory/{free}/usage").json()["can_delete"] is True

    u = c.get(f"/api/inventory/{used}/usage").json()
    assert u["can_delete"] is False
    assert u["used_by"].get("invoices") == 1


# ── the guard that keeps the list honest ────────────────────────────────────
def test_every_table_referencing_an_item_is_accounted_for(db):
    """A new table with an inventory_id must be classified, not ignored.

    Miss one and `delete` silently stops seeing that kind of history: the item
    goes, and rows in the new table are left pointing at nothing. This walks
    the real schema so the omission fails here rather than in production.
    """
    from routers.inventory import _USED_BY, _OWN_ROWS

    known = {t for t, _c, _l in _USED_BY} | {t for t, _c in _OWN_ROWS} | {"inventory"}

    tables = [r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    referencing = set()
    for t in tables:
        for col in db.execute(f"PRAGMA table_info({t})").fetchall():
            if str(col["name"]).endswith("inventory_id"):
                referencing.add(t)

    missing = referencing - known
    assert not missing, (
        "these tables reference an inventory item but are neither checked "
        "before deleting nor deleted with it: " + ", ".join(sorted(missing)))


def test_the_columns_named_in_the_list_exist(db):
    """A renamed column would make a check silently pass on everything."""
    from routers.inventory import _USED_BY, _OWN_ROWS

    for table, column, _label in _USED_BY:
        cols = [c["name"] for c in db.execute(f"PRAGMA table_info({table})").fetchall()]
        assert cols, f"{table} does not exist"
        assert column in cols, f"{table}.{column} does not exist"
    for table, column in _OWN_ROWS:
        cols = [c["name"] for c in db.execute(f"PRAGMA table_info({table})").fetchall()]
        assert column in cols, f"{table}.{column} does not exist"
