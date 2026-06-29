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
