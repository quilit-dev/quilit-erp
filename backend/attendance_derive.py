"""Turning punch times into a day.

A fingerprint reader records instants. Payroll needs a day: was this person
here, were they late, how many hours. Everything in this module is the
translation between those two, and it is deliberately a PURE function so the
arguing about the rules can happen in a test file rather than through HTTP.

The rules that matter, and why they are what they are:

* **Pairing is by alternation**, not by the terminal's IN/OUT flag. The flag
  only carries meaning if somebody configured the device's function keys, and
  on most sites every record comes back with the same value. The raw flag is
  stored on the punch row so this rule can be tightened later without having to
  re-collect a month of data.

* **A missing check-out is never guessed.** It would be easy to close an open
  day at the scheduled finish time and get a tidy number. That number would be
  invented, and for an hourly employee invented hours are invented money. An
  unpaired punch leaves `hours` as None and raises `needs_review` instead.

* **`hours` is None, not 0, when nothing can be computed.** `_hours_worked` in
  routers/hr.py is `COALESCE(SUM(hours), 0)` and SQL `SUM` skips NULLs, so a
  half-finished day contributes nothing. A zero would contribute a claim.

* **Half-day beats Late.** Both can be true at once; only one can be the
  status. Half-day is the one that carries meaning for pay, and the lateness is
  still visible from `first_in` sitting beside the schedule.

* **`Leave` is never derived.** A person on approved leave does not punch, and
  a clock cannot tell that from an absence. Leave is by definition typed by a
  human, which in this design also means the clock will not overwrite it.

The caller decides which of these values are allowed to land on a row --- see
the source/'manual' rule in routers/hr.py. This module only computes.
"""
from datetime import datetime, timedelta

# Two punches this close together are one event: people press again when the
# reader does not beep, and a second finger read 4 seconds later is not a
# check-out followed by a check-in.
DEBOUNCE_SECONDS = 60

# How far past the scheduled end of an overnight shift a punch can fall and
# still belong to the shift that started the day before.
_OVERNIGHT_TAIL_MINUTES = 120

# Used when a tenant has no default schedule row. The migration deliberately
# seeds none --- a migration that INSERTs is one that can insert twice --- so
# the fallback lives here, in the same "opt-in, sensible default" shape
# _payroll_settings already uses for the payroll percentages.
DEFAULT_SCHEDULE = {
    "start_time": "08:00",
    "end_time": "17:00",
    "break_minutes": 0,
    "grace_minutes": 15,
    "min_hours_full_day": 6.0,
    "workdays": "1,2,3,4,5",
    "crosses_midnight": 0,
}


# ── small parsers ────────────────────────────────────────────────────────────
def _minutes(hhmm, default=0):
    """'08:30' -> 510. Anything unparseable falls back rather than raising:
    a malformed schedule must not be able to take down an ingest."""
    try:
        parts = str(hhmm).strip().split(":")
        return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, IndexError, AttributeError):
        return default


def _dt(value):
    """A punch instant, from a datetime or a 'YYYY-MM-DD HH:MM:SS' string."""
    if isinstance(value, datetime):
        return value
    s = str(value).strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s[:19] if len(s) >= 19 else s, fmt)
        except ValueError:
            continue
    raise ValueError("unrecognised punch time: %r" % (value,))


def schedule_or_default(schedule):
    """Fill any missing key from DEFAULT_SCHEDULE, so a partially-populated row
    (or None) still describes a whole working day."""
    out = dict(DEFAULT_SCHEDULE)
    for k, v in (schedule or {}).items():
        if v is not None and k in out:
            out[k] = v
    return out


def workday_numbers(schedule):
    """{1..7}, Monday = 1, matching ISO weekday numbering."""
    raw = str(schedule_or_default(schedule)["workdays"] or "")
    days = set()
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit() and 1 <= int(part) <= 7:
            days.add(int(part))
    return days


def is_workday(schedule, date_str):
    return _dt(str(date_str)[:10] + " 00:00:00").isoweekday() in \
        workday_numbers(schedule)


