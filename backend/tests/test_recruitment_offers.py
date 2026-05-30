"""
Tests for the Recruitment > Offers feature — pre-employment draft contracts
sent to applicants before they're onboarded to HR.

Focus areas:
  * CRUD lifecycle (Draft → Sent → Accepted/Declined; immutable after send)
  * Lebanon-aware validation (probation cap, working-hours cap)
  * Permission gates
  * The print-data endpoint pulls company branding + the legal-reference block
"""
import pytest


# ── Helpers ────────────────────────────────────────────────────────────────
def _user_id(db, username):
    row = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    assert row, f"user {username!r} missing"
    return row["id"]


def _seed_applicant(db, **overrides):
    """Insert an applicant directly so tests don't depend on the create API's
    payload shape. Returns the new applicant id."""
    fields = {
        "full_name":   "Test Candidate",
        "email":       "test@example.com",
        "status":      "Accepted",   # Default to a state where offers are legal
        "applied_at":  "2026-05-01",
        "created_at":  "2026-05-01 09:00:00",
        **overrides,
    }
    cols = ", ".join(fields.keys())
    qs   = ", ".join("?" for _ in fields)
    cur  = db.execute(f"INSERT INTO recruitment_applicants ({cols}) VALUES ({qs})",
                      tuple(fields.values()))
    db.commit()
    return cur.lastrowid


