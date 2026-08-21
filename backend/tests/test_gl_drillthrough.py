"""From a posting to the paper behind it, and back again.

Every journal entry carries `(source_type, source_id)`, which tells the code
that wrote it everything and the person reading the ledger nothing. These tests
cover the two directions an operator actually travels: opening the document
behind a posting, and asking a document what it did to the books.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Drill Co"}).json()["id"]


def _invoice(client, cid, amount=100):
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-03-31",
        "items": [{"name": "Item", "quantity": 1, "unit_price": amount}]}).json()
    return created.get("invoice_id") or created.get("id")


def _entries(client, **kw):
    return client.get("/api/accounting/journal-entries", params=kw).json()


# ── A posting names its document ─────────────────────────────────────────────

def test_an_invoice_posting_carries_the_invoice_number(client, acme):
    inv = _invoice(client, acme)

    rows = _entries(client, source_type="invoice")["rows"]

    src = next(r["source"] for r in rows if r["source_id"] == inv)
    assert src["label"] == client.get(f"/api/invoices/{inv}").json()["invoice_number"]
    assert src["route"] == f"/invoices?focus={inv}"


def test_a_payment_posting_points_at_the_invoice_it_settled(client, acme):
    """The payment row is not a document. The invoice is."""
    inv = _invoice(client, acme)
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 100, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    rows = _entries(client, source_type="invoice_payment")["rows"]

    src = rows[0]["source"]
    assert src["route"] == f"/invoices?focus={inv}"
    assert src["label"]      # named by the invoice it settled


def test_the_detail_resolves_its_source_too(client, acme):
    inv = _invoice(client, acme)
    je = _entries(client, source_type="invoice")["rows"][0]["id"]

    detail = client.get(f"/api/accounting/journal-entries/{je}").json()

    assert detail["source"]["route"] == f"/invoices?focus={inv}"


def test_an_entry_with_no_document_behind_it_says_so(client):
    """A manual entry has no paper. Inventing a link to one would be a lie."""
    accounts = client.get("/api/accounting/accounts", params={"active": True}).json()
    a, b = accounts[0]["id"], accounts[1]["id"]
    client.post("/api/accounting/journal-entries", json={
        "entry_date": "2026-02-01", "memo": "Manual",
        "lines": [{"account_id": a, "debit": 10, "credit": 0},
                  {"account_id": b, "debit": 0, "credit": 10}]})

    row = next(r for r in _entries(client)["rows"] if r["memo"] == "Manual")

    assert row["source"] is None


def test_a_deleted_document_does_not_break_the_ledger(client, acme, db):
    """A ledger that refuses to render because one document was purged is
    worse than one that says the document is gone."""
    inv = _invoice(client, acme)
    db.execute("DELETE FROM invoices WHERE id=?", (inv,))
    db.commit()

    row = next(r for r in _entries(client, source_type="invoice")["rows"]
               if r["source_id"] == inv)

    assert row["source"]["exists"] is False
    assert row["source"]["route"] is None


# ── A document names its postings ────────────────────────────────────────────

def test_a_document_reports_every_posting_it_produced(client, acme):
    inv = _invoice(client, acme)
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 40, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    body = client.get(f"/api/accounting/for/invoice/{inv}").json()

    kinds = {e["source_type"] for e in body["entries"]}
    assert "invoice" in kinds and "invoice_payment" in kinds


def test_the_postings_come_with_their_lines(client, acme):
    """A list of entry numbers answers nothing. The lines are the answer."""
    inv = _invoice(client, acme)

    body = client.get(f"/api/accounting/for/invoice/{inv}").json()

    lines = body["entries"][0]["lines"]
    assert lines and all("account_code" in l for l in lines)


def test_a_document_with_no_postings_returns_an_empty_list(client, acme):
    body = client.get("/api/accounting/for/purchase/999999").json()

    assert body["entries"] == []


def test_an_unknown_document_type_is_refused(client):
    assert client.get("/api/accounting/for/banana/1").status_code == 404


def test_it_needs_permission_to_read_the_books(as_role, client, acme):
    inv = _invoice(client, acme)

    r = as_role("Sales").get(f"/api/accounting/for/invoice/{inv}")

    assert r.status_code == 403


# ── Searching the journal ────────────────────────────────────────────────────

def test_the_search_reaches_the_account_on_the_lines(client, acme):
    """Nobody searches the journal by entry number. They search by account."""
    _invoice(client, acme)
    code = client.get("/api/accounting/journal-entries",
                      params={"source_type": "invoice"}).json()["rows"][0]
    je = client.get(f"/api/accounting/journal-entries/{code['id']}").json()
    account = je["lines"][0]["account_name"]

    found = _entries(client, q_text=account)["rows"]

    assert any(r["id"] == code["id"] for r in found)


def test_the_search_can_be_narrowed_to_one_account(client, acme):
    _invoice(client, acme)
    je = client.get(f"/api/accounting/journal-entries/"
                    f"{_entries(client)['rows'][0]['id']}").json()
    acct = je["lines"][0]["account_id"]

    rows = _entries(client, account_id=acct)["rows"]

    assert rows
    for r in rows:
        detail = client.get(f"/api/accounting/journal-entries/{r['id']}").json()
        assert any(l["account_id"] == acct for l in detail["lines"])


def test_amount_bounds_exclude_what_falls_outside_them(client, acme):
    _invoice(client, acme, amount=100)
    _invoice(client, acme, amount=5000)

    rows = _entries(client, source_type="invoice", min_amount=1000)["rows"]

    assert rows
    assert all(r["total_debit"] >= 1000 for r in rows)


def test_the_count_matches_the_filtered_rows_not_the_ledger(client, acme):
    """`total` drives the pager. A total that ignores the new filters pages
    into empty results."""
    _invoice(client, acme, amount=100)
    _invoice(client, acme, amount=5000)

    body = _entries(client, source_type="invoice", min_amount=1000)

    assert body["total"] == len(body["rows"])
