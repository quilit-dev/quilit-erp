"""Getting the old chart out of the books, and keeping it out.

Installing a statutory chart RETIRES the previous one rather than removing it,
which is right while the old chart has history — an account is what historical
entries point at. On a business that switched before it ever posted, it is
forty rows of a chart nobody uses sitting in the account list beside the real
one, and they cannot be deleted by hand because every seeded account is a
system account.

The other half of the problem was that they came BACK. Every migration that
adds an account inserts it active, so a tenant already on the Lebanese plan
collected default-chart codes one deploy at a time — euro cash, then the
asset-disposal pair. Two charts again, arriving quietly.
"""
import uuid
from datetime import date

import pytest as _pytest

import chart_lebanon as LB

pytestmark = _pytest.mark.critical

OURS = {a[0] for a in LB.all_accounts()}


@_pytest.fixture
def default_chart(as_role):
    """A tenant that never switched — still on the chart it started with."""
    return as_role("superadmin")


@_pytest.fixture
def client(as_role):
    c = as_role("superadmin")
    r = c.post("/api/accounting/chart/lebanon/install", json={"confirm": "SWITCH CHART"})
    assert r.status_code == 200, r.text
    return c


def _accounts(c, **params):
    return c.get("/api/accounting/accounts", params=params).json()


def _foreign(c, active_only=False):
    rows = _accounts(c)
    return [r for r in rows
            if r["code"] not in OURS and (not active_only or r["is_active"])]


def _preview(c):
    r = c.get("/api/accounting/chart/purge/preview")
    assert r.status_code == 200, r.text
    return r.json()


# ── What it can see ──────────────────────────────────────────────────────────

def test_it_lists_the_old_chart_as_removable(client):
    body = _preview(client)

    assert body["eligible"] is True
    assert body["removable_count"] > 20        # the default chart, in full
    assert all(a["lines"] == 0 for a in body["removable"])


def test_it_says_nothing_is_removable_on_the_default_chart(default_chart):
    """"Remove the accounts not on the current chart" would otherwise delete
    the chart the business is actually using."""
    body = _preview(default_chart)

    assert body["eligible"] is False
    assert body["reason"] == "default"


def test_the_preview_deletes_nothing(client, db):
    before = db.execute("SELECT COUNT(*) AS n FROM chart_of_accounts").fetchone()["n"]

    _preview(client)

    assert db.execute("SELECT COUNT(*) AS n FROM chart_of_accounts").fetchone()["n"] == before


# ── Removing it ──────────────────────────────────────────────────────────────

def test_the_old_chart_is_gone_afterwards(client):
    r = client.post("/api/accounting/chart/purge")

    assert r.status_code == 200, r.text
    assert _foreign(client) == []


def test_the_lebanese_chart_is_untouched(client):
    before = len([a for a in _accounts(client) if a["code"] in OURS])

    client.post("/api/accounting/chart/purge")

    assert len([a for a in _accounts(client) if a["code"] in OURS]) == before


def test_an_account_a_role_points_at_is_never_removed(client, db):
    """Even one off the published plan. Deleting where the next posting is
    about to land breaks tomorrow's transaction, not yesterday's."""
    db.execute("INSERT OR IGNORE INTO chart_of_accounts "
               "(code, name, type, subtype, normal_balance, is_system, is_active, created_at) "
               "VALUES ('9999','Odd one','Expense','Other Expense','debit',0,1,'2026-01-01')")
    db.execute("INSERT INTO account_roles (role, code, updated_at) VALUES "
               "('other_expense','9999','2026-01-01') "
               "ON CONFLICT(role) DO UPDATE SET code=excluded.code")
    db.commit()

    client.post("/api/accounting/chart/purge")

    assert db.execute("SELECT 1 FROM chart_of_accounts WHERE code='9999'").fetchone()


def test_a_bank_account_keeps_its_own_leaf(client, db):
    """It opens under whatever the bank role points at, so it is a child of
    this chart rather than a stranger to it."""
    bank = client.post("/api/banks/", json={"name": "Byblos", "currency": "USD"}).json()

    client.post("/api/accounting/chart/purge")

    assert db.execute("SELECT 1 FROM chart_of_accounts WHERE code=?",
                      (bank["account_code"],)).fetchone()


