"""
Branch hierarchy — visibility isolation enforced through the API.

Branch == warehouse. Each user has a single HOME branch (users.branch_id). A
non-admin user sees only their home branch and is forced to write into it; the
Business Owner (admin-tier) and the vendor superadmin are global and may focus a
branch with ?branch_id=. A user with no branch assigned falls back to the default
branch, so upgrades never produce an empty screen.
"""
import pytest


def _make_branch(admin, code="BR2", name="Branch Two"):
    r = admin.post("/api/warehouses/", json={"code": code, "name": name, "type": "Branch"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _main_branch_id(admin):
    rows = admin.get("/api/warehouses/").json()
    return next(w["id"] for w in rows if w["is_default"])


def _assign_branch(username, wid, db):
    """Set a user's HOME branch — the visibility boundary in the new model."""
    db.execute("UPDATE users SET branch_id=? WHERE username=?", (wid, username))
    db.commit()
    return db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()["id"]


def test_expense_branch_isolation(make_client, db):
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)

    # Admin records one expense in each branch.
    assert admin.post("/api/finance/expenses",
                      json={"category": "Materials", "amount": 100,
                            "branch_id": main_id}).status_code == 200
    assert admin.post("/api/finance/expenses",
                      json={"category": "Materials", "amount": 200,
                            "branch_id": br2}).status_code == 200

    # Admin sees both; admin focused on br2 sees only the br2 one.
    assert len(admin.get("/api/finance/expenses").json()) == 2
    focus = admin.get(f"/api/finance/expenses?branch_id={br2}").json()
    assert len(focus) == 1 and float(focus[0]["amount"]) == 200

    # A finance manager whose home branch is br2.
    fm = make_client("Finance Manager")
    _assign_branch("u_finance_mgr", br2, db)

    # Sees only br2's expense.
    visible = fm.get("/api/finance/expenses").json()
    assert len(visible) == 1 and float(visible[0]["amount"]) == 200

    # Creating without a branch is forced into their home branch (br2).
    r = fm.post("/api/finance/expenses", json={"category": "Transport", "amount": 50})
    assert r.status_code == 200, r.text
    after = fm.get("/api/finance/expenses").json()
    assert len(after) == 2  # the 200 + the new 50

    # Cannot create into another branch.
    blocked = fm.post("/api/finance/expenses",
                      json={"category": "Transport", "amount": 5, "branch_id": main_id})
    assert blocked.status_code == 403


def test_unassigned_user_defaults_to_default_branch(make_client, db):
    """A non-admin user with no home branch assigned falls back to the default
    branch — never 'nothing' — so single-branch installs are unaffected."""
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 100, "branch_id": main_id})
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 200, "branch_id": br2})

    # Finance manager with NO branch assigned → defaults to the default branch,
    # so sees only the default branch's expense (not br2's, not all).
    fm = make_client("Finance Manager")
    visible = fm.get("/api/finance/expenses").json()
    assert len(visible) == 1 and float(visible[0]["amount"]) == 100


def test_business_owner_is_global(make_client, db):
    """The admin-tier Business Owner role sees every branch — even when pinned to
    a home branch — because admin-tier users are global."""
    from helpers.seeding import TEST_PASSWORD
    from auth_utils import hash_password

    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 100, "branch_id": main_id})
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 200, "branch_id": br2})

    # Create an admin-tier Business Owner user pinned to br2.
    owner_role = db.execute("SELECT id FROM roles WHERE name='Business Owner'").fetchone()["id"]
    db.execute(
        "INSERT INTO users (username, password_hash, full_name, role, role_id, "
        " is_active, is_superadmin, must_change_password, branch_id, created_at) "
        "VALUES (?,?,?,?,?,1,0,0,?,datetime('now'))",
        ("u_owner", hash_password(TEST_PASSWORD), "Owner", "Business Owner",
         owner_role, br2),
    )
    db.commit()

    owner = make_client()
    assert owner.post("/api/auth/login",
                      json={"username": "u_owner", "password": TEST_PASSWORD}).status_code == 200
    # Pinned to br2 but admin-tier → global → sees both branches' expenses.
    assert len(owner.get("/api/finance/expenses").json()) == 2


def test_recruitment_branch_isolation(make_client, db):
    """Applicants are branch-scoped: a branch HR manager sees only their branch's
    applicants and cannot register one into another branch."""
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)

    assert admin.post("/api/recruitment/applicants",
                      json={"full_name": "Alice", "branch_id": main_id}).status_code == 200
    assert admin.post("/api/recruitment/applicants",
                      json={"full_name": "Bob", "branch_id": br2}).status_code == 200
    assert len(admin.get("/api/recruitment/applicants").json()) == 2

    hr = make_client("HR Manager")
    _assign_branch("u_hr_mgr", br2, db)
    visible = hr.get("/api/recruitment/applicants").json()
    assert len(visible) == 1 and visible[0]["full_name"] == "Bob"

    # Cannot register an applicant into another branch.
    blocked = hr.post("/api/recruitment/applicants",
                      json={"full_name": "Mallory", "branch_id": main_id})
    assert blocked.status_code == 403


