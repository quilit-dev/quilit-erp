"""
Financial-year closing — close a year (posts the year-end closing entry into
Retained Earnings + locks dated-in-year changes), and reopen it (reverses).
"""
import uuid
import pytest


def _client(c):
    cl = c.post("/api/clients/", json={"name": "FY Client", "type": "Company"})
    return cl.json()["id"]


def _paid_invoice(c, client_id, amount, date):
    """Create an invoice and fully pay it on `date` → posts DR Cash / CR Revenue."""
    iv = c.post("/api/invoices/", json={
        "client_id": client_id, "date": date,
        "items": [{"name": "Service", "quantity": 1, "unit_price": amount}],
    })
    assert iv.status_code in (200, 201), iv.text
    inv = c.get(f"/api/invoices/{iv.json()['id']}").json()
    pay = c.post(f"/api/invoices/{iv.json()['id']}/payments",
                 json={"amount": inv["amount"], "method": "Cash",
                       "idempotency_key": str(uuid.uuid4())})
    assert pay.status_code in (200, 201), pay.text
    return iv.json()["id"]


def _fy(c, year):
    return next(f for f in c.get("/api/accounting/fiscal-years").json() if f["year"] == year)


def test_close_year_posts_closing_entry_and_locks(make_client, db):
    c = make_client("superadmin")
    cid = _client(c)
    # Revenue recognised "this year" via a paid invoice (payment dated today).
    _paid_invoice(c, cid, 1000, None)
    # Expense this year.
    c.post("/api/finance/expenses", json={"category": "Rent", "amount": 300})

    from datetime import datetime
    year = datetime.utcnow().year

    # Year shows open with a live net result.
    fy = _fy(c, year)
    assert fy["status"] == "open"
    assert fy["net_income"] == pytest.approx(700)   # 1000 income − 300 expense

    # Close it.
    res = c.post(f"/api/accounting/fiscal-years/{year}/close")
    assert res.status_code in (200, 201), res.text
    assert res.json()["net_income"] == pytest.approx(700)
    assert res.json()["closing_entry_id"]

    # Now closed; the P&L still shows the real operating result (closing entry
    # is excluded from the income statement).
    fy = _fy(c, year)
    assert fy["status"] == "closed"
    inc = c.get(f"/api/accounting/income-statement?start={year}-01-01&end={year}-12-31").json()
    assert inc["net_income"] == pytest.approx(700)

    # Net income has moved into Retained Earnings on the balance sheet.
    tb = db.execute(
        "SELECT a.code, SUM(l.credit)-SUM(l.debit) AS bal FROM journal_entry_lines l "
        "JOIN chart_of_accounts a ON a.id=l.account_id WHERE a.code='3900' GROUP BY a.id"
    ).fetchone()
    assert tb and float(tb["bal"]) == pytest.approx(700)

    # Modifications dated in the closed year are blocked.
    blocked = c.post("/api/finance/expenses",
                     json={"category": "Rent", "amount": 50, "date": f"{year}-06-15"})
    assert blocked.status_code == 400
    assert "closed" in blocked.text.lower()


def test_cannot_close_twice(make_client):
    c = make_client("superadmin")
    _paid_invoice(c, _client(c), 500, None)
    from datetime import datetime
    year = datetime.utcnow().year
    assert c.post(f"/api/accounting/fiscal-years/{year}/close").status_code in (200, 201)
    again = c.post(f"/api/accounting/fiscal-years/{year}/close")
    assert again.status_code == 400
    assert "already closed" in again.text.lower()


def test_reopen_unlocks_and_reverses(make_client):
    c = make_client("superadmin")
    cid = _client(c)
    _paid_invoice(c, cid, 800, None)
    from datetime import datetime
    year = datetime.utcnow().year
    c.post(f"/api/accounting/fiscal-years/{year}/close")

    # Reopen → status open again, and a dated-in-year change is allowed.
    rop = c.post(f"/api/accounting/fiscal-years/{year}/reopen")
    assert rop.status_code in (200, 201), rop.text
    assert _fy(c, year)["status"] == "open"
    ok = c.post("/api/finance/expenses",
                json={"category": "Rent", "amount": 50, "date": f"{year}-06-15"})
    assert ok.status_code in (200, 201), ok.text

    # Retained Earnings is back to zero (closing entry reversed).
    re = c.get(f"/api/accounting/income-statement?start={year}-01-01&end={year}-12-31").json()
    assert re["total_income"] == pytest.approx(800)   # operating P&L intact


def test_close_locks_invoice_payments_and_journal(make_client):
    c = make_client("superadmin")
    cid = _client(c)
    iv = c.post("/api/invoices/", json={
        "client_id": cid, "items": [{"name": "x", "quantity": 1, "unit_price": 100}]}).json()
    from datetime import datetime
    year = datetime.utcnow().year
    c.post(f"/api/accounting/fiscal-years/{year}/close")
    # A manual journal entry dated in the closed year is rejected.
    accts = {a["code"]: a["id"] for a in c.get("/api/accounting/accounts").json()}
    je = c.post("/api/accounting/journal-entries", json={
        "entry_date": f"{year}-03-01", "memo": "backdated",
        "lines": [{"account_id": accts["1000"], "debit": 10},
                  {"account_id": accts["3000"], "credit": 10}]})
    assert je.status_code == 400
    assert "closed" in je.text.lower()
