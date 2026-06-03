"""HR-module workflow tests — salary history, payroll, file attachments.

Covers the post-091 HR upgrade:
  • Creating an employee writes a 'hire' row to hr_employment_changes.
  • PUT /api/hr/employees/{id} auto-logs salary / title / department / manager
    diffs as new rows.
  • Explicit change_type wins over auto-classification.
  • Payroll runs: create (seeds one line per active employee) → approve →
    mark-paid posts a single row to expenses and links via posted_expense_id.
  • Employee file upload accepts PDFs only; CV and Contract are single-slot;
    download streams the bytes; delete removes the row.
"""
import io
import pytest


def _emp(client, **overrides):
    payload = {
        "full_name":      "Test Person",
        "job_title":      "Engineer",
        "employment_type": "Full-time",
        "status":         "Active",
        "salary":         3000,
    }
    payload.update(overrides)
    r = client.post("/api/hr/employees", json=payload)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _get_history(client, emp_id):
    r = client.get(f"/api/hr/employees/{emp_id}")
    assert r.status_code == 200
    return r.json()["history"]


# ── Salary / role history ───────────────────────────────────────────────────

def test_create_employee_seeds_hire_row(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c, full_name="Alice")
    hist = _get_history(c, emp_id)
    assert len(hist) == 1
    assert hist[0]["change_type"] == "hire"
    assert hist[0]["new_salary"] == 3000


def test_raise_is_auto_classified(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c, salary=3000)
    # bump salary only — should produce a 'raise' row.
    # Carry job_title through so the PUT doesn't read as a title diff too
    # (which would be auto-classified as 'promotion').
    r = c.put(f"/api/hr/employees/{emp_id}",
              json={"full_name": "Test Person", "job_title": "Engineer",
                    "salary": 3500,
                    "employment_type": "Full-time", "status": "Active"})
    assert r.status_code == 200, r.text
    hist = _get_history(c, emp_id)
    assert hist[0]["change_type"] == "raise"
    assert hist[0]["old_salary"] == 3000 and hist[0]["new_salary"] == 3500


def test_title_change_is_promotion_when_salary_also_rises(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c, job_title="Engineer", salary=3000)
    r = c.put(f"/api/hr/employees/{emp_id}",
              json={"full_name": "Test Person", "job_title": "Senior Engineer",
                    "salary": 3500, "employment_type": "Full-time", "status": "Active"})
    assert r.status_code == 200, r.text
    hist = _get_history(c, emp_id)
    assert hist[0]["change_type"] == "promotion"


def test_explicit_change_type_wins(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c, salary=3000)
    r = c.put(f"/api/hr/employees/{emp_id}",
              json={"full_name": "Test Person", "job_title": "Engineer",
                    "salary": 3200,
                    "employment_type": "Full-time", "status": "Active",
                    "change_type": "adjustment", "change_reason": "COLA bump"})
    assert r.status_code == 200
    hist = _get_history(c, emp_id)
    assert hist[0]["change_type"] == "adjustment"
    assert hist[0]["reason"] == "COLA bump"


def test_no_diff_no_history_row(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c, salary=3000)
    before = len(_get_history(c, emp_id))
    # Touch fields that are NOT tracked (email, phone, notes) — no new row.
    # Carry tracked fields through so they don't read as diffs.
    r = c.put(f"/api/hr/employees/{emp_id}",
              json={"full_name": "Test Person", "job_title": "Engineer",
                    "salary": 3000,
                    "employment_type": "Full-time", "status": "Active",
                    "email": "x@y.com", "phone": "555-0000", "notes": "hi"})
    assert r.status_code == 200
    assert len(_get_history(c, emp_id)) == before


# ── Payroll ─────────────────────────────────────────────────────────────────

def test_payroll_lifecycle_posts_expense(make_client, db):
    c = make_client("superadmin")
    _emp(c, full_name="A", salary=2000)
    _emp(c, full_name="B", salary=3000)

    # Create run — should seed one line per active employee
    r = c.post("/api/hr/payroll/runs",
               json={"period_start": "2025-06-01", "period_end": "2025-06-30",
                     "notes": "June payroll"})
    assert r.status_code == 200, r.text
    run_id = r.json()["id"]
    assert r.json()["lines"] >= 2  # at least our two; may include more

    # Approve
    r = c.post(f"/api/hr/payroll/runs/{run_id}/approve")
    assert r.status_code == 200, r.text

    # Snapshot the expense count before paying
    expenses_before = db.execute("SELECT COUNT(*) FROM expenses").fetchone()[0]

    # Mark paid → should add ONE expense row
    r = c.post(f"/api/hr/payroll/runs/{run_id}/mark-paid")
    assert r.status_code == 200, r.text
    expense_id = r.json()["expense_id"]

    expenses_after = db.execute("SELECT COUNT(*) FROM expenses").fetchone()[0]
    assert expenses_after == expenses_before + 1

    # The expense links back to the run and has the right category
    exp = db.execute("SELECT * FROM expenses WHERE id=?", (expense_id,)).fetchone()
    assert exp["category"] == "Payroll"

    # Run row carries the link
    run = db.execute("SELECT status, posted_expense_id FROM hr_payroll_runs WHERE id=?",
                     (run_id,)).fetchone()
    assert run["status"] == "Paid"
    assert run["posted_expense_id"] == expense_id