def test_branch_manager_is_scoped_with_full_access(make_client, db):
    """A Branch Manager runs one branch: full operational access, but scoped to
    their home branch (not global like the Business Owner)."""
    from helpers.seeding import TEST_PASSWORD
    from auth_utils import hash_password

    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 100, "branch_id": main_id})
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 200, "branch_id": br2})

    role_id = db.execute("SELECT id FROM roles WHERE name='Branch Manager'").fetchone()["id"]
    db.execute(
        "INSERT INTO users (username, password_hash, full_name, role, role_id, "
        " is_active, is_superadmin, must_change_password, branch_id, created_at) "
        "VALUES (?,?,?,?,?,1,0,0,?,datetime('now'))",
        ("u_branchmgr", hash_password(TEST_PASSWORD), "Branch Mgr", "Branch Manager",
         role_id, br2),
    )
    db.commit()

    bm = make_client()
    assert bm.post("/api/auth/login",
                   json={"username": "u_branchmgr", "password": TEST_PASSWORD}).status_code == 200

    # Scoped: sees only their branch's expense.
    visible = bm.get("/api/finance/expenses").json()
    assert len(visible) == 1 and float(visible[0]["amount"]) == 200

    # Full access: can create operational data, and it lands in their branch.
    r = bm.post("/api/finance/expenses", json={"category": "Transport", "amount": 30})
    assert r.status_code == 200, r.text
    assert len(bm.get("/api/finance/expenses").json()) == 2

    # Not global: cannot reach the other branch even by passing its id.
    assert bm.post("/api/finance/expenses",
                   json={"category": "X", "amount": 5, "branch_id": main_id}).status_code == 403


def test_dashboard_and_reports_scope_to_branch(make_client, db):
    """A branch-scoped user's dashboard + financial reports reflect only their
    home branch; an admin sees the company-wide totals."""
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 100, "branch_id": main_id})
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 200, "branch_id": br2})

    # Admin: company-wide expense report total = 300.
    rep_all = admin.get("/api/reports/financial").json()
    assert abs(rep_all["total_expenses"] - 300) < 0.001

    # Admin focused on br2: only 200.
    rep_focus = admin.get(f"/api/reports/financial?branch_id={br2}").json()
    assert abs(rep_focus["total_expenses"] - 200) < 0.001

    # Finance manager whose home branch is br2: report + dashboard reflect 200.
    fm = make_client("Finance Manager")
    _assign_branch("u_finance_mgr", br2, db)
    rep_fm = fm.get("/api/reports/financial").json()
    assert abs(rep_fm["total_expenses"] - 200) < 0.001
    dash_fm = fm.get("/api/dashboard/").json()
    assert abs((dash_fm.get("monthly_expenses") or 0) - 200) < 0.001


def test_accounting_statements_scope_to_branch(make_client, db):
    """The Accounting statements are branch-aware: a scoped accountant sees only
    their branch's P&L, and the trial balance / balance sheet still balance."""
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 100, "branch_id": main_id})
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 200, "branch_id": br2})

    rng = "start=2000-01-01&end=2100-01-01"
    pnl_all = admin.get(f"/api/accounting/income-statement?{rng}").json()
    assert abs(pnl_all["total_expense"] - 300) < 0.01
    pnl_b2 = admin.get(f"/api/accounting/income-statement?{rng}&branch_id={br2}").json()
    assert abs(pnl_b2["total_expense"] - 200) < 0.01

    # Scoped accountant whose home branch is br2.
    acc = make_client("Accountant")
    _assign_branch("u_accountant", br2, db)
    pnl = acc.get(f"/api/accounting/income-statement?{rng}").json()
    assert abs(pnl["total_expense"] - 200) < 0.01
    # Per-branch statements still tie out.
    assert acc.get("/api/accounting/trial-balance").json()["balanced"] is True
    assert acc.get("/api/accounting/balance-sheet").json()["balanced"] is True


def test_branch_comparison_report(make_client, db):
    """Admin sees a per-branch comparison covering all branches; a scoped user
    sees only their home branch's row."""
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 100, "branch_id": main_id})
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 200, "branch_id": br2})

    comp = admin.get("/api/reports/branch-comparison").json()
    by_id = {r["id"]: r for r in comp["branches"]}
    assert by_id[main_id]["expenses"] == 100
    assert by_id[br2]["expenses"] == 200
    assert comp["totals"]["expenses"] == 300

    fm = make_client("Finance Manager")
    _assign_branch("u_finance_mgr", br2, db)
    comp_fm = fm.get("/api/reports/branch-comparison").json()
    ids = [r["id"] for r in comp_fm["branches"]]
    assert ids == [br2]
    assert comp_fm["totals"]["expenses"] == 200
