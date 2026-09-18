"""
A working day that differs by weekday, and who works which Saturday.

The company: some staff work 9-3 and some 9-5, Monday to Friday; on Saturday
everyone who is in works 9-1; and certain people work one Saturday on, one
off. Two things had no way to be said:

  * A schedule had ONE start and end for every day it covered, so a 9-to-1
    Saturday was measured against the weekday hours and came out Half-day,
    or was left off the schedule and never measured at all.
  * Nothing represented a rota. Every Saturday was the same Saturday.

`work_schedules.day_overrides` gives a weekday its own hours; the derivation
reads the schedule *as it applies on that date*. `hr_employees.saturday_rota`
(+ an anchor Saturday) says which Saturdays are working days for this person,
and wins over the schedule's list on Saturdays alone.
"""
import pytest

import attendance_derive as ad
import attendance_sync

pytestmark = pytest.mark.critical

SAT_OVERRIDE = {"6": {"start_time": "09:00", "end_time": "13:00"}}
WEEK = {"start_time": "09:00", "end_time": "17:00", "min_hours_full_day": 6,
        "grace_minutes": 15, "workdays": "1,2,3,4,5,6", "day_overrides": SAT_OVERRIDE}

SAT1, SAT2, SAT3 = "2026-09-19", "2026-09-26", "2026-10-03"   # consecutive Saturdays
MON = "2026-09-21"


# ── the pure derivation ──────────────────────────────────────────────────────
def test_saturday_is_judged_on_its_own_hours():
    # 09:05 in, 13:02 out: a full Saturday, on time.
    day = ad.derive_day([f"{SAT1} 09:05:00", f"{SAT1} 13:02:00"], WEEK, SAT1)
    assert day["status"] == "Present"
    assert day["hours"] == pytest.approx(3.95)
    # 09:20 is past the grace period against a 09:00 start.
    assert ad.derive_day([f"{SAT1} 09:20:00", f"{SAT1} 13:00:00"], WEEK, SAT1)["status"] == "Late"
    # Leaving at eleven is a half Saturday.
    assert ad.derive_day([f"{SAT1} 09:00:00", f"{SAT1} 11:00:00"], WEEK, SAT1)["status"] == "Half-day"


def test_the_full_day_threshold_scales_to_the_shorter_day():
    """6 of 8 hours on a weekday is 3 of 4 on Saturday --- not 6, which no
    Saturday could reach, and not 4, where two minutes early is a Half-day."""
    eff = ad.effective_schedule(WEEK, SAT1)
    assert eff["min_hours_full_day"] == pytest.approx(3.0)
    # An explicit threshold in the override is taken as given.
    explicit = dict(WEEK, day_overrides={"6": {"end_time": "13:00", "min_hours_full_day": 2}})
    assert ad.effective_schedule(explicit, SAT1)["min_hours_full_day"] == 2


def test_weekdays_are_untouched_by_a_saturday_override():
    assert ad.effective_schedule(WEEK, MON)["end_time"] == "17:00"
    assert ad.derive_day([f"{MON} 09:00:00", f"{MON} 13:00:00"], WEEK, MON)["status"] == "Half-day"


def test_a_malformed_override_is_ignored_not_fatal():
    for bad in ("{not json", '{"9": {"end_time": "13:00"}}', '{"6": "13:00"}', 7):
        s = dict(WEEK, day_overrides=bad)
        assert ad.effective_schedule(s, SAT1)["end_time"] == "17:00"


def test_alternate_saturdays_from_an_anchor():
    s = dict(WEEK, rota="alternate", rota_anchor=SAT1)
    assert ad.is_workday(s, SAT1) is True
    assert ad.is_workday(s, SAT2) is False
    assert ad.is_workday(s, SAT3) is True
    # Backwards too: the Saturday before the anchor is off, two before is on.
    assert ad.is_workday(s, "2026-09-12") is False
    assert ad.is_workday(s, "2026-09-05") is True
    # An anchor given as a weekday means the Saturday of that week.
    s2 = dict(WEEK, rota="alternate", rota_anchor="2026-09-16")
    assert ad.is_workday(s2, SAT1) is True


def test_the_other_group_is_the_other_anchor():
    a = dict(WEEK, rota="alternate", rota_anchor=SAT1)
    b = dict(WEEK, rota="alternate", rota_anchor=SAT2)
    for sat in (SAT1, SAT2, SAT3):
        assert ad.is_workday(a, sat) != ad.is_workday(b, sat)


