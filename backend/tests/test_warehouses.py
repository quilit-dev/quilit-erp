"""
Multi-warehouse foundation tests — Phase 1.

Verifies the invariants the rest of the ERP will rely on:

  * Migration is idempotent and seeds a default 'MAIN' warehouse.
  * `inventory.quantity` stays in sync with the sum of `inventory_stock`
    quantities — every legacy SELECT keeps working.
  * Row-level access: zero grants = access to all; first grant restricts.
  * Transfer workflow Draft → In Transit → Completed moves stock between
    warehouses without ever changing the company-wide total.
  * Transfer-in-transit cancellation re-credits the source.
  * Completed transfers cannot be cancelled (immutable audit trail).
  * No journal entries posted during any transfer step (accounting unchanged).
"""
import uuid
import pytest


def _wid(c, code):
    """Look up a warehouse id by code via the API."""
    rows = c.get("/api/warehouses/").json()
    for r in rows:
        if r["code"] == code:
            return r["id"]
    raise AssertionError(f"Warehouse {code!r} not found in API response")


# ── Migration / backfill ─────────────────────────────────────────────────

def test_default_warehouse_seeded(make_client, db):
    c = make_client("superadmin")
    rows = c.get("/api/warehouses/").json()
    assert any(r["code"] == "MAIN" and r["is_default"] == 1 for r in rows), rows
    # All existing inventory backfilled into MAIN
    main_id = _wid(c, "MAIN")
    inv_total = db.execute("SELECT COUNT(*) FROM inventory").fetchone()[0]
    stock_total = db.execute(
        "SELECT COUNT(*) FROM inventory_stock WHERE warehouse_id=?", (main_id,)
    ).fetchone()[0]
    assert inv_total == stock_total
    # Per-item sums match the company-wide quantity
    bad = db.execute(
        """SELECT i.id, i.quantity AS company, COALESCE(SUM(s.quantity),0) AS sum
           FROM inventory i LEFT JOIN inventory_stock s ON s.inventory_id = i.id
           GROUP BY i.id HAVING ABS(i.quantity - COALESCE(SUM(s.quantity),0)) > 0.0001 LIMIT 1"""
    ).fetchone()
    assert bad is None, f"Mismatched item: {dict(bad)}"


# ── CRUD ─────────────────────────────────────────────────────────────────

def test_create_warehouse_with_type(make_client):
    c = make_client("superadmin")
    r = c.post("/api/warehouses/", json={
        "code": "BRANCH-A", "name": "Branch A", "type": "Branch",
        "address": "Beirut", "is_active": True,
    })
    assert r.status_code == 200, r.text
    wid = r.json()["id"]
    detail = c.get(f"/api/warehouses/{wid}").json()
    assert detail["type"] == "Branch"
    assert detail["is_default"] == 0


def test_invalid_warehouse_type_rejected(make_client):
    c = make_client("superadmin")
    r = c.post("/api/warehouses/", json={
        "code": "BAD", "name": "Bad", "type": "NotAType",
    })
    assert r.status_code == 400


def test_only_one_default_at_a_time(make_client):
    c = make_client("superadmin")
    r = c.post("/api/warehouses/", json={"code": "B2", "name": "B2", "type": "Branch"})
    wid = r.json()["id"]
    r = c.post(f"/api/warehouses/{wid}/set-default")
    assert r.status_code == 200, r.text
    rows = c.get("/api/warehouses/").json()
    defaults = [w for w in rows if w["is_default"] == 1]
    assert len(defaults) == 1 and defaults[0]["id"] == wid


# ── Row-level access ─────────────────────────────────────────────────────

def test_zero_grants_means_access_to_all(make_client):
    """No rows in user_warehouse_access ⇒ user sees every active warehouse."""
    admin = make_client("superadmin")
    admin.post("/api/warehouses/", json={"code": "R1", "name": "Restricted 1", "type": "Branch"})
    cashier = make_client("Inventory")
    rows = cashier.get("/api/warehouses/").json()
    codes = {r["code"] for r in rows}
    assert "MAIN" in codes and "R1" in codes, codes


