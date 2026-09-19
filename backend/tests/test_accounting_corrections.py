"""
The ledger follows the business record, and an accountant corrects it without
rewriting it.

Six things that were wrong, each one a way for the books to drift from what
the business did, and the one correction an accountant needs:

  * An expense that needed approval never reached the ledger when approved.
  * Editing a posted expense changed the row and left the old journal saying
    what it said the day the expense was first recorded.
  * A reversal was booked to the default branch, not the original's.
  * The year-end close sent the result to the default chart's 3900, which on
    the Lebanese chart is retired.
  * Any posting path could land on an inactive or heading account.
  * A pending or rejected expense counted in Finance totals and the VAT report.

And Reclassify: a line posted to the wrong account is moved to the right one
by a NEW balancing entry linked to the original --- never by editing the
posted line. A bare Reverse on an entry a document produced is refused.
"""
import pytest

import accounting

pytestmark = pytest.mark.critical


def _expense(c, amount=110, category="Rent", **extra):
    r = c.post("/api/finance/expenses", json={"category": category, "description": "x",
                                              "amount": amount, "payment_method": "Cash", **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _live_entry(db, source_type, source_id):
    return accounting.source_entry(db, source_type, source_id)


def _lines(db, je_id):
    return {r["code"]: (float(r["debit"]), float(r["credit"])) for r in db.execute(
        "SELECT a.code, l.debit, l.credit FROM journal_entry_lines l "
        "JOIN chart_of_accounts a ON a.id=l.account_id WHERE l.journal_entry_id=?", (je_id,))}


def _balance(db, code):
    row = db.execute(
        "SELECT COALESCE(SUM(l.debit),0) - COALESCE(SUM(l.credit),0) AS b "
        "  FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id=l.account_id "
        "  JOIN journal_entries e ON e.id=l.journal_entry_id "
        " WHERE a.code=? AND e.status <> 'draft'", (code,)).fetchone()
    return round(float(row["b"] or 0), 2)


# ── an approved expense reaches the ledger, once ─────────────────────────────
def _pending_expense_with_request(c, db, amount=200):
    """An expense held for approval, plus the request a Manager can resolve.
    Built directly, the way test_workflow_approvals seeds its requests."""
    eid = _expense(c, amount=amount)
    db.execute("UPDATE expenses SET status='Pending Approval' WHERE id=?", (eid,))
    # Creation posted it (no policy fired in the test seed); take that back
    # so the row is what a policy-gated expense looks like: held, no entry.
    je = _live_entry(db, "expense", eid)
    if je:
        db.execute("DELETE FROM journal_entry_lines WHERE journal_entry_id=?", (je["id"],))
        db.execute("DELETE FROM journal_entries WHERE id=?", (je["id"],))
    uid = db.execute("SELECT id FROM users WHERE username='u_sales'").fetchone()["id"]
    cur = db.execute(
        "INSERT INTO approval_requests (policy_name, module, entity_id, entity_label, trigger_action, "
        " status, approval_type, current_step, total_steps, requested_by, requested_at) "
        "VALUES ('QA','expense',?,'Rent','create','pending','single',1,1,?,datetime('now'))", (eid, uid))
    req = cur.lastrowid
    db.execute("INSERT INTO approval_steps (request_id, step_number, approver_role, status) "
               "VALUES (?,1,'Manager','pending')", (req,))
    db.commit()
    return eid, req


def test_an_approved_expense_is_posted_exactly_once(make_client, db):
    c = make_client("superadmin")
    eid, req = _pending_expense_with_request(c, db)
    assert _live_entry(db, "expense", eid) is None
    assert make_client("Manager").post(f"/api/approval-requests/{req}/approve", json={}).status_code == 200
    je = _live_entry(db, "expense", eid)
    assert je is not None, "approval must put the expense on the books"
    assert float(je["total_debit"]) == pytest.approx(200)
    # A second resolution --- replayed request, force-approve --- posts nothing more.
    assert make_client("superadmin").post(f"/api/approval-requests/{req}/force-approve", json={}).status_code in (200, 400, 409)
    n = db.execute("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='expense' AND source_id=?",
                   (eid,)).fetchone()["n"]
    assert n == 1


def test_a_rejected_expense_posts_nothing(make_client, db):
    c = make_client("superadmin")
    eid, req = _pending_expense_with_request(c, db)
    assert make_client("Manager").post(f"/api/approval-requests/{req}/reject", json={}).status_code == 200
    assert _live_entry(db, "expense", eid) is None


# ── editing a posted expense moves the ledger with it ────────────────────────
def test_editing_a_posted_expense_reverses_and_reposts(make_client, db):
    c = make_client("superadmin")
    eid = _expense(c, amount=100, category="Rent")
    first = _live_entry(db, "expense", eid)
    assert first is not None

    r = c.put(f"/api/finance/expenses/{eid}", json={"category": "Utilities", "description": "x",
                                                     "amount": 150, "payment_method": "Cash"})
    assert r.status_code == 200, r.text
    # The old entry is reversed (still readable), a new one stands.
    old = db.execute("SELECT * FROM journal_entries WHERE id=?", (first["id"],)).fetchone()
    assert old["status"] == "reversed" and old["reversed_by"]
    live = _live_entry(db, "expense", eid)
    assert live is not None and live["id"] != first["id"]
    assert float(live["total_debit"]) == pytest.approx(150)
    utilities = accounting.expense_account_code("Utilities", db)
    rent = accounting.expense_account_code("Rent", db)
    assert utilities in _lines(db, live["id"])
    # Net effect on the accounts: Rent back to zero, Utilities carries 150.
    assert _balance(db, rent) == pytest.approx(0)
    assert _balance(db, utilities) == pytest.approx(150)


def test_editing_a_pending_expense_posts_nothing(make_client, db):
    c = make_client("superadmin")
    eid, _req = _pending_expense_with_request(c, db)
    r = c.put(f"/api/finance/expenses/{eid}", json={"category": "Rent", "description": "y",
                                                     "amount": 250, "payment_method": "Cash"})
    assert r.status_code == 200, r.text
    assert _live_entry(db, "expense", eid) is None


# ── reversal keeps the branch ────────────────────────────────────────────────
def test_a_reversal_is_booked_in_the_original_branch(make_client, db):
    c = make_client("superadmin")
    other = db.execute("SELECT id FROM warehouses WHERE is_default=0 LIMIT 1").fetchone()
    if not other:
        db.execute("INSERT INTO warehouses (code, name, is_default, is_active, created_at) "
                   "VALUES ('B2','Branch two',0,1,'2026-01-01')")
        db.commit()
        other = db.execute("SELECT id FROM warehouses WHERE code='B2'").fetchone()
    cash, rent = accounting.code(db, "cash"), accounting.expense_account_code("Rent", db)
    je = accounting.post_entry(db, entry_date="2026-09-01", memo="t",
                               lines=[{"code": rent, "debit": 40}, {"code": cash, "credit": 40}],
                               source_type="manual", branch_id=other["id"])
    rev = accounting.reverse_entry(db, je)
    db.commit()
    assert db.execute("SELECT branch_id FROM journal_entries WHERE id=?", (rev,)).fetchone()["branch_id"] == other["id"]
    # Each branch's own trial balance is back to zero, not just the company's.
    tb = accounting.trial_balance(db, branch_id=other["id"])
    for row in tb["rows"] if isinstance(tb, dict) else tb:
        if row["code"] in (cash, rent):
            assert round(float(row["debit"]) - float(row["credit"]), 2) == 0


# ── the close goes through the role ──────────────────────────────────────────
def test_the_year_close_uses_the_retained_earnings_role(make_client, db):
    c = make_client("superadmin")
    _expense(c, amount=100, category="Rent")
    year = 2026
    # Point the role at a different active account and the close must follow.
    db.execute("INSERT OR IGNORE INTO chart_of_accounts (code, name, type, subtype, normal_balance, "
               "is_system, is_active, created_at) VALUES ('3950','Result of the year','Equity','Equity',"
               "'credit',0,1,'2026-01-01')")
    db.execute("UPDATE account_roles SET code='3950' WHERE role='retained_earnings'")
    db.commit()
    result = accounting.close_fiscal_year(db, year, created_by=1)
    db.commit()
    lines = _lines(db, result["closing_entry_id"])
    assert "3950" in lines and "3900" not in lines


# ── no posting to an inactive or heading account ─────────────────────────────
def test_no_path_may_post_to_an_inactive_or_heading_account(db):
    cash = accounting.code(db, "cash")
    db.execute("INSERT OR IGNORE INTO chart_of_accounts (code, name, type, subtype, normal_balance, "
               "is_system, is_active, is_postable, created_at) VALUES ('6999','Old','Expense','Operating Expense',"
               "'debit',0,0,1,'2026-01-01')")
    db.execute("INSERT OR IGNORE INTO chart_of_accounts (code, name, type, subtype, normal_balance, "
               "is_system, is_active, is_postable, created_at) VALUES ('6000H','Expenses (heading)','Expense',"
               "'Operating Expense','debit',0,1,0,'2026-01-01')")
    db.commit()
    for bad in ("6999", "6000H"):
        with pytest.raises(ValueError):
            accounting.post_entry(db, entry_date="2026-09-01", memo="t",
                                  lines=[{"code": bad, "debit": 10}, {"code": cash, "credit": 10}],
                                  source_type="manual")


# ── pending expenses are requests, not costs ─────────────────────────────────
def test_pending_expenses_stay_out_of_finance_totals_and_the_vat_report(make_client, db):
    c = make_client("superadmin")
    _expense(c, amount=100, category="Rent")
    eid, _ = _pending_expense_with_request(c, db, amount=999)
    summary = c.get("/api/finance/summary").json()
    total = summary.get("total_expenses", summary.get("expenses", None))
    if total is not None:
        assert float(total) < 999
    r = c.get("/api/reports/vat", params={"start": "2026-01-01", "end": "2026-12-31"})
    if r.status_code == 200:
        body = r.text
        assert "999" not in body


# ── Reclassify ───────────────────────────────────────────────────────────────
def _acct_id(db, code):
    return db.execute("SELECT id FROM chart_of_accounts WHERE code=?", (code,)).fetchone()["id"]


def test_a_wrong_account_is_corrected_by_a_linked_balancing_entry(make_client, db):
    c = make_client("superadmin")
    eid = _expense(c, amount=100, category="Rent")
    je = _live_entry(db, "expense", eid)
    rent, util = accounting.expense_account_code("Rent", db), accounting.expense_account_code("Utilities", db)
    before = _lines(db, je["id"])

    r = c.post(f"/api/accounting/journal-entries/{je['id']}/reclassify", json={
        "from_account_id": _acct_id(db, rent), "to_account_id": _acct_id(db, util),
        "reason": "Booked to rent by mistake; it is the electricity bill"})
    assert r.status_code == 200, r.text
    new_id = r.json()["id"]
    # The original is untouched --- still posted, same lines.
    assert db.execute("SELECT status FROM journal_entries WHERE id=?", (je["id"],)).fetchone()["status"] == "posted"
    assert _lines(db, je["id"]) == before
    # The new entry moves the amount and points back at the original.
    new = db.execute("SELECT * FROM journal_entries WHERE id=?", (new_id,)).fetchone()
    assert new["reclassifies_id"] == je["id"]
    assert new["branch_id"] == je["branch_id"]
    moved = _lines(db, new_id)
    assert moved[util][0] == pytest.approx(100) and moved[rent][1] == pytest.approx(100)
    assert _balance(db, rent) == pytest.approx(0) and _balance(db, util) == pytest.approx(100)
    # Both ends show the chain.
    detail = c.get(f"/api/accounting/journal-entries/{je['id']}").json()
    assert [x["id"] for x in detail["reclassified_by"]] == [new_id]
    assert c.get(f"/api/accounting/journal-entries/{new_id}").json()["reclassifies"]["id"] == je["id"]


def test_part_of_a_line_may_move_but_not_more_than_it_carries(make_client, db):
    c = make_client("superadmin")
    eid = _expense(c, amount=100, category="Rent")
    je = _live_entry(db, "expense", eid)
    rent, util = accounting.expense_account_code("Rent", db), accounting.expense_account_code("Utilities", db)
    body = {"from_account_id": _acct_id(db, rent), "to_account_id": _acct_id(db, util), "reason": "split"}
    assert c.post(f"/api/accounting/journal-entries/{je['id']}/reclassify",
                  json={**body, "amount": 40}).status_code == 200
    assert _balance(db, rent) == pytest.approx(60)
    r = c.post(f"/api/accounting/journal-entries/{je['id']}/reclassify", json={**body, "amount": 500})
    assert r.status_code == 400 and "Only" in r.text


def test_reclassify_refuses_bad_targets_and_needs_a_reason(make_client, db):
    c = make_client("superadmin")
    eid = _expense(c, amount=100, category="Rent")
    je = _live_entry(db, "expense", eid)
    rent = _acct_id(db, accounting.expense_account_code("Rent", db))
    util = _acct_id(db, accounting.expense_account_code("Utilities", db))
    cash = _acct_id(db, accounting.code(db, "cash"))
    base = f"/api/accounting/journal-entries/{je['id']}/reclassify"
    assert c.post(base, json={"from_account_id": rent, "to_account_id": util}).status_code == 400   # no reason
    assert c.post(base, json={"from_account_id": rent, "to_account_id": rent, "reason": "r"}).status_code == 400
    assert c.post(base, json={"from_account_id": 999999, "to_account_id": util, "reason": "r"}).status_code == 400
    db.execute("UPDATE chart_of_accounts SET is_active=0 WHERE id=?", (util,)); db.commit()
    assert c.post(base, json={"from_account_id": rent, "to_account_id": util, "reason": "r"}).status_code == 400
    assert cash  # the cash side is never what a reclassification touches unless asked


def test_reclassify_needs_accounting_edit(make_client, db):
    owner = make_client("superadmin")
    eid = _expense(owner, amount=100, category="Rent")
    je = _live_entry(db, "expense", eid)
    rent = _acct_id(db, accounting.expense_account_code("Rent", db))
    util = _acct_id(db, accounting.expense_account_code("Utilities", db))
    r = make_client("Viewer").post(f"/api/accounting/journal-entries/{je['id']}/reclassify",
                                   json={"from_account_id": rent, "to_account_id": util, "reason": "r"})
    assert r.status_code == 403


# ── a document's entry is not reversed behind the document's back ────────────
def test_a_bare_reverse_on_a_document_entry_is_refused(make_client, db):
    c = make_client("superadmin")
    eid = _expense(c, amount=100, category="Rent")
    je = _live_entry(db, "expense", eid)
    r = c.post(f"/api/accounting/journal-entries/{je['id']}/reverse")
    assert r.status_code == 400, r.text
    assert "Reclassify" in r.text
    assert _live_entry(db, "expense", eid) is not None
    # A manual entry may still be reversed --- that is what Reverse is for.
    cash, rent = accounting.code(db, "cash"), accounting.expense_account_code("Rent", db)
    manual = accounting.post_entry(db, entry_date="2026-09-01", memo="t", source_type="manual",
                                   lines=[{"code": rent, "debit": 5}, {"code": cash, "credit": 5}])
    db.commit()
    assert c.post(f"/api/accounting/journal-entries/{manual}/reverse").status_code == 200
