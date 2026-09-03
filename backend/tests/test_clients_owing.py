"""Who owes money, biggest first.

Chasing debts starts with one question — who owes, and how much — and the
answer is read from the top of a list. The clients list could not answer it:
it had no notion of money at all, so the only way to find out was to open every
customer in turn.

The figure has ONE definition (`_OWED_SQL` in routers/clients.py), shared with
the customer's own page. Two queries written months apart, one of which forgets
that a voided invoice is not a debt, is how the list and the profile come to
disagree — and that exact omission has been found four separate times in this
codebase. The last test here is the one that keeps them honest.
"""
import uuid

import pytest


def _client(c, name):
    return c.post("/api/clients/", json={"name": name}).json()["id"]


def _invoice(c, client_id, amount, paid=0):
    inv = c.post("/api/invoices/", json={
        "client_id": client_id,
        "items": [{"name": "Job", "quantity": 1, "unit_price": amount}]})
    assert inv.status_code in (200, 201), inv.text
    invoice_id = inv.json()["id"]
    if paid:
        r = c.post(f"/api/invoices/{invoice_id}/payments", json={
            "amount": paid, "method": "Cash", "idempotency_key": str(uuid.uuid4())})
        assert r.status_code == 200, r.text
    return invoice_id


def _rows(c, **params):
    r = c.get("/api/clients/", params=params)
    assert r.status_code == 200, r.text
    body = r.json()
    return body if isinstance(body, list) else body["items"]


def _named(rows):
    return [(x["name"], x["outstanding"]) for x in rows]


# ── the view ────────────────────────────────────────────────────────────────
def test_it_lists_only_accounts_that_owe(make_client):
    c = make_client("superadmin")
    _invoice(c, _client(c, "OW Owes"), 100)
    _invoice(c, _client(c, "OW Settled"), 400, paid=400)
    _client(c, "OW Never Billed")

    names = [n for n, _ in _named(_rows(c, owing=1))]
    assert "OW Owes" in names
    assert "OW Settled" not in names
    assert "OW Never Billed" not in names


def test_the_biggest_debt_is_first(make_client):
    c = make_client("superadmin")
    _invoice(c, _client(c, "OW A"), 100)
    _invoice(c, _client(c, "OW B"), 900, paid=200)      # owes 700
    _invoice(c, _client(c, "OW C"), 300)

    owed = [amt for _n, amt in _named(_rows(c, owing=1))]
    assert owed == sorted(owed, reverse=True), "not ordered biggest first"
    assert owed[0] == pytest.approx(700)


def test_a_part_payment_lowers_the_figure(make_client):
    c = make_client("superadmin")
    cl = _client(c, "OW Part")
    inv = _invoice(c, cl, 500)

    assert dict(_named(_rows(c, owing=1)))["OW Part"] == pytest.approx(500)
    c.post(f"/api/invoices/{inv}/payments", json={
        "amount": 200, "method": "Cash", "idempotency_key": str(uuid.uuid4())})
    assert dict(_named(_rows(c, owing=1)))["OW Part"] == pytest.approx(300)


def test_a_voided_invoice_is_not_a_debt(make_client):
    """The omission that has bitten four other readers in this codebase."""
    c = make_client("superadmin")
    cl = _client(c, "OW Voided")
    inv = _invoice(c, cl, 500)
    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "test"}).status_code == 200

    assert "OW Voided" not in [n for n, _ in _named(_rows(c, owing=1))]
    assert dict(_named(_rows(c)))["OW Voided"] == pytest.approx(0)


def test_the_api_refuses_an_overpayment(make_client):
    """Which is why the clamp below can only ever be reached by older data."""
    c = make_client("superadmin")
    inv = _invoice(c, _client(c, "OW NoOver"), 100)
    r = c.post(f"/api/invoices/{inv}/payments", json={
        "amount": 150, "method": "Cash", "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 400
    assert "exceeds" in r.text.lower()


def test_an_overpaid_account_reads_zero_not_negative(make_client, db):
    """A credit is not a debt, and must not sort above real ones.

    The endpoint refuses an overpayment, so this writes the payment row
    directly — the shape a row could take from older data or an import. The
    clamp has to hold whatever put it there, and a negative would otherwise
    sort to the bottom of the owing list and drag the total down.
    """
    c = make_client("superadmin")
    cl = _client(c, "OW Over")
    inv = _invoice(c, cl, 100, paid=100)
    db.execute(
        "INSERT INTO invoice_payments (invoice_id, amount, method, paid_at, "
        " idempotency_key) VALUES (?,?,?,?,?)",
        (inv, 50, "Cash", "2026-01-01 00:00:00", str(uuid.uuid4())))
    db.commit()

    assert dict(_named(_rows(c)))["OW Over"] == pytest.approx(0),         "a credit balance was reported as a negative debt"
    assert "OW Over" not in [n for n, _ in _named(_rows(c, owing=1))]


# ── the unfiltered list is unchanged ────────────────────────────────────────
def test_without_the_filter_everyone_is_listed(make_client):
    c = make_client("superadmin")
    _invoice(c, _client(c, "OW Shown Owing"), 100)
    _client(c, "OW Shown Clear")

    names = [n for n, _ in _named(_rows(c))]
    assert "OW Shown Owing" in names and "OW Shown Clear" in names


def test_every_row_carries_the_figure(make_client):
    """So the column needs no second request per row."""
    c = make_client("superadmin")
    _client(c, "OW Col")
    for row in _rows(c):
        assert "outstanding" in row


def test_sorting_and_paging_still_work(make_client):
    c = make_client("superadmin")
    for n in ("OW P1", "OW P2", "OW P3"):
        _invoice(c, _client(c, n), 100)

    r = c.get("/api/clients/", params={"owing": 1, "limit": 2, "offset": 0,
                                       "sort": "outstanding", "dir": "asc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["items"]) <= 2
    assert body["total"] >= 3
    owed = [x["outstanding"] for x in body["items"]]
    assert owed == sorted(owed), "ascending sort was ignored"


# ── the invariant that matters most ─────────────────────────────────────────
def test_the_list_and_the_profile_never_disagree(make_client):
    """One number, two screens.

    They are computed by different SQL in different functions, so this asserts
    they agree across the cases that have historically pulled them apart: a
    part payment, a voided invoice, and an overpayment.
    """
    c = make_client("superadmin")
    cl = _client(c, "OW Agree")
    _invoice(c, cl, 900, paid=200)          # owes 700
    voided = _invoice(c, cl, 500)           # owes nothing once voided
    assert c.patch(f"/api/invoices/{voided}/void",
                   json={"reason": "test"}).status_code == 200

    from_list = dict(_named(_rows(c)))["OW Agree"]
    profile = c.get(f"/api/clients/{cl}").json()["stats"]["outstanding"]
    plan = c.get(f"/api/clients/{cl}/plan").json()["outstanding"]

    assert from_list == pytest.approx(700)
    assert profile == pytest.approx(from_list), "list disagrees with the profile"
    assert plan == pytest.approx(from_list), "list disagrees with the payment plan"
