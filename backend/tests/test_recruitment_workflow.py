"""Recruitment pipeline + onboarding integration tests.

Covers:
  • Position CRUD and applicant CRUD + listing filters
  • Pipeline status transitions and the audit trail
  • Interview scheduling, score + decision
  • Applicant PDF upload + download
  • convert → creates an hr_employees row, copies the CV to hr_employee_files,
    backfills converted_employee_id and bumps the position to 'Filled'.
"""
import pytest


_TINY_PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def _position(c, **overrides):
    payload = {"title": "Software Engineer", "employment_type": "Full-time",
               "headcount": 1, "status": "Open"}
    payload.update(overrides)
    r = c.post("/api/recruitment/positions", json=payload)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _applicant(c, position_id=None, **overrides):
    payload = {"full_name": "Jane Doe", "email": "jane@example.com",
               "expected_salary": 4000}
    if position_id is not None:
        payload["position_id"] = position_id
    payload.update(overrides)
    r = c.post("/api/recruitment/applicants", json=payload)
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ── Positions ───────────────────────────────────────────────────────────────

def test_position_crud(make_client):
    c = make_client("superadmin")
    pid = _position(c, title="Backend Engineer")
    listed = c.get("/api/recruitment/positions").json()
    assert any(p["id"] == pid and p["title"] == "Backend Engineer" for p in listed)

    r = c.put(f"/api/recruitment/positions/{pid}",
              json={"title": "Senior Backend Engineer", "employment_type": "Full-time",
                    "headcount": 2, "status": "Open"})
    assert r.status_code == 200
    detail = c.get(f"/api/recruitment/positions/{pid}").json()
    assert detail["title"] == "Senior Backend Engineer"
    assert detail["headcount"] == 2


# ── Applicants ──────────────────────────────────────────────────────────────

def test_create_applicant_stamps_history_row(make_client):
    c = make_client("superadmin")
    pid = _position(c)
    aid = _applicant(c, position_id=pid)
    detail = c.get(f"/api/recruitment/applicants/{aid}").json()
    assert detail["status"] == "Applied"
    assert len(detail["status_history"]) == 1
    assert detail["status_history"][0]["new_status"] == "Applied"


def test_status_transitions_logged(make_client):
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    for to in ("Screening", "Interview", "Technical Test", "Accepted"):
        r = c.post(f"/api/recruitment/applicants/{aid}/status",
                   json={"new_status": to})
        assert r.status_code == 200, r.text
    detail = c.get(f"/api/recruitment/applicants/{aid}").json()
    assert detail["status"] == "Accepted"
    # 1 initial + 4 transitions = 5 rows
    assert len(detail["status_history"]) == 5


def test_terminal_state_blocks_reopening(make_client):
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    c.post(f"/api/recruitment/applicants/{aid}/status",
           json={"new_status": "Rejected", "reason": "Not a fit"})
    r = c.post(f"/api/recruitment/applicants/{aid}/status",
               json={"new_status": "Interview"})
    assert r.status_code == 400


# ── Interviews ──────────────────────────────────────────────────────────────

def test_schedule_and_complete_interview(make_client):
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    r = c.post(f"/api/recruitment/applicants/{aid}/interviews",
               json={"interview_type": "Technical", "scheduled_at": "2025-06-15 14:00:00",
                     "duration_min": 45, "interviewer_name": "Bob"})
    assert r.status_code == 200, r.text
    iid = r.json()["id"]
    # Mark complete with a score + decision
    r = c.put(f"/api/recruitment/interviews/{iid}",
              json={"interview_type": "Technical", "scheduled_at": "2025-06-15 14:00:00",
                    "duration_min": 45, "interviewer_name": "Bob",
                    "status": "Completed", "score": 8, "decision": "Hire",
                    "notes": "Strong on system design"})
    assert r.status_code == 200, r.text
    detail = c.get(f"/api/recruitment/applicants/{aid}").json()
    iv = detail["interviews"][0]
    assert iv["status"] == "Completed"
    assert iv["score"]  == 8
    assert iv["decision"] == "Hire"
    assert iv["completed_at"] is not None


# ── File attachments ────────────────────────────────────────────────────────

def test_applicant_cv_upload_and_download(make_client):
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    r = c.post(f"/api/recruitment/applicants/{aid}/files",
               data={"kind": "cv"},
               files={"file": ("jane_cv.pdf", _TINY_PDF, "application/pdf")})
    assert r.status_code == 200, r.text
    file_id = r.json()["id"]
    d = c.get(f"/api/recruitment/files/{file_id}/download")
    assert d.status_code == 200
    assert d.content == _TINY_PDF