def test_explicit_grant_restricts_visibility(make_client, db):
    admin = make_client("superadmin")
    r = admin.post("/api/warehouses/", json={"code": "R2", "name": "R2", "type": "Branch"})
    r2_id = r.json()["id"]
    # Resolve the Cashier user id
    cashier_id = db.execute(
        "SELECT id FROM users WHERE username='u_inventory'"
    ).fetchone()[0]
    # Grant Cashier access only to R2 — that automatically excludes MAIN.
    g = admin.post(f"/api/warehouses/{r2_id}/access", json={"user_id": cashier_id})
    assert g.status_code == 200, g.text
    cashier = make_client("Inventory")
    rows = cashier.get("/api/warehouses/").json()
    codes = {r["code"] for r in rows}
    assert codes == {"R2"}, f"Expected only R2, got {codes}"
    # Revoke restores 'access to all'
    admin.delete(f"/api/warehouses/{r2_id}/access/{cashier_id}")
    cashier2 = make_client("Inventory")
    codes2 = {r["code"] for r in cashier2.get("/api/warehouses/").json()}
    assert "MAIN" in codes2 and "R2" in codes2


# ── Stock transfer workflow ──────────────────────────────────────────────

def _seed_item(c, db, qty=100):
    """Create one inventory item with `qty` units sitting in MAIN."""
    item = c.post("/api/inventory/", json={
        "name": f"WHTest-{uuid.uuid4().hex[:6]}", "category": "Test",
        "quantity": qty, "min_stock": 0, "unit_cost": 5,
    })
    assert item.status_code in (200, 201), item.text
    return item.json()["id"]


def _je_count(db):
    return db.execute("SELECT COUNT(*) FROM journal_entries").fetchone()[0]


def test_branch_manager_transfers_only_into_own_branch_from_central(make_client, db):
    """A Branch Manager may only REPLENISH their own branch: destination = their
    home branch, source = a non-branch (central) warehouse. They cannot move
    stock out of, or between, branches — and still cannot create a warehouse."""
    from helpers.seeding import TEST_PASSWORD
    from auth_utils import hash_password

    admin = make_client("superadmin")
    main_id = _wid(admin, "MAIN")
    my_branch = admin.post("/api/warehouses/",
                           json={"code": "BR-MINE", "name": "My Branch", "type": "Branch"}).json()["id"]
    other_branch = admin.post("/api/warehouses/",
                              json={"code": "BR-OTHER", "name": "Other Branch", "type": "Branch"}).json()["id"]
    item_id = _seed_item(admin, db, qty=50)   # stock sits in MAIN (central)

    # A Branch Manager whose home branch is BR-MINE.
    role_id = db.execute("SELECT id FROM roles WHERE name='Branch Manager'").fetchone()["id"]
    db.execute(
        "INSERT INTO users (username, password_hash, full_name, role, role_id, "
        " is_active, is_superadmin, must_change_password, branch_id, created_at) "
        "VALUES (?,?,?,?,?,1,0,0,?,datetime('now'))",
        ("u_bm_tr", hash_password(TEST_PASSWORD), "BM", "Branch Manager", role_id, my_branch),
    )
    db.commit()
    bm = make_client()
    assert bm.post("/api/auth/login",
                   json={"username": "u_bm_tr", "password": TEST_PASSWORD}).status_code == 200

    # ALLOWED: pull from the central warehouse INTO their own branch.
    r = bm.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": my_branch,
        "items": [{"inventory_id": item_id, "quantity": 10}],
    })
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    assert bm.post(f"/api/warehouses/transfers/{tid}/dispatch").status_code == 200
    assert bm.post(f"/api/warehouses/transfers/{tid}/receive", json={}).status_code == 200

    # BLOCKED: destination is not their branch (central → another branch).
    assert bm.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": other_branch,
        "items": [{"inventory_id": item_id, "quantity": 1}],
    }).status_code == 403

    # BLOCKED: source is another branch (branch → my branch).
    assert bm.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": other_branch, "to_warehouse_id": my_branch,
        "items": [{"inventory_id": item_id, "quantity": 1}],
    }).status_code == 403

    # BLOCKED: still cannot create a branch/warehouse — owner-only.
    assert bm.post("/api/warehouses/",
                   json={"code": "NOPE", "name": "Nope", "type": "Branch"}).status_code == 403


