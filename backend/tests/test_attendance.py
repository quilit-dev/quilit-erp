"""
Employee daily attendance (HR Phase 1) — mark, roster, bulk upsert, summary.
"""


def _emp(c, name):
    r = c.post("/api/hr/employees", json={"full_name": name})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_mark_and_roster_shows_status(make_client):
    c = make_client("superadmin")
    e1, e2 = _emp(c, "Sara"), _emp(c, "Rami")
    r = c.post("/api/hr/attendance",
               json={"employee_id": e1, "date": "2026-06-08", "status": "Late", "hours": 6})
    assert r.status_code in (200, 201), r.text

    roster = c.get("/api/hr/attendance?date=2026-06-08").json()["rows"]
    by = {row["employee_id"]: row for row in roster}
    assert by[e1]["status"] == "Late" and by[e1]["hours"] == 6
    assert by[e2]["status"] is None          # unmarked employees still listed


def test_bulk_upsert_is_idempotent(make_client):
    c = make_client("superadmin")
    e1, e2 = _emp(c, "A"), _emp(c, "B")
    day = "2026-06-09"
    c.post("/api/hr/attendance/bulk", json={"date": day, "records": [
        {"employee_id": e1, "status": "Present"}, {"employee_id": e2, "status": "Absent"}]})
    # Re-save the same day with swapped statuses → updates in place, no duplicates.
    r = c.post("/api/hr/attendance/bulk", json={"date": day, "records": [
        {"employee_id": e1, "status": "Absent"}, {"employee_id": e2, "status": "Present"}]})
    assert r.json()["saved"] == 2
    by = {x["employee_id"]: x for x in c.get(f"/api/hr/attendance?date={day}").json()["rows"]}
    assert by[e1]["status"] == "Absent" and by[e2]["status"] == "Present"


def test_invalid_status_rejected(make_client):
    c = make_client("superadmin")
    e1 = _emp(c, "C")
    r = c.post("/api/hr/attendance",
               json={"employee_id": e1, "date": "2026-06-08", "status": "Teleported"})
    assert r.status_code == 422


def test_summary_counts_for_month(make_client):
    c = make_client("superadmin")
    e1 = _emp(c, "D")
    for day, st in [("2026-07-01", "Present"), ("2026-07-02", "Present"), ("2026-07-03", "Absent")]:
        c.post("/api/hr/attendance", json={"employee_id": e1, "date": day, "status": st})
    s = c.get("/api/hr/attendance/summary?month=2026-07").json()
    row = next(r for r in s["rows"] if r["employee_id"] == e1)
    assert row["counts"].get("Present") == 2 and row["counts"].get("Absent") == 1


def test_viewer_cannot_mark(make_client):
    c = make_client("Viewer")
    r = c.post("/api/hr/attendance",
               json={"employee_id": 1, "date": "2026-06-08", "status": "Present"})
    assert r.status_code == 403
