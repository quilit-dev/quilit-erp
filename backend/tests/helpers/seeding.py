"""
Deterministic test-data seeding.

`init_db()` already creates the 14 system roles and a single superadmin
('admin') with a random password. For tests we need a *known* password and
exactly one user per role, so this module:

  * resets the 'admin' password to TEST_PASSWORD
  * inserts one active user per RBAC role
  * inserts two deliberately broken accounts:
      - __norole__   : active but has no role assigned   (expect 403 everywhere)
      - __disabled__ : has a role but is_active = 0       (expect 401/403)
"""
from auth_utils import hash_password

TEST_PASSWORD = "Test1234!"

# role name (as seeded by database.init_db) -> canonical test username
ROLE_USERS = {
    "superadmin":          "admin",
    "Branch Manager":      "u_branch_mgr",
    "Manager":             "u_manager",
    "Finance Manager":     "u_finance_mgr",
    "Accountant":          "u_accountant",
    "Sales Manager":       "u_sales_mgr",
    "Sales":               "u_sales",
    "Project Manager":     "u_project_mgr",
    "Operations Manager":  "u_ops_mgr",
    "HR Manager":          "u_hr_mgr",
    "Procurement Officer": "u_procurement",
    "Inventory":           "u_inventory",
    "CRM Specialist":      "u_crm",
    "Auditor":             "u_auditor",
    "Viewer":              "u_viewer",
    "__norole__":          "u_norole",
    "__disabled__":        "u_disabled",
}

# real RBAC roles only (excludes superadmin + the two broken accounts)
RBAC_ROLES = [r for r in ROLE_USERS if not r.startswith("__") and r != "superadmin"]


def seed_test_users(conn):
    """Insert/normalise the canonical test accounts. `conn` is an open sqlite3 connection."""
    pw = hash_password(TEST_PASSWORD)

    # 'admin' already exists (superadmin) — just give it a known password
    conn.execute(
        "UPDATE users SET password_hash=?, must_change_password=0 WHERE username='admin'",
        (pw,),
    )

    roles = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM roles").fetchall()}

    for role_name, username in ROLE_USERS.items():
        if username == "admin":
            continue
        if role_name == "__norole__":
            role_id, is_active = None, 1
        elif role_name == "__disabled__":
            role_id, is_active = roles.get("Viewer"), 0
        else:
            role_id, is_active = roles.get(role_name), 1

        conn.execute(
            "INSERT INTO users "
            "(username, password_hash, full_name, role, role_id, is_active, "
            " is_superadmin, must_change_password, created_at) "
            "VALUES (?,?,?,?,?,?,0,0,datetime('now'))",
            (username, pw, username, role_name, role_id, is_active),
        )
