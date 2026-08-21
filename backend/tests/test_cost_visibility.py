"""Hiding what stock cost to buy, from staff who only need what it sells for.

A shop floor works in unit PRICE. `GET /api/inventory/` is a `SELECT i.*`, so
`unit_cost` rode along in the JSON for anyone holding `inventory:view` --
including the Cashier. The POS screen never drew it, which made this look solved
when it was one devtools panel away from being read.

`costs` is now a permission key of its own. Roles that hold it see cost exactly
as before; roles that do not get responses with the cost fields absent.

Two things these tests care about more than the hiding itself:

  * A user who cannot see cost must not be able to DESTROY it. Their form has no
    cost field, so an unguarded handler takes the missing value as 0 and wipes
    the item's cost -- silently taking stock valuation and every future COGS
    posting with it. That is worse than the leak it fixes.
  * The people who work in cost terms must keep working. Purchase orders and
    BOMs are authored as costs; withholding it there does not hide information,
    it stops the job.
"""
import pytest


# The suite seeds no Cashier account, and Cashier is the role that prompted
# this. `Viewer` stands in: it holds inventory:view and not costs:view, which is
# the same code path and the same shape of user -- allowed to see what is in
# stock, not what it cost. Change this if a Cashier fixture is ever added.
NO_COST_ROLE = "Viewer"


def _item(client, name="Widget", cost=40, price=100):
    r = client.post("/api/inventory/", json={
        "name": name, "quantity": 10, "unit_cost": cost, "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _find(rows, item_id):
    rows = rows if isinstance(rows, list) else (rows.get("rows") or rows.get("items") or [])
    return next(r for r in rows if r["id"] == item_id)


# ── The leak ─────────────────────────────────────────────────────────────────

def test_the_owner_still_sees_cost(as_role):
    """The capability must not hide cost from the person who owns the business."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    row = _find(owner.get("/api/inventory/").json(), item)

    assert row["unit_cost"] == pytest.approx(40)


def test_a_no_cost_role_gets_none_in_the_json(as_role):
    """Not hidden in React -- absent from the response. The whole point."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    cashier = as_role(NO_COST_ROLE)
    row = _find(cashier.get("/api/inventory/").json(), item)

    assert "unit_cost" not in row, "cost is still in the payload"
    assert row["sale_price"] == pytest.approx(100), "the price they DO need is gone"
    assert row["name"] == "Widget"


def test_the_item_detail_hides_it_too(as_role):
    """A list that hides cost and a detail endpoint that returns it is not
    hiding anything -- the id is in the list."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    body = as_role(NO_COST_ROLE).get(f"/api/inventory/{item}").json()

    assert "unit_cost" not in body


def test_stock_levels_still_work_without_cost(as_role):
    """The reason a cashier holds inventory:view at all is to see what is in
    stock. Stripping cost must not cost them that."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    row = _find(as_role(NO_COST_ROLE).get("/api/inventory/").json(), item)

    assert row["quantity"] == pytest.approx(10)


# ── Derivation ───────────────────────────────────────────────────────────────

def test_the_valuation_report_gives_nothing_away(as_role):
    """Stock valuation IS quantity x cost, so a value column divides straight
    back out to the number being hidden."""
    owner = as_role("superadmin")
    _item(owner, cost=40)

    body = as_role(NO_COST_ROLE).get("/api/reports/inventory-by-warehouse")
    if body.status_code == 403:
        return                      # no reports access at all is also fine
    text = str(body.json())

    assert "unit_cost" not in text
    assert "'value'" not in text and '"value"' not in text


def test_warehouse_stock_hides_cost_and_value(as_role):
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    r = as_role(NO_COST_ROLE).get(f"/api/inventory/{item}/by-warehouse")
    if r.status_code == 403:
        return
    for row in r.json():
        assert "unit_cost" not in row
        assert "value" not in row


# ── The dangerous one ────────────────────────────────────────────────────────

def test_editing_without_cost_access_does_not_destroy_it(as_role, db):
    """The failure that matters. Their form has no cost field, so an unguarded
    handler reads the absent value as 0 and wipes the item's cost."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40, price=100)

    # Someone with inventory:edit but no cost access renames the item.
    editor = as_role("Inventory")
    db.execute("DELETE FROM role_permissions WHERE module='costs' AND role_id="
               "(SELECT id FROM roles WHERE name='Inventory')")
    db.commit()

    r = editor.put(f"/api/inventory/{item}", json={
        "name": "Widget (renamed)", "quantity": 10, "sale_price": 100})
    assert r.status_code == 200, r.text

    row = db.execute("SELECT name, unit_cost FROM inventory WHERE id=?", (item,)).fetchone()
    assert row["name"] == "Widget (renamed)", "the edit they were allowed did not happen"
    assert row["unit_cost"] == pytest.approx(40), "their edit wiped the cost"


def test_the_owner_can_still_change_cost(as_role):
    """The guard must not freeze cost for everyone."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    owner.put(f"/api/inventory/{item}", json={
        "name": "Widget", "quantity": 10, "unit_cost": 55, "sale_price": 100})

    assert owner.get(f"/api/inventory/{item}").json()["unit_cost"] == pytest.approx(55)


