"""Rates that know which currency they are for, and when they took effect.

The table held one rate — LBP per USD, newest wins. Entering last month's
invoice today converted it at this morning's rate, which in a country whose
currency moved by multiples is not a rounding difference.

The property worth protecting hardest is that **none of this restates anything
already posted**. Amounts are stored in USD, so history was fixed at the moment
it was written; effective dating only decides which rate a NEW conversion uses.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import currency


def _rate(db, cur, rate, effective, note="test"):
    db.execute(
        "INSERT INTO exchange_rates (rate, currency, effective_date, note, created_at) "
        "VALUES (?,?,?,?,datetime('now'))", (rate, cur, effective, note))
    db.commit()


# ── The right rate for the date ──────────────────────────────────────────────

def test_a_transaction_uses_the_rate_in_force_on_its_own_date(db):
    """The headline. Last month's invoice converts at last month's rate."""
    _rate(db, "LBP", 15000, "2026-01-01")
    _rate(db, "LBP", 89000, "2026-06-01")

    assert currency.rate_on(db, "LBP", "2026-03-15") == 15000
    assert currency.rate_on(db, "LBP", "2026-07-15") == 89000


def test_the_rate_applies_from_its_effective_date_not_before(db):
    _rate(db, "LBP", 15000, "2026-01-01")
    _rate(db, "LBP", 89000, "2026-06-01")

    assert currency.rate_on(db, "LBP", "2026-05-31") == 15000
    assert currency.rate_on(db, "LBP", "2026-06-01") == 89000


def test_without_a_date_the_newest_rate_wins(db):
    """What the system always did, and what a live form on screen wants."""
    _rate(db, "LBP", 15000, "2026-01-01")
    _rate(db, "LBP", 89000, "2026-06-01")

    assert currency.rate_on(db, "LBP") == 89000
    assert currency.latest_rate(db) == 89000


def test_a_date_before_every_rate_still_converts(db):
    """Rates entered before anyone thought to backdate them must still convert
    something dated earlier, rather than refusing and blocking the sale."""
    _rate(db, "LBP", 89000, "2026-06-01")

    assert currency.rate_on(db, "LBP", "2020-01-01") == 89000


# ── More than one currency ───────────────────────────────────────────────────

def test_currencies_do_not_read_each_other_s_rates(db):
    """The table used to hold one number. A EUR lookup finding an LBP rate
    would convert 100 EUR into a fraction of a cent."""
    _rate(db, "LBP", 89000, "2026-01-01")
    _rate(db, "EUR", 0.92, "2026-01-01")

    assert currency.rate_on(db, "LBP", "2026-06-01") == 89000
    assert currency.rate_on(db, "EUR", "2026-06-01") == 0.92


def test_eur_converts(db):
    _rate(db, "EUR", 0.92, "2026-01-01")

    assert currency.to_usd(92, "EUR", db, on_date="2026-06-01") == _pytest.approx(100)


def test_usd_needs_no_rate_at_all(db):
    assert currency.rate_on(db, "USD", "2026-06-01") == 1.0
    assert currency.to_usd(100, "USD", db) == _pytest.approx(100)


def test_an_unsupported_currency_is_refused(db):
    from fastapi import HTTPException

    with _pytest.raises(HTTPException) as e:
        currency.to_usd(100, "GBP", db)
    assert "GBP" in str(e.value.detail)


def test_a_currency_with_no_rate_says_so(db):
    from fastapi import HTTPException

    with _pytest.raises(HTTPException) as e:
        currency.to_usd(100, "EUR", db)
    assert "EUR" in str(e.value.detail)


# ── Nothing already recorded moves ───────────────────────────────────────────

def test_rows_recorded_before_this_are_still_lbp_rates(db):
    """Every rate already in the table was an LBP rate; the column defaults so
    they keep meaning that."""
    db.execute("INSERT INTO exchange_rates (rate, created_at) "
               "VALUES (90000, '2026-02-01 10:00:00')")
    db.commit()

    row = db.execute("SELECT currency FROM exchange_rates "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row["currency"] == "LBP"
    assert currency.rate_on(db, "LBP") == 90000


def test_the_operator_s_own_rate_still_wins(db):
    """A cashier handed LBP at the rate the street agreed on has better
    information than a table someone updated on Monday."""
    _rate(db, "LBP", 89000, "2026-01-01")

    assert currency.resolve_rate(db, supplied=90500, currency="LBP") == 90500
    assert currency.to_usd(90500, "LBP", db, rate=90500) == _pytest.approx(1)


# ── Back the other way ───────────────────────────────────────────────────────

def test_converting_out_of_usd_for_a_customer_document(db):
    _rate(db, "LBP", 89000, "2026-01-01")

    assert currency.from_usd(1, "LBP", db) == 89000


def test_lbp_comes_back_whole(db):
    """A bill is never quoted in piastres."""
    _rate(db, "LBP", 89000, "2026-01-01")

    out = currency.from_usd(1.005, "LBP", db)
    assert out == int(out)
