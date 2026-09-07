"""What a person typed beats what the clock saw.

hr_attendance is UNIQUE(employee_id, date), so a derived day and a typed day
compete for one row --- and that row already pays hourly staff through
`_hours_worked`. Every test here is a way that could go wrong quietly.

The one that matters most is the last: a salaried employee with a month of
absences must still produce `base_salary == salary`. The decision taken with
the customer was that attendance INFORMS payroll for salaried staff and never
computes it, and this is the assertion that keeps that true as the feature grows.
"""
import pytest

pytestmark = pytest.mark.critical

BEARER = "Authorization"
MON = "2026-09-07"          # a Monday
SAT = "2026-09-12"


@pytest.fixture()
def rig(make_client):
    """Admin client, a device-bearing agent, and one employee mapped to finger 7."""
    admin = make_client("superadmin")
    dev = admin.post("/api/hr/timeclock/devices",
                     json={"name": "Front door"}).json()
    agent = make_client()
    agent.headers.update({BEARER: "Bearer " + dev["token"]})

    emp = admin.post("/api/hr/employees", json={
        "full_name": "Rami Haddad", "employment_type": "Full-time",
        "status": "Active", "salary": 1200}).json()["id"]
    return admin, agent, emp


def enable(admin):
    r = admin.put("/api/settings/", json={"attendance_source": "device"})
    assert r.status_code == 200, r.text


def send(admin, agent, emp, *times, claim=True):
    """Push punches as finger 7 and (once) claim that finger for `emp`."""
    body = {"punches": [{"device_user_id": "7", "punched_at": t} for t in times]}
    r = agent.post("/api/time/punches", json=body)
    assert r.status_code == 200, r.text
    if claim:
        rows = admin.get("/api/hr/timeclock/device-users").json()
        m = next(x for x in rows if x["device_user_id"] == "7")
        if m["employee_id"] is None:
            admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
                      json={"employee_id": emp})
    return r.json()


def derive(admin, start=MON, end=MON):
    r = admin.post("/api/hr/attendance/derive", json={"start": start, "end": end})
    assert r.status_code == 200, r.text
    return r.json()


def row(db, emp, day=MON):
    return db.execute("SELECT * FROM hr_attendance WHERE employee_id=? AND date=?",
                      (emp, day)).fetchone()


# ── the switch ───────────────────────────────────────────────────────────────
def test_nothing_happens_until_somebody_turns_it_on(rig, db):
    # Every tenant today is in this state, and must stay exactly as it was.
    admin, agent, emp = rig
    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    assert derive(admin)["enabled"] is False
    assert row(db, emp) is None, "punches became attendance without being asked"


def test_the_punches_are_still_kept_while_it_is_off(rig, db):
    # The point of the switch: collect real data for a week, look at it, and
    # only then let it start affecting what anyone reads.
    admin, agent, emp = rig
    send(admin, agent, emp, MON + " 08:00:00")
    assert db.execute("SELECT COUNT(*) c FROM time_punches").fetchone()["c"] == 1


def test_turning_it_on_makes_the_day_appear(rig, db):
    admin, agent, emp = rig
    enable(admin)
    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin)

    r = row(db, emp)
    assert r is not None
    assert r["source"] == "device"
    assert r["status"] == "Present"
    assert r["hours"] == pytest.approx(9.0)
    assert r["first_in"] == "08:00:00" and r["last_out"] == "17:00:00"


# ── a human owns their row ───────────────────────────────────────────────────
def test_a_typed_day_survives_the_punches_arriving(rig, db):
    # A manager marked him absent -- maybe somebody else used his finger, maybe
    # he went home. Whatever the reason, the clock does not get to argue.
    admin, agent, emp = rig
    enable(admin)
    admin.post("/api/hr/attendance", json={
        "employee_id": emp, "date": MON, "status": "Absent", "hours": 0})

    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin)

    r = row(db, emp)
    assert r["source"] == "manual"
    assert r["status"] == "Absent", "the clock overwrote a person's decision"
    assert r["hours"] == 0
    # But what the clock saw is kept beside it, which is what makes the screen
    # able to say "you typed 0, the clock says 9".
    assert r["device_hours"] == pytest.approx(9.0)
    assert r["first_in"] == "08:00:00"
    assert r["punch_count"] == 2


