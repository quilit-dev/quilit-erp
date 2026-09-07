"""What the clock says a day was.

These are the rules that decide someone's pay, so they are tested against the
pure function rather than through HTTP: every case below is a real thing that
happens on a shop floor, and each one is here because the obvious
implementation gets it wrong in a way nobody would notice until a payslip was
already out.

The two that matter most:

  * a day with a missing check-out must NOT be closed at the scheduled finish
    time, because the tidy number that produces is invented, and
  * an unreadable day yields ``hours = None``, never 0 --- `_hours_worked` is
    ``COALESCE(SUM(hours), 0)`` and SQL SUM skips NULLs, so None contributes
    nothing while 0 contributes a claim that the person worked no hours.
"""
import pytest

import attendance_derive as ad


@pytest.fixture(autouse=True)
def fresh_db():
    """Override conftest's autouse database rebuild.

    Everything in this file is a pure function over times and a schedule. The
    shared fixture rebuilds and re-seeds the whole SQLite database before every
    single test, which for these twenty-odd cases would be seconds of work to
    set up a database not one of them touches.
    """
    yield

# 2026-09-07 is a Monday, 2026-09-12 a Saturday. Every date below is chosen so
# the weekday is part of the assertion rather than an accident.
MON = "2026-09-07"
SAT = "2026-09-12"

OFFICE = {
    "start_time": "08:00", "end_time": "17:00", "break_minutes": 0,
    "grace_minutes": 15, "min_hours_full_day": 6.0,
    "workdays": "1,2,3,4,5", "crosses_midnight": 0,
}
NIGHT = dict(OFFICE, start_time="20:00", end_time="04:00", crosses_midnight=1)


def at(date, *times):
    return ["%s %s" % (date, t) for t in times]


# ── an ordinary day ──────────────────────────────────────────────────────────
def test_a_clean_day_is_present_with_its_hours():
    d = ad.derive_day(at(MON, "07:58:00", "17:02:00"), OFFICE, MON)
    assert d["status"] == "Present"
    assert d["hours"] == pytest.approx(9.07, abs=0.01)
    assert d["first_in"] == "07:58:00"
    assert d["last_out"] == "17:02:00"
    assert d["needs_review"] == 0
    assert d["punch_count"] == 2


def test_a_lunch_break_falls_out_of_the_arithmetic():
    # Four punches, one day. Pairing handles the break with no special case:
    # the hour they were out is simply not inside either pair.
    d = ad.derive_day(
        at(MON, "08:00:00", "12:00:00", "13:00:00", "17:00:00"), OFFICE, MON)
    assert d["hours"] == pytest.approx(8.0)
    assert d["first_in"] == "08:00:00"
    assert d["last_out"] == "17:00:00"
    assert d["punch_count"] == 4
    assert d["needs_review"] == 0


def test_the_day_is_one_row_however_many_times_they_came_and_went():
    d = ad.derive_day(
        at(MON, "08:00:00", "10:00:00", "10:30:00", "12:00:00",
           "13:00:00", "17:00:00"), OFFICE, MON)
    assert d["hours"] == pytest.approx(7.5)
    assert d["status"] == "Present"


# ── the day that cannot be read ──────────────────────────────────────────────
def test_a_missing_check_out_is_never_guessed():
    # The tempting fix is to close the day at 17:00 and report 9 hours. That
    # number would be invented, and for an hourly employee invented hours are
    # invented money. It is flagged instead.
    d = ad.derive_day(at(MON, "08:00:00"), OFFICE, MON)
    assert d["hours"] is None, "an open day must not be given a length"
    assert d["last_out"] is None
    assert d["needs_review"] == 1
    assert "Missing check-out" in d["note"]
    assert d["status"] == "Present", "they turned up; that much is known"


def test_an_odd_punch_count_keeps_only_the_complete_pairs():
    # In, out, in --- and then nothing. Four hours are known; the rest is not.
    d = ad.derive_day(at(MON, "08:00:00", "12:00:00", "13:00:00"), OFFICE, MON)
    assert d["hours"] == pytest.approx(4.0)
    assert d["last_out"] == "12:00:00"
    assert d["needs_review"] == 1


def test_an_unreadable_day_yields_none_and_not_zero():
    # This is the assertion that protects payroll. `_hours_worked` sums the
    # column, and SUM skips NULLs --- so None contributes nothing, while 0
    # would contribute the claim that this person worked no hours that day.
    # `== 0` would pass for None in some languages and not in Python, so the
    # identity check is the one that says what is meant.
    d = ad.derive_day(at(MON, "09:00:00"), OFFICE, MON)
    assert d["hours"] is None, "an unreadable day must not report a number"


# ── status ───────────────────────────────────────────────────────────────────
def test_arrival_inside_the_grace_period_is_not_late():
    assert ad.derive_day(at(MON, "08:15:00", "17:00:00"),
                         OFFICE, MON)["status"] == "Present"


def test_one_minute_past_grace_is_late():
    assert ad.derive_day(at(MON, "08:16:00", "17:00:00"),
                         OFFICE, MON)["status"] == "Late"


def test_half_day_beats_late():
    # Arrived at 11:00 (late) and left at 14:00 (three hours, under the
    # threshold). Both are true; only one can be the status, and it has to be
    # the one that carries meaning for pay. The lateness stays visible in
    # first_in.
    d = ad.derive_day(at(MON, "11:00:00", "14:00:00"), OFFICE, MON)
    assert d["status"] == "Half-day"
    assert d["first_in"] == "11:00:00"


