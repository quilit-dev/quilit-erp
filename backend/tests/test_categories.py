"""
Owner-defined category registry.

The registry feeds every category picker; it must seed the four domains, allow
admin CRUD, reject duplicates per domain, stay admin-only for writes, and never
constrain the actual category stored on a record (an owner-invented expense
category must still post — its GL falls back to Other Expense).
"""
import pytest


def test_seeded_domains_present(make_client):
    c = make_client("superadmin")
    names = {r["name"] for r in c.get("/api/categories?domain=expense").json()}
    assert {"Labour", "Materials", "Other"} <= names
    inv = {r["name"] for r in c.get("/api/categories?domain=inventory").json()}
    assert {"Equipment", "Tools"} <= inv
    # Domain filter is honoured — no expense-only category leaks into inventory.
    assert "Rent" not in inv


def test_admin_crud_roundtrip(make_client):
    c = make_client("superadmin")
    created = c.post("/api/categories", json={"domain": "expense", "name": "Marketing"})
    assert created.status_code in (200, 201), created.text
    cid = created.json()["id"]
    assert "Marketing" in {r["name"] for r in c.get("/api/categories?domain=expense").json()}

    # Rename.
    assert c.put(f"/api/categories/{cid}", json={"name": "Advertising"}).status_code == 200
    names = {r["name"] for r in c.get("/api/categories?domain=expense").json()}
    assert "Advertising" in names and "Marketing" not in names

    # Archive removes it from the picker.
    assert c.patch(f"/api/categories/{cid}/archive").status_code == 200
    assert "Advertising" not in {r["name"] for r in c.get("/api/categories?domain=expense").json()}


def test_duplicate_name_per_domain_rejected(make_client):
    c = make_client("superadmin")
    assert c.post("/api/categories", json={"domain": "asset", "name": "Drones"}).status_code in (200, 201)
    dup = c.post("/api/categories", json={"domain": "asset", "name": "Drones"})
    assert dup.status_code == 400
    # Same name in a DIFFERENT domain is fine.
    assert c.post("/api/categories", json={"domain": "inventory", "name": "Drones"}).status_code in (200, 201)


def test_unknown_domain_rejected(make_client):
    c = make_client("superadmin")
    assert c.post("/api/categories", json={"domain": "nonsense", "name": "X"}).status_code == 400


@pytest.mark.parametrize("role", ["Sales", "Viewer", "Accountant"])
def test_non_admin_cannot_write(role, make_client):
    c = make_client(role)
    assert c.post("/api/categories", json={"domain": "expense", "name": "Sneaky"}).status_code == 403
    # …but can read for the dropdowns.
    assert c.get("/api/categories?domain=expense").status_code == 200


