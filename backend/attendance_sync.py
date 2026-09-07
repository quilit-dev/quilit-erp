"""Landing derived days on hr_attendance without stepping on anybody.

attendance_derive.py works out what a day was. This module decides whether that
answer is allowed to be written down, which is the delicate half: hr_attendance
is UNIQUE(employee_id, date), so a derived day and a day somebody typed compete
for one row, and that row already pays hourly staff through `_hours_worked`.

Three rules, in the order they are applied.

**The switch.** Nothing here writes anything until a tenant sets
`attendance_source` to 'device'. Punches are stored regardless, so a customer
can install the agent, watch a week of real data arrive, and only then turn the
automation on --- and until they do, every existing tenant behaves exactly as
it did before any of this shipped.

**The row remembers who wrote it.** `hr_attendance.source` defaults to 'manual',
so every row that already existed is owned by a human by default. Derivation
will update a manual row's *observational* columns --- first_in, last_out,
device_hours, punch_count --- because showing "you typed 8, the clock says 7.5"
is what makes the feature trustworthy. It will never touch that row's status,
hours or note. Editing a day is how a manager takes it back off the clock, and
that has to actually mean something.

**A paid period is closed.** If an Approved or Paid payroll run covers the date,
the pay-affecting columns are left alone whatever the punches now say. Rules get
corrected; payslips that have already been handed over do not get to change
meaning underneath the person who received one.

One more guard, which is not obvious until you watch it go wrong: derivation
only ever reaches an employee **from their first punch onwards**. Without that,
switching the feature on and re-deriving a past month would mark every employee
Absent for every working day before the clock was installed --- a hundred false
absences, on the screen a manager uses to decide who gets paid.
"""
import sqlite3
from datetime import datetime, timedelta

import attendance_derive as ad

SETTING_KEY = "attendance_source"

# Runs in these states have been signed off; a re-derivation must not move the
# numbers underneath them.
_CLOSED_RUN_STATUSES = ("Approved", "Paid")


def attendance_source(db) -> str:
    """'manual' (the default, and every tenant today) or 'device'."""
    try:
        row = db.execute("SELECT value FROM settings WHERE key=?",
                         (SETTING_KEY,)).fetchone()
    except sqlite3.OperationalError:
        return "manual"
    return (row["value"] if row and row["value"] else "manual").strip() or "manual"


def device_attendance_enabled(db) -> bool:
    return attendance_source(db) == "device"


def schedule_for(db, employee_id: int) -> dict:
    """The employee's own schedule, else the company default, else the built-in.

    The migration seeds no default row on purpose --- a migration that INSERTs is
    one that can insert twice, and the Postgres half runs on every boot --- so
    falling through to attendance_derive.DEFAULT_SCHEDULE is the normal case on
    a tenant that has not configured anything yet, not an error path.
    """
    row = db.execute(
        "SELECT s.* FROM work_schedules s "
        "  JOIN hr_employees e ON e.work_schedule_id = s.id "
        " WHERE e.id = ? AND s.archived_at IS NULL", (employee_id,)).fetchone()
    if row is None:
        row = db.execute(
            "SELECT * FROM work_schedules "
            " WHERE is_default = 1 AND archived_at IS NULL "
            " ORDER BY id LIMIT 1").fetchone()
    return ad.schedule_or_default(dict(row) if row else None)


def _period_is_closed(db, day: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM hr_payroll_runs "
        " WHERE archived_at IS NULL AND status IN (%s) "
        "   AND ? BETWEEN period_start AND period_end LIMIT 1"
        % ",".join("?" * len(_CLOSED_RUN_STATUSES)),
        tuple(_CLOSED_RUN_STATUSES) + (day,)).fetchone()
    return row is not None


def _first_punch_date(db, employee_id: int):
    row = db.execute(
        "SELECT MIN(local_date) d FROM time_punches WHERE employee_id = ?",
        (employee_id,)).fetchone()
    return row["d"] if row and row["d"] else None


