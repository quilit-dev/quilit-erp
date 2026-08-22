"""Putting a tenant on the Lebanese chart, from the application.

The chart itself was written and then reachable from nothing — no endpoint, no
screen, no way for the owner who supplied it to apply it. These cover the path
that makes it real, and the refusal that protects a tenant which has already
posted.
"""
import pytest as _pytest

import chart_lebanon as LB

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _status(client):
    return client.get("/api/accounting/chart").json()


def _install(client, **body):
    return client.post("/api/accounting/chart/lebanon/install", json=body)


# ── Seeing which chart you are on ────────────────────────────────────────────

def test_a_new_tenant_is_on_the_default_chart(client):
    body = _status(client)

    assert body["current"] == "default"
    lb = next(c for c in body["charts"] if c["key"] == "lebanon")
    assert lb["installed"] is False
    assert lb["accounts_total"] == len(LB.all_accounts())


def test_the_status_says_how_far_along_it_is(client):
    """"You are not on it" is not enough to act on: an install that half
    finished has to be visible as half finished."""
    lb = next(c for c in _status(client)["charts"] if c["key"] == "lebanon")

    assert lb["roles_total"] == len(LB.ROLES)
    assert lb["accounts_present"] <= lb["accounts_total"]
    assert "posted_lines" in lb and "clean" in lb


# ── Installing it ────────────────────────────────────────────────────────────

def test_a_tenant_that_has_never_posted_can_switch_freely(client):
    r = _install(client)

    assert r.status_code == 200, r.text
    assert _status(client)["current"] == "lebanon"


def test_the_statutory_accounts_are_there_afterwards(client):
    _install(client)

    codes = {a["code"] for a in client.get("/api/accounting/accounts").json()}
    # Class 4 is third parties in this plan and class 5 is financial — not a
    # renaming of the default chart but a different tree.
    assert "4111" in codes      # customers
    assert "5311" in codes      # cash on hand, LBP
    assert "7011" in codes      # sales


def test_the_arabic_names_come_with_them(client):
    """The plan is published in Arabic. Seeding it in English only would be
    seeding something else."""
    _install(client)

    rows = client.get("/api/accounting/accounts").json()
    ar = next(a for a in rows if a["code"] == "4111")
    assert ar.get("name_ar")
    assert any("؀" <= ch <= "ۿ" for ch in ar["name_ar"])


def test_postings_land_on_the_new_accounts(client):
    """The roles are what decide where a posting goes. Seeding the accounts
    without re-pointing them would change nothing at all."""
    _install(client)
    cid = client.post("/api/clients/", json={"name": "Chart Co"}).json()["id"]
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}]}).json()
    inv = created.get("invoice_id") or created.get("id")

    entries = client.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]

    codes = {l["account_code"] for e in entries for l in e["lines"]}
    assert "4111" in codes, f"receivable did not land on the statutory account: {codes}"
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_the_old_chart_is_retired_not_deleted(client):
    """An account is what historical entries point at. Removing one would make
    the old ledger unreadable."""
    before = {a["code"] for a in client.get("/api/accounting/accounts").json()}
    assert "1100" in before

    _install(client)

    every = {a["code"] for a in client.get("/api/accounting/accounts").json()}
    active = {a["code"] for a in
              client.get("/api/accounting/accounts", params={"active": True}).json()}
    assert "1100" in every, "the old account was deleted"
    assert "1100" not in active, "the old account is still being offered"


def test_installing_twice_changes_nothing(client):
    _install(client)
    first = _status(client)

    r = _install(client)

    assert r.status_code == 200
    assert _status(client) == first


# ── The refusal that protects a live tenant ──────────────────────────────────

def test_a_tenant_with_postings_is_refused_and_told_why(client):
    """Switching mid-life leaves balances split across two charts. The message
    has to say that, and what to do instead."""
    cid = client.post("/api/clients/", json={"name": "Live Co"}).json()["id"]
    client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}]})

    r = _install(client)

    assert r.status_code == 400
    assert "posted journal lines" in r.text
    assert "SWITCH CHART" in r.text
    assert _status(client)["current"] == "default"


def test_the_phrase_lets_an_owner_proceed_anyway(client):
    """Refusing outright leaves the owner stuck with a chart they did not
    choose. The phrase makes it deliberate rather than impossible."""
    cid = client.post("/api/clients/", json={"name": "Live Co"}).json()["id"]
    client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}]})

    r = _install(client, confirm="SWITCH CHART")

    assert r.status_code == 200, r.text
    assert _status(client)["current"] == "lebanon"


def test_the_wrong_phrase_does_not_count(client):
    cid = client.post("/api/clients/", json={"name": "Live Co"}).json()["id"]
    client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}]})

    r = _install(client, confirm="yes")

    assert r.status_code == 400
    assert _status(client)["current"] == "default"


def test_the_old_entries_still_read_after_a_forced_switch(client):
    """They keep pointing at the accounts they were posted to, which is
    exactly right — and the books must still balance."""
    cid = client.post("/api/clients/", json={"name": "Live Co"}).json()["id"]
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": 100}]}).json()
    inv = created.get("invoice_id") or created.get("id")

    _install(client, confirm="SWITCH CHART")

    entries = client.get(f"/api/accounting/for/invoice/{inv}").json()["entries"]
    codes = {l["account_code"] for e in entries for l in e["lines"]}
    assert "1100" in codes, "the historical entry was rewritten"
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_switching_is_written_to_the_audit_trail(client, db):
    _install(client)

    row = db.execute(
        "SELECT * FROM audit_log WHERE action='install_chart' "
        "ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None


def test_it_needs_permission_to_change_the_books(as_role):
    r = as_role("Sales").post("/api/accounting/chart/lebanon/install", json={})

    assert r.status_code == 403
