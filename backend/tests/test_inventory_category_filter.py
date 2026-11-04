"""Filtering inventory by category finds every item that carries it.

The filter used an exact match and offered only the categories registered in
Settings. An item imported or typed as "materials" or "Materials " never
matched "Materials", and a category that items carried but the registry did
not could not be picked at all --- the picker said "No matches" while the
table showed the category on the rows.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def c(make_client):
    return make_client("superadmin")


def _item(c, category):
    r = c.post("/api/inventory/", json={"name": "Cat " + uuid.uuid4().hex[:6], "quantity": 1,
                                        "unit_cost": 1, "sale_price": 2, "category": category})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _ids(c, category):
    return {i["id"] for i in c.get("/api/inventory/", params={"category": category}).json()}


def test_case_and_spaces_do_not_hide_an_item(c, db):
    a = _item(c, "Fasteners")
    b = _item(c, "Fasteners")
    # As an import or an old screen might have stored them.
    db.execute("UPDATE inventory SET category = ? WHERE id = ?", ("fasteners", a))
    db.execute("UPDATE inventory SET category = ? WHERE id = ?", ("Fasteners  ", b))
    db.commit()
    assert {a, b} <= _ids(c, "Fasteners")
    assert {a, b} <= _ids(c, "FASTENERS")


def test_other_categories_are_still_excluded(c):
    a = _item(c, "Bolts")
    other = _item(c, "Nuts")
    got = _ids(c, "Bolts")
    assert a in got and other not in got


def test_every_category_in_use_is_offered(c, db):
    a = _item(c, "Imported Only")
    db.execute("UPDATE inventory SET category = ? WHERE id = ?", ("  Imported Only ", a))
    db.commit()
    cats = c.get("/api/inventory/categories").json()
    assert "Imported Only" in cats, "trimmed, and present even if not in the registry"
    assert "" not in cats


def test_removing_a_category_clears_every_spelling_of_it(c, db):
    """Otherwise a removed name would come back through the filter list."""
    r = c.post("/api/categories/", json={"domain": "inventory", "name": "Gaskets"})
    assert r.status_code in (200, 201), r.text
    cat_id = r.json().get("id")
    a = _item(c, "Gaskets")
    db.execute("UPDATE inventory SET category = ? WHERE id = ?", ("gaskets ", a))
    db.commit()
    assert c.patch(f"/api/categories/{cat_id}/archive").status_code == 200
    assert db.execute("SELECT category FROM inventory WHERE id = ?", (a,)).fetchone()["category"] is None
    assert "gaskets" not in [x.lower() for x in c.get("/api/inventory/categories").json()]
