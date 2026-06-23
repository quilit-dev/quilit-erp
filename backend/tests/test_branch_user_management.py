"""
Branch managers manage their OWN branch's staff — and only that.

A Branch Manager (non-global, holds the `users` permission) may list/create/edit
users in their home branch, but can never see or touch users in another branch,
cannot create owners/superadmins, and cannot assign an admin-tier role.
"""
from helpers.seeding import TEST_PASSWORD
from auth_utils import hash_password


def _make_branch(admin, code="BR2", name="Branch Two"):
    r = admin.post("/api/warehouses/", json={"code": code, "name": name, "type": "Branch"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _main_branch_id(admin):
    return next(w["id"] for w in admin.get("/api/warehouses/").json() if w["is_default"])


def _staff_role_id(db, name="Accountant"):
    return db.execute("SELECT id FROM roles WHERE name=?", (name,)).fetchone()["id"]


def _login_branch_mgr(make_client, db, branch_id, username="u_bm"):
    role_id = db.execute("SELECT id FROM roles WHERE name='Branch Manager'").fetchone()["id"]
    db.execute(
        "INSERT INTO users (username, password_hash, full_name, role, role_id, "
        " is_active, is_superadmin, must_change_password, branch_id, created_at) "
        "VALUES (?,?,?,?,?,1,0,0,?,datetime('now'))",
        (username, hash_password(TEST_PASSWORD), "BM", "Branch Manager", role_id, branch_id),
    )
    db.commit()
    c = make_client()
    assert c.post("/api/auth/login",
                  json={"username": username, "password": TEST_PASSWORD}).status_code == 200
    return c


def test_branch_manager_sees_only_own_branch_users(make_client, db):
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    acc = _staff_role_id(db)
    # A staff user in each branch.
    admin.post("/api/users/", json={"username": "main_staff", "password": "passw0rd1",
                                    "role_id": acc, "branch_id": main_id})
    admin.post("/api/users/", json={"username": "br2_staff", "password": "passw0rd1",
                                    "role_id": acc, "branch_id": br2})

    bm = _login_branch_mgr(make_client, db, br2)
    names = {u["username"] for u in bm.get("/api/users/").json()}
    assert "br2_staff" in names
    assert "main_staff" not in names      # other branch hidden
    assert "admin" not in names           # superadmin hidden
    assert all(u.get("username") != "main_staff" for u in bm.get("/api/users/").json())


def test_branch_manager_creates_into_own_branch_only(make_client, db):
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    acc = _staff_role_id(db)
    bm = _login_branch_mgr(make_client, db, br2)

    # Create a staff user — branch is forced to the manager's branch even if they
    # try to pass another branch id.
    r = bm.post("/api/users/", json={"username": "newhire", "password": "passw0rd1",
                                     "role_id": acc, "branch_id": main_id})
    assert r.status_code == 200, r.text
    uid = r.json()["id"]
    row = db.execute("SELECT branch_id FROM users WHERE id=?", (uid,)).fetchone()
    assert row["branch_id"] == br2          # forced into the manager's branch

    # Cannot assign an admin-tier role (Business Owner).
    bo = db.execute("SELECT id FROM roles WHERE name='Business Owner'").fetchone()["id"]
    blocked = bm.post("/api/users/", json={"username": "wannabe_owner", "password": "passw0rd1",
                                           "role_id": bo, "branch_id": br2})
    assert blocked.status_code == 403


def test_branch_manager_cannot_touch_other_branch_or_admins(make_client, db):
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    acc = _staff_role_id(db)
    other = admin.post("/api/users/", json={"username": "other_staff", "password": "passw0rd1",
                                            "role_id": acc, "branch_id": main_id}).json()["id"]
    bm = _login_branch_mgr(make_client, db, br2)

    # Cannot view or edit a user in another branch (hidden as 404).
    assert bm.get(f"/api/users/{other}").status_code == 404
    assert bm.put(f"/api/users/{other}", json={"full_name": "Hacked"}).status_code == 404
    assert bm.post(f"/api/users/{other}/reset-password",
                   json={"new_password": "passw0rd2"}).status_code == 404

    # Cannot delete users at all (no delete permission) — admin-only.
    assert bm.delete(f"/api/users/{other}").status_code == 403

    # Cannot reach the admin-only Roles/Settings surfaces.
    assert bm.post("/api/roles/", json={"name": "X"}).status_code == 403
