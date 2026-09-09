"""The dashboard's date filters, on the seams.

`date(created_at) = date('now')` and `strftime('%Y-%m', col) = ...` were
replaced with half-open ranges computed in Python, because a column wrapped in
a function is invisible to an index --- on Postgres `dialect.py` rewrites those
calls to `substr(col, 1, 10)`, so the front page scanned `pos_sales` on every
load.

Performance was never the risk in that change. **The boundary was.** A bound
built from the wrong clock, or a closed upper bound instead of a half-open
one, moves "today's takings" by a day or silently drops the last day of the
month --- a wrong number on the front page, which a customer notices and does
not report as a bug, because it looks like a number rather than an error.

So these tests do not check that the query is fast. They put rows at
23:59:59 and 00:00:00 on either side of every seam and check which ones are
counted.

The clock is UTC on purpose: `_now()` writes UTC, SQLite's `'now'` is UTC, and
`_day_bounds()`/`_month_bounds()` use `utcnow()`. All four have to agree or
the seam moves.
"""
from datetime import datetime, timedelta

import pytest

from utils import _day_bounds, _month_bounds

pytestmark = pytest.mark.critical


# ── the helpers themselves ───────────────────────────────────────────────────
def test_a_day_is_half_open():
    assert _day_bounds("2026-09-09") == ("2026-09-09", "2026-09-10")


def test_a_month_is_half_open():
    assert _month_bounds("2026-09-15") == ("2026-09-01", "2026-10-01")


def test_december_rolls_the_year():
    """`month + 1` is wrong once a year, in the last month of it."""
    assert _month_bounds("2026-12-31") == ("2026-12-01", "2027-01-01")


def test_february_ends_where_march_begins():
    """No arithmetic on day counts: the upper bound is the next month's first."""
    assert _month_bounds("2026-02-01") == ("2026-02-01", "2026-03-01")
    assert _month_bounds("2024-02-29") == ("2024-02-01", "2024-03-01")


def test_a_timestamped_row_on_the_last_day_falls_inside():
    """The reason it is half-open rather than BETWEEN.

    These columns hold 'YYYY-MM-DD HH:MM:SS' as well as bare dates. A closed
    upper bound of the month's last day would exclude every row written after
    midnight on it --- an entire day of revenue, every month.
    """
    lo, hi = _month_bounds("2026-09-01")
    assert lo <= "2026-09-30 23:59:59" < hi


# ── through the endpoint, which is where the parameter order can be wrong ────
def _mk_sale(db, when, total=100.0, status="completed"):
    """A sale needs a till session, an invoice and a cashier to exist --- the
    foreign keys are enforced here, so they are created rather than faked."""
    cashier = db.execute("SELECT id FROM users LIMIT 1").fetchone()["id"]
    sess = db.execute("SELECT id FROM pos_sessions LIMIT 1").fetchone()
    if not sess:
        db.execute("INSERT INTO pos_sessions (cashier_id, status, opened_at) "
                   "VALUES (?, 'open', ?)", (cashier, when))
        sess_id = db.execute("SELECT MAX(id) AS id FROM pos_sessions").fetchone()["id"]
    else:
        sess_id = sess["id"]
    db.execute("INSERT INTO invoices (invoice_number, created_at) VALUES (?, ?)",
               ("POS-%s" % when.replace(" ", "").replace(":", ""), when))
    inv_id = db.execute("SELECT MAX(id) AS id FROM invoices").fetchone()["id"]

    db.execute(
        "INSERT INTO pos_sales (session_id, invoice_id, cashier_id, cashier_name, "
        "                       total_usd, status, created_at) "
        "VALUES (?, ?, ?, 'till', ?, ?, ?)",
        (sess_id, inv_id, cashier, total, status, when))
    db.commit()


def _pos(client):
    r = client.get("/api/dashboard/")
    assert r.status_code == 200, r.text
    return r.json()["pos"]


def test_a_sale_one_second_before_midnight_yesterday_is_not_todays(make_client, db):
    yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
    _mk_sale(db, yesterday + " 23:59:59")
    assert _pos(make_client("superadmin"))["c"] == 0, \
        "yesterday's last sale was counted in today's takings"


def test_a_sale_at_midnight_today_is_todays(make_client, db):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    _mk_sale(db, today + " 00:00:00")
    assert _pos(make_client("superadmin"))["c"] == 1, \
        "the first sale of the day was missed --- the lower bound is exclusive"


def test_a_sale_one_second_before_midnight_tonight_is_still_todays(make_client, db):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    _mk_sale(db, today + " 23:59:59")
    assert _pos(make_client("superadmin"))["c"] == 1, \
        "the last sale of the day was dropped --- the upper bound is closed"


def test_a_sale_at_midnight_tomorrow_is_not_todays(make_client, db):
    tomorrow = (datetime.utcnow() + timedelta(days=1)).strftime("%Y-%m-%d")
    _mk_sale(db, tomorrow + " 00:00:00")
    assert _pos(make_client("superadmin"))["c"] == 0, \
        "a sale dated tomorrow appeared in today's takings"


