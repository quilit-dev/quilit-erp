"""Paying someone by the hour.

`salary` on an employee has always meant a MONTHLY figure, so an hourly worker
had nowhere to record their rate and payroll had nothing to work from. Attendance
already stored hours per day, but nothing read them: the month's pay had to be
multiplied out by hand and typed over the prefilled figure, every month, and the
line kept no record of how the number was reached.

Now an employee carries a `pay_type` and an `hourly_rate`, and opening a payroll
run totals that employee's attendance across the period:

    base_salary = hours recorded in the period x hourly_rate

The hours and the rate are stored ON the line rather than recomputed at read
time, so a payslip keeps saying what it said the day it was paid even after the
rate changes or an attendance day is corrected.
"""
import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _employee(client, **kw):
    body = {"full_name": "Hourly Hala", "pay_type": "Hourly",
            "hourly_rate": 12, "salary": 0}
    body.update(kw)
    r = client.post("/api/hr/employees", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _hours(client, emp_id, day, hours, status="Present"):
    r = client.post("/api/hr/attendance", json={
        "employee_id": emp_id, "date": day, "status": status, "hours": hours})
    assert r.status_code == 200, r.text


def _run(client, start="2026-03-01", end="2026-03-31"):
    r = client.post("/api/hr/payroll/runs",
                    json={"period_start": start, "period_end": end})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _line(client, run_id, emp_id):
    body = client.get(f"/api/hr/payroll/runs/{run_id}").json()
    lines = body["lines"] if isinstance(body, dict) and "lines" in body else body
    return next(l for l in lines if l["employee_id"] == emp_id)


# ── The question that started this ───────────────────────────────────────────

def test_pay_is_hours_times_rate(client):
    """The headline: record the hours, and the run works out the pay."""
    emp = _employee(client, hourly_rate=12)
    _hours(client, emp, "2026-03-02", 8)
    _hours(client, emp, "2026-03-03", 7.5)
    _hours(client, emp, "2026-03-04", 6)

    line = _line(client, _run(client), emp)

    assert line["hours_worked"] == pytest.approx(21.5)
    assert line["hourly_rate"] == pytest.approx(12)
    assert line["base_salary"] == pytest.approx(258.0)      # 21.5 x 12


def test_only_hours_inside_the_period_count(client):
    """A run pays for its own month. Hours either side belong to another one."""
    emp = _employee(client, hourly_rate=10)
    _hours(client, emp, "2026-02-27", 8)      # before
    _hours(client, emp, "2026-03-10", 5)      # inside
    _hours(client, emp, "2026-04-02", 8)      # after

    line = _line(client, _run(client, "2026-03-01", "2026-03-31"), emp)

    assert line["hours_worked"] == pytest.approx(5)
    assert line["base_salary"] == pytest.approx(50)


def test_an_employee_with_no_hours_is_paid_nothing(client):
    """Not an error — somebody who did not work that month earns nothing, and
    the line still exists so it is visible rather than silently absent."""
    emp = _employee(client, hourly_rate=12)

    line = _line(client, _run(client), emp)

    assert line["hours_worked"] == pytest.approx(0)
    assert line["base_salary"] == pytest.approx(0)
    assert line["net_amount"] == pytest.approx(0)


def test_a_salaried_employee_is_untouched(client):
    """The change must be invisible to everyone already on a monthly salary,
    including when they have attendance recorded."""
    emp = _employee(client, full_name="Salaried Sami",
                    pay_type="Salaried", salary=2000, hourly_rate=0)
    _hours(client, emp, "2026-03-02", 8)

    line = _line(client, _run(client), emp)

    assert line["base_salary"] == pytest.approx(2000)
    assert line["hours_worked"] == pytest.approx(0)


def test_half_days_and_leave_count_as_the_hours_entered(client):
    """The hours field is the record of hours worked, whatever the status says.
    A Half-day carries four; a day marked Absent carries none."""
    emp = _employee(client, hourly_rate=10)
    _hours(client, emp, "2026-03-02", 8, status="Present")
    _hours(client, emp, "2026-03-03", 4, status="Half-day")
    _hours(client, emp, "2026-03-04", None, status="Absent")

    line = _line(client, _run(client), emp)

    assert line["hours_worked"] == pytest.approx(12)
    assert line["base_salary"] == pytest.approx(120)


# ── Editing ──────────────────────────────────────────────────────────────────

def _edit(client, line_id, **kw):
    return client.put(f"/api/hr/payroll/lines/{line_id}", json=kw)


def test_correcting_the_hours_recomputes_the_pay(client):
    """A missed day gets added after the run was opened."""
    emp = _employee(client, hourly_rate=12)
    _hours(client, emp, "2026-03-02", 8)
    run = _run(client)
    line = _line(client, run, emp)

    r = _edit(client, line["id"], hours_worked=20)
    assert r.status_code == 200, r.text

    line = _line(client, run, emp)
    assert line["hours_worked"] == pytest.approx(20)
    assert line["base_salary"] == pytest.approx(240)


def test_correcting_the_rate_recomputes_the_pay(client):
    emp = _employee(client, hourly_rate=12)
    _hours(client, emp, "2026-03-02", 10)
    run = _run(client)
    line = _line(client, run, emp)

    _edit(client, line["id"], hourly_rate=15)

    line = _line(client, run, emp)
    assert line["base_salary"] == pytest.approx(150)


def test_the_total_cannot_be_overwritten_directly(client):
    """Otherwise the payslip shows hours and a rate that no longer multiply out
    to the amount paid, and nothing on screen says which one is real."""
    emp = _employee(client, hourly_rate=12)
    _hours(client, emp, "2026-03-02", 10)
    run = _run(client)
    line = _line(client, run, emp)

    r = _edit(client, line["id"], base_salary=999)

    assert r.status_code == 400
    assert "hour" in r.text.lower()
    assert _line(client, run, emp)["base_salary"] == pytest.approx(120)


def test_a_one_off_correction_goes_through_bonuses(client):
    """Which is what they are for, and it keeps the hours honest."""
    emp = _employee(client, hourly_rate=12)
    _hours(client, emp, "2026-03-02", 10)
    run = _run(client)
    line = _line(client, run, emp)

    assert _edit(client, line["id"], bonuses=50).status_code == 200

    line = _line(client, run, emp)
    assert line["base_salary"] == pytest.approx(120)
    assert line["gross_total"] == pytest.approx(170)


def test_negative_hours_are_refused(client):
    emp = _employee(client, hourly_rate=12)
    _hours(client, emp, "2026-03-02", 10)
    run = _run(client)
    line = _line(client, run, emp)

    assert _edit(client, line["id"], hours_worked=-5).status_code == 400


def test_a_salaried_line_can_still_have_its_total_set(client):
    """The existing behaviour for salaried staff must keep working."""
    emp = _employee(client, full_name="Salaried Sami",
                    pay_type="Salaried", salary=2000, hourly_rate=0)
    run = _run(client)
    line = _line(client, run, emp)

    assert _edit(client, line["id"], base_salary=2500).status_code == 200
    assert _line(client, run, emp)["base_salary"] == pytest.approx(2500)


# ── Overtime finally has a real rate ─────────────────────────────────────────

def test_overtime_uses_the_real_hourly_rate(client):
    """It used to derive one from monthly base / 173.33, which for an hourly
    employee is a rate of zero — so overtime silently paid nothing."""
    emp = _employee(client, hourly_rate=10)
    _hours(client, emp, "2026-03-02", 8)
    run = _run(client)
    line = _line(client, run, emp)

    r = _edit(client, line["id"], overtime_hours=4)
    assert r.status_code == 200, r.text

    line = _line(client, run, emp)
    assert line["overtime_amount"] > 0, "overtime paid nothing"
    # 4h at $10 with the configured multiplier (1.5 by default) = 60.
    assert line["overtime_amount"] == pytest.approx(60, abs=0.01)


# ── The record ───────────────────────────────────────────────────────────────

def test_the_payslip_keeps_the_working(client):
    """A payslip has to keep saying what it said the day it was paid, even
    after the employee's rate changes."""
    emp = _employee(client, hourly_rate=12)
    _hours(client, emp, "2026-03-02", 10)
    run = _run(client)
    before = _line(client, run, emp)["base_salary"]

    client.put(f"/api/hr/employees/{emp}",
               json={"full_name": "Hourly Hala", "pay_type": "Hourly",
                     "hourly_rate": 30, "salary": 0})

    line = _line(client, run, emp)
    assert line["hourly_rate"] == pytest.approx(12), "the line followed the employee"
    assert line["base_salary"] == pytest.approx(before)


def test_the_employee_record_round_trips_the_rate(client):
    emp = _employee(client, hourly_rate=12.5)

    body = client.get(f"/api/hr/employees/{emp}").json()

    assert body["pay_type"] == "Hourly"
    assert body["hourly_rate"] == pytest.approx(12.5)


def test_a_nonsense_pay_type_is_refused(client):
    r = client.post("/api/hr/employees",
                    json={"full_name": "X", "pay_type": "Freelance"})

    assert r.status_code == 422


def test_a_negative_rate_is_refused(client):
    r = client.post("/api/hr/employees",
                    json={"full_name": "X", "pay_type": "Hourly", "hourly_rate": -5})

    assert r.status_code == 422


def test_an_hourly_employee_with_no_rate_yet_is_still_hourly(client):
    """The edge that makes inferring from the line's own numbers unsafe: before
    a rate is entered the line is all zeros, indistinguishable from a salaried
    one. Guessing wrong there hands back a directly editable total on exactly
    the record that most needs its working shown."""
    emp = _employee(client, hourly_rate=0)
    run = _run(client)
    line = _line(client, run, emp)

    r = _edit(client, line["id"], base_salary=500)

    assert r.status_code == 400, "an hourly line accepted a typed-in total"
    assert _line(client, run, emp)["base_salary"] == pytest.approx(0)