def _upsert_derived(db, employee_id: int, day: str, derived, now: str) -> str:
    """Write one derived day. Returns what happened, for the caller's counters.

    'skipped'    nothing to write, or a day that should carry no row at all
    'observed'   a human owns this row; only the clock's own columns moved
    'locked'     a signed-off payroll run covers it; pay inputs left alone
    'written'    the clock owns this row and it was updated in full
    """
    row = db.execute(
        "SELECT * FROM hr_attendance WHERE employee_id=? AND date=?",
        (employee_id, day)).fetchone()

    if derived is None:
        # A day off with no punches carries no row. If one already exists it was
        # put there by a person, and removing somebody's record is not this
        # module's business.
        return "skipped"

    obs = (derived["first_in"], derived["last_out"], derived["device_hours"],
           derived["punch_count"], derived["needs_review"], now)

    if row is None:
        db.execute(
            "INSERT INTO hr_attendance "
            "(employee_id, date, status, hours, note, source, first_in, last_out,"
            " device_hours, punch_count, needs_review, created_at, updated_at) "
            "VALUES (?,?,?,?,?,'device',?,?,?,?,?,?,?)",
            (employee_id, day, derived["status"], derived["hours"],
             derived["note"], derived["first_in"], derived["last_out"],
             derived["device_hours"], derived["punch_count"],
             derived["needs_review"], now, now))
        return "written"

    # A human owns this row. Show what the clock saw beside what they typed, and
    # touch nothing that decides pay.
    if (row["source"] or "manual") != "device":
        db.execute(
            "UPDATE hr_attendance SET first_in=?, last_out=?, device_hours=?, "
            " punch_count=?, needs_review=?, updated_at=? "
            " WHERE employee_id=? AND date=?", obs + (employee_id, day))
        return "observed"

    if _period_is_closed(db, day):
        # Same treatment as a manual row: the figures stay, the observation is
        # kept, and needs_review says the two no longer agree.
        # obs[:4] deliberately stops short of needs_review: the statement sets
        # it to 1 itself, because the whole point of a locked day is that the
        # clock and the payslip no longer agree and somebody should look.
        db.execute(
            "UPDATE hr_attendance SET first_in=?, last_out=?, device_hours=?, "
            " punch_count=?, needs_review=1, updated_at=? "
            " WHERE employee_id=? AND date=?", obs[:4] + (now, employee_id, day))
        return "locked"

    db.execute(
        "UPDATE hr_attendance SET status=?, hours=?, note=?, source='device', "
        " first_in=?, last_out=?, device_hours=?, punch_count=?, needs_review=?, "
        " updated_at=? WHERE employee_id=? AND date=?",
        (derived["status"], derived["hours"], derived["note"]) + obs
        + (employee_id, day))
    return "written"


def _days(start: str, end: str):
    a = datetime.strptime(start[:10], "%Y-%m-%d")
    b = datetime.strptime(end[:10], "%Y-%m-%d")
    while a <= b:
        yield a.strftime("%Y-%m-%d")
        a += timedelta(days=1)


def derive_range(db, start: str, end: str, employee_ids=None) -> dict:
    """Recompute attendance from punches over a date range.

    Only employees who have punches are considered --- somebody who has never
    touched the reader is not on the clock, and inventing Absent rows for them
    would be a lie told in the one place a manager checks before paying people.
    """
    if not device_attendance_enabled(db):
        return {"enabled": False, "written": 0, "observed": 0,
                "locked": 0, "skipped": 0, "employees": 0}

    start, end = start[:10], end[:10]
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    sql = ("SELECT DISTINCT employee_id FROM time_punches "
           " WHERE employee_id IS NOT NULL")
    params = []
    if employee_ids:
        sql += " AND employee_id IN (%s)" % ",".join("?" * len(employee_ids))
        params += list(employee_ids)
    people = [r["employee_id"] for r in db.execute(sql, tuple(params)).fetchall()]

    counts = {"enabled": True, "written": 0, "observed": 0, "locked": 0,
              "skipped": 0, "employees": len(people)}

    for emp in people:
        first = _first_punch_date(db, emp)
        if first is None:
            continue
        sched = schedule_for(db, emp)

        # A day either side, so a night shift's punches are all in hand when the
        # business day they belong to is worked out.
        rows = db.execute(
            "SELECT punched_at FROM time_punches "
            " WHERE employee_id=? AND local_date BETWEEN ? AND ? "
            " ORDER BY punched_at",
            (emp,
             (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=1)
              ).strftime("%Y-%m-%d"),
             (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)
              ).strftime("%Y-%m-%d"))).fetchall()

        by_day = {}
        for r in rows:
            by_day.setdefault(
                ad.business_date_for(r["punched_at"], sched), []
            ).append(r["punched_at"])

        for day in _days(start, end):
            # Never before their first punch: the clock has nothing to say about
            # a time it was not there for.
            if day < first:
                counts["skipped"] += 1
                continue
            derived = ad.derive_day(by_day.get(day, []), sched, day)
            counts[_upsert_derived(db, emp, day, derived, now)] += 1

    return counts


def derive_for_punches(db, employee_ids, days) -> dict:
    """Re-derive exactly the (employee, day) pairs a batch of punches touched.

    Called from ingest, which is what makes the whole thing work without a
    scheduler --- the codebase has none, and `recurring.py` sets the precedent
    that time-based work is driven by a request rather than a daemon.
    """
    if not employee_ids or not days:
        return {"enabled": device_attendance_enabled(db), "written": 0,
                "observed": 0, "locked": 0, "skipped": 0, "employees": 0}
    return derive_range(db, min(days), max(days), employee_ids=list(employee_ids))
