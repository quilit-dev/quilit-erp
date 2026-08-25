"""Buying a truck, running it for a year, and selling it.

Depreciation was the only part of Fixed Assets that reached the ledger. Buying
posted nothing, so the cost never landed on the balance sheet and the
depreciation charged against it piled into a contra-asset standing against
nothing. Selling posted nothing either: the gain or loss was computed, shown to
the operator in a toast, written into the audit log, and discarded.

On the Lebanese chart because that is the one that can tell these accounts
apart — 2210 is the asset, 282 its depreciation, 512 the bank. On the default
chart cash and bank share one account and half of this is invisible.

The running example is the truck: 30,000, five years, 6,000 salvage, so 400 a
month and 4,800 after a year — book value 25,200.
"""
import uuid
from datetime import date, timedelta

import pytest as _pytest

pytestmark = _pytest.mark.critical

ASSET = "2210"      # tangible fixed assets — cost
ACCDEP = "282"      # accumulated depreciation
GAIN = "781"
LOSS = "662"
TILL = "5312"

COST = 30000.0
SALVAGE = 6000.0
LIFE = 60           # months
MONTHLY = (COST - SALVAGE) / LIFE      # 400


@_pytest.fixture
def client(as_role):
    c = as_role("superadmin")
    r = c.post("/api/accounting/chart/lebanon/install", json={"confirm": "SWITCH CHART"})
    assert r.status_code == 200, r.text
    return c


@_pytest.fixture
def bank(client):
    return client.post("/api/banks/",
                       json={"name": "Byblos current", "currency": "USD"}).json()


def _months_ago(n):
    d = date.today().replace(day=1)
    y, m = divmod(d.year * 12 + (d.month - 1) - n, 12)
    return date(y, m + 1, 1).isoformat()


def _truck(c, bought=None, **kw):
    body = {
        "name": "Delivery truck", "category": "Vehicles",
        "acquisition_cost": COST,
        "acquisition_date": bought or _months_ago(11),
        "depreciation_method": "straight_line",
        "useful_life_months": LIFE, "salvage_value": SALVAGE,
    }
    body.update(kw)
    r = c.post("/api/assets/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()


def _lines(db, source_type, code=None):
    rows = db.execute(
        "SELECT a.code, SUM(l.debit) AS dr, SUM(l.credit) AS cr "
        "  FROM journal_entry_lines l "
        "  JOIN journal_entries je ON je.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id "
        " WHERE je.source_type = ? GROUP BY a.code", (source_type,)).fetchall()
    out = {r["code"]: (float(r["dr"] or 0), float(r["cr"] or 0)) for r in rows}
    return out[code] if code else out


def _balance(db, code):
    row = db.execute(
        "SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS bal "
        "  FROM journal_entry_lines l "
        "  JOIN journal_entries je ON je.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id "
        " WHERE a.code = ? AND je.status = 'posted'", (code,)).fetchone()
    return round(float(row["bal"] or 0), 2)


def _depreciate(c, asset_id, period=None):
    return c.post(f"/api/assets/{asset_id}/depreciate",
                  json={"period": period} if period else {})


def _dispose(c, asset_id, proceeds, **kw):
    body = {"disposal_proceeds": proceeds, "payment_method": "Bank Transfer"}
    body.update(kw)
    return c.post(f"/api/assets/{asset_id}/dispose", json=body)


# ── Buying it ────────────────────────────────────────────────────────────────

def test_buying_the_truck_puts_it_on_the_balance_sheet(client, bank, db):
    """It posted nothing at all before, so the register and the ledger
    described different businesses from the first asset onwards."""
    _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])

    dr, _cr = _lines(db, "asset_acquisition", ASSET)
    assert dr == _pytest.approx(COST)
    assert _lines(db, "asset_acquisition", bank["account_code"])[1] \
        == _pytest.approx(COST)


def test_paying_cash_for_it_comes_out_of_the_till(client, db):
    _truck(client, payment_method="Cash")

    assert _lines(db, "asset_acquisition", TILL)[1] == _pytest.approx(COST)


def test_buying_on_credit_owes_the_supplier_instead(client, db):
    """No money has moved yet. Crediting cash would say it had."""
    _truck(client, on_credit=True)

    touched = _lines(db, "asset_acquisition")
    assert TILL not in touched
    assert "4011" in touched            # ordinary suppliers