def business_date_for(punched_at, schedule):
    """Which working day a punch belongs to.

    For an ordinary schedule this is just the calendar date. For a shift that
    crosses midnight it is not: a 20:00-04:00 shift's 03:50 check-out belongs
    to the day the shift STARTED, and filing it under its own calendar date
    would split one night into two broken half-days.

    This is computed at derivation time rather than stored on the punch, so
    that correcting a schedule fixes punches that were already recorded.
    """
    sched = schedule_or_default(schedule)
    when = _dt(punched_at)
    if not int(sched["crosses_midnight"] or 0):
        return when.strftime("%Y-%m-%d")
    cutoff = (_minutes(sched["end_time"], 17 * 60) + _OVERNIGHT_TAIL_MINUTES) % (24 * 60)
    if when.hour * 60 + when.minute < cutoff:
        return (when - timedelta(days=1)).strftime("%Y-%m-%d")
    return when.strftime("%Y-%m-%d")


# ── pairing ──────────────────────────────────────────────────────────────────
def debounce(times, seconds=DEBOUNCE_SECONDS):
    """Collapse repeat reads. Input need not be sorted."""
    out = []
    for t in sorted(_dt(x) for x in times):
        if out and (t - out[-1]).total_seconds() < seconds:
            continue
        out.append(t)
    return out


def pair_punches(times):
    """Alternate in/out. Returns (pairs, unpaired_tail).

    An odd count leaves the last punch unpaired, and it stays that way --- the
    caller reports it rather than closing it at a guessed time.
    """
    pairs = [(times[i], times[i + 1]) for i in range(0, len(times) - 1, 2)]
    tail = times[-1] if len(times) % 2 else None
    return pairs, tail


# ── the day ──────────────────────────────────────────────────────────────────
def derive_day(punches, schedule, business_date):
    """What the clock says about one employee on one day.

    Returns a dict, or **None** meaning "no row should exist for this day" ---
    which is the case for a day off with no punches on it. Writing an Absent
    row for every weekend would put a hundred false absences a year against
    every employee and move the technician report for the whole company.

    Keys: status, hours, first_in, last_out, device_hours, punch_count,
    needs_review, note.
    """
    sched = schedule_or_default(schedule)
    times = debounce(punches or [])
    working = is_workday(sched, business_date)

    if not times:
        if not working:
            return None
        return {
            "status": "Absent", "hours": None,
            "first_in": None, "last_out": None, "device_hours": None,
            "punch_count": 0, "needs_review": 0, "note": None,
        }

    pairs, tail = pair_punches(times)
    notes = []

    hours = None
    if pairs:
        worked = sum((b - a).total_seconds() for a, b in pairs) / 3600.0
        # An unpaid break is deducted ONLY when the day is one unbroken stretch.
        # If somebody punched out for lunch and back in, that break is already
        # missing from the arithmetic above, and subtracting it again would
        # take the same half hour off twice --- which for an hourly employee is
        # money they worked for.
        if len(pairs) == 1:
            worked -= float(sched["break_minutes"] or 0) / 60.0
        hours = round(max(0.0, worked), 2)

    if tail is not None:
        notes.append("Missing check-out")

    first_in = times[0]
    last_out = pairs[-1][1] if pairs else None

    if not working:
        status = "Present"
        notes.append("Worked a non-working day")
    elif hours is not None and hours < float(sched["min_hours_full_day"] or 0):
        # Deliberately ahead of the Late check: both can be true, and this is
        # the one that means something for pay.
        status = "Half-day"
    elif (first_in.hour * 60 + first_in.minute) > (
            _minutes(sched["start_time"], 8 * 60) + int(sched["grace_minutes"] or 0)):
        status = "Late"
    else:
        status = "Present"

    return {
        "status": status,
        "hours": hours,
        "first_in": first_in.strftime("%H:%M:%S"),
        "last_out": last_out.strftime("%H:%M:%S") if last_out else None,
        "device_hours": hours,
        "punch_count": len(times),
        "needs_review": 1 if tail is not None else 0,
        "note": "; ".join(notes) or None,
    }