def test_applicant_file_rejects_non_pdf(make_client):
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    r = c.post(f"/api/recruitment/applicants/{aid}/files",
               data={"kind": "cv"},
               files={"file": ("note.txt", b"hi", "text/plain")})
    assert r.status_code == 400


# ── Convert to employee ─────────────────────────────────────────────────────

def test_convert_accepted_applicant_becomes_employee(make_client, db):
    c = make_client("superadmin")
    pid = _position(c, title="QA Engineer", headcount=1)
    aid = _applicant(c, position_id=pid, full_name="Acme Candidate",
                     expected_salary=3500)
    # Upload a CV that should follow the applicant into HR
    c.post(f"/api/recruitment/applicants/{aid}/files",
           data={"kind": "cv"},
           files={"file": ("cv.pdf", _TINY_PDF, "application/pdf")})

    # Walk through the pipeline to Accepted
    for to in ("Screening", "Interview", "Accepted"):
        c.post(f"/api/recruitment/applicants/{aid}/status", json={"new_status": to})

    # Convert
    r = c.post(f"/api/recruitment/applicants/{aid}/convert", json={})
    assert r.status_code == 200, r.text
    emp_id = r.json()["employee_id"]

    # Employee created in HR
    emp = c.get(f"/api/hr/employees/{emp_id}").json()
    assert emp["full_name"] == "Acme Candidate"
    assert emp["job_title"] == "QA Engineer"
    assert emp["salary"]    == 3500
    # CV was carried over
    assert any(f["kind"] == "cv" for f in emp["files"])
    # Hire row in salary timeline
    assert emp["history"][-1]["change_type"] == "hire"

    # Applicant stamped both ways
    detail = c.get(f"/api/recruitment/applicants/{aid}").json()
    assert detail["converted_employee_id"] == emp_id

    # Position with headcount=1 is now Filled
    pos = c.get(f"/api/recruitment/positions/{pid}").json()
    assert pos["status"] == "Filled"


def test_cannot_convert_unaccepted(make_client):
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    r = c.post(f"/api/recruitment/applicants/{aid}/convert", json={})
    assert r.status_code == 400


def test_summary_counts(make_client):
    c = make_client("superadmin")
    pid = _position(c)
    _applicant(c, position_id=pid)
    _applicant(c, position_id=pid, full_name="Another")
    summary = c.get("/api/recruitment/summary").json()
    assert summary["open_positions"]  >= 1
    assert summary["applied"]         >= 2
    assert "upcoming_interviews"      in summary


# ── Interview ↔ HR Activity mirror ──────────────────────────────────────────

def _future_ts(days_ahead: int = 7) -> str:
    """Pick a timestamp in the future so the mirrored reminder is actually
    scheduled rather than skipped as already-past."""
    from datetime import datetime, timedelta
    return (datetime.utcnow() + timedelta(days=days_ahead)).strftime("%Y-%m-%d %H:%M:%S")


def test_scheduling_interview_creates_hr_activity(make_client, db):
    """Scheduling a recruitment interview should fan out to HR Activities so
    the interviewer sees it on their personal queue alongside other
    touchpoints."""
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c), full_name="Mirror Candidate")
    when = _future_ts(7)

    r = c.post(f"/api/recruitment/applicants/{aid}/interviews",
               json={"interview_type": "Video",
                     "scheduled_at": when,
                     "duration_min": 45,
                     "interviewer_name": "Ext Panel"})
    assert r.status_code == 200, r.text
    body = r.json()
    interview_id = body["id"]
    activity_id  = body.get("hr_activity_id")
    assert activity_id, "schedule_interview should return the mirrored hr_activity_id"

    # The mirror row points at the same applicant and timestamp.
    act = db.execute("SELECT * FROM hr_activities WHERE id=?", (activity_id,)).fetchone()
    assert act is not None
    assert act["applicant_id"] == aid
    assert act["scheduled_at"] == when
    assert act["activity_type"] == "Interview"
    assert act["status"] == "Planned"
    assert "Mirror Candidate" in act["subject"]

    # The interview row remembers the activity id for sync.
    iv = db.execute("SELECT hr_activity_id FROM recruitment_interviews WHERE id=?",
                    (interview_id,)).fetchone()
    assert iv["hr_activity_id"] == activity_id


def test_phone_interview_maps_to_call_activity(make_client, db):
    """Phone interviews map to the 'Call' activity type so the HR Activities
    filter chips line up with how the touchpoint actually happened."""
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    when = _future_ts(7)
    r = c.post(f"/api/recruitment/applicants/{aid}/interviews",
               json={"interview_type": "Phone", "scheduled_at": when, "duration_min": 30})
    activity_id = r.json()["hr_activity_id"]
    act = db.execute("SELECT activity_type FROM hr_activities WHERE id=?",
                     (activity_id,)).fetchone()
    assert act["activity_type"] == "Call"


