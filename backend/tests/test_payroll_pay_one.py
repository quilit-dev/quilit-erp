"""Paying one employee at a time, and the receipt they are handed.

A run used to be paid all at once. Now an approved run can pay any employee on
their own --- the one leaving early, the one who needs it today --- and the
rest later with the run. The things that must hold:

  * **Nobody is paid twice.** An employee paid on their own is skipped when
    the run is paid, and the run's entry covers only the others.
  * **The two ways post the same accounting.** Salaries debited, the money
    account credited, an advance being recovered credited to 1260.
  * **The run closes itself** when the last employee on it is paid.
  * **A paid line is final.** It cannot be edited, and a run with anyone paid
    on it cannot be cancelled --- that money has left.
  * **The receipt number is stable.** Every reprint of one payment carries
    the same number.
"""
import pytest

pytestmark = pytest.mark.critical

START, END = "2026-03-01", "2026-03-31"


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _employee(c, name, salary=1000, **kw):
    body = {"full_name": name, "salary": salary}
    body.update(kw)
    r = c.post("/api/hr/employees", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _approved_run(c):
    r = c.post("/api/hr/payroll/runs", json={"period_start": START, "period_end": END})
    assert r.status_code == 200, r.text
    run = r.json()["id"]
    return run


def _approve(c, run):
    assert c.post(f"/api/hr/payroll/runs/{run}/approve").status_code == 200


def _line(c, run, emp):
    body = c.get(f"/api/hr/payroll/runs/{run}").json()
    return next(l for l in body["lines"] if l["employee_id"] == emp)


def _salary_debits(db):
    row = db.execute(
        "SELECT COALESCE(SUM(l.debit),0) d FROM journal_entry_lines l "
        "  JOIN journal_entries je ON je.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id "
        " WHERE a.code='6000' AND je.status != 'draft'").fetchone()
    return round(float(row["d"] or 0), 2)


def test_one_employee_can_be_paid_before_the_run(client, db):
    a, b = _employee(client, "Ali", 1000), _employee(client, "Batoul", 600)
    run = _approved_run(client)
    _approve(client, run)
    line = _line(client, run, a)

    r = client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["amount"] == pytest.approx(line["net_amount"])
    assert body["receipt_number"] == f"SAL-{line['id']:06d}"
    assert body["run_paid"] is False, "Batoul is still unpaid"

    after = client.get(f"/api/hr/payroll/runs/{run}").json()
    assert after["status"] == "Approved"
    mine = next(l for l in after["lines"] if l["employee_id"] == a)
    theirs = next(l for l in after["lines"] if l["employee_id"] == b)
    assert mine["paid_on"] and mine["receipt_number"] == body["receipt_number"]
    assert theirs["paid_on"] is None and theirs["receipt_number"] is None
    assert _salary_debits(db) == pytest.approx(line["net_amount"])


def test_paying_the_run_afterwards_pays_only_the_rest(client, db):
    a, b = _employee(client, "Ali", 1000), _employee(client, "Batoul", 600)
    run = _approved_run(client)
    _approve(client, run)
    la, lb = _line(client, run, a), _line(client, run, b)
    client.post(f"/api/hr/payroll/lines/{la['id']}/pay", json={"payment_method": "Cash"})

    r = client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={"payment_method": "Cash"})
    assert r.status_code == 200, r.text
    assert r.json()["amount"] == pytest.approx(lb["net_amount"]), "Ali was paid again"
    assert _salary_debits(db) == pytest.approx(la["net_amount"] + lb["net_amount"])
    assert client.get(f"/api/hr/payroll/runs/{run}").json()["status"] == "Paid"
    # Every line now has a receipt, the run-paid one included.
    lines = client.get(f"/api/hr/payroll/runs/{run}").json()["lines"]
    assert all(l["receipt_number"] for l in lines)