def test_payroll_future_period_posts_dated_today_not_future(make_client, db):
    """A payroll run whose period_end is in the future must post its expense
    AND its GL journal entry dated to TODAY, never to the future month-end —
    otherwise the entry hides from the default "this month → today" GL /
    Trial Balance views and the operator thinks payroll "didn't post".

    A back-period run keeps its own month-end (already <= today), so only the
    future-dated case is pulled back. This locks in accounting.clamp_posting_date.
    """
    from datetime import date, timedelta
    c = make_client("superadmin")
    _emp(c, full_name="Future", salary=2500)

    today = date.today()
    # A period that ends well into the future relative to "now".
    future_end = (today + timedelta(days=60)).isoformat()
    start      = today.replace(day=1).isoformat()

    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": start, "period_end": future_end}).json()
    c.post(f"/api/hr/payroll/runs/{run['id']}/approve")
    paid = c.post(f"/api/hr/payroll/runs/{run['id']}/mark-paid")
    assert paid.status_code == 200, paid.text
    expense_id = paid.json()["expense_id"]

    # Expense row must be dated to today, not the future period end.
    exp = db.execute("SELECT date FROM expenses WHERE id=?", (expense_id,)).fetchone()
    assert exp["date"][:10] == today.isoformat(), (
        f"expense dated {exp['date']} expected {today.isoformat()}"
    )

    # The GL journal entry must also be dated to today.
    je = db.execute(
        "SELECT entry_date FROM journal_entries "
        "WHERE source_type='payroll' AND source_id=?", (run["id"],)
    ).fetchone()
    assert je is not None, "payroll did not post a journal entry"
    assert je["entry_date"][:10] == today.isoformat(), (
        f"JE dated {je['entry_date']} expected {today.isoformat()}"
    )


def test_payroll_back_period_keeps_its_month_end(make_client, db):
    """The clamp must NOT move a back-period run — a payroll for a month that
    has already ended keeps its own period-end date (which is <= today)."""
    c = make_client("superadmin")
    _emp(c, full_name="Past", salary=2500)

    # A safely-past period (this fixture DB seeds dates around 2025-2026; we
    # use an unambiguously historical window).
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2024-01-01", "period_end": "2024-01-31"}).json()
    c.post(f"/api/hr/payroll/runs/{run['id']}/approve")
    paid = c.post(f"/api/hr/payroll/runs/{run['id']}/mark-paid")
    assert paid.status_code == 200, paid.text

    je = db.execute(
        "SELECT entry_date FROM journal_entries "
        "WHERE source_type='payroll' AND source_id=?", (run["id"],)
    ).fetchone()
    assert je["entry_date"][:10] == "2024-01-31", (
        f"back-period JE should keep its month-end, got {je['entry_date']}"
    )


def test_payroll_mark_paid_is_idempotent(make_client):
    c = make_client("superadmin")
    _emp(c, salary=2000)
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2025-07-01", "period_end": "2025-07-31"}).json()
    c.post(f"/api/hr/payroll/runs/{run['id']}/approve")
    first = c.post(f"/api/hr/payroll/runs/{run['id']}/mark-paid").json()
    again = c.post(f"/api/hr/payroll/runs/{run['id']}/mark-paid").json()
    assert again["expense_id"] == first["expense_id"]


def test_payroll_cannot_skip_approval(make_client):
    c = make_client("superadmin")
    _emp(c, salary=2000)
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2025-08-01", "period_end": "2025-08-31"}).json()
    r = c.post(f"/api/hr/payroll/runs/{run['id']}/mark-paid")
    assert r.status_code == 400


# ── File attachments ────────────────────────────────────────────────────────

# Tiny valid PDF (header + EOF marker — enough for content-type pass-through).
_TINY_PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def test_upload_and_download_employee_file(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c)
    r = c.post(
        f"/api/hr/employees/{emp_id}/files",
        data={"kind": "cv"},
        files={"file": ("alice_cv.pdf", _TINY_PDF, "application/pdf")},
    )
    assert r.status_code == 200, r.text
    file_id = r.json()["id"]

    # Listing returns the metadata
    files = c.get(f"/api/hr/employees/{emp_id}/files").json()
    assert any(f["id"] == file_id and f["kind"] == "cv" for f in files)

    # Download returns the bytes
    d = c.get(f"/api/hr/files/{file_id}/download")
    assert d.status_code == 200
    assert d.content == _TINY_PDF
    assert d.headers["content-type"].startswith("application/pdf")


