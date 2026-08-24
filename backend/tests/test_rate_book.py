"""Setting a rate: which currency, from which date, and who says so.

Two things were missing and one was quietly wrong.

Missing: nothing could set a EUR rate. The column, the lookup and the
conversion all took a currency; the only endpoint that wrote a rate did not,
so every row landed as the tenant's secondary currency and a business holding
euro had no way to tell the system what one was worth.

Quietly wrong: `effective_date` was added, backfilled, and then never written
again. Every new rate went in with a NULL date, so the by-date lookup could
never match one and fell through to "the newest" — which means entering last
month's invoice converted it at today's rate, the exact thing effective dating
exists to prevent.

And the design that holds the rest together: ONE number per currency, every
pair derived. A rate and its reciprocal are the same agreement said twice.
"""
from datetime import date, timedelta

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def admin(as_role):
    return as_role("superadmin")


def _set(c, rate, **kw):
    return c.post("/api/settings/exchange-rate", json={"rate": rate, **kw})


def _book(c):
    r = c.get("/api/settings/exchange-rate")
    assert r.status_code == 200, r.text
    return r.json()


def _pair(book, frm, to):
    return next((p for p in book["pairs"]
                 if p["from"] == frm and p["to"] == to), None)


def _ago(days):
    return (date.today() - timedelta(days=days)).isoformat()


# ── Every currency the system handles ────────────────────────────────────────

def test_a_euro_rate_can_be_set(admin):
    """It could not before: the write path dropped the currency entirely."""
    assert _set(admin, 0.92, currency="EUR").status_code == 200

    assert _book(admin)["rates"]["EUR"]["rate"] == _pytest.approx(0.92)


def test_each_currency_keeps_its_own_rate(admin):
    _set(admin, 89000, currency="LBP")
    _set(admin, 0.92, currency="EUR")

    rates = _book(admin)["rates"]

    assert rates["LBP"]["rate"] == _pytest.approx(89000)
    assert rates["EUR"]["rate"] == _pytest.approx(0.92)


def test_omitting_the_currency_still_means_what_it_always_meant(admin):
    """Every existing caller sends a bare rate and means the secondary
    currency. That has to keep working."""
    _set(admin, 90000)

    book = _book(admin)
    assert book["current"]["rate"] == _pytest.approx(90000)
    assert book["rates"][book["secondary_currency"]]["rate"] == _pytest.approx(90000)


def test_a_currency_the_system_does_not_handle_is_refused(admin):
    r = _set(admin, 1.2, currency="GBP")

    assert r.status_code == 400
    assert "GBP" in r.text


def test_the_books_own_currency_has_no_rate_to_set(admin):
    """One dollar is one dollar. A row saying otherwise would be picked up by
    a conversion and silently rescale the ledger."""
    r = _set(admin, 1.05, currency="USD")

    assert r.status_code == 400
    assert "1 by definition" in r.text


# ── Every pair, from one number each ─────────────────────────────────────────

def test_all_six_directions_are_reported(admin):
    _set(admin, 89000, currency="LBP")
    _set(admin, 0.92, currency="EUR")

    pairs = _book(admin)["pairs"]

    assert {(p["from"], p["to"]) for p in pairs} == {
        ("USD", "LBP"), ("USD", "EUR"), ("LBP", "USD"),
        ("LBP", "EUR"), ("EUR", "USD"), ("EUR", "LBP"),
    }


def test_a_pair_and_its_reverse_agree_exactly(admin):
    """The reason the reciprocals are not stored. Typed separately they drift,
    and then a hundred dollars converted out and back is not a hundred
    dollars — with the difference landing in the accounts as profit."""
    _set(admin, 89000, currency="LBP")

    book = _book(admin)
    there = _pair(book, "USD", "LBP")["rate"]
    back = _pair(book, "LBP", "USD")["rate"]

    assert there * back == _pytest.approx(1.0, rel=1e-12)


def test_the_cross_rate_comes_from_the_two_that_were_entered(admin):
    """Nobody types EUR→LBP. It is what the two dollar rates imply, and if it
    were typed it could disagree with them."""
    _set(admin, 89000, currency="LBP")
    _set(admin, 0.92, currency="EUR")

    eur_lbp = _pair(_book(admin), "EUR", "LBP")

    assert eur_lbp["rate"] == _pytest.approx(89000 / 0.92)
    assert eur_lbp["derived"] is True


def test_a_pair_against_the_dollar_is_not_marked_derived(admin):
    _set(admin, 89000, currency="LBP")

    assert _pair(_book(admin), "USD", "LBP")["derived"] is False


def test_a_currency_with_no_rate_yet_produces_no_pairs(admin):
    """Better silent than a made-up number: a pair nobody has priced cannot be
    shown as if somebody had."""
    _set(admin, 89000, currency="LBP")

    pairs = _book(admin)["pairs"]

    assert not [p for p in pairs if "EUR" in (p["from"], p["to"])]


# ── The date the accountant reads ────────────────────────────────────────────

