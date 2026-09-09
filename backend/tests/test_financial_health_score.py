"""Financial Health is one server-owned KPI, independent of client and role UI."""
import uuid

import pytest

import financial_health
from utils import _today

pytestmark = pytest.mark.critical


def test_canonical_policy_matches_the_established_dashboard_weights():
    assert financial_health.score(
        margin=21, unpaid_invoices=0, overdue_invoices=0,
        low_stock_alerts=0, active_projects=1,
        include_inventory=True, include_projects=True,
    ) == 100
    assert financial_health.score(
        margin=-1, unpaid_invoices=6, overdue_invoices=2,
        low_stock_alerts=1, active_projects=0,
        include_inventory=True, include_projects=True,
    ) == 15


def test_margin_rounding_matches_the_javascript_dashboard():
    assert financial_health.margin_percent(200, 159) == 21
    assert financial_health.margin_percent(200, 161) == 20
    assert financial_health.margin_percent(0, 10) == 0


def test_dashboard_score_does_not_change_with_ui_permissions(make_client, db):
    owner = make_client("superadmin")
    accountant = make_client("Accountant")

    # Existing installations can customise role permissions. Reproduce the
    # exact failure mode: two finance users share the same business scope, but
    # only one can open Inventory. That UI difference must not alter the KPI.
    db.execute(
        "UPDATE role_permissions SET can_view=0 "
        "WHERE role_id=(SELECT id FROM roles WHERE name='Accountant') "
        "AND module='inventory'"
    )
    db.commit()

    owner_data = owner.get("/api/dashboard/").json()
    accountant_data = accountant.get("/api/dashboard/").json()

    assert owner_data["permissions"]["inventory"] is True
    assert accountant_data["permissions"]["inventory"] is False
    assert owner_data["financial_health_score"] == accountant_data["financial_health_score"]


def test_range_summary_returns_the_same_authoritative_policy(make_client):
    owner = make_client("superadmin")
    accountant = make_client("Accountant")
    params = {"start": "2000-01-01", "end": "2100-12-31"}

    owner_score = owner.get("/api/finance/range-summary", params=params).json()["financial_health_score"]
    accountant_score = accountant.get("/api/finance/range-summary", params=params).json()["financial_health_score"]

    assert owner_score == accountant_score


def test_finance_views_and_dashboard_share_the_selected_branch(make_client, db):
    """Every client gets the same scoped source figures and canonical score."""
    owner = make_client("superadmin")
    main_id = db.execute(
        "SELECT id FROM warehouses WHERE is_default=1"
    ).fetchone()["id"]
    other = owner.post("/api/warehouses/", json={
        "code": "FH-BR2", "name": "Financial Health Branch", "type": "Branch",
    })
    assert other.status_code in (200, 201), other.text
    other_id = other.json()["id"]
    client_id = owner.post("/api/clients/", json={"name": "Health Scope Client"}).json()["id"]

    def add_money(branch_id, income, expenses):
        invoice = owner.post("/api/invoices/", json={
            "client_id": client_id,
            "branch_id": branch_id,
            "items": [{"name": f"Branch {branch_id}", "quantity": 1,
                       "unit_price": income}],
        })
        assert invoice.status_code == 200, invoice.text
        paid = owner.post(
            f"/api/invoices/{invoice.json()['id']}/payments",
            json={"amount": income, "method": "Cash",
                  "idempotency_key": str(uuid.uuid4())},
        )
        assert paid.status_code == 200, paid.text
        spent = owner.post("/api/finance/expenses", json={
            "branch_id": branch_id,
            "category": "Other",
            "description": f"Branch {branch_id} expense",
            "amount": expenses,
            "date": _today(),
        })
        assert spent.status_code == 200, spent.text

    add_money(main_id, 101, 11)
    add_money(other_id, 303, 33)
    day = _today()
    month = day[:7]

    # Voided costs are absent from every finance total. This previously held
    # for the KPI but not the range chart.
    voided = owner.post("/api/finance/expenses", json={
        "branch_id": main_id,
        "category": "Other",
        "description": "Voided chart regression",
        "amount": 999,
        "date": day,
    })
    assert voided.status_code == 200, voided.text
    voided_response = owner.patch(
        f"/api/finance/expenses/{voided.json()['id']}/void",
        json={"reason": "Regression fixture"},
    )
    assert voided_response.status_code == 200, voided_response.text

    # Locked-period snapshots contain company totals. A selected branch must
    # keep its own immutable source figures instead of receiving this overlay.
    year, month_number = map(int, month.split("-"))
    db.execute(
        "INSERT INTO accounting_periods (year, month, locked_at, locked_by) "
        "VALUES (?, ?, datetime('now'), 'test')",
        (year, month_number),
    )
    db.execute(
        "INSERT INTO period_snapshots "
        "(year, month, income, expenses, profit, payment_count, expense_count, "
        " locked_at, locked_by) VALUES (?, ?, 404, 44, 360, 2, 2, datetime('now'), 'test')",
        (year, month_number),
    )
    db.commit()

    for branch_id, income, expenses in (
        (main_id, 101.0, 11.0),
        (other_id, 303.0, 33.0),
    ):
        selected = {"branch_id": branch_id}
        summary = owner.get(
            "/api/finance/summary", params={"month": month, **selected}
        ).json()
        ranged = owner.get(
            "/api/finance/range-summary",
            params={"start": day, "end": day, **selected},
        ).json()
        monthly = owner.get("/api/finance/monthly", params=selected).json()
        range_monthly = owner.get(
            "/api/finance/range-monthly",
            params={"start": day, "end": day, **selected},
        ).json()
        detail = owner.get(
            "/api/finance/range-detail",
            params={"start": day, "end": day, **selected},
        ).json()
        dashboard = owner.get("/api/dashboard/", params=selected).json()

        assert (summary["income"], summary["expenses"]) == (income, expenses)
        assert (ranged["income"], ranged["expenses"]) == (income, expenses)
        assert [(r["income"], r["expenses"]) for r in monthly if r["month"] == month] == [
            (income, expenses)
        ]
        assert [(r["income"], r["expenses"]) for r in range_monthly] == [
            (income, expenses)
        ]
        assert [r["amount"] for r in detail["income_records"]] == [income]
        assert [r["amount"] for r in detail["expense_records"]] == [expenses]
        assert (dashboard["monthly_income"], dashboard["monthly_expenses"]) == (
            income, expenses,
        )
        assert dashboard["financial_health_score"] == ranged["financial_health_score"]
