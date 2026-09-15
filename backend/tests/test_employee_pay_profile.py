"""What an employee's pay is made of, derived by the run from the person and
the month instead of typed onto every line.

Seven facts on the employee record --- commute distance, overtime rate, late
deduction, attendance bonus, insurance (both shares), NSSF exemption --- and
two company defaults. A payroll run reads them, reads the attendance the
clock recorded for the period, and seeds each line with transport, the
attendance bonus, the late deduction, insurance and any open advance already
worked out.

**The property everything else rests on:** every field defaults to nothing,
and every computation is zero when its field is nothing. An employee with
none of it filled in gets a line identical, column for column, to the one
they got before this existed. That is the first test, and it is what makes
this safe to deploy under three live tenants.

The second thing pinned here is the base for NSSF and tax: transport is
OUTSIDE it. That is the treatment of a transport allowance under Lebanese
rules; folding it in would deduct contributions on money that is not wages.
"""
import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def client(as_role):
    return as_role("superadmin")

# A period with no weekends at the edges to worry about; attendance rows are
# written explicitly, so what the calendar says does not matter.
START, END = "2026-03-01", "2026-03-31"


def _employee(c, **kw):
    body = {"full_name": "Rami Salaried", "salary": 1000}
    body.update(kw)
    r = c.post("/api/hr/employees", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _day(c, emp, day, status="Present", hours=8):
    r = c.post("/api/hr/attendance", json={
        "employee_id": emp, "date": day, "status": status, "hours": hours})
    assert r.status_code == 200, r.text


def _settings(c, **kw):
    r = c.put("/api/settings/", json={k: str(v) for k, v in kw.items()})
    assert r.status_code == 200, r.text


def _run(c):
    r = c.post("/api/hr/payroll/runs", json={"period_start": START, "period_end": END})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _line(c, run, emp):
    body = c.get(f"/api/hr/payroll/runs/{run}").json()
    return next(l for l in body["lines"] if l["employee_id"] == emp)


# ── the no-op ────────────────────────────────────────────────────────────────
def test_an_employee_with_nothing_set_gets_the_line_they_always_got(client):
    """Column for column. If this ever fails, a tenant that never touched the
    new fields has had its payroll changed by a deploy."""
    _settings(client, payroll_nssf_employee_pct=3, payroll_nssf_employer_pct=21.5,
              payroll_tax_pct=2)
    emp = _employee(client, salary=1000)
    for d in ("2026-03-02", "2026-03-03", "2026-03-04"):
        _day(client, emp, d)
    _day(client, emp, "2026-03-05", status="Late")

    line = _line(client, _run(client), emp)

    # Exactly what _compute_payroll_line(1000, 0, 0, 0, settings) produced before.
    assert line["base_salary"] == 1000
    assert line["gross_total"] == 1000
    assert line["nssf_employee"] == pytest.approx(30.0)
    assert line["nssf_employer"] == pytest.approx(215.0)
    assert line["tax_amount"] == pytest.approx(19.4)          # (1000 - 30) x 2%
    assert line["net_amount"] == pytest.approx(950.6)         # 1000 - 30 - 19.4
    # ...and every new component is zero, even though the month had a Late day.
    for k in ("transport_allowance", "attendance_bonus", "late_deduction",
              "insurance_employee", "insurance_employer", "advance_recovery"):
        assert line[k] == 0, k
    assert line["nssf_exempt"] == 0


# ── transport ────────────────────────────────────────────────────────────────
def test_transport_is_km_times_rate_times_days_attended(client):
    _settings(client, payroll_transport_rate_per_km=0.5)
    emp = _employee(client, commute_km=10)
    _day(client, emp, "2026-03-02")
    _day(client, emp, "2026-03-03")
    _day(client, emp, "2026-03-04", status="Half-day", hours=4)   # came in: counts
    _day(client, emp, "2026-03-05", status="Absent", hours=0)     # did not: no journey
    _day(client, emp, "2026-03-06", status="Leave", hours=0)      # no journey either

    line = _line(client, _run(client), emp)
    assert line["attended_days"] == 3
    assert line["transport_allowance"] == pytest.approx(10 * 0.5 * 3)
    assert line["gross_total"] == pytest.approx(1000 + 15)
    assert line["net_amount"] == pytest.approx(1015)


def test_transport_is_outside_the_nssf_and_tax_base(client):
    """The pinned treatment. 1000 salary, 15 transport, 3% NSSF, 2% tax:
    the contributions are on 1000, not 1015."""
    _settings(client, payroll_transport_rate_per_km=0.5,
              payroll_nssf_employee_pct=3, payroll_tax_pct=2)
    emp = _employee(client, commute_km=10)
    for d in ("2026-03-02", "2026-03-03", "2026-03-04"):
        _day(client, emp, d)

    line = _line(client, _run(client), emp)
    assert line["transport_allowance"] == pytest.approx(15)
    assert line["nssf_employee"] == pytest.approx(30.0), "NSSF was charged on transport"
    assert line["tax_amount"] == pytest.approx(19.4), "tax was charged on transport"
    assert line["net_amount"] == pytest.approx(1015 - 30 - 19.4)


def test_no_rate_means_no_transport_however_far_they_live(client):
    emp = _employee(client, commute_km=40)
    _day(client, emp, "2026-03-02")
    assert _line(client, _run(client), emp)["transport_allowance"] == 0


# ── lateness ─────────────────────────────────────────────────────────────────
def test_late_deduction_uses_the_employees_own_amount(client):
    _settings(client, payroll_late_deduction=5)          # company default
    emp = _employee(client, late_deduction=8)            # this person's own
    _day(client, emp, "2026-03-02", status="Late")
    _day(client, emp, "2026-03-03", status="Late")
    _day(client, emp, "2026-03-04")

    line = _line(client, _run(client), emp)
    assert line["late_days"] == 2
    assert line["late_deduction"] == pytest.approx(16)
    assert line["net_amount"] == pytest.approx(1000 - 16)


def test_late_deduction_falls_back_to_the_company_default(client):
    _settings(client, payroll_late_deduction=5)
    emp = _employee(client)                              # late_deduction NULL
    _day(client, emp, "2026-03-02", status="Late")
    line = _line(client, _run(client), emp)
    assert line["late_deduction"] == pytest.approx(5)


def test_no_late_days_no_deduction(client):
    _settings(client, payroll_late_deduction=5)
    emp = _employee(client, late_deduction=8)
    _day(client, emp, "2026-03-02")
    assert _line(client, _run(client), emp)["late_deduction"] == 0


# ── the attendance bonus ─────────────────────────────────────────────────────
def test_attendance_bonus_is_paid_for_a_clean_month(client):
    emp = _employee(client, attendance_bonus=50)
    _day(client, emp, "2026-03-02")
    _day(client, emp, "2026-03-03", status="Half-day", hours=4)
    _day(client, emp, "2026-03-04", status="Leave", hours=0)  # leave is not a lapse
    line = _line(client, _run(client), emp)
    assert line["attendance_bonus"] == pytest.approx(50)
    assert line["gross_total"] == pytest.approx(1050)


@pytest.mark.parametrize("lapse", ["Late", "Absent"])
def test_one_lapse_forfeits_the_attendance_bonus(client, lapse):
    emp = _employee(client, attendance_bonus=50)
    _day(client, emp, "2026-03-02")
    _day(client, emp, "2026-03-03", status=lapse, hours=0 if lapse == "Absent" else 8)
    assert _line(client, _run(client), emp)["attendance_bonus"] == 0


def test_the_attendance_bonus_is_wages_and_inside_the_nssf_base(client):
    """Unlike transport. It is pay for turning up, which is what wages are."""
    _settings(client, payroll_nssf_employee_pct=10)
    emp = _employee(client, attendance_bonus=50)
    _day(client, emp, "2026-03-02")
    line = _line(client, _run(client), emp)
    assert line["nssf_employee"] == pytest.approx(105.0)     # 10% of 1050


# ── insurance and the fund ───────────────────────────────────────────────────
def test_employee_insurance_is_deducted_and_employer_insurance_is_not(client):
    emp = _employee(client, insurance_employee=20, insurance_employer=35)
    line = _line(client, _run(client), emp)
    assert line["insurance_employee"] == pytest.approx(20)
    assert line["insurance_employer"] == pytest.approx(35)
    assert line["net_amount"] == pytest.approx(980), "employer share reached the person's net"


def test_an_exempt_employee_pays_no_nssf_and_costs_no_employer_nssf(client):
    _settings(client, payroll_nssf_employee_pct=3, payroll_nssf_employer_pct=21.5)
    exempt = _employee(client, full_name="Exempt", nssf_exempt=True)
    normal = _employee(client, full_name="Normal")
    run = _run(client)
    ex, no = _line(client, run, exempt), _line(client, run, normal)
    assert ex["nssf_employee"] == 0 and ex["nssf_employer"] == 0
    assert no["nssf_employee"] == pytest.approx(30) and no["nssf_employer"] == pytest.approx(215)
    assert ex["nssf_exempt"] == 1


# ── overtime ─────────────────────────────────────────────────────────────────
def test_overtime_uses_the_employees_own_rate(client):
    _settings(client, payroll_overtime_multiplier=1.5)
    emp = _employee(client, overtime_rate=9)
    run = _run(client)
    line = _line(client, run, emp)
    r = client.put(f"/api/hr/payroll/lines/{line['id']}", json={"overtime_hours": 4})
    assert r.status_code == 200, r.text
    assert _line(client, run, emp)["overtime_amount"] == pytest.approx(36)


def test_overtime_without_a_rate_falls_back_to_the_old_guess(client):
    """1000 / 173.33 x 1.5 x 4h --- what a salaried line always produced."""
    _settings(client, payroll_overtime_multiplier=1.5)
    emp = _employee(client)
    run = _run(client)
    line = _line(client, run, emp)
    client.put(f"/api/hr/payroll/lines/{line['id']}", json={"overtime_hours": 4})
    assert _line(client, run, emp)["overtime_amount"] == pytest.approx(
        round(4 * (1000 / 173.33) * 1.5, 2))


# ── a manager's override ─────────────────────────────────────────────────────
def test_a_derived_figure_can_be_overridden_and_the_rest_is_left_alone(client):
    _settings(client, payroll_transport_rate_per_km=1, payroll_late_deduction=5)
    emp = _employee(client, commute_km=10, attendance_bonus=50)
    _day(client, emp, "2026-03-02")
    _day(client, emp, "2026-03-03", status="Late")
    run = _run(client)
    line = _line(client, run, emp)
    assert line["transport_allowance"] == 20 and line["late_deduction"] == 5
    assert line["attendance_bonus"] == 0                      # forfeited by the Late

    # The manager waives the late deduction. Nothing else moves.
    r = client.put(f"/api/hr/payroll/lines/{line['id']}", json={"late_deduction": 0})
    assert r.status_code == 200, r.text
    after = _line(client, run, emp)
    assert after["late_deduction"] == 0
    assert after["transport_allowance"] == 20
    assert after["attendance_bonus"] == 0
    assert after["net_amount"] == pytest.approx(1020)


def test_the_run_header_totals_the_new_components(client):
    _settings(client, payroll_transport_rate_per_km=1)
    a = _employee(client, full_name="A", commute_km=5, insurance_employee=10)
    b = _employee(client, full_name="B", commute_km=3, insurance_employee=10)
    for e in (a, b):
        _day(client, e, "2026-03-02")
    run = client.get(f"/api/hr/payroll/runs/{_run(client)}").json()
    assert run["total_transport_allowance"] == pytest.approx(8)
    assert run["total_insurance_employee"] == pytest.approx(20)