def test_transfer_full_workflow_moves_stock_no_gl(make_client, db):
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    # Create a destination
    dst = c.post("/api/warehouses/", json={"code": "BRANCH-X", "name": "Branch X", "type": "Branch"})
    dst_id = dst.json()["id"]
    item_id = _seed_item(c, db, qty=100)

    before_je = _je_count(db)

    # Draft
    r = c.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": dst_id,
        "items": [{"inventory_id": item_id, "quantity": 30}],
    })
    assert r.status_code == 200, r.text
    tid = r.json()["id"]

    # Dispatch — stock leaves MAIN immediately
    r = c.post(f"/api/warehouses/transfers/{tid}/dispatch")
    assert r.status_code == 200, r.text
    main_qty = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, main_id),
    ).fetchone()[0]
    assert main_qty == 70, main_qty
    # Company-wide total still 100 — the units are in transit, not gone.
    company = db.execute(
        "SELECT quantity FROM inventory WHERE id=?", (item_id,)
    ).fetchone()[0]
    assert company == 70, ("Company qty drops on dispatch by design — receipt "
                           "credits the destination. Got {}".format(company))

    # Receive — stock lands at destination
    r = c.post(f"/api/warehouses/transfers/{tid}/receive", json={})
    assert r.status_code == 200, r.text
    dst_qty = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, dst_id),
    ).fetchone()[0]
    assert dst_qty == 30, dst_qty
    company = db.execute(
        "SELECT quantity FROM inventory WHERE id=?", (item_id,)
    ).fetchone()[0]
    assert company == 100, "Company total restored after receipt"

    # No journal entries posted for the transfer (accounting unchanged).
    assert _je_count(db) == before_je, (
        "Transfers must NOT post to the GL — one Inventory account, no movement"
    )


def test_transfer_cannot_overdraw_source(make_client, db):
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    dst = c.post("/api/warehouses/", json={"code": "BRANCH-OD", "name": "OD", "type": "Branch"})
    dst_id = dst.json()["id"]
    item_id = _seed_item(c, db, qty=5)
    r = c.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": dst_id,
        "items": [{"inventory_id": item_id, "quantity": 50}],
    })
    tid = r.json()["id"]
    r = c.post(f"/api/warehouses/transfers/{tid}/dispatch")
    assert r.status_code == 400, "Cannot dispatch more than the source holds"


def test_transfer_in_transit_can_be_cancelled(make_client, db):
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    dst = c.post("/api/warehouses/", json={"code": "BRANCH-C", "name": "C", "type": "Branch"})
    dst_id = dst.json()["id"]
    item_id = _seed_item(c, db, qty=20)
    r = c.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": dst_id,
        "items": [{"inventory_id": item_id, "quantity": 5}],
    })
    tid = r.json()["id"]
    c.post(f"/api/warehouses/transfers/{tid}/dispatch")
    r = c.post(f"/api/warehouses/transfers/{tid}/cancel", json={"reason": "Truck broke down"})
    assert r.status_code == 200, r.text
    # Source re-credited
    main_qty = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, main_id),
    ).fetchone()[0]
    assert main_qty == 20


def test_completed_transfer_cannot_be_cancelled(make_client, db):
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    dst = c.post("/api/warehouses/", json={"code": "BRANCH-D", "name": "D", "type": "Branch"})
    dst_id = dst.json()["id"]
    item_id = _seed_item(c, db, qty=10)
    r = c.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": dst_id,
        "items": [{"inventory_id": item_id, "quantity": 3}],
    })
    tid = r.json()["id"]
    c.post(f"/api/warehouses/transfers/{tid}/dispatch")
    c.post(f"/api/warehouses/transfers/{tid}/receive", json={})
    r = c.post(f"/api/warehouses/transfers/{tid}/cancel")
    assert r.status_code == 400