def test_the_status_allow_list_survived_the_rewrite(make_client, db):
    """The predicate that was rewritten sits next to one that matters more.

    'returned' and 'amended' rows are not sales; counting them put the same
    money in today's takings twice. The range rewrite must not have disturbed
    the allow-list beside it.
    """
    today = datetime.utcnow().strftime("%Y-%m-%d")
    _mk_sale(db, today + " 09:00:00", total=100.0)
    _mk_sale(db, today + " 10:00:00", total=250.0, status="returned")
    pos = _pos(make_client("superadmin"))
    assert pos["c"] == 1 and pos["total"] == 100.0, \
        "a returned sale was counted as revenue"


# ── the month seam, which moves eleven times a year without anyone noticing ──
def _mk_expense(db, when, amount=50.0):
    db.execute("INSERT INTO expenses (category, amount, date, created_at) "
               "VALUES ('Other', ?, ?, ?)", (amount, when, when))
    db.commit()


def _finance(client):
    r = client.get("/api/dashboard/")
    assert r.status_code == 200, r.text
    return r.json()


def test_an_expense_on_the_first_of_the_month_is_in_this_month(make_client, db):
    lo, _ = _month_bounds()
    _mk_expense(db, lo, amount=50.0)
    assert _finance(make_client("superadmin"))["monthly_expenses"] == 50.0, \
        "the first day of the month fell outside it"


def test_an_expense_on_the_last_day_of_last_month_is_not(make_client, db):
    lo, _ = _month_bounds()
    last = (datetime.strptime(lo, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    _mk_expense(db, last + " 23:59:59", amount=50.0)
    assert _finance(make_client("superadmin"))["monthly_expenses"] == 0, \
        "last month's final expense leaked into this month's total"


def test_an_expense_dated_next_month_is_not_counted_yet(make_client, db):
    _, hi = _month_bounds()
    _mk_expense(db, hi + " 00:00:00", amount=50.0)
    assert _finance(make_client("superadmin"))["monthly_expenses"] == 0, \
        "an expense dated next month was already in this month's total"


# ── the upper bound must be exclusive, and a bare date is what proves it ─────
# `col < 'YYYY-MM-DD'` and `col <= 'YYYY-MM-DD'` differ for exactly one value:
# a row stored as the bare date itself, with no time. That is not a corner
# case --- `expenses.date` is a bare date on every row, so the difference
# between the two operators is a whole extra day of expenses on the front
# page. A test using '00:00:00' cannot tell them apart, because
# '2026-10-01 00:00:00' > '2026-10-01' as a string.
def test_a_sale_stored_as_a_bare_date_tomorrow_is_not_todays(make_client, db):
    _, hi = _day_bounds()
    _mk_sale(db, hi)
    assert _pos(make_client("superadmin"))["c"] == 0, \
        "the upper bound is inclusive: tomorrow was counted as today"


def test_an_expense_stored_as_a_bare_first_of_next_month_is_not_counted(make_client, db):
    _, hi = _month_bounds()
    _mk_expense(db, hi, amount=50.0)
    assert _finance(make_client("superadmin"))["monthly_expenses"] == 0, \
        "the upper bound is inclusive: next month's first day was counted in " \
        "this month, and expenses.date is a bare date on every row"


# ── the third rewritten predicate: money in, by month ────────────────────────
def _mk_payment(db, when, amount=75.0):
    db.execute("INSERT INTO invoices (invoice_number, created_at) VALUES (?, ?)",
               ("INV-%s" % when.replace(" ", "").replace(":", ""), when))
    inv = db.execute("SELECT MAX(id) AS id FROM invoices").fetchone()["id"]
    db.execute("INSERT INTO invoice_payments (invoice_id, amount, paid_at) "
               "VALUES (?, ?, ?)", (inv, amount, when))
    db.commit()


def test_a_payment_on_the_first_of_the_month_counts_as_this_months_income(make_client, db):
    lo, _ = _month_bounds()
    _mk_payment(db, lo + " 00:00:00", amount=75.0)
    assert _finance(make_client("superadmin"))["monthly_income"] == 75.0


def test_a_payment_on_the_last_day_of_last_month_does_not(make_client, db):
    lo, _ = _month_bounds()
    last = (datetime.strptime(lo, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    _mk_payment(db, last + " 23:59:59", amount=75.0)
    assert _finance(make_client("superadmin"))["monthly_income"] == 0, \
        "last month's final payment was counted as this month's income"


def test_a_payment_stored_as_a_bare_first_of_next_month_does_not(make_client, db):
    """The exclusive-upper-bound case again --- `paid_at` is written by
    `_now()` today, but nothing stops an import writing a bare date."""
    _, hi = _month_bounds()
    _mk_payment(db, hi, amount=75.0)
    assert _finance(make_client("superadmin"))["monthly_income"] == 0
