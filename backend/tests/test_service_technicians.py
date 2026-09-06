"""Who attended a service job, and what that adds up to at month end.

A job was assigned to a system USER — someone with a login. Field technicians
normally have none, so the picker offered every accountant and manager in the
company and the one person who actually held the spanner could not be recorded
at all. And a job routinely takes two people, which one column cannot say.

The crew is drawn from `hr_employees` now, through `service_job_technicians`,
and a job can carry several. What these tests are really guarding is the
arithmetic that falls out of that:

  * a two-man job counts once for EACH technician, and once for the business;
  * so the per-technician column legitimately adds up to more than the job
    count, and the header total must never be derived from it;
  * `value_attended` is the worth of the jobs a person was on, not a share of
    the revenue. Two technicians on one $500 job is still $500.

Getting that wrong produces a report whose columns do not reconcile, which is
worse than no report: it is a number somebody will quote in a meeting.
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


# ── helpers ─────────────────────────────────────────────────────────────────
def _employee(c, name, title="Technician", **extra):
    r = c.post("/api/hr/employees", json={
        "full_name": f"{name} {uuid.uuid4().hex[:5]}", "job_title": title,
        "status": "Active", **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _client_id(c):
    r = c.post("/api/clients/", json={"name": f"Svc Co {uuid.uuid4().hex[:5]}"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _job(c, client_id, technician_ids=(), **extra):
    r = c.post("/api/service/jobs", json={
        "client_id": client_id, "job_type": "Repair",
        "reported_fault": "Will not start",
        "technician_ids": list(technician_ids), **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _get(c, job_id):
    r = c.get(f"/api/service/jobs/{job_id}")
    assert r.status_code == 200, r.text
    return r.json()


def _complete(c, job_id):
    r = c.post(f"/api/service/jobs/{job_id}/complete")
    assert r.status_code == 200, r.text
    return r


def _report(c, **params):
    r = c.get("/api/reports/service-jobs", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _row(rep, employee_id):
    return next((t for t in rep["by_technician"] if t["employee_id"] == employee_id),
                None)


# ── the crew ────────────────────────────────────────────────────────────────
def test_a_job_records_every_technician_who_attended(make_client):
    c = make_client("superadmin")
    a, b = _employee(c, "Sami"), _employee(c, "Rami")
    job = _job(c, _client_id(c), [a, b])

    names = {t["id"] for t in _get(c, job)["technicians"]}
    assert names == {a, b}, "both people were on the call"


def test_the_same_person_cannot_be_added_twice(make_client, db):
    """A double-click must not inflate anybody's month."""
    c = make_client("superadmin")
    a = _employee(c, "Sami")
    job = _job(c, _client_id(c), [a, a])

    assert len(_get(c, job)["technicians"]) == 1
    n = db.execute("SELECT COUNT(*) n FROM service_job_technicians WHERE job_id=?",
                   (job,)).fetchone()["n"]
    assert n == 1, "the crew table must hold one row per person per job"


def test_an_unknown_or_archived_technician_is_refused(make_client):
    c = make_client("superadmin")
    cid = _client_id(c)
    r = c.post("/api/service/jobs", json={
        "client_id": cid, "job_type": "Repair", "technician_ids": [999999]})
    assert r.status_code == 400
    assert "999999" in r.text


def test_editing_the_crew_replaces_it_rather_than_adding(make_client):
    c = make_client("superadmin")
    a, b, d = _employee(c, "Sami"), _employee(c, "Rami"), _employee(c, "Nadia")
    cid = _client_id(c)
    job = _job(c, cid, [a, b])

    r = c.put(f"/api/service/jobs/{job}", json={
        "client_id": cid, "job_type": "Repair", "technician_ids": [d]})
    assert r.status_code == 200, r.text
    assert {t["id"] for t in _get(c, job)["technicians"]} == {d}


def test_saying_nothing_about_the_crew_leaves_it_alone(make_client):
    """`None` means "this request is not about the crew" — as with the lines."""
    c = make_client("superadmin")
    a = _employee(c, "Sami")
    cid = _client_id(c)
    job = _job(c, cid, [a])

    r = c.put(f"/api/service/jobs/{job}",
              json={"client_id": cid, "job_type": "Maintenance"})
    assert r.status_code == 200, r.text
    assert {t["id"] for t in _get(c, job)["technicians"]} == {a}