def test_no_punches_on_a_working_day_is_absent():
    d = ad.derive_day([], OFFICE, MON)
    assert d["status"] == "Absent"
    assert d["hours"] is None


def test_no_punches_on_a_day_off_writes_no_row_at_all():
    # A hundred Absent weekends a year against every employee would be noise,
    # and it would move `days_present` in the technician report for the whole
    # company.
    assert ad.derive_day([], OFFICE, SAT) is None


def test_working_a_day_off_is_recorded_and_said_so():
    d = ad.derive_day(at(SAT, "09:00:00", "13:00:00"), OFFICE, SAT)
    assert d is not None
    assert d["status"] == "Present", "not Half-day: no day was expected of them"
    assert d["hours"] == pytest.approx(4.0)
    assert "non-working day" in d["note"]


# ── the night shift ──────────────────────────────────────────────────────────
def test_a_night_shift_is_one_day_not_two_broken_halves():
    # 20:05 on Monday to 03:50 on Tuesday is ONE shift. Filing the check-out
    # under its own calendar date would leave two days that each look like a
    # missing punch.
    punches = at(MON, "20:05:00") + at("2026-09-08", "03:50:00")
    for p in punches:
        assert ad.business_date_for(p, NIGHT) == MON

    d = ad.derive_day(punches, NIGHT, MON)
    assert d["hours"] == pytest.approx(7.75, abs=0.01)
    assert d["needs_review"] == 0
    assert d["first_in"] == "20:05:00"
    assert d["last_out"] == "03:50:00"


def test_the_schedule_is_what_decides_it_not_the_punches():
    # The same two punches under a NON-crossing schedule are two broken days.
    # This is what proves the business day comes from the schedule and is not
    # inferred from the data --- which is why it is derived rather than frozen
    # onto the punch row when it arrives.
    punches = at(MON, "20:05:00") + at("2026-09-08", "03:50:00")
    assert ad.business_date_for(punches[0], OFFICE) == MON
    assert ad.business_date_for(punches[1], OFFICE) == "2026-09-08"

    monday = ad.derive_day(at(MON, "20:05:00"), OFFICE, MON)
    assert monday["needs_review"] == 1 and monday["hours"] is None


def test_an_ordinary_schedule_never_moves_a_punch():
    for t in ("00:30:00", "08:00:00", "23:59:00"):
        assert ad.business_date_for("%s %s" % (MON, t), OFFICE) == MON


# ── the reader that beeped twice ─────────────────────────────────────────────
def test_a_double_tap_is_one_event():
    # People press again when the reader does not beep. Counted as two, the
    # second read becomes a check-out four seconds after arriving.
    d = ad.derive_day(
        at(MON, "08:00:00", "08:00:04", "17:00:00"), OFFICE, MON)
    assert d["punch_count"] == 2
    assert d["hours"] == pytest.approx(9.0)
    assert d["needs_review"] == 0


def test_punches_need_not_arrive_in_order():
    # The agent batches whatever the device gives it; the order is not a
    # promise.
    d = ad.derive_day(at(MON, "17:00:00", "08:00:00"), OFFICE, MON)
    assert d["first_in"] == "08:00:00" and d["last_out"] == "17:00:00"
    assert d["hours"] == pytest.approx(9.0)


# ── the unpaid break ─────────────────────────────────────────────────────────
def test_an_unpaid_break_is_deducted_from_an_unbroken_day():
    sched = dict(OFFICE, break_minutes=60)
    d = ad.derive_day(at(MON, "08:00:00", "17:00:00"), sched, MON)
    assert d["hours"] == pytest.approx(8.0)


def test_it_is_not_deducted_twice_when_they_punched_out_for_it():
    # They clocked out for lunch, so the hour is already missing from the
    # pairs. Subtracting the configured break as well would take the same hour
    # off twice --- an hour they were paid for yesterday and not today, with
    # nothing on screen to explain the difference.
    sched = dict(OFFICE, break_minutes=60)
    d = ad.derive_day(
        at(MON, "08:00:00", "12:00:00", "13:00:00", "17:00:00"), sched, MON)
    assert d["hours"] == pytest.approx(8.0)


# ── defaults and bad input ───────────────────────────────────────────────────
def test_a_tenant_with_no_schedule_still_gets_a_working_day():
    # The migration seeds no default row on purpose, so None has to be a
    # complete schedule rather than a crash.
    d = ad.derive_day(at(MON, "08:00:00", "17:00:00"), None, MON)
    assert d["status"] == "Present" and d["hours"] == pytest.approx(9.0)
    assert ad.derive_day([], None, SAT) is None


def test_a_half_written_schedule_is_completed_not_rejected():
    d = ad.derive_day(at(MON, "09:00:00", "17:00:00"),
                      {"start_time": "09:00"}, MON)
    assert d["status"] == "Present"


def test_a_malformed_time_does_not_take_the_ingest_down():
    # A schedule is configuration a human typed. It must not be able to stop
    # punches being recorded.
    d = ad.derive_day(at(MON, "08:00:00", "17:00:00"),
                      dict(OFFICE, start_time="not a time"), MON)
    assert d["status"] in ("Present", "Late")
    assert d["hours"] == pytest.approx(9.0)


def test_workdays_parses_to_iso_weekdays():
    assert ad.workday_numbers(OFFICE) == {1, 2, 3, 4, 5}
    assert ad.workday_numbers({"workdays": "6,7"}) == {6, 7}
    assert ad.is_workday(OFFICE, MON) and not ad.is_workday(OFFICE, SAT)
    assert ad.is_workday({"workdays": "6,7"}, SAT)
