"""
Comprehensive period / year locking — a locked month or closed year blocks
every dated-in-period financial change across the integrated modules.
"""
import uuid
from datetime import datetime
import pytest


def _client(c):
    return c.post("/api/clients/", json={"name": "Lock Co", "type": "Company"}).json()["id"]


def test_locked_month_blocks_backdated_expense(make_client):
    c = make_client("superadmin")
    now = datetime.utcnow()
    # Lock the current month.
    lk = c.post(f"/api/finance/periods/{now.year}/{now.month}/lock")
    assert lk.status_code in (200, 201), lk.text

    # A new expense dated in the locked month is rejected.
    blocked = c.post("/api/finance/expenses", json={"category": "Rent", "amount": 100})
    assert blocked.status_code == 400 and "locked" in blocked.text.lower()

    # Unlock → allowed again.
    assert c.post(f"/api/finance/periods/{now.year}/{now.month}/unlock").status_code in (200, 201)
    assert c.post("/api/finance/expenses", json={"category": "Rent", "amount": 100}).status_code in (200, 201)


def test_closed_year_blocks_invoice_void(make_client):
    c = make_client("superadmin")
    cid = _client(c)
    iv = c.post("/api/invoices/", json={
        "client_id": cid, "items": [{"name": "x", "quantity": 1, "unit_price": 100}]}).json()
    year = datetime.utcnow().year
    c.post(f"/api/accounting/fiscal-years/{year}/close")
    # Voiding an invoice that belongs to the closed year is rejected.
    v = c.patch(f"/api/invoices/{iv['id']}/void", json={"reason": "x"})
    assert v.status_code == 400 and "closed" in v.text.lower()


def test_closed_year_blocks_payroll_mark_paid(make_client):
    c = make_client("superadmin")
    dept = c.post("/api/hr/departments", json={"name": "Ops"}).json()["id"]
    c.post("/api/hr/employees", json={"full_name": "Worker", "department_id": dept,
                                      "employment_type": "Full-time", "salary": 1000})
    year = datetime.utcnow().year
    # A payroll run whose period ends in a (to-be) closed year.
    run = c.post("/api/hr/payroll/runs", json={
        "period_start": f"{year}-01-01", "period_end": f"{year}-01-31"}).json()
    c.post(f"/api/hr/payroll/runs/{run['id']}/approve")
    c.post(f"/api/accounting/fiscal-years/{year}/close")
    # Marking it paid would post an expense dated in the closed year → blocked.
    paid = c.post(f"/api/hr/payroll/runs/{run['id']}/mark-paid")
    assert paid.status_code == 400 and "closed" in paid.text.lower()