# ── Nobody is broken ─────────────────────────────────────────────────────────

def test_procurement_still_sees_cost(as_role):
    """Purchase orders are authored in cost terms. Taking it away here does not
    hide information, it stops the work."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    row = _find(as_role("Procurement Officer").get("/api/inventory/").json(), item)

    assert row["unit_cost"] == pytest.approx(40)


@pytest.mark.parametrize("role", ["Finance Manager", "Accountant", "Auditor",
                                  "Operations Manager"])
def test_cost_authoring_and_finance_roles_keep_it(as_role, role):
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    rows = as_role(role).get("/api/inventory/")
    if rows.status_code == 403:
        pytest.skip(f"{role} has no inventory access at all")
    assert "unit_cost" in _find(rows.json(), item)


def test_a_read_only_viewer_does_not_get_it(as_role):
    """Viewer is blanket-granted every module in the seeded matrix, which is
    exactly the account an owner does not want reading cost prices. It is
    granted explicitly instead, so Viewer is left out."""
    owner = as_role("superadmin")
    item = _item(owner, cost=40)

    rows = as_role("Viewer").get("/api/inventory/")
    if rows.status_code == 403:
        return
    assert "unit_cost" not in _find(rows.json(), item)


# ── Wiring ───────────────────────────────────────────────────────────────────

def test_the_capability_is_never_paywalled():
    """`costs` has no sidebar entry, so it never appears in a vendor's
    ENABLED_MODULES. Absent from _ALWAYS_ON, module_allowed() would refuse it on
    every licensed install and the owner would lose their own cost prices."""
    import vendor_config
    import capabilities

    # TWO always-on sets exist and both matter: vendor_config._ALWAYS_ON gates
    # the API, capabilities.ALWAYS_ON keeps it out of the sellable catalogue so
    # the Control Center does not offer it as a purchasable module. Adding to
    # one and forgetting the other is why this asserts on both.
    assert "costs" in vendor_config._ALWAYS_ON
    assert "costs" in capabilities.ALWAYS_ON
    assert vendor_config.module_allowed("costs")
    assert "costs" not in {m["key"] for m in capabilities.catalog()} - set(capabilities.ALWAYS_ON)


def test_the_role_editor_can_grant_it():
    """The frontend keeps its own copy of the module list. A capability the
    backend knows about and the role editor cannot show is ungrantable."""
    import pathlib
    import permissions

    assert "costs" in permissions.MODULES
    src = (pathlib.Path(__file__).resolve().parents[2]
           / "frontend_src" / "src" / "pages" / "RoleManagement.jsx").read_text(encoding="utf-8")
    assert "'costs'" in src, "costs is missing from the role editor's module list"
