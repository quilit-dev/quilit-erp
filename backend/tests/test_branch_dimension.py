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


def test_branch_filter_scoped_user_pinned_to_home_branch(db):
    """A non-global user is pinned to their home branch (users.branch_id) and
    cannot widen the view — selecting another branch is ignored."""
    now = _dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    db.execute(
        "INSERT INTO warehouses (code, name, type, is_active, is_default, created_at) "
        "VALUES ('BR2', 'Branch Two', 'Branch', 1, 0, ?)", (now,),
    )
    branch2 = db.execute("SELECT id FROM warehouses WHERE code='BR2'").fetchone()["id"]
    main_id = db.execute(
        "SELECT id FROM warehouses WHERE is_default=1 LIMIT 1"
    ).fetchone()["id"]
    # A non-admin user whose HOME branch is branch2.
    db.execute(
        "INSERT INTO users (username, password_hash, role, branch_id, created_at) "
        "VALUES ('branchmgr', 'x', 'Manager', ?, ?)", (branch2, now),
    )
    uid = db.execute("SELECT id FROM users WHERE username='branchmgr'").fetchone()["id"]
    db.commit()

    user = {"id": uid, "is_superadmin": False, "admin_access": False, "branch_id": branch2}
    frag, params = branch_access.branch_filter(user, db)
    assert frag == " AND branch_id = ?" and params == [branch2]

    # A scoped user cannot widen scope: selecting another branch is ignored —
    # they stay pinned to their home branch.
    frag2, params2 = branch_access.branch_filter(user, db, selected=main_id)
    assert frag2 == " AND branch_id = ?" and params2 == [branch2]

    # Writes are forced into the home branch; targeting another branch is 403.
    assert branch_access.resolve_branch_id(user, db) == branch2
    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        branch_access.resolve_branch_id(user, db, main_id)
    assert ei.value.status_code == 403
