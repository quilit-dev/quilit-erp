"""Custom expense categories are allowed.

The category whitelist was relaxed so users can add their own categories from
the picker. The ledger maps any unknown category to the Other Expense account
(accounting.expense_account_code), so the journal entry still posts and balances.
"""
import pytest


def test_custom_category_is_accepted_and_posts_to_gl(make_client, db):
    c = make_client("superadmin")
    r = c.post("/api/finance/expenses", json={"category": "Marketing", "amount": 120})
    assert r.status_code in (200, 201), r.text
    eid = r.json()["id"]

    row = db.execute("SELECT category, status FROM expenses WHERE id=?", (eid,)).fetchone()
    assert row["category"] == "Marketing"

    je = db.execute(
        "SELECT id FROM journal_entries WHERE source_type='expense' AND source_id=?",
        (eid,),
    ).fetchone()
    assert je, "custom-category expense did not post a journal entry"


def test_blank_category_is_still_rejected(make_client):
    c = make_client("superadmin")
    r = c.post("/api/finance/expenses", json={"category": "   ", "amount": 50})
    assert r.status_code in (400, 422), r.text