# ── User default warehouse ──────────────────────────────────────────────

# ── Phase 2 — operational integration ───────────────────────────────────

def test_purchase_with_warehouse_lands_at_chosen_warehouse(make_client, db):
    """A PO created with warehouse_id=BRANCH and moved to Received must land
    the inventory at BRANCH, not at MAIN. Verifies the operational wiring of
    the warehouse_id column added in Phase 1."""
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    branch = c.post("/api/warehouses/", json={"code": "BRANCH-RX", "name": "RX", "type": "Branch"})
    branch_id = branch.json()["id"]
    item_id = _seed_item(c, db, qty=0)

    po = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item_id, "product_name": "WHTest",
        "quantity": 12, "unit_cost": 10, "warehouse_id": branch_id,
    })
    assert po.status_code in (200, 201), po.text
    po_id = po.json()["id"]
    r = c.patch(f"/api/purchases/{po_id}/status", json={"status": "Received"})
    assert r.status_code == 200, r.text

    main_qty   = db.execute(
        "SELECT COALESCE(quantity,0) FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, main_id),
    ).fetchone()
    branch_qty = db.execute(
        "SELECT COALESCE(quantity,0) FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, branch_id),
    ).fetchone()
    assert (main_qty[0] if main_qty else 0) == 0,   "Receipt must NOT land at MAIN"
    assert (branch_qty[0] if branch_qty else 0) == 12, "Receipt must land at BRANCH-RX"
    company = db.execute("SELECT quantity FROM inventory WHERE id=?", (item_id,)).fetchone()[0]
    assert company == 12, "Company total must reflect the receipt"


def test_warehouse_breakdown_endpoint(make_client, db):
    """The /by-warehouse endpoint returns one row per active warehouse with
    each holding's quantity — the feed for the inventory detail page."""
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    c.post("/api/warehouses/", json={"code": "BRX-1", "name": "BRX 1", "type": "Branch"})
    item_id = _seed_item(c, db, qty=20)   # all in MAIN after backfill
    rows = c.get(f"/api/inventory/{item_id}/by-warehouse").json()
    assert len(rows) >= 2
    main_row = next(r for r in rows if r["warehouse_id"] == main_id)
    other    = next(r for r in rows if r["warehouse_id"] != main_id)
    assert main_row["quantity"] == 20
    assert other["quantity"] == 0


# ── Phase 3 — reports + search + dashboard ──────────────────────────────

def test_inventory_valuation_by_warehouse_report(make_client, db):
    """The new /api/reports/inventory-by-warehouse endpoint returns one row
    per active warehouse with sku_count / qty_total / value, plus totals."""
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    branch = c.post("/api/warehouses/", json={"code": "BRANCH-V", "name": "V", "type": "Branch"})
    branch_id = branch.json()["id"]
    item_id = _seed_item(c, db, qty=10)   # 10 @ $5 in MAIN

    # Transfer 4 units to BRANCH-V so the report has two locations to show
    tx = c.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": branch_id,
        "items": [{"inventory_id": item_id, "quantity": 4}],
    })
    tid = tx.json()["id"]
    c.post(f"/api/warehouses/transfers/{tid}/dispatch")
    c.post(f"/api/warehouses/transfers/{tid}/receive", json={})

    r = c.get("/api/reports/inventory-by-warehouse")
    assert r.status_code == 200, r.text
    body = r.json()
    by_id = {w["id"]: w for w in body["warehouses"]}
    assert by_id[main_id]["qty_total"] == 6,    f"MAIN qty wrong: {by_id[main_id]}"
    assert by_id[branch_id]["qty_total"] == 4,  f"BRANCH-V qty wrong: {by_id[branch_id]}"
    assert by_id[main_id]["value"] == 30.0,     "MAIN value 6 × $5"
    assert by_id[branch_id]["value"] == 20.0,   "BRANCH-V value 4 × $5"
    # Company total should match the GL Inventory account semantics
    assert body["totals"]["qty_total"] == 10
    assert body["totals"]["value"]     == 50.0
    # Top-SKU section should include our seeded item
    assert any(s["id"] == item_id for s in body["top_skus"])