def test_an_asset_the_business_already_owned_posts_nothing(client, db):
    """Registering a truck bought three years ago must not invent a cash
    movement that never happened."""
    _truck(client, is_opening_balance=True)

    assert _lines(db, "asset_acquisition") == {}


def test_the_entry_is_kept_on_the_asset(client, bank, db):
    a = _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])

    row = db.execute("SELECT acquisition_entry_id FROM fixed_assets WHERE id=?",
                     (a["id"],)).fetchone()
    assert row["acquisition_entry_id"] == a["journal_entry_id"]


def test_the_books_balance_after_buying_it(client, bank):
    _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])

    assert client.get("/api/accounting/trial-balance").json()["balanced"]


# ── Selling it ───────────────────────────────────────────────────────────────

def _truck_a_year_in(client, bank):
    """Bought a year ago, depreciated to date: 4,800 charged, 25,200 left."""
    a = _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])
    _depreciate(client, a["id"])
    return a


def test_a_year_of_depreciation_leaves_the_expected_book_value(client, bank, db):
    a = _truck_a_year_in(client, bank)

    row = db.execute("SELECT accumulated_depreciation FROM fixed_assets WHERE id=?",
                     (a["id"],)).fetchone()
    assert float(row["accumulated_depreciation"]) == _pytest.approx(12 * MONTHLY, abs=1)


def test_selling_above_book_value_books_a_gain(client, bank, db):
    a = _truck_a_year_in(client, bank)
    accumulated = 12 * MONTHLY                       # 4,800
    book = COST - accumulated                        # 25,200

    r = _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert r.status_code == 200, r.text
    assert r.json()["gain_loss"] == _pytest.approx(27000 - book, abs=1)
    assert _lines(db, "asset_disposal", GAIN)[1] == _pytest.approx(27000 - book, abs=1)


def test_selling_below_book_value_books_a_loss(client, bank, db):
    a = _truck_a_year_in(client, bank)
    book = COST - 12 * MONTHLY

    r = _dispose(client, a["id"], 20000, bank_account_id=bank["id"])

    assert r.json()["gain_loss"] == _pytest.approx(20000 - book, abs=1)
    assert _lines(db, "asset_disposal", LOSS)[0] == _pytest.approx(book - 20000, abs=1)


def test_scrapping_it_for_nothing_loses_the_whole_book_value(client, bank, db):
    a = _truck_a_year_in(client, bank)
    book = COST - 12 * MONTHLY

    r = _dispose(client, a["id"], 0)

    assert r.json()["gain_loss"] == _pytest.approx(-book, abs=1)
    assert _lines(db, "asset_disposal", LOSS)[0] == _pytest.approx(book, abs=1)


def test_the_cost_and_its_depreciation_come_off_the_books(client, bank, db):
    """The whole point. Both used to sit there forever, so the balance sheet
    carried a truck the business had sold."""
    a = _truck_a_year_in(client, bank)

    _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert _balance(db, ASSET) == _pytest.approx(0, abs=0.01)
    assert _balance(db, ACCDEP) == _pytest.approx(0, abs=0.01)


def test_the_money_reaches_the_bank_account_it_was_paid_into(client, bank, db):
    a = _truck_a_year_in(client, bank)

    _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    dr, _cr = _lines(db, "asset_disposal", bank["account_code"])
    assert dr == _pytest.approx(27000)


def test_vat_on_the_sale_is_not_counted_as_gain(client, bank, db):
    """Selling a business asset is a taxable supply. The tax collected on the
    state's behalf is not income, and treating it as such overstates the gain
    by exactly the VAT."""
    a = _truck_a_year_in(client, bank)
    book = COST - 12 * MONTHLY

    r = _dispose(client, a["id"], 27000, vat_amount=3000, bank_account_id=bank["id"])

    assert r.json()["gain_loss"] == _pytest.approx(24000 - book, abs=1)
    assert _lines(db, "asset_disposal", "4427")[1] == _pytest.approx(3000)


def test_the_gain_on_the_screen_is_the_gain_in_the_books(client, bank, db):
    """It used to be computed, displayed and thrown away."""
    a = _truck_a_year_in(client, bank)

    shown = _dispose(client, a["id"], 27000, bank_account_id=bank["id"]).json()

    row = db.execute("SELECT disposal_gain_loss, disposal_entry_id "
                     "FROM fixed_assets WHERE id=?", (a["id"],)).fetchone()
    assert float(row["disposal_gain_loss"]) == _pytest.approx(shown["gain_loss"])
    assert row["disposal_entry_id"] == shown["journal_entry_id"]