def test_the_books_still_balance(client):
    client.post("/api/accounting/chart/purge")

    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_it_is_written_to_the_audit_trail(client, db):
    client.post("/api/accounting/chart/purge")

    row = db.execute("SELECT * FROM audit_log WHERE action='chart_purge' "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None


def test_it_needs_permission(as_role):
    r = as_role("Sales").post("/api/accounting/chart/purge")

    assert r.status_code == 403


# ── What it refuses to remove ────────────────────────────────────────────────

def test_an_account_with_history_stays(as_role, db):
    """An entry pointing at an account that no longer exists is a trial
    balance that cannot explain itself."""
    c = as_role("superadmin")
    cid = c.post("/api/clients/", json={"name": "Co"}).json()["id"]
    created = c.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": str(date.today()),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": 100}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    c.post(f"/api/invoices/{inv}/payments", json={
        "amount": 100, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    # Switching with history is the case the cutover exists for.
    c.post("/api/accounting/chart/lebanon/install",
           json={"confirm": "SWITCH CHART", "force": True})

    body = c.get("/api/accounting/chart/purge/preview").json()

    assert body["kept_count"] >= 1
    assert all(a["lines"] > 0 for a in body["kept"])
    # And it names them, because "3 must stay" invites "which ones".
    assert body["kept"][0]["code"]


def test_removing_leaves_the_ones_with_history_retired(as_role, db):
    c = as_role("superadmin")
    cid = c.post("/api/clients/", json={"name": "Co"}).json()["id"]
    created = c.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": str(date.today()),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": 100}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    c.post(f"/api/invoices/{inv}/payments", json={
        "amount": 100, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    c.post("/api/accounting/chart/lebanon/install",
           json={"confirm": "SWITCH CHART", "force": True})

    r = c.post("/api/accounting/chart/purge")

    assert r.status_code == 200, r.text
    kept = r.json()["kept_codes"]
    assert kept
    for code in kept:
        row = db.execute("SELECT is_active FROM chart_of_accounts WHERE code=?",
                         (code,)).fetchone()
        assert row and row["is_active"] == 0


def test_running_it_twice_is_told_there_is_nothing_left(client):
    client.post("/api/accounting/chart/purge")

    r = client.post("/api/accounting/chart/purge")

    assert r.status_code == 400
    assert "nothing here" in r.text.lower()


# ── And they do not come back ────────────────────────────────────────────────

def test_an_account_a_later_migration_adds_is_retired_not_offered(client, db):
    """The half that kept undoing the switch. A migration inserts an account
    ACTIVE, so a tenant already on this plan collected default-chart codes one
    deploy at a time."""
    db.execute("INSERT OR IGNORE INTO chart_of_accounts "
               "(code, name, type, subtype, normal_balance, is_system, is_active, created_at) "
               "VALUES ('4999','Added By A Later Deploy','Income','Other Income','credit',1,1,'2026-01-01')")
    db.commit()
    assert db.execute("SELECT is_active FROM chart_of_accounts "
                      "WHERE code='4999'").fetchone()["is_active"] == 1

    LB.reconcile_active(db)

    assert db.execute("SELECT is_active FROM chart_of_accounts "
                      "WHERE code='4999'").fetchone()["is_active"] == 0


def test_it_leaves_the_default_chart_alone(default_chart, db):
    """A tenant that never switched must keep every account it is using."""
    before = db.execute("SELECT COUNT(*) AS n FROM chart_of_accounts "
                        "WHERE is_active=1").fetchone()["n"]

    LB.reconcile_active(db)

    assert db.execute("SELECT COUNT(*) AS n FROM chart_of_accounts "
                      "WHERE is_active=1").fetchone()["n"] == before


def test_it_does_not_retire_the_lebanese_accounts_themselves(client, db):
    LB.reconcile_active(db)

    active = {r["code"] for r in db.execute(
        "SELECT code FROM chart_of_accounts WHERE is_active=1").fetchall()}
    assert OURS <= active
