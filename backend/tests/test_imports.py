"""
Bulk import wizard — validate (dry run) + commit through the real create path.

The importer must reuse the live endpoints' validation, dedupe and side effects
(e.g. inventory opening stock), never re-implement them.
"""


def _names(c, path):
    return {r["name"] for r in c.get(path).json()}


# ── Schema ────────────────────────────────────────────────────────────────────
def test_schema_lists_fields(make_client):
    c = make_client("superadmin")
    s = c.get("/api/imports/clients/schema").json()
    keys = {f["key"] for f in s["fields"]}
    assert {"name", "phone", "email"} <= keys
    assert any(f.get("required") for f in s["fields"])  # name is required


def test_unknown_entity_404(make_client):
    c = make_client("superadmin")
    assert c.get("/api/imports/teleporters/schema").status_code == 404


# ── Validate (dry run) ─────────────────────────────────────────────────────────
def test_validate_flags_missing_required_and_writes_nothing(make_client):
    c = make_client("superadmin")
    before = len(c.get("/api/clients/").json())
    r = c.post("/api/imports/clients/validate", json={"rows": [
        {"name": "Acme Co", "phone": "01-111111"},
        {"phone": "no name here"},               # missing required name
    ]}).json()
    assert r["total"] == 2 and r["ok"] == 1 and r["errors"] == 1
    statuses = [row["status"] for row in r["rows"]]
    assert statuses == ["ok", "error"]
    # Dry run must not have created anything.
    assert len(c.get("/api/clients/").json()) == before


# ── Commit: clients ─────────────────────────────────────────────────────────────
def test_commit_clients_creates_records(make_client):
    c = make_client("superadmin")
    r = c.post("/api/imports/clients/commit", json={"rows": [
        {"name": "Imported One", "email": "one@x.com", "type": "company"},
        {"name": "Imported Two", "phone": "03-222222"},
        {"email": "broken@x.com"},               # no name → failed
    ]}).json()
    assert r["created"] == 2 and r["failed"] == 1
    names = _names(c, "/api/clients/")
    assert {"Imported One", "Imported Two"} <= names


# ── Commit: suppliers + duplicate handling ──────────────────────────────────────
def test_commit_suppliers_dedupes_existing_and_in_file(make_client):
    c = make_client("superadmin")
    # Seed one supplier the normal way so the importer must detect it.
    c.post("/api/suppliers/", json={"name": "DupCo"})

    rows = [
        {"name": "DupCo"},          # already exists → duplicate
        {"name": "FreshCo"},        # new
        {"name": "FreshCo"},        # duplicate within the same file
    ]
    # Default on_duplicate="skip"
    r = c.post("/api/imports/suppliers/commit", json={"rows": rows}).json()
    assert r["created"] == 1 and r["skipped"] == 2 and r["failed"] == 0

    # on_duplicate="error" turns the same duplicates into failures.
    r2 = c.post("/api/imports/suppliers/commit",
                json={"rows": [{"name": "DupCo"}], "on_duplicate": "error"}).json()
    assert r2["failed"] == 1 and r2["created"] == 0


def test_validate_marks_duplicates(make_client):
    c = make_client("superadmin")
    c.post("/api/suppliers/", json={"name": "Existing LLC"})
    r = c.post("/api/imports/suppliers/validate", json={"rows": [
        {"name": "Existing LLC"},
        {"name": "Brand New LLC"},
    ]}).json()
    assert r["duplicates"] == 1 and r["ok"] == 1


# ── Commit: inventory exercises the real create side effects ────────────────────
def test_commit_inventory_creates_item_with_opening_stock(make_client):
    c = make_client("superadmin")
    r = c.post("/api/imports/inventory/commit", json={"rows": [
        {"name": "Widget", "quantity": "10", "unit_cost": "2.5", "sale_price": "5"},
        {"name": "BadType", "product_type": "not_a_type"},   # rejected by create_item
    ]}).json()
    assert r["created"] == 1 and r["failed"] == 1
    items = {i["name"]: i for i in c.get("/api/inventory/").json()}
    assert "Widget" in items
    assert float(items["Widget"]["quantity"]) == 10        # opening stock applied
    # The failed row must not have leaked a half-created item.
    assert "BadType" not in items


# ── Permissions ────────────────────────────────────────────────────────────────
def test_viewer_cannot_import(make_client):
    c = make_client("Viewer")
    for verb_path in ("/api/imports/clients/validate", "/api/imports/clients/commit"):
        r = c.post(verb_path, json={"rows": [{"name": "X"}]})
        assert r.status_code == 403, f"{verb_path}: {r.status_code}"