def test_interview_owner_follows_interviewer_user(make_client, db):
    """When an internal user is set as interviewer, the mirrored activity
    lives in *their* queue, not the scheduler's."""
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    # Re-use the seeded HR Manager as the interviewer.
    interviewer_id = db.execute(
        "SELECT id FROM users WHERE username='u_hr_mgr'"
    ).fetchone()["id"]
    r = c.post(f"/api/recruitment/applicants/{aid}/interviews",
               json={"interview_type": "On-site",
                     "scheduled_at": _future_ts(7),
                     "duration_min": 60,
                     "interviewer_id": interviewer_id})
    activity_id = r.json()["hr_activity_id"]
    act = db.execute("SELECT owner_id FROM hr_activities WHERE id=?",
                     (activity_id,)).fetchone()
    assert act["owner_id"] == interviewer_id


def test_updating_interview_resyncs_mirror(make_client, db):
    """Editing the interview (time / type) propagates to the HR Activity row
    so both views stay consistent."""
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c), full_name="Edit Candidate")
    first  = _future_ts(7)
    second = _future_ts(10)
    iid = c.post(f"/api/recruitment/applicants/{aid}/interviews",
                 json={"interview_type": "Phone", "scheduled_at": first,
                       "duration_min": 30}).json()["id"]
    r = c.put(f"/api/recruitment/interviews/{iid}",
              json={"interview_type": "On-site", "scheduled_at": second,
                    "duration_min": 90, "interviewer_name": "Bob",
                    "status": "Scheduled"})
    assert r.status_code == 200, r.text
    activity_id = db.execute(
        "SELECT hr_activity_id FROM recruitment_interviews WHERE id=?", (iid,),
    ).fetchone()["hr_activity_id"]
    act = db.execute("SELECT * FROM hr_activities WHERE id=?", (activity_id,)).fetchone()
    assert act["scheduled_at"] == second
    assert act["activity_type"] == "Interview"   # was Call, now Interview
    assert act["duration_min"] == 90


def test_deleting_interview_archives_mirror(make_client, db):
    """Cancelling the interview hides the HR Activity from the active queue
    (soft-archive) without erasing the audit trail."""
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    iid = c.post(f"/api/recruitment/applicants/{aid}/interviews",
                 json={"interview_type": "Phone",
                       "scheduled_at": _future_ts(7),
                       "duration_min": 30}).json()["id"]
    activity_id = db.execute(
        "SELECT hr_activity_id FROM recruitment_interviews WHERE id=?", (iid,),
    ).fetchone()["hr_activity_id"]

    r = c.delete(f"/api/recruitment/interviews/{iid}")
    assert r.status_code == 200, r.text

    act = db.execute("SELECT archived_at FROM hr_activities WHERE id=?",
                     (activity_id,)).fetchone()
    assert act["archived_at"] is not None


# ── Accept / Reject reason capture ─────────────────────────────────────────

def test_accept_reason_is_persisted(make_client):
    """Accepting an applicant with a reason stores it on the dedicated
    accepted_reason column so the detail view can surface 'why hired'."""
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    r = c.post(f"/api/recruitment/applicants/{aid}/status",
               json={"new_status": "Accepted",
                     "reason": "Strongest portfolio + employee referral"})
    assert r.status_code == 200, r.text
    detail = c.get(f"/api/recruitment/applicants/{aid}").json()
    assert detail["status"] == "Accepted"
    assert detail["accepted_reason"] == "Strongest portfolio + employee referral"
    assert detail["rejected_reason"] in (None, "")
    # The reason is also visible on the audit trail.
    last = detail["status_history"][0]
    assert last["new_status"] == "Accepted"
    assert "portfolio" in (last["note"] or "")


def test_reject_reason_does_not_pollute_accept(make_client):
    """rejected_reason and accepted_reason must be independent columns —
    one transition must not bleed its reason into the other."""
    c = make_client("superadmin")
    aid = _applicant(c, position_id=_position(c))
    r = c.post(f"/api/recruitment/applicants/{aid}/status",
               json={"new_status": "Rejected", "reason": "Salary mismatch"})
    assert r.status_code == 200
    detail = c.get(f"/api/recruitment/applicants/{aid}").json()
    assert detail["rejected_reason"] == "Salary mismatch"
    assert detail["accepted_reason"] in (None, "")