def _create_offer(c, app_id, **overrides):
    body = {
        "contract_type":    "Permanent",
        "job_title":        "Software Engineer",
        "start_date":       "2026-07-01",
        "salary":           1500,
        "salary_currency":  "USD",
        **overrides,
    }
    r = c.post(f"/api/recruitment/applicants/{app_id}/offers", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── CRUD lifecycle ─────────────────────────────────────────────────────────
def test_create_offer_draft(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    res = _create_offer(c, app_id)
    assert res["id"]
    assert res["offer_number"].startswith("OFF-")


def test_list_offers_for_applicant(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    _create_offer(c, app_id, salary=2000)
    _create_offer(c, app_id, salary=2500)
    rows = c.get(f"/api/recruitment/applicants/{app_id}/offers").json()
    assert len(rows) == 2
    # Newest first
    assert rows[0]["salary"] == 2500
    # JSON booleans are real bools, not 0/1
    assert isinstance(rows[0]["include_nssf"], bool)


def test_update_draft_offer(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]

    r = c.put(f"/api/recruitment/offers/{oid}", json={
        "contract_type":   "Fixed-term",
        "job_title":       "Senior Engineer",
        "start_date":      "2026-08-01",
        "end_date":        "2027-08-01",
        "salary":          2200,
        "salary_currency": "USD",
        "weekly_hours":    40,
    })
    assert r.status_code == 200

    row = c.get(f"/api/recruitment/applicants/{app_id}/offers").json()[0]
    assert row["job_title"] == "Senior Engineer"
    assert row["contract_type"] == "Fixed-term"
    assert row["end_date"] == "2027-08-01"


def test_archive_offer(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]
    assert c.patch(f"/api/recruitment/offers/{oid}/archive").status_code == 200
    rows = c.get(f"/api/recruitment/applicants/{app_id}/offers").json()
    assert all(o["id"] != oid for o in rows)


# ── Lifecycle transitions ─────────────────────────────────────────────────
def test_status_draft_to_sent(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]
    r = c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Sent"})
    assert r.status_code == 200
    assert r.json()["status"] == "Sent"

    row = c.get(f"/api/recruitment/applicants/{app_id}/offers").json()[0]
    assert row["status"] == "Sent"
    assert row["sent_at"] is not None


def test_status_sent_to_accepted(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]
    c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Sent"})

    r = c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Accepted"})
    assert r.status_code == 200

    row = c.get(f"/api/recruitment/applicants/{app_id}/offers").json()[0]
    assert row["status"] == "Accepted"
    assert row["accepted_at"] is not None


def test_status_sent_to_declined_captures_reason(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]
    c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Sent"})

    r = c.post(f"/api/recruitment/offers/{oid}/status", json={
        "status": "Declined", "declined_reason": "Accepted competing offer",
    })
    assert r.status_code == 200

    row = c.get(f"/api/recruitment/applicants/{app_id}/offers").json()[0]
    assert row["status"] == "Declined"
    assert row["declined_reason"] == "Accepted competing offer"


def test_illegal_status_transitions_rejected(as_role, db):
    """Draft can't jump straight to Accepted, sent offers can't go back, etc."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]
    # Draft → Accepted is not allowed; you must Send first
    bad = c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Accepted"})
    assert bad.status_code == 400

    # Move it Sent → Accepted → try to go back to Draft
    c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Sent"})
    c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Accepted"})
    revert = c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Draft"})
    assert revert.status_code == 400


def test_cannot_edit_offer_after_sending(as_role, db):
    """The offer is the candidate's reference copy once sent — freeze it."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]
    c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Sent"})

    r = c.put(f"/api/recruitment/offers/{oid}", json={
        "contract_type": "Permanent", "job_title": "Bumped",
        "start_date": "2026-07-01", "salary": 9999, "salary_currency": "USD",
    })
    assert r.status_code == 400


# ── Lebanon-aware validation ──────────────────────────────────────────────
def test_probation_capped_at_3_months(as_role, db):
    """Article 9 of the Lebanese Labor Code caps the probationary period."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    r = c.post(f"/api/recruitment/applicants/{app_id}/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "USD",
        "probation_months": 6,
    })
    assert r.status_code == 422   # Pydantic validation kicks in before route
    assert "Labor Code Article 9" in r.text


def test_weekly_hours_capped_at_48(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    r = c.post(f"/api/recruitment/applicants/{app_id}/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "USD",
        "weekly_hours": 60,
    })
    assert r.status_code == 422
    assert "Article 31" in r.text


def test_negative_salary_rejected(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    r = c.post(f"/api/recruitment/applicants/{app_id}/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": -100, "salary_currency": "USD",
    })
    assert r.status_code == 422


def test_invalid_currency_rejected(as_role, db):
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    r = c.post(f"/api/recruitment/applicants/{app_id}/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "XYZ",
    })
    assert r.status_code == 422


def test_cannot_draft_offer_for_rejected_applicant(as_role, db):
    """No back-dating offers onto a closed file."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db, status="Rejected")
    r = c.post(f"/api/recruitment/applicants/{app_id}/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "USD",
    })
    assert r.status_code == 400


def test_unknown_applicant_rejected(as_role):
    c = as_role("HR Manager")
    r = c.post("/api/recruitment/applicants/999999/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "USD",
    })
    assert r.status_code == 404


# ── Print-data payload ───────────────────────────────────────────────────
def test_print_data_includes_legal_block(as_role, db):
    """The template needs the Lebanon-aware constants alongside the offer."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]

    data = c.get(f"/api/recruitment/offers/{oid}/print-data").json()
    assert "offer" in data and "company" in data and "lebanon" in data
    assert data["lebanon"]["max_probation_months"] == 3
    assert data["lebanon"]["max_weekly_hours"]     == 48
    assert "NSSF" in data["lebanon"]["nssf_full_name"]
    # Applicant join columns present
    assert data["offer"]["applicant_name"] == "Test Candidate"


# ── Permission gates ─────────────────────────────────────────────────────
def test_anonymous_blocked(client):
    r = client.get("/api/recruitment/applicants/1/offers")
    assert r.status_code == 401


def test_role_without_recruitment_blocked(as_role, db):
    """Sales has no recruitment permission — every endpoint should 403."""
    c = as_role("Sales")
    app_id = _seed_applicant(db)
    assert c.get(f"/api/recruitment/applicants/{app_id}/offers").status_code == 403
    assert c.post(f"/api/recruitment/applicants/{app_id}/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "USD",
    }).status_code == 403


def test_view_only_role_can_read_but_not_edit(as_role, db):
    c_hr = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c_hr, app_id)["id"]

    auditor = as_role("Auditor")
    assert auditor.get(f"/api/recruitment/applicants/{app_id}/offers").status_code == 200
    assert auditor.post(f"/api/recruitment/applicants/{app_id}/offers", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "USD",
    }).status_code == 403
    assert auditor.put(f"/api/recruitment/offers/{oid}", json={
        "contract_type": "Permanent", "start_date": "2026-07-01",
        "salary": 1500, "salary_currency": "USD",
    }).status_code == 403


# ── Offer → contract bridge on convert ────────────────────────────────────
def test_convert_with_accepted_offer_mints_active_contract(as_role, db):
    """The whole point of the offer model — when HR onboards the candidate
    and passes the accepted offer's id, the convert endpoint must mint a
    matching Active hr_contracts row carrying the offer's terms forward."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    # Draft an offer with distinctive values we can verify on the contract
    oid = _create_offer(c, app_id, salary=2750, job_title="Senior Dev",
                        contract_type="Permanent")["id"]
    # Lifecycle the offer through Sent → Accepted
    c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Sent"})
    c.post(f"/api/recruitment/offers/{oid}/status", json={"status": "Accepted"})

    # Convert the applicant, passing the offer id
    res = c.post(f"/api/recruitment/applicants/{app_id}/convert",
                 json={"accepted_offer_id": oid}).json()
    assert res["contract_created"] is True
    assert res["contract_number"]
    assert res["employee_id"]

    # The new contract should be Active and carry the offer's salary/title
    contract = db.execute(
        "SELECT * FROM hr_contracts WHERE id=?", (res["contract_id"],)
    ).fetchone()
    assert contract["status"]    == "Active"
    assert contract["salary"]    == 2750
    assert contract["job_title"] == "Senior Dev"
    # The terms column should include the NSSF + EOS clauses we toggled on
    assert "NSSF" in (contract["terms"] or "")
    assert "Article 50" in (contract["terms"] or "")


def test_convert_rejects_non_accepted_offer(as_role, db):
    """Refuse if the offer is still Draft / Sent — we don't want HR to bind
    the employee to terms the candidate never accepted."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    oid = _create_offer(c, app_id)["id"]
    # Still Draft — convert with this id must 400
    r = c.post(f"/api/recruitment/applicants/{app_id}/convert",
               json={"accepted_offer_id": oid})
    assert r.status_code == 400
    assert "Accepted" in r.text


def test_convert_rejects_foreign_offer(as_role, db):
    """The offer must belong to the applicant being converted."""
    c = as_role("HR Manager")
    app1 = _seed_applicant(db, full_name="Candidate One")
    app2 = _seed_applicant(db, full_name="Candidate Two")
    oid_for_app1 = _create_offer(c, app1)["id"]
    # Try to convert applicant 2 using applicant 1's offer
    r = c.post(f"/api/recruitment/applicants/{app2}/convert",
               json={"accepted_offer_id": oid_for_app1})
    assert r.status_code == 400


def test_convert_without_offer_still_works(as_role, db):
    """Offer is optional — direct convert (no offer_id) still mints the
    employee, just without auto-creating a contract."""
    c = as_role("HR Manager")
    app_id = _seed_applicant(db)
    res = c.post(f"/api/recruitment/applicants/{app_id}/convert", json={}).json()
    assert res["employee_id"]
    assert res["contract_created"] is False
    assert res["contract_number"] is None