def test_the_date_is_recorded(admin):
    _set(admin, 91000, currency="LBP", effective_date=_ago(3))

    assert _book(admin)["rates"]["LBP"]["effective_date"] == _ago(3)


def test_no_date_means_today_rather_than_no_date_at_all(admin):
    """A NULL date is invisible to the by-date lookup, which is how every rate
    set through this endpoint used to become undateable.

    "Today" is the server's date, in UTC, as it is for every other date this
    system stamps — a rate dated by a different convention from the invoices
    it converts would be worse than one dated a few hours out. The screen does
    not rely on it: the panel always sends the operator's own date, so the
    fallback only ever applies to a caller that omitted one.
    """
    from utils import _today

    _set(admin, 91000, currency="LBP")

    assert _book(admin)["rates"]["LBP"]["effective_date"] == _today()[:10]


def test_the_date_the_operator_sent_always_wins(admin):
    """Which is what keeps the three hours a night when the server's date and
    Beirut's disagree from mattering."""
    _set(admin, 91000, currency="LBP", effective_date="2026-01-15")

    assert _book(admin)["rates"]["LBP"]["effective_date"] == "2026-01-15"


def test_a_transaction_converts_at_the_rate_of_its_own_date(admin, db):
    """The whole point of the dates. An invoice dated last week must not be
    converted at a rate agreed this morning."""
    import currency as currency_mod

    _set(admin, 80000, currency="LBP", effective_date=_ago(30))
    _set(admin, 100000, currency="LBP", effective_date=str(date.today()))

    assert currency_mod.rate_on(db, "LBP", _ago(10)) == _pytest.approx(80000)
    assert currency_mod.rate_on(db, "LBP", str(date.today())) == _pytest.approx(100000)


def test_the_newest_rate_is_the_one_in_force_now(admin):
    _set(admin, 80000, currency="LBP", effective_date=_ago(30))
    _set(admin, 100000, currency="LBP", effective_date=str(date.today()))

    assert _book(admin)["rates"]["LBP"]["rate"] == _pytest.approx(100000)


def test_a_rate_entered_out_of_order_does_not_become_the_current_one(admin):
    """Catching up on a missed week must not roll the rate backwards."""
    _set(admin, 100000, currency="LBP", effective_date=str(date.today()))
    _set(admin, 80000, currency="LBP", effective_date=_ago(30))

    assert _book(admin)["rates"]["LBP"]["rate"] == _pytest.approx(100000)


def test_something_that_is_not_a_date_is_refused(admin):
    r = _set(admin, 90000, currency="LBP", effective_date="last tuesday")

    assert r.status_code == 400
    assert "YYYY-MM-DD" in r.text


def test_a_rate_of_zero_or_less_is_refused(admin):
    assert _set(admin, 0, currency="LBP").status_code == 400
    assert _set(admin, -5, currency="LBP").status_code == 400


# ── Who may, and what is kept ────────────────────────────────────────────────

def test_anyone_signed_in_can_read_the_rates(as_role):
    """The rate decides what the till converts at, so an operator has to be
    able to see it even though only an administrator sets it."""
    assert as_role("Sales").get("/api/settings/exchange-rate").status_code == 200


def test_only_an_administrator_can_change_them(as_role):
    r = as_role("Sales").post("/api/settings/exchange-rate",
                              json={"rate": 95000, "currency": "LBP"})

    assert r.status_code == 403


def test_every_change_is_kept_with_its_currency_and_date(admin):
    """What the accountant is actually asking for: when did it change, to
    what, and who said so."""
    _set(admin, 89000, currency="LBP", effective_date=_ago(5), note="Parallel")
    _set(admin, 0.92, currency="EUR")

    history = _book(admin)["history"]

    lbp = next(h for h in history if h["currency"] == "LBP")
    assert lbp["effective_date"] == _ago(5)
    assert lbp["note"] == "Parallel"
    assert lbp["set_by_name"]
    assert any(h["currency"] == "EUR" for h in history)


def test_setting_a_rate_is_written_to_the_audit_trail(admin, db):
    _set(admin, 89000, currency="EUR", effective_date=_ago(1))

    row = db.execute("SELECT * FROM audit_log WHERE module='settings' "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None
    assert "EUR" in str(dict(row))


def test_nothing_already_posted_moves_when_a_rate_changes(admin, db):
    """Amounts are stored converted, so history was fixed when it was written.
    A new rate must be a fact about the future only."""
    import uuid

    _set(admin, 80000, currency="LBP", effective_date=_ago(10))
    cid = admin.post("/api/clients/", json={"name": "Rate Co"}).json()["id"]
    created = admin.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": str(date.today()),
        "items": [{"name": "Goods", "quantity": 1, "unit_price": 100}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    admin.post(f"/api/invoices/{inv}/payments", json={
        "amount": 100, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    before = admin.get("/api/accounting/trial-balance").json()

    _set(admin, 100000, currency="LBP", effective_date=str(date.today()))

    after = admin.get("/api/accounting/trial-balance").json()
    assert after["total_debit"] == _pytest.approx(before["total_debit"], abs=0.01)
    assert after["balanced"]