def test_editing_a_derived_day_takes_it_off_the_clock(rig, db):
    admin, agent, emp = rig
    enable(admin)
    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin)
    assert row(db, emp)["source"] == "device"

    admin.post("/api/hr/attendance", json={
        "employee_id": emp, "date": MON, "status": "Present", "hours": 8})
    assert row(db, emp)["source"] == "manual"

    # And a second pass does not quietly take it back.
    derive(admin)
    r = row(db, emp)
    assert r["source"] == "manual"
    assert r["hours"] == pytest.approx(8.0), "the correction was reverted"
    assert r["device_hours"] == pytest.approx(9.0)


def test_a_row_written_before_any_of_this_reads_as_manual(rig, db):
    # No backfill runs anywhere in this feature. Rows that already exist on the
    # live tenants are protected by the column default alone, and this is what
    # says so.
    admin, agent, emp = rig
    admin.post("/api/hr/attendance", json={
        "employee_id": emp, "date": MON, "status": "Present", "hours": 7.5})
    assert row(db, emp)["source"] == "manual"


def test_the_bulk_editor_also_claims_its_rows(rig, db):
    admin, agent, emp = rig
    admin.post("/api/hr/attendance/bulk", json={
        "date": MON, "records": [{"employee_id": emp, "status": "Leave"}]})
    assert row(db, emp)["source"] == "manual"


# ── a signed-off period is closed ────────────────────────────────────────────
def test_a_paid_period_does_not_move_when_the_rules_change(rig, db, make_client):
    # Correcting a schedule must not reach back through a payslip somebody has
    # already been handed.
    admin, agent, emp = rig
    enable(admin)
    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin)
    assert row(db, emp)["hours"] == pytest.approx(9.0)

    run = admin.post("/api/hr/payroll/runs", json={
        "period_start": "2026-09-01", "period_end": "2026-09-30"})
    assert run.status_code in (200, 201), run.text
    run_id = run.json()["id"]
    assert admin.post("/api/hr/payroll/runs/%d/approve" % run_id).status_code == 200

    # More punches for the same day, which would otherwise rewrite it.
    send(admin, agent, emp, MON + " 18:00:00", MON + " 20:00:00")
    derive(admin)

    r = row(db, emp)
    assert r["hours"] == pytest.approx(9.0), \
        "an approved period's hours moved underneath it"
    assert r["needs_review"] == 1, "and nobody was told they no longer agree"


# ── payroll is not quietly rewired ───────────────────────────────────────────
def test_hours_worked_is_still_the_plain_sum(rig, db):
    import routers.hr as hr
    admin, agent, emp = rig
    enable(admin)
    send(admin, agent, emp,
         MON + " 08:00:00", MON + " 12:00:00",
         MON + " 13:00:00", MON + " 17:00:00")
    derive(admin)
    assert hr._hours_worked(db, emp, "2026-09-01", "2026-09-30") == \
        pytest.approx(8.0)


def test_opening_a_payroll_run_reads_the_clock_by_itself(rig, db):
    # The "no effort at month end" promise, and the only test that holds it.
    # NOTHING calls the derive endpoint here: the run is created straight after
    # the punches arrive, and the hours on the line have to be the hours the
    # reader recorded. Without the hook in create_payroll_run this passes only
    # by accident of ingest having already run, so the assertion is on the
    # PAYROLL LINE rather than on hr_attendance.
    admin, agent, emp = rig
    enable(admin)
    hourly = admin.post("/api/hr/employees", json={
        "full_name": "Sami Hourly", "employment_type": "Full-time",
        "status": "Active", "salary": 0,
        "pay_type": "Hourly", "hourly_rate": 10}).json()["id"]

    body = {"punches": [{"device_user_id": "9", "punched_at": t}
                        for t in (MON + " 08:00:00", MON + " 17:00:00")]}
    assert agent.post("/api/time/punches", json=body).status_code == 200
    rows = admin.get("/api/hr/timeclock/device-users").json()
    m = next(x for x in rows if x["device_user_id"] == "9")
    admin.put("/api/hr/timeclock/device-users/%d" % m["id"],
              json={"employee_id": hourly})

    run_id = admin.post("/api/hr/payroll/runs", json={
        "period_start": "2026-09-01", "period_end": "2026-09-30"}).json()["id"]
    line = db.execute(
        "SELECT * FROM hr_payroll_lines WHERE payroll_run_id=? AND employee_id=?",
        (run_id, hourly)).fetchone()
    assert line["hours_worked"] == pytest.approx(9.0), \
        "the run did not pick up the hours the clock recorded"
    assert line["base_salary"] == pytest.approx(90.0)


