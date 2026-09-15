"""Money handed to an employee before payday, and getting it back.

An advance (سلفة) is an ASSET --- the person owes it --- not an expense.
Recording one posts DR 1260 Advances to Employees / CR cash. The next payroll
run deducts the open total from the person's net, and when that run is PAID
it credits 1260 for the recovery, so the salary cost is recognised once, in
full, by the run, and the asset is cleared.

Three things these tests care about beyond the arithmetic:

  * **A draft that is cancelled leaves the advance open.** Recovery is
    claimed at seed and confirmed only at Paid. Anything else means a
    cancelled run could quietly write off what somebody owes.
  * **An advance recorded after the run was opened is not in it.** It was not
    in any line's figure, so marking it recovered would lose the money.
  * **Two drafts cannot both recover the same advance.** The first to seed
    claims it; the second sees nothing to recover.
"""
import pytest

pytestmark = pytest.mark.critical

START, END = "2026-03-01", "2026-03-31"


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _employee(c, **kw):
    body = {"full_name": "Nour", "salary": 1000}
    body.update(kw)
    r = c.post("/api/hr/employees", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _advance(c, emp, amount, **kw):
    body = {"employee_id": emp, "amount": amount, "paid_at": "2026-03-10"}
    body.update(kw)
    r = c.post("/api/hr/advances", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _advances(c, emp):
    return c.get(f"/api/hr/advances?employee_id={emp}").json()


def _run(c):
    r = c.post("/api/hr/payroll/runs", json={"period_start": START, "period_end": END})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _line(c, run, emp):
    body = c.get(f"/api/hr/payroll/runs/{run}").json()
    return next(l for l in body["lines"] if l["employee_id"] == emp)


def _pay(c, run):
    assert c.post(f"/api/hr/payroll/runs/{run}/approve").status_code == 200
    r = c.post(f"/api/hr/payroll/runs/{run}/mark-paid", json={"payment_method": "Cash"})
    assert r.status_code == 200, r.text


def _balance(db, code):
    row = db.execute(
        "SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS bal "
        "  FROM journal_entry_lines l "
        "  JOIN journal_entries je ON je.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id "
        # != 'draft', as the statements themselves read it: a reversed entry
        # and its reversal BOTH count, and net to nothing.
        " WHERE a.code = ? AND je.status != 'draft'", (code,)).fetchone()
    return round(float(row["bal"] or 0), 2)


# ── recording ────────────────────────────────────────────────────────────────
def test_recording_an_advance_is_an_asset_not_an_expense(client, db):
    emp = _employee(client)
    cash_before = _balance(db, "1000")
    _advance(client, emp, 200)

    assert _balance(db, "1260") == pytest.approx(200), "the advance is not sitting in 1260"
    assert _balance(db, "1000") == pytest.approx(cash_before - 200)
    assert _balance(db, "6000") == 0, "an advance reached Salaries expense"
    assert _advances(client, emp)["outstanding"] == pytest.approx(200)


def test_voiding_reverses_the_posting(client, db):
    emp = _employee(client)
    adv = _advance(client, emp, 200)
    r = client.patch(f"/api/hr/advances/{adv}/void", json={"reason": "keyed twice"})
    assert r.status_code == 200, r.text
    assert _balance(db, "1260") == 0
    assert _advances(client, emp)["outstanding"] == 0


def test_a_recovered_advance_cannot_be_voided(client):
    emp = _employee(client)
    adv = _advance(client, emp, 200)
    _pay(client, _run(client))
    r = client.patch(f"/api/hr/advances/{adv}/void", json={})
    assert r.status_code == 400 and "recovered" in r.text


def test_an_advance_needs_a_positive_amount(client):
    emp = _employee(client)
    r = client.post("/api/hr/advances", json={"employee_id": emp, "amount": 0})
    assert r.status_code == 422


# ── recovery ─────────────────────────────────────────────────────────────────
def test_the_next_run_deducts_the_open_total(client):
    emp = _employee(client, salary=1000)
    _advance(client, emp, 200)
    _advance(client, emp, 50)
    line = _line(client, _run(client), emp)
    assert line["advance_recovery"] == pytest.approx(250)
    assert line["net_amount"] == pytest.approx(750)


def test_marking_paid_recovers_them_and_relieves_the_asset(client, db):
    emp = _employee(client, salary=1000)
    _advance(client, emp, 200)
    cash_before = _balance(db, "1000")          # already net of the advance
    run = _run(client)
    _pay(client, run)

    rows = _advances(client, emp)
    assert rows["outstanding"] == 0
    assert all(r["status"] == "recovered" and r["recovered_in_run_id"] == run
               for r in rows["rows"])
    # The books: salary cost is the whole 1000; 800 left as cash now, 200 had
    # already left as the advance --- so 1260 is back to zero.
    assert _balance(db, "6000") == pytest.approx(1000)
    assert _balance(db, "1260") == 0
    assert _balance(db, "1000") == pytest.approx(cash_before - 800)


def test_a_cancelled_draft_leaves_the_advance_open(client):
    """Recovery is claimed at seed and confirmed only at Paid."""
    emp = _employee(client)
    _advance(client, emp, 200)
    run = _run(client)
    assert _line(client, run, emp)["advance_recovery"] == 200
    assert client.post(f"/api/hr/payroll/runs/{run}/cancel").status_code == 200

    assert _advances(client, emp)["outstanding"] == pytest.approx(200)
    # ...and the next run picks it up.
    assert _line(client, _run(client), emp)["advance_recovery"] == 200


def test_an_advance_recorded_after_the_run_opened_is_not_swallowed_by_it(client):
    emp = _employee(client)
    run = _run(client)                       # nothing to recover yet
    late = _advance(client, emp, 300)        # recorded while the run is a draft
    _pay(client, run)

    rows = _advances(client, emp)
    assert rows["outstanding"] == pytest.approx(300), "an advance not in any line was marked recovered"
    assert next(r for r in rows["rows"] if r["id"] == late)["status"] == "open"


def test_two_drafts_cannot_both_recover_the_same_advance(client):
    emp = _employee(client)
    _advance(client, emp, 200)
    first = _run(client)
    second = _run(client)
    assert _line(client, first, emp)["advance_recovery"] == 200
    assert _line(client, second, emp)["advance_recovery"] == 0


def test_an_advance_claimed_by_a_draft_cannot_be_voided_underneath_it(client):
    emp = _employee(client)
    adv = _advance(client, emp, 200)
    _run(client)
    r = client.patch(f"/api/hr/advances/{adv}/void", json={})
    assert r.status_code == 400 and "draft" in r.text.lower()


def test_an_advance_larger_than_the_pay_stops_the_run_being_approved(client):
    """The seed records the truth --- recovery 500 against pay 100 --- and the
    run refuses to be approved while a line is negative, naming the person.
    Nobody is paid a minus, and nothing is silently written off."""
    emp = _employee(client, full_name="Nour", salary=100)
    _advance(client, emp, 500)
    run = _run(client)
    assert _line(client, run, emp)["net_amount"] == pytest.approx(-400)

    r = client.post(f"/api/hr/payroll/runs/{run}/approve")
    assert r.status_code == 400 and "Nour" in r.text, r.text