def test_a_technician_with_no_login_does_not_break_assignment(make_client, db):
    """The whole point: a technician normally has no user account.

    Notification looks up hr_employees.user_id and must silently skip anyone
    without one rather than failing the save.
    """
    c = make_client("superadmin")
    a = _employee(c, "No Login")
    assert db.execute("SELECT user_id FROM hr_employees WHERE id=?",
                      (a,)).fetchone()["user_id"] is None
    job = _job(c, _client_id(c), [a])
    assert len(_get(c, job)["technicians"]) == 1

    # And it must not leave a notification addressed to nobody. `notify` writes
    # the row whatever it is handed, so passing a null user_id creates one that
    # no inbox will ever show and no one will ever clear.
    orphan = db.execute(
        "SELECT COUNT(*) n FROM notifications "
        "WHERE entity_type='service_job' AND entity_id=? AND user_id IS NULL",
        (job,)).fetchone()["n"]
    assert orphan == 0, "a technician with no login must produce no notification"


# ── the month-end figures ───────────────────────────────────────────────────
def test_each_technician_is_credited_for_a_job_they_shared(make_client):
    c = make_client("superadmin")
    a, b = _employee(c, "Sami"), _employee(c, "Rami")
    job = _job(c, _client_id(c), [a, b])
    _complete(c, job)

    rep = _report(c)
    assert _row(rep, a)["jobs"] == 1
    assert _row(rep, b)["jobs"] == 1


def test_the_header_total_counts_a_shared_job_once(make_client):
    """The arithmetic this whole file exists for.

    Two technicians, one job: each is credited, the business completed ONE.
    Deriving the header by summing the technician column would report two.
    """
    c = make_client("superadmin")
    a, b = _employee(c, "Sami"), _employee(c, "Rami")
    before = _report(c)["totals"]["completed_jobs"]
    job = _job(c, _client_id(c), [a, b])
    _complete(c, job)

    rep = _report(c)
    assert rep["totals"]["completed_jobs"] == before + 1, \
        "one job was completed, whoever attended it"
    assert sum(t["jobs"] for t in rep["by_technician"]) > rep["totals"]["completed_jobs"], \
        "setup: the per-person column is expected to exceed the job count here"
    assert rep["technician_rows_overlap"] is True, \
        "the report has to admit the columns do not reconcile, and why"


def test_value_attended_is_not_a_share_of_the_revenue(make_client):
    """Two technicians on one job are each shown its full worth.

    That is what "the jobs I was on were worth this" means, and it is why the
    column must never be summed into a headline.
    """
    c = make_client("superadmin")
    a, b = _employee(c, "Sami"), _employee(c, "Rami")
    cid = _client_id(c)
    job = _job(c, cid, [a, b], items=[
        {"line_type": "charge", "name": "Callout", "quantity": 1,
         "unit_price": 500}])
    _complete(c, job)

    rep = _report(c)
    va = _row(rep, a)["value_attended"]
    assert va == pytest.approx(_row(rep, b)["value_attended"], abs=0.01)
    assert va > 0, "setup: the job has to be worth something"
    assert rep["totals"]["revenue"] == pytest.approx(
        sum(j["revenue"] for j in rep["jobs"]), abs=0.01), \
        "revenue is the sum of JOBS, never of technician rows"


def test_reopening_a_job_takes_the_credit_back(make_client):
    """The invariant the report leans on.

    The roll-up filters on `completed_at IS NOT NULL`, which only excludes
    reopened work because `reopen` nulls that column. If it were ever changed
    to keep the timestamp, a technician would stay credited for a job that had
    been undone — and the status check beside it is belt-and-braces that no
    reachable path exercises. This is what actually holds the line.
    """
    c = make_client("superadmin")
    a = _employee(c, "Sami")
    job = _job(c, _client_id(c), [a])
    _complete(c, job)
    assert _row(_report(c), a)["jobs"] == 1, "setup: credited once done"

    r = c.post(f"/api/service/jobs/{job}/reopen")
    assert r.status_code == 200, r.text
    assert _row(_report(c), a) is None,         "work that was undone is not work attended"


def test_only_completed_work_counts(make_client):
    """An open job is not a service attended."""
    c = make_client("superadmin")
    a = _employee(c, "Sami")
    _job(c, _client_id(c), [a])          # left Open

    assert _row(_report(c), a) is None