def test_a_salaried_employee_with_absences_is_paid_their_salary(rig, db):
    # THE assertion. The decision taken was that attendance informs payroll for
    # salaried staff and never computes it. If this ever fails, somebody's pay
    # changed because of a feature that was sold as reporting.
    admin, agent, emp = rig
    enable(admin)
    # One day present in a month of working days: every other weekday derives
    # as Absent.
    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin, "2026-09-01", "2026-09-30")

    absent = db.execute(
        "SELECT COUNT(*) c FROM hr_attendance WHERE employee_id=? AND status='Absent'",
        (emp,)).fetchone()["c"]
    assert absent >= 5, "setup: there should be plenty of absences to react to"

    run_id = admin.post("/api/hr/payroll/runs", json={
        "period_start": "2026-09-01", "period_end": "2026-09-30"}).json()["id"]
    line = db.execute(
        "SELECT * FROM hr_payroll_lines WHERE payroll_run_id=? AND employee_id=?",
        (run_id, emp)).fetchone()
    assert line["base_salary"] == pytest.approx(1200.0), \
        "a salaried employee's pay was changed by attendance"


# ── the guard against inventing a hundred absences ───────────────────────────
def test_nobody_is_marked_absent_before_the_clock_existed(rig, db):
    # Switching the feature on and re-deriving a past month must not mark
    # everybody Absent for every working day before the reader was installed.
    admin, agent, emp = rig
    enable(admin)
    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin, "2026-08-01", "2026-09-30")

    earlier = db.execute(
        "SELECT COUNT(*) c FROM hr_attendance WHERE employee_id=? AND date < ?",
        (emp, MON)).fetchone()["c"]
    assert earlier == 0, \
        "%d absences were invented for days before this person's first punch" % earlier


def test_somebody_who_never_touches_the_reader_is_left_alone(rig, db):
    # Not everyone is on the clock. Office staff on trust, a director who never
    # punches -- marking them Absent every day would be a lie in the one place a
    # manager checks before paying people.
    admin, agent, emp = rig
    enable(admin)
    other = admin.post("/api/hr/employees", json={
        "full_name": "Never Punches", "employment_type": "Full-time",
        "status": "Active", "salary": 900}).json()["id"]

    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin, "2026-09-01", "2026-09-30")

    assert db.execute("SELECT COUNT(*) c FROM hr_attendance WHERE employee_id=?",
                      (other,)).fetchone()["c"] == 0


def test_a_day_off_gets_no_row(rig, db):
    admin, agent, emp = rig
    enable(admin)
    send(admin, agent, emp, MON + " 08:00:00", MON + " 17:00:00")
    derive(admin, MON, SAT)
    assert row(db, emp, SAT) is None


# ── ingest derives on its own ────────────────────────────────────────────────
def test_punches_arriving_build_the_day_without_anyone_pressing_anything(rig, db):
    # There is no scheduler in this codebase and this feature does not add one.
    # Ingest is the trigger, which is also why a day recovers on its own after
    # the agent has been offline.
    admin, agent, emp = rig
    enable(admin)
    # The arrival punch both opens the mapping and gets claimed; the departure
    # then lands against a person who is already known.
    send(admin, agent, emp, MON + " 08:00:00")
    send(admin, agent, emp, MON + " 17:00:00")

    r = row(db, emp)
    assert r is not None, "ingest should have derived the day it just touched"
    assert r["source"] == "device"
    assert r["last_out"] == "17:00:00", "no derive endpoint was called"
    assert r["hours"] == pytest.approx(9.0)
    assert r["needs_review"] == 0


def test_a_half_finished_day_is_flagged_rather_than_closed(rig, db):
    # Somebody is still at work: one punch, no departure yet. The day must not
    # be given a length, because for an hourly employee that length is money.
    admin, agent, emp = rig
    enable(admin)
    send(admin, agent, emp, MON + " 08:00:00")
    send(admin, agent, emp, MON + " 08:00:01")   # forces a re-derive of the day

    r = row(db, emp)
    assert r["hours"] is None, "an open day was given a number"
    assert r["needs_review"] == 1
    assert r["last_out"] is None