def test_the_books_balance_after_selling_it(client, bank):
    a = _truck_a_year_in(client, bank)

    _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert client.get("/api/accounting/trial-balance").json()["balanced"]


# ── Depreciation is brought up to date first ─────────────────────────────────

def test_depreciation_is_caught_up_to_the_month_of_sale(client, bank, db):
    """Sold in June with depreciation last run in February, the four missing
    months are posted before book value is taken — otherwise every month
    nobody remembered to run turns into a gain that was never made."""
    a = _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])
    four_months_back = _months_ago(4)[:7]
    _depreciate(client, a["id"], period=four_months_back)
    before = db.execute("SELECT accumulated_depreciation FROM fixed_assets "
                        "WHERE id=?", (a["id"],)).fetchone()[0]

    r = _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert len(r.json()["depreciation_posted"]) == 4
    after = db.execute("SELECT accumulated_depreciation FROM fixed_assets "
                       "WHERE id=?", (a["id"],)).fetchone()[0]
    assert after == _pytest.approx(before + 4 * MONTHLY, abs=1)


def test_book_value_uses_the_caught_up_figure(client, bank):
    a = _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])
    _depreciate(client, a["id"], period=_months_ago(4)[:7])

    r = _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert r.json()["book_value"] == _pytest.approx(COST - 12 * MONTHLY, abs=1)


# ── Refusals and edges ───────────────────────────────────────────────────────

def test_disposing_twice_posts_once(client, bank, db):
    """A second click must not sell the truck again."""
    a = _truck_a_year_in(client, bank)
    _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    again = _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert again.status_code == 400
    n = db.execute("SELECT COUNT(*) AS n FROM journal_entries "
                   "WHERE source_type='asset_disposal'").fetchone()["n"]
    assert n == 1


def test_a_disposal_into_a_locked_period_is_refused(client, bank):
    """Depreciation refuses to write into a sealed month. Disposal moves more
    money than a month's charge does, so it cannot be the exception."""
    a = _truck_a_year_in(client, bank)
    locked = _months_ago(2)[:7]
    year, month = locked.split("-")
    r = client.post(f"/api/finance/periods/{int(year)}/{int(month)}/lock", json={})
    assert r.status_code == 200, r.text

    r = _dispose(client, a["id"], 27000, disposal_date=_months_ago(2),
                 bank_account_id=bank["id"])

    assert r.status_code == 400
    assert "locked" in r.text.lower()


def test_vat_larger_than_the_proceeds_is_refused(client, bank):
    a = _truck_a_year_in(client, bank)

    r = _dispose(client, a["id"], 1000, vat_amount=2000)

    assert r.status_code == 400


def test_a_fully_depreciated_asset_can_still_be_sold(client, bank, db):
    """Which is exactly when a truck goes for scrap."""
    a = _truck(client, bought=_months_ago(70),
               payment_method="Bank Transfer", bank_account_id=bank["id"])
    _depreciate(client, a["id"])

    r = _dispose(client, a["id"], 2000, bank_account_id=bank["id"])

    assert r.status_code == 200, r.text
    assert _balance(db, ASSET) == _pytest.approx(0, abs=0.01)


def test_an_asset_registered_as_already_owned_still_sells(client, bank, db):
    """Its cost is not on the books, so the disposal credits an account that
    was never debited — which is why the opening-balance reconciliation
    exists. The sale itself must still work and still balance."""
    a = _truck(client, is_opening_balance=True)
    _depreciate(client, a["id"])

    r = _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert r.status_code == 200, r.text
    assert client.get("/api/accounting/trial-balance").json()["balanced"]


# ── A rejected capex request is not a sale ───────────────────────────────────

def test_a_rejected_purchase_is_not_reported_as_a_disposal(client, db):
    """It used to be stamped as a same-day disposal with zero proceeds, which
    was harmless while disposal did nothing. Now that selling posts money, the
    two must not look alike."""
    from approval_engine import MODULE_REGISTRY

    assert MODULE_REGISTRY["fixed_asset"]["actions"]["create"]["rejected"] == "Rejected"


# ── Assets that were already on the register ─────────────────────────────────
# Every one registered before buying became an accounting event posted no cost,
# while depreciation has been charged against them ever since — so the ledger
# carries a contra-asset standing against nothing. One entry states what the
# business owns and what it has already worn out.