def test_a_job_counts_in_the_month_it_was_FINISHED(make_client, db):
    """Not the month it was booked.

    The two dates are set a year apart here on purpose. Booking date is the
    obvious thing to reach for and it is the wrong one: a job rescheduled twice
    would keep moving between months long after the work was done, so a
    technician's past figures would never settle.
    """
    c = make_client("superadmin")
    a = _employee(c, "Sami")
    job = _job(c, _client_id(c), [a], scheduled_date="2021-06-15")
    _complete(c, job)

    db.execute("UPDATE service_jobs SET completed_at='2020-03-04 10:00:00' WHERE id=?",
               (job,))
    db.commit()

    assert _row(_report(c, start="2020-01-01", end="2020-12-31"), a)["jobs"] == 1,         "it belongs to the year it was completed"
    assert _row(_report(c, start="2021-01-01", end="2021-12-31"), a) is None,         "and NOT to the year it was scheduled for"
    assert _row(_report(c, start="2026-01-01", end="2026-12-31"), a) is None


# ── who may read the picker ─────────────────────────────────────────────────
def test_the_picker_shows_names_and_never_salaries(make_client):
    """Deliberately not /api/hr/employees, which needs hr.view and returns pay."""
    c = make_client("superadmin")
    _employee(c, "Sami", salary=4321)

    r = c.get("/api/service/technicians")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert rows, "setup: at least one employee"
    for row in rows:
        assert set(row) == {"id", "full_name", "job_title"}, \
            f"the technician picker must expose nothing but a name: {row}"
    assert "4321" not in r.text


def test_an_archived_employee_is_not_offered(make_client, db):
    c = make_client("superadmin")
    a = _employee(c, "Gone")
    db.execute("UPDATE hr_employees SET archived_at='2026-01-01' WHERE id=?", (a,))
    db.commit()

    assert not any(x["id"] == a for x in c.get("/api/service/technicians").json())


# ── the column that must never come back into use ───────────────────────────
def test_the_crew_and_the_legacy_field_stay_out_of_each_others_way(make_client, db):
    """`assigned_to` is kept, not dropped, and not repurposed.

    Dropping it was the precedent (172e) and the wrong call here: employees are
    linked to logins by hr_employees.user_id and, on the tenant this was checked
    against, NONE of them had one — a backfill would have preserved nothing
    while destroying the assignments that existed.

    So it survives, and it still works for a caller that sends it. What must not
    happen is either one writing the other's field: a job assigned a crew leaves
    the column alone, and a job sent the old field records no crew. Otherwise
    the report would count the same work twice, under two different names.
    """
    c = make_client("superadmin")
    a = _employee(c, "Sami")
    cid = _client_id(c)

    crew_job = _job(c, cid, [a])
    assert db.execute("SELECT assigned_to FROM service_jobs WHERE id=?",
                      (crew_job,)).fetchone()["assigned_to"] is None

    users = c.get("/api/users/").json()
    legacy_job = _job(c, cid, [], assigned_to=users[0]["id"])
    n = db.execute("SELECT COUNT(*) n FROM service_job_technicians WHERE job_id=?",
                   (legacy_job,)).fetchone()["n"]
    assert n == 0, "the old field must not invent a crew member"


# ── attendance beside the service count ─────────────────────────────────────
# A technician is staff who works INSIDE the company and goes out on demand, so
# the month-end view is both halves: days at work AND services attended. The
# report used to list only people who completed a job, which made a technician
# who spent the month in the workshop disappear — the one case a manager most
# wants to see.
def _field_staff(c, name, **extra):
    return _employee(c, name, is_field_staff=True, **extra)


def _attend(c, employee_id, day, status="Present"):
    r = c.post("/api/hr/attendance", json={
        "employee_id": employee_id, "date": day, "status": status})
    assert r.status_code in (200, 201), r.text


def test_a_technician_who_did_no_calls_still_appears(make_client):
    """The row this was extended to show.

    Present all month, no jobs. Under the old query he vanished, and "he was
    here and did nothing" looked identical to "he was not here at all".
    """
    c = make_client("superadmin")
    a = _field_staff(c, "Workshop Sami")
    _attend(c, a, "2026-03-02")
    _attend(c, a, "2026-03-03")

    row = _row(_report(c, start="2026-03-01", end="2026-03-31"), a)
    assert row is not None, "a flagged technician must be listed even with no jobs"
    assert row["jobs"] == 0
    assert row["days_present"] == 2