def test_paying_the_last_employee_closes_the_run(client, db):
    a = _employee(client, "Ali", 1000)
    run = _approved_run(client)
    _approve(client, run)
    line = _line(client, run, a)
    r = client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})
    assert r.json()["run_paid"] is True
    assert client.get(f"/api/hr/payroll/runs/{run}").json()["status"] == "Paid"
    # Marking the run paid now is harmless: it is already paid.
    again = client.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={"payment_method": "Cash"})
    assert again.status_code == 200
    assert _salary_debits(db) == pytest.approx(line["net_amount"])


def test_paying_the_same_employee_twice_is_refused_quietly(client, db):
    a = _employee(client, "Ali", 1000)
    _employee(client, "Batoul", 600)
    run = _approved_run(client)
    _approve(client, run)
    line = _line(client, run, a)
    client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})
    second = client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})
    assert second.status_code == 200 and second.json()["message"] == "Already paid"
    assert _salary_debits(db) == pytest.approx(line["net_amount"])


def test_a_draft_run_cannot_pay_anyone(client):
    a = _employee(client, "Ali", 1000)
    run = _approved_run(client)
    line = _line(client, run, a)
    r = client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})
    assert r.status_code == 400 and "Approve" in r.json()["detail"]


def test_a_paid_line_cannot_be_edited_and_its_run_cannot_be_cancelled(client):
    a, _b = _employee(client, "Ali", 1000), _employee(client, "Batoul", 600)
    run = _approved_run(client)
    _approve(client, run)
    line = _line(client, run, a)
    client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})

    edit = client.put(f"/api/hr/payroll/lines/{line['id']}", json={"bonuses": 50})
    assert edit.status_code == 400 and "already been paid" in edit.json()["detail"]
    cancel = client.post(f"/api/hr/payroll/runs/{run}/cancel")
    assert cancel.status_code == 400 and "already been paid" in cancel.json()["detail"]


def test_an_hourly_employee_is_paid_hours_times_rate(client, db):
    emp = _employee(client, "Hadi", 0, pay_type="Hourly", hourly_rate=12.5)
    run = _approved_run(client)
    line = _line(client, run, emp)
    r = client.put(f"/api/hr/payroll/lines/{line['id']}", json={"hours_worked": 80})
    assert r.status_code == 200, r.text
    _approve(client, run)
    line = _line(client, run, emp)
    assert line["base_salary"] == pytest.approx(1000)
    paid = client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})
    assert paid.json()["amount"] == pytest.approx(line["net_amount"])


def test_an_advance_is_recovered_only_for_the_employee_paid(client, db):
    a, b = _employee(client, "Ali", 1000), _employee(client, "Batoul", 600)
    for emp in (a, b):
        r = client.post("/api/hr/advances", json={"employee_id": emp, "amount": 100,
                                                  "paid_at": "2026-03-10"})
        assert r.status_code == 200, r.text
    run = _approved_run(client)
    _approve(client, run)
    la = _line(client, run, a)
    client.post(f"/api/hr/payroll/lines/{la['id']}/pay", json={"payment_method": "Cash"})

    status = {r["employee_id"]: r["status"] for r in db.execute(
        "SELECT employee_id, status FROM hr_salary_advances").fetchall()}
    assert status[a] == "recovered"
    assert status[b] == "open", "Batoul's advance was marked recovered before she was paid"


def test_the_journal_entry_points_back_at_the_run(client, db):
    import gl_source
    a = _employee(client, "Ali", 1000)
    _employee(client, "Batoul", 600)
    run = _approved_run(client)
    _approve(client, run)
    line = _line(client, run, a)
    client.post(f"/api/hr/payroll/lines/{line['id']}/pay", json={"payment_method": "Cash"})
    je = db.execute("SELECT source_type, source_id FROM journal_entries "
                    "WHERE source_type='payroll_line'").fetchone()
    assert je is not None
    d = gl_source.describe(db, je["source_type"], je["source_id"])
    assert d["exists"] and d["label"]
