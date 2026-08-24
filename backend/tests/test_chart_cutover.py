"""Carrying the balances across when a business changes chart.

Switching charts leaves every historical entry pointing where it was posted,
which is right — but it also leaves the balances there. Until they move, the
trial balance carries two charts at once and no statement reads correctly.

The entry that moves them is a reclassification and must be nothing else: the
same totals, in different places. These tests hold that line, because an entry
that quietly restated profit or revalued an asset would be indistinguishable
from a correct one on a screen.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


@_pytest.fixture
def traded(client):
    """A business that has traded on the default chart, then switched."""
    cid = client.post("/api/clients/", json={"name": "Established Co"}).json()["id"]
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Old sale", "quantity": 1, "unit_price": 900}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 400, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    r = client.post("/api/accounting/chart/lebanon/install",
                    json={"confirm": "SWITCH CHART"})
    assert r.status_code == 200, r.text
    return client


def _preview(client, as_of=None):
    """As of today unless told otherwise, which is how a cutover is done."""
    return client.get("/api/accounting/chart/cutover/preview",
                      params=({"as_of": as_of} if as_of else {})).json()


def _auto_map(preview):
    return {l["from_code"]: l["to_code"] for l in preview["lines"] if l["to_code"]}


def _post(client, mappings, as_of=None, **kw):
    body = {"mappings": mappings}
    if as_of:
        body["as_of"] = as_of
    body.update(kw)
    return client.post("/api/accounting/chart/cutover", json=body)


def _tb(client):
    return client.get("/api/accounting/trial-balance").json()


# ── Seeing what would move ───────────────────────────────────────────────────

def test_the_preview_lists_every_retired_account_still_carrying_something(traded):
    body = _preview(traded)

    codes = {l["from_code"] for l in body["lines"]}
    assert "1100" in codes          # receivables from the old chart
    assert "1000" in codes          # cash
    assert body["total"] > 0


def test_it_says_where_each_one_would_go_and_how_it_decided(traded):
    """A destination derived from a role is not a guess; one picked by
    similarity is. A reviewer has to be able to tell them apart."""
    body = _preview(traded)

    ar = next(l for l in body["lines"] if l["from_code"] == "1100")
    assert ar["to_code"] == "4111"
    assert ar["suggested_by"] == "role"
    assert ar["role"] == "receivable"


def test_the_preview_writes_nothing(traded):
    before = len(traded.get("/api/accounting/journal-entries").json()["rows"])

    _preview(traded)

    after = len(traded.get("/api/accounting/journal-entries").json()["rows"])
    assert after == before


def test_an_account_squared_off_by_its_own_history_is_not_listed(traded):
    """Only balances need moving. A retired account that nets to zero would be
    a line of noise in a document somebody has to check by hand."""
    body = _preview(traded)

    assert all(abs(l["balance"]) > 0.005 for l in body["lines"])


# ── Posting it ───────────────────────────────────────────────────────────────

def test_the_old_accounts_are_left_at_zero(traded):
    """The whole point: the trial balance stops carrying two charts."""
    _post(traded, _auto_map(_preview(traded)))

    rows = {r["code"]: r for r in _tb(traded)["rows"]}
    for old in ("1000", "1100", "2400", "4000"):
        if old in rows:
            net = round(float(rows[old]["debit"]) - float(rows[old]["credit"]), 2)
            assert net == _pytest.approx(0, abs=0.01), f"{old} still carries {net}"


def test_the_balances_arrive_on_the_new_chart(traded):
    before = {l["from_code"]: l["balance"] for l in _preview(traded)["lines"]}

    _post(traded, _auto_map(_preview(traded)))

    rows = {r["code"]: r for r in _tb(traded)["rows"]}
    ar = rows["4111"]
    moved = round(float(ar["debit"]) - float(ar["credit"]), 2)
    assert moved == _pytest.approx(before["1100"], abs=0.01)


def test_nothing_is_created_or_destroyed(traded):
    """A reclassification moves figures; it does not change them. The books
    have to total the same before and after."""
    before = _tb(traded)

    _post(traded, _auto_map(_preview(traded)))

    after = _tb(traded)
    assert after["balanced"]
    assert after["total_debit"] == _pytest.approx(before["total_debit"], abs=0.01)
    assert after["total_credit"] == _pytest.approx(before["total_credit"], abs=0.01)


def test_the_profit_for_the_period_is_unchanged(traded):
    """An entry that quietly restated the year's result would look exactly
    like a correct one on screen."""
    span = {"start": "2000-01-01", "end": "2099-12-31"}
    before = traded.get("/api/accounting/income-statement", params=span).json()

    _post(traded, _auto_map(_preview(traded)))

    after = traded.get("/api/accounting/income-statement", params=span).json()
    assert after["net_income"] == _pytest.approx(before["net_income"], abs=0.01)


def test_the_history_is_not_rewritten(traded, db):
    """The original entries keep pointing where they were posted. That is what
    makes the old ledger still readable."""
    before = db.execute(
        "SELECT COUNT(*) AS n FROM journal_entry_lines l "
        "JOIN chart_of_accounts a ON a.id = l.account_id "
        "WHERE a.code = '1100'").fetchone()["n"]

    _post(traded, _auto_map(_preview(traded)))

    after = db.execute(
        "SELECT COUNT(*) AS n FROM journal_entry_lines l "
        "JOIN chart_of_accounts a ON a.id = l.account_id "
        "JOIN journal_entries je ON je.id = l.journal_entry_id "
        "WHERE a.code = '1100' AND je.source_type != 'chart_cutover'").fetchone()["n"]
    assert after == before


def test_it_is_one_entry_that_can_be_reversed(traded):
    """If the mapping was wrong, undoing it has to be possible — and it is an
    ordinary journal entry, so it reverses like one."""
    r = _post(traded, _auto_map(_preview(traded)))
    je = r.json()["journal_entry_id"]

    rev = traded.post(f"/api/accounting/journal-entries/{je}/reverse")

    assert rev.status_code == 200, rev.text
    assert _tb(traded)["balanced"]


# ── Refusals ─────────────────────────────────────────────────────────────────

def test_an_account_with_nowhere_to_go_stops_the_whole_thing(traded):
    """A partial cutover is worse than none: it leaves the books spread over
    two charts while looking finished."""
    mapping = _auto_map(_preview(traded))
    mapping.pop("1100", None)

    r = _post(traded, mapping)

    assert r.status_code == 400
    assert "1100" in r.text
    assert _preview(traded)["already_posted"] is None


def test_a_destination_that_is_itself_retired_is_refused(traded):
    mapping = _auto_map(_preview(traded))
    mapping["1100"] = "2400"          # also retired

    r = _post(traded, mapping)

    assert r.status_code == 400
    assert "not an account on the chart in use" in r.text


def test_moving_a_balance_to_another_type_is_refused(traded):
    """An asset landing on an income account is a restatement, not a
    relocation, and it would change the year's profit."""
    mapping = _auto_map(_preview(traded))
    mapping["1100"] = "7011"          # receivable → sales

    r = _post(traded, mapping)

    assert r.status_code == 400
    assert "rather than relocating" in r.text


def test_it_cannot_be_run_twice(traded):
    """Twice would move every balance again, off the new accounts and onto
    themselves — doubling them."""
    _post(traded, _auto_map(_preview(traded)))

    r = _post(traded, _auto_map(_preview(traded)))

    assert r.status_code == 400
    assert "already been posted" in r.text


def test_a_business_with_nothing_to_move_is_told_so(client):
    r = _post(client, {})

    assert r.status_code == 400
    assert "nothing to move" in r.text


def test_it_needs_permission_to_post(as_role):
    r = as_role("Sales").post("/api/accounting/chart/cutover", json={})

    assert r.status_code == 403


def test_it_is_written_to_the_audit_trail(traded, db):
    _post(traded, _auto_map(_preview(traded)))

    row = db.execute("SELECT * FROM audit_log WHERE action='chart_cutover' "
                     "ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None


def test_a_cutover_dated_in_the_future_is_refused(traded):
    """The entry would exist and no statement would show it until that date
    arrived, so the books would look untouched and somebody would run it
    again."""
    r = _post(traded, _auto_map(_preview(traded)), as_of="2099-12-31")

    assert r.status_code == 400
    assert "future" in r.text
    assert _preview(traded)["already_posted"] is None