def test_global_search_finds_warehouses_and_transfers(make_client, db):
    """Adding to search.py: warehouses + stock_transfers should appear in
    global results when the caller types matching codes/numbers."""
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    branch = c.post("/api/warehouses/", json={"code": "BRANCH-SX", "name": "Search Branch", "type": "Branch"})
    branch_id = branch.json()["id"]
    item_id = _seed_item(c, db, qty=5)
    # A transfer for the search to find by number
    tx = c.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": branch_id,
        "items": [{"inventory_id": item_id, "quantity": 1}],
    })
    transfer_number = tx.json()["transfer_number"]

    # Search for the warehouse code
    res = c.get("/api/search/?q=BRANCH-SX").json()
    types = {r["type"] for r in res["results"]}
    assert "warehouse" in types, f"Warehouse not in search results: {types}"
    # Search for the transfer number
    res2 = c.get(f"/api/search/?q={transfer_number[:10]}").json()
    assert any(r["type"] == "stock_transfer" for r in res2["results"]), (
        f"Transfer {transfer_number} not surfaced in search: {res2}"
    )


def test_dashboard_includes_warehouse_summary(make_client, db):
    """Dashboard payload exposes the new `warehouses` block with active count,
    in-transit count, and the location most needing restock."""
    c = make_client("superadmin")
    body = c.get("/api/dashboard/").json()
    assert "warehouses" in body
    summary = body["warehouses"]
    assert summary is not None, "Superadmin should see the warehouse summary"
    assert summary["active"] >= 1   # MAIN at minimum
    assert "in_transit" in summary
    assert "lowest_code" in summary
    assert body["permissions"]["warehouses"] is True


def test_deduct_to_project_is_warehouse_aware(make_client, db):
    """The 'Deduct material to project' endpoint must:
       1. Accept an optional warehouse_id
       2. Default to the user's default warehouse when omitted
       3. Validate the per-warehouse balance (not just the company total)
       4. Keep `inventory.quantity` (company) AND `inventory_stock` in sync
       5. Stamp `warehouse_id` on the resulting stock_movements row
    Fixing the last remaining warehouse-blind stock path discovered in audit."""
    c = make_client("superadmin")
    main_id = _wid(c, "MAIN")
    branch = c.post("/api/warehouses/", json={"code": "BRANCH-DTP", "name": "DTP", "type": "Branch"})
    branch_id = branch.json()["id"]

    # Seed 10 units in MAIN, transfer 3 to BRANCH-DTP
    item_id = _seed_item(c, db, qty=10)
    tx = c.post("/api/warehouses/transfers/", json={
        "from_warehouse_id": main_id, "to_warehouse_id": branch_id,
        "items": [{"inventory_id": item_id, "quantity": 3}],
    })
    tid = tx.json()["id"]
    c.post(f"/api/warehouses/transfers/{tid}/dispatch")
    c.post(f"/api/warehouses/transfers/{tid}/receive", json={})

    # Need a project to consume into
    cl = c.post("/api/clients/", json={"name": "DTP Client"})
    cid = cl.json()["id"]
    p = c.post("/api/projects/", json={"name": "DTP Project", "client_id": cid})
    pid = p.json()["id"]

    # Try to draw 5 from BRANCH-DTP — it only holds 3, must fail
    r = c.post(f"/api/inventory/{item_id}/deduct-to-project", json={
        "project_id": pid, "quantity": 5, "warehouse_id": branch_id,
    })
    assert r.status_code == 400, f"Should reject overdraw at BRANCH-DTP, got {r.status_code}"
    assert "Insufficient stock at this warehouse" in r.text

    # Draw 2 from BRANCH-DTP — should succeed; per-warehouse balance & company
    # total both drop by 2, and the movement is stamped with BRANCH-DTP's id.
    r = c.post(f"/api/inventory/{item_id}/deduct-to-project", json={
        "project_id": pid, "quantity": 2, "warehouse_id": branch_id,
    })
    assert r.status_code == 200, r.text

    main_qty = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, main_id),
    ).fetchone()[0]
    branch_qty = db.execute(
        "SELECT quantity FROM inventory_stock WHERE inventory_id=? AND warehouse_id=?",
        (item_id, branch_id),
    ).fetchone()[0]
    company = db.execute("SELECT quantity FROM inventory WHERE id=?", (item_id,)).fetchone()[0]
    assert main_qty == 7,    "MAIN unchanged (didn't touch it)"
    assert branch_qty == 1,  "BRANCH-DTP went 3 → 1"
    assert company == 8,     "Company total went 10 → 8"
    # The most recent movement carries the right warehouse_id
    mv = db.execute(
        "SELECT type, delta, warehouse_id FROM stock_movements "
        "WHERE inventory_id=? ORDER BY id DESC LIMIT 1", (item_id,),
    ).fetchone()
    assert mv["type"] == "project_use"
    assert mv["delta"] == -2
    assert mv["warehouse_id"] == branch_id