def test_owner_category_still_posts_an_expense(make_client, db):
    """A brand-new owner-defined expense category is accepted on an expense and
    posts to the ledger (unknown categories fall back to the Other Expense
    account, so the registry never blocks a sale/expense)."""
    c = make_client("superadmin")
    c.post("/api/categories", json={"domain": "expense", "name": "Mascot Costumes"})
    r = c.post("/api/finance/expenses", json={
        "category": "Mascot Costumes", "amount": 50, "description": "Parade",
    })
    assert r.status_code in (200, 201), r.text
    # The expense persisted with the owner category verbatim.
    row = db.execute(
        "SELECT category FROM expenses WHERE description='Parade' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert row["category"] == "Mascot Costumes"


def test_owner_can_map_expense_category_to_ledger_account(make_client):
    """An owner pins an expense category to a specific Expense account; expenses
    in that category then post to it instead of the Other Expense default."""
    c = make_client("superadmin")
    cid = c.post("/api/categories", json={"domain": "expense", "name": "Marketing"}).json()["id"]
    # Map it to Rent (6100) — an existing Expense account, not the 6900 default.
    assert c.put(f"/api/categories/{cid}",
                 json={"name": "Marketing", "account_code": "6100"}).status_code == 200
    row = next(r for r in c.get("/api/categories?domain=expense").json() if r["id"] == cid)
    assert row["account_code"] == "6100"

    r = c.post("/api/finance/expenses",
               json={"category": "Marketing", "amount": 75, "description": "AdRun"})
    assert r.status_code in (200, 201), r.text
    rows = c.get("/api/accounting/journal-entries?source_type=expense").json()["rows"]
    full = c.get(f"/api/accounting/journal-entries/{rows[0]['id']}").json()
    debits = [l["account_code"] for l in full["lines"] if l["debit"]]
    assert "6100" in debits and "6900" not in debits


def test_invalid_ledger_account_rejected(make_client):
    c = make_client("superadmin")
    cid = c.post("/api/categories", json={"domain": "expense", "name": "Promo"}).json()["id"]
    # A code that doesn't exist in the chart of accounts.
    assert c.put(f"/api/categories/{cid}",
                 json={"name": "Promo", "account_code": "9999"}).status_code == 400
    # A real account that isn't an Expense account (1000 = Cash, an Asset).
    assert c.put(f"/api/categories/{cid}",
                 json={"name": "Promo", "account_code": "1000"}).status_code == 400


def test_rename_preserves_gl_mapping(make_client):
    """Renaming a category (a payload without account_code) must not silently
    clear an existing ledger mapping."""
    c = make_client("superadmin")
    cid = c.post("/api/categories", json={"domain": "expense", "name": "Ads"}).json()["id"]
    assert c.put(f"/api/categories/{cid}",
                 json={"name": "Ads", "account_code": "6100"}).status_code == 200
    assert c.put(f"/api/categories/{cid}", json={"name": "Campaigns"}).status_code == 200
    row = next(r for r in c.get("/api/categories?domain=expense").json() if r["id"] == cid)
    assert row["name"] == "Campaigns" and row["account_code"] == "6100"


# ── removing an inventory category clears it off the stock ──────────────────
def test_removing_an_inventory_category_leaves_its_items_with_none(make_client, db):
    """The owner's ask: a removed category must be gone from the list and its
    filter too, not kept alive by the items that still wore it."""
    c = make_client("superadmin")
    cat = c.post("/api/categories", json={"domain": "inventory", "name": "Widgets"}).json()
    a = c.post("/api/inventory/", json={"name": "A", "category": "Widgets", "quantity": 1}).json()["id"]
    b = c.post("/api/inventory/", json={"name": "B", "category": "Widgets", "quantity": 1}).json()["id"]
    keep = c.post("/api/inventory/", json={"name": "K", "category": "Other", "quantity": 1}).json()["id"]

    r = c.patch(f"/api/categories/{cat['id']}/archive")
    assert r.status_code == 200, r.text
    assert r.json()["items_cleared"] == 2
    for item in (a, b):
        assert c.get(f"/api/inventory/{item}").json()["category"] is None
    assert c.get(f"/api/inventory/{keep}").json()["category"] == "Other"
    # Nothing carries the name any more, so the derived list is clean too.
    assert "Widgets" not in c.get("/api/inventory/categories").json()


def test_removing_an_expense_category_keeps_the_records(make_client, db):
    """An expense's category feeds its ledger account; blanking it would be a
    posting nobody asked for. Only the inventory domain is cleared."""
    c = make_client("superadmin")
    cat = c.post("/api/categories", json={"domain": "expense", "name": "Fuel"}).json()
    db.execute("INSERT INTO expenses (category, description, amount, date, created_at) "
               "VALUES ('Fuel', 'x', 10, '2026-09-01', '2026-09-01 00:00:00')")
    db.commit()
    r = c.patch(f"/api/categories/{cat['id']}/archive")
    assert r.status_code == 200, r.text
    assert r.json()["items_cleared"] == 0
    assert db.execute("SELECT category FROM expenses WHERE description='x'").fetchone()["category"] == "Fuel"


def test_the_one_time_cleanup_clears_categories_removed_before_it_and_runs_once(make_client, db):
    import database
    c = make_client("superadmin")
    cat = c.post("/api/categories", json={"domain": "inventory", "name": "Legacy"}).json()
    item = c.post("/api/inventory/", json={"name": "L", "category": "Legacy", "quantity": 1}).json()["id"]
    # Archived the old way: the registry row alone, the item untouched.
    db.execute("UPDATE categories SET archived_at='2026-01-01 00:00:00' WHERE id=?", (cat["id"],))
    db.execute("DELETE FROM schema_migrations WHERE name='187d_clear_removed_inventory_categories'")
    db.commit()

    database._run_migrations(db, db.cursor()); db.commit()
    assert c.get(f"/api/inventory/{item}").json()["category"] is None

    # Re-created and re-assigned later: a second boot must not clear it again.
    c.post("/api/categories", json={"domain": "inventory", "name": "Legacy2"})
    db.execute("UPDATE categories SET archived_at='2026-01-02 00:00:00' WHERE name='Legacy2'")
    db.execute("UPDATE inventory SET category='Legacy2' WHERE id=?", (item,))
    db.commit()
    database._run_migrations(db, db.cursor()); db.commit()
    assert c.get(f"/api/inventory/{item}").json()["category"] == "Legacy2"