def test_work_is_never_hidden_by_a_missing_flag(make_client):
    """The union, not a filter.

    Somebody forgot to tick the box; he still went out and did the work. His
    jobs must be counted whatever the flag says, or the report under-reports
    real services.
    """
    c = make_client("superadmin")
    a = _employee(c, "Unflagged")        # is_field_staff defaults to False
    job = _job(c, _client_id(c), [a])
    _complete(c, job)

    row = _row(_report(c), a)
    assert row is not None, "an unflagged employee who attended a job must appear"
    assert row["jobs"] == 1
    assert row["field_staff"] is False


def test_an_office_employee_with_neither_is_left_off(make_client):
    """Otherwise a service report becomes a staff list."""
    c = make_client("superadmin")
    a = _employee(c, "Bookkeeper", title="Bookkeeper")
    _attend(c, a, "2026-03-02")

    assert _row(_report(c, start="2026-03-01", end="2026-03-31"), a) is None


def test_absent_days_are_not_days_present(make_client):
    """Late and Half-day both mean he came in; Absent is the only one that does
    not. A technician marked Late who then did three calls was at work."""
    c = make_client("superadmin")
    a = _field_staff(c, "Mixed")
    _attend(c, a, "2026-04-01", "Present")
    _attend(c, a, "2026-04-02", "Late")
    _attend(c, a, "2026-04-03", "Half-day")
    _attend(c, a, "2026-04-06", "Absent")

    row = _row(_report(c, start="2026-04-01", end="2026-04-30"), a)
    assert row["days_present"] == 3, "Absent must not count; Late and Half-day must"


def test_attendance_is_counted_only_inside_the_period(make_client):
    c = make_client("superadmin")
    a = _field_staff(c, "Ranged")
    _attend(c, a, "2026-05-10")
    _attend(c, a, "2026-06-10")

    assert _row(_report(c, start="2026-05-01", end="2026-05-31"), a)["days_present"] == 1


# ── who may see it ──────────────────────────────────────────────────────────
def test_attendance_is_withheld_from_a_viewer_without_hr(make_client, as_role):
    """Days present is personnel data, and Reports is a wider door than HR.

    Operations Manager holds `reports.view` and NOT `hr.view`. Their service
    figures are unchanged; the attendance is simply not there — the KEY is
    absent, not zero, because a zero on screen reads as "he was never here",
    which is a worse lie than no column.
    """
    admin = make_client("superadmin")
    a = _field_staff(admin, "Seen")
    _attend(admin, a, "2026-07-01")
    job = _job(admin, _client_id(admin), [a])
    _complete(admin, job)

    full = _report(admin)
    assert full["attendance_visible"] is True
    assert _row(full, a)["days_present"] == 1

    ops = as_role("Operations Manager")
    limited = _report(ops)
    assert limited["attendance_visible"] is False
    row = _row(limited, a)
    assert row is not None and row["jobs"] == 1, "the job figures are not HR data"
    assert "days_present" not in row, \
        "withheld means absent from the payload, never a zero"


def test_the_backfill_flags_exactly_the_people_with_service_history(make_client, db):
    """Seeded from evidence, not from a guess at the job title.

    `job_title` is free text the customer types and is not necessarily in
    English, so matching on it would mislabel people in both directions. Anyone
    already recorded on a service job demonstrably goes out on calls.

    It only ever turns the flag ON, so re-running is a no-op — which matters
    because _ensure_pg_post_baseline runs it on every boot.
    """
    import database

    c = make_client("superadmin")
    been_out = _employee(c, "Been Out")
    never = _employee(c, "Never Out", title="Technician")
    _job(c, _client_id(c), [been_out])

    raw = db._conn if hasattr(db, "_conn") else db
    raw.execute("UPDATE hr_employees SET is_field_staff = 0")
    raw.execute(database._FIELD_STAFF_BACKFILL)
    raw.commit()

    flag = lambda eid: db.execute(
        "SELECT is_field_staff f FROM hr_employees WHERE id=?", (eid,)).fetchone()["f"]
    assert flag(been_out) == 1, "he has attended a job"
    assert flag(never) == 0, "a Technician job title is not evidence of anything"

    # A hand-ticked box must survive a second pass.
    raw.execute("UPDATE hr_employees SET is_field_staff = 1 WHERE id=?", (never,))
    raw.execute(database._FIELD_STAFF_BACKFILL)
    raw.commit()
    assert flag(never) == 1, "the backfill must never turn a flag off"
