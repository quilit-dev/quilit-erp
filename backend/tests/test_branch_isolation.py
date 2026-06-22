"""
Phase 1 — branch isolation enforced through the API.

Branch == warehouse. A user granted access to only one branch (via the existing
user_warehouse_access list) sees only that branch's operational rows and cannot
create rows in another branch. Admins see everything and may focus one branch
with ?branch_id=. Existing zero-grant users keep full access (backward compat).
"""
import pytest


def _make_branch(admin, code="BR2", name="Branch Two"):
    r = admin.post("/api/warehouses/", json={"code": code, "name": name, "type": "Branch"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _main_branch_id(admin):
    rows = admin.get("/api/warehouses/").json()
    return next(w["id"] for w in rows if w["is_default"])


def _grant(admin, wid, username, db):
    uid = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()["id"]
    r = admin.post(f"/api/warehouses/{wid}/access", json={"user_id": uid})
    assert r.status_code == 200, r.text
    return uid


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

    # A finance manager granted access to br2 only.
    fm = make_client("Finance Manager")
    _grant(admin, br2, "u_finance_mgr", db)

    # Sees only br2's expense.
    visible = fm.get("/api/finance/expenses").json()
    assert len(visible) == 1 and float(visible[0]["amount"]) == 200

    # Creating without a branch lands in their accessible branch (br2).
    r = fm.post("/api/finance/expenses", json={"category": "Transport", "amount": 50})
    assert r.status_code == 200, r.text
    after = fm.get("/api/finance/expenses").json()
    assert len(after) == 2  # the 200 + the new 50

    # Cannot create into a branch they don't have access to.
    blocked = fm.post("/api/finance/expenses",
                      json={"category": "Transport", "amount": 5, "branch_id": main_id})
    assert blocked.status_code == 403


def test_zero_grant_user_sees_all_branches(make_client, db):
    """A user with no explicit warehouse grants keeps full visibility — the safe
    default that preserves single-branch behavior."""
    admin = make_client("superadmin")
    main_id = _main_branch_id(admin)
    br2 = _make_branch(admin)
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 100, "branch_id": main_id})
    admin.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 200, "branch_id": br2})

    # Finance manager with NO grants → sees both branches.
    fm = make_client("Finance Manager")
    assert len(fm.get("/api/finance/expenses").json()) == 2


def test_dashboard_and_reports_scope_to_branch(make_client, db):
    """A branch-restricted user's dashboard + financial reports reflect only
    their branch; an admin sees the company-wide totals."""
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

    # Finance manager granted br2 only: report + dashboard reflect only 200.
    fm = make_client("Finance Manager")
    _grant(admin, br2, "u_finance_mgr", db)
    rep_fm = fm.get("/api/reports/financial").json()
    assert abs(rep_fm["total_expenses"] - 200) < 0.001
    dash_fm = fm.get("/api/dashboard/").json()
    assert abs((dash_fm.get("monthly_expenses") or 0) - 200) < 0.001


def test_branch_comparison_report(make_client, db):
    """Admin sees a per-branch comparison covering all branches; a restricted
    user sees only their branch's row."""
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
    _grant(admin, br2, "u_finance_mgr", db)
    comp_fm = fm.get("/api/reports/branch-comparison").json()
    ids = [r["id"] for r in comp_fm["branches"]]
    assert ids == [br2]
    assert comp_fm["totals"]["expenses"] == 200
