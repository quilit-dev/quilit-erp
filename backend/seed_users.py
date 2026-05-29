"""
Per-role test-user injector.

Creates exactly one active login for every RBAC role in the live `erp.db`
so you can sign in and exercise each role's permissions end-to-end. Usernames
are derived from the role names in the database, so this always covers every
role — including any added later. Idempotent: re-running skips users that
already exist and never touches the real 'admin' superadmin.

All seeded users share one password (TEST_PASSWORD below) and have
must_change_password = 0, so you can log straight in.

Run from project root:
    python backend/seed_users.py
or with a specific DB path:
    DB_PATH=erp.db python backend/seed_users.py
"""
import os
import re
import sqlite3
import sys
from pathlib import Path

# Import hash_password the same way the app does (run from project root, the
# backend dir is on sys.path when launched normally; add it defensively here).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from auth_utils import hash_password

# Run from project root so we hit the real erp.db, not backend/erp.db.
DB_PATH = os.environ.get("DB_PATH") or str(Path(__file__).resolve().parent.parent / "erp.db")

# Shared password for every seeded role login. Meets typical complexity rules
# (upper, lower, digit, symbol) so it also passes any change-password flow.
TEST_PASSWORD = "Test1234!"


def _username_for(role_name: str) -> str:
    """'Finance Manager' -> 'u_finance_manager'. Stable, collision-free slug."""
    slug = re.sub(r"[^a-z0-9]+", "_", role_name.lower()).strip("_")
    return f"u_{slug}"


def seed():
    if not os.path.exists(DB_PATH):
        sys.exit(f"DB not found at {DB_PATH}. Run the ERP once to initialise it first.")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    user_cols = {r["name"] for r in cur.execute("PRAGMA table_info(users)").fetchall()}
    required = {"username", "password_hash", "full_name", "role", "role_id",
                "is_active", "is_superadmin", "must_change_password", "created_at"}
    missing = required - user_cols
    if missing:
        sys.exit(f"users table is missing columns: {missing}. "
                 f"Run database migrations first (start the ERP normally).")
    has_email = "email" in user_cols

    roles = cur.execute("SELECT id, name FROM roles ORDER BY id").fetchall()
    if not roles:
        sys.exit("No roles found. Start the ERP once so init_db seeds the system roles.")

    pw = hash_password(TEST_PASSWORD)
    created, skipped = [], []

    for role in roles:
        username = _username_for(role["name"])

        if cur.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            skipped.append((username, role["name"]))
            continue

        cols = ["username", "password_hash", "full_name", "role", "role_id",
                "is_active", "is_superadmin", "must_change_password", "created_at"]
        vals = [username, pw, role["name"], role["name"], role["id"], 1, 0, 0]
        if has_email:
            cols.insert(3, "email")
            vals.insert(3, f"{username}@example.com")

        placeholders = ", ".join(["?"] * len(vals)) + ", datetime('now')"
        cur.execute(
            f"INSERT INTO users ({', '.join(cols)}) VALUES ({placeholders})",
            vals,
        )
        created.append((username, role["name"]))

    conn.commit()

    name_w = max((len(u) for u, _ in created + skipped), default=8)
    print(f"\nRole test users in {DB_PATH}")
    print(f"  password for all: {TEST_PASSWORD}\n")
    if created:
        print(f"  created ({len(created)}):")
        for u, r in created:
            print(f"    {u.ljust(name_w)}  ->  {r}")
    if skipped:
        print(f"\n  skipped (already present, {len(skipped)}):")
        for u, r in skipped:
            print(f"    {u.ljust(name_w)}  ->  {r}")
    print("\n  (the 'admin' superadmin is left untouched)")
    conn.close()


if __name__ == "__main__":
    seed()