def test_the_preview_lists_what_the_register_owes_the_ledger(client):
    _truck(client, is_opening_balance=True)
    _depreciate(client, _truck(client, is_opening_balance=True)["id"])

    body = client.get("/api/assets/opening-balances/preview").json()

    assert body["count"] == 2
    assert body["cost"] == _pytest.approx(2 * COST)
    assert body["already_posted"] is None


def test_an_asset_bought_through_the_system_is_not_listed(client, bank):
    """Its cost is already there. Bringing it in again would double it."""
    _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])

    assert client.get("/api/assets/opening-balances/preview").json()["count"] == 0


def test_the_preview_writes_nothing(client, db):
    _truck(client, is_opening_balance=True)
    before = db.execute("SELECT COUNT(*) AS n FROM journal_entries").fetchone()["n"]

    client.get("/api/assets/opening-balances/preview")

    assert db.execute("SELECT COUNT(*) AS n FROM journal_entries").fetchone()["n"] == before


def test_bringing_them_in_puts_the_missing_cost_on_the_books(client, db):
    a = _truck(client, is_opening_balance=True)
    _depreciate(client, a["id"])

    r = client.post("/api/assets/opening-balances", json={})

    assert r.status_code == 200, r.text
    assert _lines(db, "asset_opening", ASSET)[0] == _pytest.approx(COST)


def test_it_does_not_touch_depreciation_already_charged(client, db):
    """Every charge was posted when it happened, so it is already in the
    contra-asset. Crediting it again would leave the account at twice what has
    actually been written off."""
    a = _truck(client, is_opening_balance=True)
    _depreciate(client, a["id"])
    charged = _balance(db, ACCDEP)

    client.post("/api/assets/opening-balances", json={})

    assert ACCDEP not in _lines(db, "asset_opening")
    assert _balance(db, ACCDEP) == _pytest.approx(charged)


def test_the_cost_goes_to_retained_earnings(client, db):
    """It is value the business already had, not profit it made this year.
    Crediting anything in the P&L would invent one."""
    a = _truck(client, is_opening_balance=True)
    _depreciate(client, a["id"])

    client.post("/api/assets/opening-balances", json={})

    assert _lines(db, "asset_opening", "121")[1] == _pytest.approx(COST)



def test_the_contra_asset_stops_standing_against_nothing(client, db):
    """The symptom that makes this worth doing: depreciation posted against a
    cost that was never debited leaves the asset section negative."""
    a = _truck(client, is_opening_balance=True)
    _depreciate(client, a["id"])
    assert _balance(db, ASSET) == _pytest.approx(0)

    client.post("/api/assets/opening-balances", json={})

    assert _balance(db, ASSET) == _pytest.approx(COST)
    assert _balance(db, ACCDEP) < 0          # a credit balance, as it should be


def test_it_refuses_to_run_twice(client):
    _truck(client, is_opening_balance=True)
    client.post("/api/assets/opening-balances", json={})

    r = client.post("/api/assets/opening-balances", json={})

    assert r.status_code == 400
    assert "already been brought in" in r.text


def test_a_business_with_nothing_to_bring_in_is_told_so(client, bank):
    _truck(client, payment_method="Bank Transfer", bank_account_id=bank["id"])

    r = client.post("/api/assets/opening-balances", json={})

    assert r.status_code == 400
    assert "nothing to bring in" in r.text


def test_it_cannot_be_dated_in_the_future(client):
    _truck(client, is_opening_balance=True)

    r = client.post("/api/assets/opening-balances", json={"as_of": "2099-12-31"})

    assert r.status_code == 400
    assert "future" in r.text


def test_the_books_still_balance_afterwards(client):
    a = _truck(client, is_opening_balance=True)
    _depreciate(client, a["id"])

    client.post("/api/assets/opening-balances", json={})

    assert client.get("/api/accounting/trial-balance").json()["balanced"]


def test_selling_one_afterwards_leaves_the_asset_account_flat(client, bank, db):
    """The two halves meeting: brought in at cost, then sold. Nothing of it
    should remain on the balance sheet."""
    a = _truck(client, is_opening_balance=True)
    _depreciate(client, a["id"])
    client.post("/api/assets/opening-balances", json={})

    _dispose(client, a["id"], 27000, bank_account_id=bank["id"])

    assert _balance(db, ASSET) == _pytest.approx(0, abs=0.01)
    assert _balance(db, ACCDEP) == _pytest.approx(0, abs=0.01)
