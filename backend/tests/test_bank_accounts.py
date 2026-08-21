"""Bank accounts, and the movements that went through them.

Cash drawers already answered "where are the notes". A bank transfer had nowhere
to say WHICH account it landed in, so every bank movement piled into one ledger
line and no balance could ever be reconciled against the statement the bank
sends.

Each account gets its own code in the chart, opened under whatever the `bank`
role points at — 512 بنوك on Lebanon's plan, 1000 Cash & Bank on the default.
That separate ledger account is what makes a per-account balance possible at
all.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import accounting


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _bank(client, name="Byblos — main", ccy="USD", **kw):
    body = {"name": name, "currency": ccy, "bank_name": "Byblos Bank"}
    body.update(kw)
    r = client.post("/api/banks/", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── Opening one ──────────────────────────────────────────────────────────────

def test_a_bank_account_gets_its_own_ledger_account(client, db):
    """Without a separate code every bank shares one line and no statement can
    be reconciled."""
    made = _bank(client)

    assert made["account_code"], "no ledger account was opened"
    row = db.execute("SELECT name, parent_code, is_postable FROM chart_of_accounts "
                     "WHERE code=?", (made["account_code"],)).fetchone()
    assert row is not None
    assert row["parent_code"] == accounting.code(db, "bank")
    assert row["is_postable"] == 1


def test_two_accounts_do_not_share_a_code(client):
    a = _bank(client, "Byblos — main")
    b = _bank(client, "Audi — payroll")

    assert a["account_code"] != b["account_code"]


def test_it_hangs_under_the_bank_heading_of_whatever_chart_is_active(client, db):
    """On Lebanon's plan that is 512 بنوك, not 1000."""
    made = _bank(client)
    row = db.execute("SELECT parent_code FROM chart_of_accounts WHERE code=?",
                     (made["account_code"],)).fetchone()

    assert row["parent_code"] == accounting.code(db, "bank")


def test_a_name_is_required(client):
    assert client.post("/api/banks/", json={"name": "   "}).status_code == 422


def test_only_supported_currencies(client):
    assert client.post("/api/banks/", json={"name": "X", "currency": "GBP"}).status_code == 422
    assert client.post("/api/banks/", json={"name": "Euro acct", "currency": "EUR"}).status_code == 200


# ── Listing and balances ─────────────────────────────────────────────────────

def test_the_list_carries_a_balance(client):
    _bank(client, "Byblos — main", opening_balance=500)

    rows = client.get("/api/banks/").json()

    assert len(rows) == 1
    assert rows[0]["balance"] == _pytest.approx(500)


def test_the_balance_follows_the_ledger(client, db):
    """Opening balance plus what the ledger says, so it can be compared with a
    statement rather than being a number somebody typed."""
    made = _bank(client, opening_balance=100)
    accounting.post_entry(
        db, entry_date="2026-06-01", memo="Test receipt",
        lines=[{"code": made["account_code"], "debit": 250},
               {"code": accounting.code(db, "revenue"), "credit": 250}],
        source_type="manual", source_id=None)
    db.commit()

    rows = client.get("/api/banks/").json()

    assert rows[0]["balance"] == _pytest.approx(350)


# ── Guarding the history ─────────────────────────────────────────────────────

def test_the_currency_cannot_change_once_money_has_moved(client, db):
    """The ledger account behind it holds amounts already converted at that
    currency's rates. Re-labelling it would silently reinterpret every one."""
    made = _bank(client, ccy="USD")
    accounting.post_entry(
        db, entry_date="2026-06-01", memo="Test",
        lines=[{"code": made["account_code"], "debit": 10},
               {"code": accounting.code(db, "revenue"), "credit": 10}],
        source_type="manual", source_id=None)
    db.commit()

    r = client.put(f"/api/banks/{made['id']}",
                   json={"name": "Byblos — main", "currency": "EUR"})

    assert r.status_code == 400
    assert "movements" in r.text


def test_the_currency_can_change_before_anything_moved(client):
    made = _bank(client, ccy="USD")

    r = client.put(f"/api/banks/{made['id']}",
                   json={"name": "Byblos — main", "currency": "EUR"})

    assert r.status_code == 200


def test_archiving_keeps_the_account(client, db):
    """An account is what historical entries point at, so it is retired rather
    than removed."""
    made = _bank(client)

    assert client.patch(f"/api/banks/{made['id']}/archive").status_code == 200

    assert client.get("/api/banks/").json() == []
    assert len(client.get("/api/banks/?include_archived=true").json()) == 1
    assert db.execute("SELECT 1 FROM chart_of_accounts WHERE code=?",
                      (made["account_code"],)).fetchone() is not None


def test_archiving_can_be_undone(client):
    made = _bank(client)
    client.patch(f"/api/banks/{made['id']}/archive")

    assert client.patch(f"/api/banks/{made['id']}/unarchive").status_code == 200
    assert len(client.get("/api/banks/").json()) == 1


# ── Routing a movement ───────────────────────────────────────────────────────

def test_a_movement_through_an_account_lands_in_that_account(client, db):
    made = _bank(client)

    assert accounting.bank_account_code(db, made["id"]) == made["account_code"]


def test_without_an_account_it_falls_back_to_where_it_always_went(db):
    """Older payments, and tenants that never set any up, must keep posting."""
    assert accounting.bank_account_code(db, None) == accounting.code(db, "bank")
    assert accounting.bank_account_code(db, 9999) == accounting.code(db, "bank")


def test_cash_still_follows_the_currency(db):
    """Each currency keeps its own cash account so a balance in a non-functional
    currency can be revalued without unpicking it from the rest."""
    assert accounting.money_account_for(db, method="Cash", currency="USD") == \
        accounting.code(db, "cash")
    assert accounting.money_account_for(db, method="Cash", currency="LBP") == \
        accounting.code(db, "cash_lbp")


def test_a_transfer_goes_to_the_bank_not_the_till(db):
    assert accounting.money_account_for(db, method="Bank Transfer", currency="USD") == \
        accounting.code(db, "bank")
