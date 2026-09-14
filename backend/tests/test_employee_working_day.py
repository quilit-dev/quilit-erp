"""Each employee measured against their own working day.

"Some work 9 to 3, some 9 to 5." A schedule is a row under HR > Time clock >
Working day; one of them is the company default, and an employee may be
given a different one on their record. This exercises the whole path through
the API --- create two schedules, assign one to one employee and leave the
other on the default --- and then asks the derivation which schedule it will
actually use for each. That last question is the one that decides Late,
Half-day and Absent on a payslip.

The employee form only gained the field on 2026-09-14; the backend had
accepted `work_schedule_id` for weeks with nothing able to send it.
"""
import pytest

import attendance_sync

pytestmark = pytest.mark.critical


def _schedule(c, name, start, end, default=False):
    r = c.post("/api/hr/timeclock/schedules", json={
        "name": name, "start_time": start, "end_time": end,
        "is_default": default, "min_hours_full_day": 5})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _employee(c, name, schedule_id=None):
    r = c.post("/api/hr/employees", json={"full_name": name,
                                          "work_schedule_id": schedule_id})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_two_people_two_working_days(as_role, db):
    owner = as_role("superadmin")
    full = _schedule(owner, "Full day", "09:00", "17:00", default=True)
    short = _schedule(owner, "Mornings", "09:00", "15:00")

    on_default = _employee(owner, "Rami")
    on_short = _employee(owner, "Nour", schedule_id=short)

    assert attendance_sync.schedule_for(db, on_default)["end_time"] == "17:00"
    assert attendance_sync.schedule_for(db, on_short)["end_time"] == "15:00"


def test_the_record_can_be_changed_and_cleared(as_role, db):
    """Blank on the form means the company default --- a real answer, so
    clearing it must actually clear it rather than keep the old value."""
    owner = as_role("superadmin")
    _schedule(owner, "Full day", "09:00", "17:00", default=True)
    short = _schedule(owner, "Mornings", "09:00", "15:00")
    emp = _employee(owner, "Nour")

    r = owner.put(f"/api/hr/employees/{emp}", json={"full_name": "Nour",
                                                   "work_schedule_id": short})
    assert r.status_code == 200, r.text
    assert attendance_sync.schedule_for(db, emp)["end_time"] == "15:00"
    assert owner.get(f"/api/hr/employees/{emp}").json()["work_schedule_id"] == short

    r = owner.put(f"/api/hr/employees/{emp}", json={"full_name": "Nour",
                                                   "work_schedule_id": None})
    assert r.status_code == 200, r.text
    assert attendance_sync.schedule_for(db, emp)["end_time"] == "17:00", \
        "clearing the field did not fall back to the company default"


def test_nobody_assigned_means_everyone_is_on_the_default(as_role, db):
    owner = as_role("superadmin")
    _schedule(owner, "Full day", "08:30", "16:30", default=True)
    emp = _employee(owner, "Rami")
    s = attendance_sync.schedule_for(db, emp)
    assert (s["start_time"], s["end_time"]) == ("08:30", "16:30")