def test_my_accessible_warehouses_returns_default(make_client):
    """The /me/accessible endpoint is what the frontend uses to populate
    warehouse selectors and resolve the right pre-selection."""
    c = make_client("superadmin")
    body = c.get("/api/warehouses/me/accessible").json()
    assert "warehouses" in body and "default_id" in body
    assert body["default_id"] is not None, body
    codes = {w["code"] for w in body["warehouses"]}
    assert "MAIN" in codes


def test_warehouse_archive_unarchive_roundtrip(make_client):
    """A non-default, empty warehouse can be archived (hidden from the active
    list) and then restored back to active."""
    c = make_client("superadmin")
    wid = c.post("/api/warehouses/", json={"code": "ARCH1", "name": "Archive Me", "type": "Branch"}).json()["id"]

    assert c.patch(f"/api/warehouses/{wid}/archive").status_code == 200
    assert "ARCH1" not in {w["code"] for w in c.get("/api/warehouses/").json()}     # hidden
    arch = c.get("/api/warehouses/", params={"include_archived": True}).json()
    assert next(w for w in arch if w["code"] == "ARCH1")["archived_at"] is not None  # shows when asked

    assert c.patch(f"/api/warehouses/{wid}/unarchive").status_code == 200
    back = next(w for w in c.get("/api/warehouses/").json() if w["code"] == "ARCH1")  # active again
    assert back["archived_at"] is None
    assert back["is_active"] in (1, True)

    # Restoring something that isn't archived is a 400, not a silent no-op.
    assert c.patch(f"/api/warehouses/{wid}/unarchive").status_code == 400


# ── Per-warehouse stock breakdown (the "View stock" modal) ────────────────

def test_warehouse_stock_breakdown(make_client, db):
    """GET /{wid}/stock returns the items held at the warehouse with a
    rounded valuation. Regression: the old query used ROUND(expr, 2) in SQL,
    which SQLite accepts but PostgreSQL rejects (no round(double precision,
    int) overload) — the endpoint 500'd on the PG deployment. Value is now
    rounded in Python, so this asserts the rounding contract itself."""
    c = make_client("superadmin")
    item_id = _seed_item(c, db, qty=3)
    main_id = _wid(c, "MAIN")

    r = c.get(f"/api/warehouses/{main_id}/stock")
    assert r.status_code == 200, r.text
    rows = r.json()
    mine = next(x for x in rows if x["id"] == item_id)
    assert mine["quantity"] == 3
    assert mine["value"] == round(3 * 5, 2)  # qty × unit_cost, 2dp