def test_an_off_saturday_is_a_day_off_not_an_absence():
    s = dict(WEEK, rota="alternate", rota_anchor=SAT1)
    assert ad.derive_day([], s, SAT2) is None                       # no row at all
    assert ad.derive_day([], s, SAT1)["status"] == "Absent"         # they were due
    # Coming in on an off Saturday is recorded as extra, not judged.
    extra = ad.derive_day([f"{SAT2} 09:00:00", f"{SAT2} 13:00:00"], s, SAT2)
    assert extra["status"] == "Present" and "non-working" in extra["note"]


def test_rota_all_and_none_override_the_schedule_on_saturdays_only():
    weekdays_only = dict(WEEK, workdays="1,2,3,4,5")
    assert ad.is_workday(dict(weekdays_only, rota="all"), SAT1) is True
    assert ad.is_workday(dict(WEEK, rota="none"), SAT1) is False
    # Monday is never the rota's business.
    assert ad.is_workday(dict(weekdays_only, rota="none"), MON) is True
    # No rota: the schedule decides, as it always did.
    assert ad.is_workday(weekdays_only, SAT1) is False
    assert ad.is_workday(WEEK, SAT1) is True


# ── through the API ──────────────────────────────────────────────────────────
def _schedule(c, name, end, default=False):
    r = c.post("/api/hr/timeclock/schedules", json={
        "name": name, "start_time": "09:00", "end_time": end, "is_default": default,
        "min_hours_full_day": 6, "workdays": "1,2,3,4,5,6",
        "day_overrides": SAT_OVERRIDE})
    assert r.status_code in (200, 201), r.text
    return r.json()


def _employee(c, name, **extra):
    r = c.post("/api/hr/employees", json={"full_name": name, **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_a_schedule_keeps_its_saturday_hours(as_role, db):
    owner = as_role("superadmin")
    s = _schedule(owner, "9 to 5", "17:00", default=True)
    assert '"6"' in (s["day_overrides"] or "")
    emp = _employee(owner, "Rami")
    sched = attendance_sync.schedule_for(db, emp)
    assert ad.effective_schedule(sched, SAT1)["end_time"] == "13:00"
    assert ad.effective_schedule(sched, MON)["end_time"] == "17:00"

    # Editing keeps them; clearing removes them.
    r = owner.put(f"/api/hr/timeclock/schedules/{s['id']}", json={
        "name": "9 to 5", "start_time": "09:00", "end_time": "17:00", "is_default": True,
        "min_hours_full_day": 6, "workdays": "1,2,3,4,5,6", "day_overrides": {}})
    assert r.status_code == 200, r.text
    assert r.json()["day_overrides"] is None


def test_bad_override_input_is_refused(as_role):
    owner = as_role("superadmin")
    for bad in ({"9": {"end_time": "13:00"}}, {"6": {"end_time": "1pm"}},
                {"6": {"grace_minutes": -5}}):
        r = owner.post("/api/hr/timeclock/schedules", json={
            "name": "x", "start_time": "09:00", "end_time": "17:00", "day_overrides": bad})
        assert r.status_code == 400, (bad, r.text)


def test_the_employee_rota_reaches_the_derivation(as_role, db):
    owner = as_role("superadmin")
    _schedule(owner, "9 to 3", "15:00", default=True)
    group_a = _employee(owner, "Nour", saturday_rota="alternate", saturday_rota_anchor=SAT1)
    group_b = _employee(owner, "Sami", saturday_rota="alternate", saturday_rota_anchor=SAT2)
    every = _employee(owner, "Rami")
    never = _employee(owner, "Lina", saturday_rota="none")

    sa, sb = attendance_sync.schedule_for(db, group_a), attendance_sync.schedule_for(db, group_b)
    assert ad.is_workday(sa, SAT1) and not ad.is_workday(sb, SAT1)
    assert not ad.is_workday(sa, SAT2) and ad.is_workday(sb, SAT2)
    assert ad.is_workday(attendance_sync.schedule_for(db, every), SAT1)
    assert not ad.is_workday(attendance_sync.schedule_for(db, never), SAT1)

    # The record reads back, and can be cleared.
    e = owner.get(f"/api/hr/employees/{group_a}").json()
    assert e["saturday_rota"] == "alternate" and e["saturday_rota_anchor"] == SAT1
    r = owner.put(f"/api/hr/employees/{group_a}", json={"full_name": "Nour", "saturday_rota": None})
    assert r.status_code == 200, r.text
    e = owner.get(f"/api/hr/employees/{group_a}").json()
    assert e["saturday_rota"] is None and e["saturday_rota_anchor"] is None


def test_an_alternate_rota_needs_its_anchor(as_role):
    owner = as_role("superadmin")
    r = owner.post("/api/hr/employees", json={"full_name": "X", "saturday_rota": "alternate"})
    assert r.status_code == 422
    r = owner.post("/api/hr/employees", json={"full_name": "X", "saturday_rota": "fortnightly"})
    assert r.status_code == 422
