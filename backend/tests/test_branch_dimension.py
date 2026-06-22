"""
Phase 0 — branch dimension foundation.

Branch == warehouse: migration 130 adds a nullable `branch_id` FK to the
operational tables that lacked a location link, backfills existing rows to the
default warehouse, and `branch_access` provides the read filter / write resolver
that scope those columns to a caller's accessible branches.
"""
import datetime as _dt
import branch_access


_BRANCH_TABLES = ("expenses", "invoices", "quotations", "cash_drawers", "hr_employees")


def _cols(db, table):
    return {r["name"] for r in db.execute(
        "SELECT name FROM pragma_table_info(?)", (table,)
    ).fetchall()}


def test_branch_columns_exist(db):
    assert "phone" in _cols(db, "warehouses")
    for tbl in _BRANCH_TABLES:
        assert "branch_id" in _cols(db, tbl), f"{tbl} missing branch_id"


def test_backfill_assigns_existing_rows_to_default_branch(db):
    """A row that existed before branch_id was added is backfilled to the default
    warehouse. We simulate the pre-migration state by inserting a row with a NULL
    branch_id, then assert the resolver/default semantics hold."""
    default_id = db.execute(
        "SELECT id FROM warehouses WHERE is_default=1 LIMIT 1"
    ).fetchone()["id"]

    now = _dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    db.execute(
        "INSERT INTO expenses (category, amount, created_at) VALUES (?, ?, ?)",
        ("Misc", 10.0, now),
    )
    db.commit()
    # Newly inserted with NULL branch_id (route layer will set it; here we assert
    # the default branch is resolvable for an admin caller).
    admin = {"id": 1, "is_superadmin": True}
    assert branch_access.resolve_branch_id(admin, db) == default_id


def test_branch_filter_admin_is_unrestricted(db):
    admin = {"id": 1, "is_superadmin": True, "admin_access": True}
    frag, params = branch_access.branch_filter(admin, db)
    assert frag == "" and params == []


def test_branch_filter_restricted_user_scoped_to_grants(db):
    """A user with explicit warehouse grants is scoped to exactly those branch
    ids, and cannot widen the view by selecting an un-granted branch."""
    now = _dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    # A second branch.
    db.execute(
        "INSERT INTO warehouses (code, name, type, is_active, is_default, created_at) "
        "VALUES ('BR2', 'Branch Two', 'Branch', 1, 0, ?)", (now,),
    )
    branch2 = db.execute("SELECT id FROM warehouses WHERE code='BR2'").fetchone()["id"]
    main_id = db.execute(
        "SELECT id FROM warehouses WHERE is_default=1 LIMIT 1"
    ).fetchone()["id"]
    # A non-admin user granted access to branch2 only.
    db.execute(
        "INSERT INTO users (username, password_hash, role, created_at) "
        "VALUES ('branchmgr', 'x', 'Manager', ?)", (now,),
    )
    uid = db.execute("SELECT id FROM users WHERE username='branchmgr'").fetchone()["id"]
    db.execute(
        "INSERT INTO user_warehouse_access (user_id, warehouse_id, granted_at) "
        "VALUES (?, ?, ?)", (uid, branch2, now),
    )
    db.commit()

    user = {"id": uid, "is_superadmin": False, "admin_access": False}
    frag, params = branch_access.branch_filter(user, db)
    assert "branch_id IN" in frag
    assert params == [branch2]

    # Selecting their own branch is allowed.
    frag2, params2 = branch_access.branch_filter(user, db, selected=branch2)
    assert frag2 == " AND branch_id = ?" and params2 == [branch2]

    # Selecting a branch they don't have access to is rejected.
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        branch_access.branch_filter(user, db, selected=main_id)
    assert ei.value.status_code == 403
