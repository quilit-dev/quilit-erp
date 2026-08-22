"""Euro is a foreign currency, and foreign cash needs its own account.

Euro was accepted as tender and had nowhere to land, so euro notes posted into
the dollar cash account. That is the precise thing the LBP account exists to
prevent: once a non-functional currency is mixed into the functional one, its
balance cannot be marked to the spot rate without unpicking it from the
dollars, and IAS 21 says it must be.

`money_account_for` already promised this — "cash follows the currency, each has
its own account" — and delivered it for pounds only.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Euro Co"}).json()["id"]


@_pytest.fixture
def eur_rate(db):
    """0.9 euro to the dollar, effective from well before anything is dated."""
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.9, '2020-01-01', '2020-01-01')")
    db.commit()
    return 0.9


def _invoice(client, cid, amount=100):
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": amount}]}).json()
    return created.get("invoice_id") or created.get("id")


def _balance(client, code):
    """The posted balance of one account, from the trial balance.

    Trial-balance rows carry debit and credit, not a signed balance; these are
    all asset accounts, so the balance is the debit side net of credits.
    """
    tb = client.get("/api/accounting/trial-balance").json()
    row = next((r for r in tb["rows"] if r["code"] == code), None)
    if not row:
        return 0.0
    return round(float(row["debit"]) - float(row["credit"]), 2)


# ── The account exists and is wired ──────────────────────────────────────────

def test_euro_cash_has_an_account_of_its_own(client):
    codes = {a["code"] for a in client.get("/api/accounting/accounts").json()}

    assert "1020" in codes


def test_euro_does_not_land_in_the_dollar_account(client, acme, eur_rate):
    """The defect: euro notes mixed into 1000, where they cannot be revalued
    without unpicking them from the dollars."""
    inv = _invoice(client, acme, 90)
    before_usd = _balance(client, "1000")

    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 81, "currency": "EUR", "exchange_rate": 0.9,
        "method": "Cash", "idempotency_key": str(uuid.uuid4())})

    assert _balance(client, "1000") == _pytest.approx(before_usd)
    assert _balance(client, "1020") == _pytest.approx(90)


def test_dollars_still_land_in_the_dollar_account(client, acme):
    """The regression that would matter most: every cash sale in the shop."""
    inv = _invoice(client, acme, 50)
    before = _balance(client, "1000")

    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 50, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    assert _balance(client, "1000") == _pytest.approx(before + 50)


def test_pounds_still_land_in_the_pound_account(client, acme, db):
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('LBP', 90000, '2020-01-01', '2020-01-01')")
    db.commit()
    inv = _invoice(client, acme, 100)

    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 9_000_000, "currency": "LBP", "exchange_rate": 90000,
        "method": "Cash", "idempotency_key": str(uuid.uuid4())})

    assert _balance(client, "1010") == _pytest.approx(100)


def test_the_books_still_balance(client, acme, eur_rate):
    inv = _invoice(client, acme, 90)
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 81, "currency": "EUR", "exchange_rate": 0.9,
        "method": "Cash", "idempotency_key": str(uuid.uuid4())})

    assert client.get("/api/accounting/trial-balance").json()["balanced"]


# ── And can be revalued, which is the point of separating it ─────────────────

def test_a_euro_balance_can_be_marked_to_the_spot_rate(client, acme, eur_rate, db):
    """Held euro that has gained against the dollar is an unrealised gain, and
    it can only be measured because the euro sits on its own."""
    inv = _invoice(client, acme, 90)
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 81, "currency": "EUR", "exchange_rate": 0.9,
        "method": "Cash", "idempotency_key": str(uuid.uuid4())})
    # Euro strengthens: fewer euro to the dollar.
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.8, '2026-01-01', '2026-01-01')")
    db.commit()

    body = client.post("/api/accounting/fx-revaluation",
                       json={"counted_eur": 81}).json()

    eur = next(r for r in body["results"] if r["currency"] == "EUR")
    # 81 EUR at 0.8 is 101.25; the books carry 90. A gain of 11.25.
    assert eur["delta"] == _pytest.approx(11.25)
    assert eur["journal_entry_id"]
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_each_currency_posts_its_own_entry(client, acme, eur_rate, db):
    """One netted figure covering two currencies tells a reader nothing about
    which one moved."""
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('LBP', 90000, '2020-01-01', '2020-01-01')")
    db.commit()

    body = client.post("/api/accounting/fx-revaluation",
                       json={"counted_eur": 10, "counted_lbp": 500_000}).json()

    assert {r["currency"] for r in body["results"]} == {"LBP", "EUR"}
    ids = [r["journal_entry_id"] for r in body["results"] if r["journal_entry_id"]]
    assert len(ids) == len(set(ids))


def test_revaluing_without_a_rate_says_which_currency_is_missing_one(client):
    r = client.post("/api/accounting/fx-revaluation", json={"counted_eur": 10})

    assert r.status_code == 400
    assert "EUR" in r.json()["detail"]


def test_a_count_is_required(client):
    r = client.post("/api/accounting/fx-revaluation", json={})

    assert r.status_code == 400


def test_the_pounds_only_request_still_works_unchanged(client, db):
    """The shape callers already send, and the keys they already read."""
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('LBP', 90000, '2020-01-01', '2020-01-01')")
    db.commit()

    body = client.post("/api/accounting/fx-revaluation",
                       json={"counted_lbp": 900_000}).json()

    for key in ("rate", "book_usd", "counted_usd", "delta"):
        assert key in body, key