def test_upload_replaces_cv_slot(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c)
    c.post(f"/api/hr/employees/{emp_id}/files", data={"kind": "cv"},
           files={"file": ("v1.pdf", _TINY_PDF, "application/pdf")})
    c.post(f"/api/hr/employees/{emp_id}/files", data={"kind": "cv"},
           files={"file": ("v2.pdf", _TINY_PDF, "application/pdf")})
    cv_files = [f for f in c.get(f"/api/hr/employees/{emp_id}/files").json()
                if f["kind"] == "cv"]
    assert len(cv_files) == 1
    assert cv_files[0]["filename"] == "v2.pdf"


def test_upload_rejects_non_pdf(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c)
    r = c.post(f"/api/hr/employees/{emp_id}/files",
               data={"kind": "cv"},
               files={"file": ("hello.txt", b"hi", "text/plain")})
    assert r.status_code == 400
    assert "pdf" in r.json()["detail"].lower()


def test_delete_employee_file(make_client):
    c = make_client("superadmin")
    emp_id = _emp(c)
    f_id = c.post(f"/api/hr/employees/{emp_id}/files", data={"kind": "contract"},
                  files={"file": ("c.pdf", _TINY_PDF, "application/pdf")}).json()["id"]
    r = c.delete(f"/api/hr/files/{f_id}")
    assert r.status_code == 200
    assert c.get(f"/api/hr/files/{f_id}/download").status_code == 404


# ── Payroll tax / NSSF / overtime compute ───────────────────────────────────

def _set_setting(c, key, value):
    """Settings tweak helper — uses the existing settings router."""
    r = c.put("/api/settings/", json={key: str(value)})
    assert r.status_code == 200, r.text


def test_payroll_default_no_tax_or_nssf(make_client):
    c = make_client("superadmin")
    _emp(c, salary=2000)
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2025-09-01", "period_end": "2025-09-30"}).json()
    detail = c.get(f"/api/hr/payroll/runs/{run['id']}").json()
    line = detail["lines"][0]
    assert line["base_salary"]   == 2000
    assert line["gross_total"]   == 2000
    assert line["tax_amount"]    == 0
    assert line["nssf_employee"] == 0
    assert line["nssf_employer"] == 0
    assert line["net_amount"]    == 2000


def test_payroll_compute_tax_and_nssf(make_client):
    c = make_client("superadmin")
    _set_setting(c, "payroll_tax_pct", 10)
    _set_setting(c, "payroll_nssf_employee_pct", 3)
    _set_setting(c, "payroll_nssf_employer_pct", 21)
    _emp(c, salary=2000)
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2025-10-01", "period_end": "2025-10-31"}).json()
    detail = c.get(f"/api/hr/payroll/runs/{run['id']}").json()
    line = next(l for l in detail["lines"] if l["base_salary"] == 2000)
    # gross = 2000; NSSF emp = 60; taxable = 1940; tax = 194; net = 1746
    assert line["gross_total"]   == 2000
    assert line["nssf_employee"] == 60
    assert line["nssf_employer"] == 420
    assert line["tax_amount"]    == 194
    assert line["net_amount"]    == 1746


def test_payroll_line_edit_recomputes_with_overtime(make_client):
    c = make_client("superadmin")
    _set_setting(c, "payroll_tax_pct", 0)
    _set_setting(c, "payroll_nssf_employee_pct", 0)
    _emp(c, salary=2000)
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2025-11-01", "period_end": "2025-11-30"}).json()
    detail = c.get(f"/api/hr/payroll/runs/{run['id']}").json()
    line_id = detail["lines"][0]["id"]
    # Add an explicit $100 bonus + $50 overtime
    r = c.put(f"/api/hr/payroll/lines/{line_id}",
              json={"bonuses": 100, "overtime_amount": 50})
    assert r.status_code == 200, r.text
    b = r.json()["breakdown"]
    assert b["gross_total"] == 2150
    assert b["net_amount"]  == 2150


def test_payroll_run_totals_aggregate_breakdown(make_client):
    c = make_client("superadmin")
    _set_setting(c, "payroll_tax_pct", 10)
    _set_setting(c, "payroll_nssf_employee_pct", 3)
    _set_setting(c, "payroll_nssf_employer_pct", 21)
    _emp(c, full_name="A", salary=2000)
    _emp(c, full_name="B", salary=3000)
    run = c.post("/api/hr/payroll/runs",
                 json={"period_start": "2025-12-01", "period_end": "2025-12-31"}).json()
    detail = c.get(f"/api/hr/payroll/runs/{run['id']}").json()
    # Header totals = sum of line breakdowns
    assert detail["total_nssf_employee"] == sum(l["nssf_employee"] for l in detail["lines"])
    assert detail["total_tax"]           == sum(l["tax_amount"]    for l in detail["lines"])
    assert detail["total_gross"]         == sum(l["gross_total"]   for l in detail["lines"])
    assert detail["total_net"]           == sum(l["net_amount"]    for l in detail["lines"])
