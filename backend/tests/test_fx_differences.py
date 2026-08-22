"""The workspace an accountant closes a period in.

The question each row has to answer is not "how much" — the ledger already says
that — but *what happened here*: which document, agreed in what, at which two
rates, on which dates, carried by which entry, and has anybody read it.

Two kinds, different in kind rather than degree. A realised difference means
the money arrived and the company genuinely has more or less of it. An
unrealised one means nothing moved and the holding is simply worth something
else today; it reverses itself when the rate comes back. Showing them in one
undifferentiated list would be the single most misleading thing this screen
could do.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def rates(db):
    for cur, rate, when in (("EUR", 0.909091, "2020-01-01"),
                            ("LBP", 90000, "2020-01-01")):
        db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
                   "VALUES (?,?,?,?)", (cur, rate, when, when))
    db.commit()


@_pytest.fixture
def euro_customer(client, rates):
    return client.post("/api/clients/", json={
        "name": "Euro Customer", "preferred_currency": "EUR"}).json()["id"]


def _invoice(client, cid, amount):
    r = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Goods", "quantity": 1, "unit_price": amount}]}).json()
    return r.get("invoice_id") or r.get("id")


def _weaken(db, rate="0.952381", when="2026-01-01"):
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', ?, ?, ?)", (float(rate), when, when))
    db.commit()


def _settle(client, inv, amount, rate=0.952381):
    return client.post(f"/api/invoices/{inv}/payments", json={
        "amount": amount, "currency": "EUR", "exchange_rate": rate,
        "method": "Cash", "idempotency_key": str(uuid.uuid4())})


def _rows(client, **params):
    return client.get("/api/accounting/fx-differences", params=params).json()


# ── A realised difference explains itself ────────────────────────────────────

def test_a_settled_euro_invoice_appears_with_its_whole_story(client,
                                                             euro_customer, db):
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)

    row = next(r for r in _rows(client)["rows"] if r["kind"] == "realized")

    # Who, and against what.
    assert row["client_name"] == "Euro Customer"
    assert row["invoice_id"] == inv
    assert row["invoice_number"]
    # Agreed in what, at which rate, worth what.
    assert row["currency"] == "EUR"
    assert row["invoice_txn_amount"] == _pytest.approx(5000)
    assert row["recognition_rate"] == _pytest.approx(0.909091)
    assert row["base_at_recognition"] == _pytest.approx(5500, abs=0.02)
    # Settled at which rate, worth what then.
    assert row["settlement_rate"] == _pytest.approx(0.952381)
    assert row["base_at_settlement"] == _pytest.approx(5250, abs=0.02)
    # And therefore.
    assert row["difference"] == _pytest.approx(-250, abs=0.02)
    assert row["direction"] == "loss"


def test_it_names_the_entry_that_carried_it(client, euro_customer, db):
    """"There is 250 in 6920" is not an answer. Which entry is."""
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)

    row = next(r for r in _rows(client)["rows"] if r["kind"] == "realized")

    assert row["journal_entry_id"]
    assert row["entry_number"]
    assert row["posting_status"] == "posted"


def test_a_settlement_at_the_same_rate_is_not_a_difference(client, euro_customer):
    """Nothing moved, so there is nothing to reconcile. A row reading zero is
    noise in the one place noise is most expensive."""
    inv = _invoice(client, euro_customer, 5000)
    _settle(client, inv, 5000, rate=0.909091)

    assert _rows(client)["rows"] == []


def test_a_dollar_invoice_produces_nothing(client):
    cid = client.post("/api/clients/", json={"name": "Dollar Co"}).json()["id"]
    inv = _invoice(client, cid, 400)
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 400, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    assert _rows(client)["rows"] == []


# ── An unrealised difference explains itself too ─────────────────────────────

def test_a_revaluation_appears_with_what_was_counted(client, euro_customer, db):
    """It used to post an entry with no source at all, so the only trace of why
    the books moved was a memo string."""
    inv = _invoice(client, euro_customer, 5000)
    _settle(client, inv, 5000, rate=0.909091)   # euro cash now on hand
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.8, '2026-02-01', '2026-02-01')")
    db.commit()

    client.post("/api/accounting/fx-revaluation", json={"counted_eur": 5000})

    row = next(r for r in _rows(client)["rows"] if r["kind"] == "unrealized")
    assert row["currency"] == "EUR"
    assert row["tender_amount"] == _pytest.approx(5000)
    assert row["account_code"] == "1020"
    assert row["settlement_rate"] == _pytest.approx(0.8)
    assert row["journal_entry_id"]
    assert row["direction"] == "gain"


def test_the_two_kinds_are_told_apart(client, euro_customer, db):
    """Realised means the company has the money. Unrealised means it might not
    still be worth this tomorrow. Summing them without saying which is which
    would misstate what the period actually earned."""
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)
    client.post("/api/accounting/fx-revaluation", json={"counted_eur": 100})

    body = _rows(client)
    kinds = {r["kind"] for r in body["rows"]}
    assert kinds == {"realized", "unrealized"}
    assert body["summary"]["realized"] != 0
    assert body["summary"]["unrealized"] != 0


# ── Filters ──────────────────────────────────────────────────────────────────

def test_filtering_by_kind(client, euro_customer, db):
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)
    client.post("/api/accounting/fx-revaluation", json={"counted_eur": 100})

    assert all(r["kind"] == "realized"
               for r in _rows(client, kind="realized")["rows"])
    assert all(r["kind"] == "unrealized"
               for r in _rows(client, kind="unrealized")["rows"])


def test_filtering_by_customer_currency_and_direction(client, euro_customer, db):
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)

    assert _rows(client, client_id=euro_customer)["rows"]
    assert _rows(client, currency="EUR")["rows"]
    assert _rows(client, direction="loss")["rows"]
    assert _rows(client, direction="gain")["rows"] == []
    assert _rows(client, client_id=euro_customer + 999)["rows"] == []


def test_filtering_by_date_range(client, euro_customer, db):
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)

    assert _rows(client, start="2000-01-01", end="2099-12-31")["rows"]
    assert _rows(client, start="2000-01-01", end="2000-12-31")["rows"] == []


# ── The reconciliation an accountant performs ────────────────────────────────

def test_signing_one_off_is_recorded_and_does_not_touch_the_books(
        client, euro_customer, db):
    """A period-end review produces a record that a person looked. It must not
    produce an accounting entry — the difference was posted when it arose."""
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)
    row = next(r for r in _rows(client)["rows"] if r["kind"] == "realized")
    before = len(client.get("/api/accounting/journal-entries").json()["rows"])

    r = client.post(
        f"/api/accounting/fx-differences/realized/{row['ref_id']}/reconcile",
        json={"note": "Checked against the bank advice"})

    assert r.status_code == 200
    after = client.get("/api/accounting/journal-entries").json()
    assert len(after["rows"]) == before, "reconciling must post nothing"
    marked = next(x for x in _rows(client)["rows"] if x["ref_id"] == row["ref_id"])
    assert marked["reconciled"] is True
    assert marked["reconcile_note"] == "Checked against the bank advice"
    assert marked["reconciled_by_name"]


def test_the_transaction_that_created_it_is_left_alone(client, euro_customer, db):
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)
    row = next(r for r in _rows(client)["rows"] if r["kind"] == "realized")
    before = dict(db.execute("SELECT * FROM invoice_payments WHERE id=?",
                             (row["ref_id"],)).fetchone())

    client.post(f"/api/accounting/fx-differences/realized/{row['ref_id']}/reconcile",
                json={"note": "ok"})

    after = dict(db.execute("SELECT * FROM invoice_payments WHERE id=?",
                            (row["ref_id"],)).fetchone())
    assert after == before


def test_it_can_be_unmarked(client, euro_customer, db):
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)
    ref = next(r for r in _rows(client)["rows"])["ref_id"]
    client.post(f"/api/accounting/fx-differences/realized/{ref}/reconcile",
                json={"note": "ok"})

    client.post(f"/api/accounting/fx-differences/realized/{ref}/reconcile",
                json={"undo": True})

    assert next(r for r in _rows(client)["rows"])["reconciled"] is False


def test_reconciling_twice_does_not_duplicate_the_mark(client, euro_customer, db):
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)
    ref = next(r for r in _rows(client)["rows"])["ref_id"]

    client.post(f"/api/accounting/fx-differences/realized/{ref}/reconcile", json={})
    client.post(f"/api/accounting/fx-differences/realized/{ref}/reconcile",
                json={"note": "second look"})

    n = db.execute("SELECT COUNT(*) AS n FROM fx_reconciliations").fetchone()["n"]
    assert n == 1
    assert next(r for r in _rows(client)["rows"])["reconcile_note"] == "second look"


def test_what_is_still_outstanding_is_countable(client, euro_customer, db):
    """The number an accountant works down to zero at period end."""
    inv = _invoice(client, euro_customer, 5000)
    _weaken(db)
    _settle(client, inv, 5000)

    assert _rows(client)["summary"]["unreconciled"] == 1
    ref = next(r for r in _rows(client)["rows"])["ref_id"]
    client.post(f"/api/accounting/fx-differences/realized/{ref}/reconcile", json={})
    assert _rows(client)["summary"]["unreconciled"] == 0
    assert _rows(client, status="open")["rows"] == []


def test_reading_the_workspace_needs_permission(as_role):
    assert as_role("Sales").get("/api/accounting/fx-differences").status_code == 403


def test_an_unknown_difference_type_is_refused(client):
    r = client.post("/api/accounting/fx-differences/banana/1/reconcile", json={})

    assert r.status_code == 404
