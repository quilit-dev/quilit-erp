"""A tenant on Lebanon's statutory chart.

The point of the role indirection is that this works at all: the same posting
code, told that the receivable is 4111 rather than 1100, produces a Lebanese
ledger without knowing it has. These tests put a tenant on the chart and then
sell something.

What they are really checking is that no account number is still hardcoded
anywhere in the posting path. A single `"1100"` left behind would put a
receivable in an account this chart uses for something else entirely — class 1
is permanent capital here, so it would land in equity — and the trial balance
would still balance while the statements quietly became nonsense.
"""
import uuid

import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import accounting
import chart_lebanon as LB


@_pytest.fixture
def lebanese(db):
    """A tenant on the Lebanese chart, before it has posted anything."""
    LB.install(db)
    db.commit()
    return db


# ── The chart itself ─────────────────────────────────────────────────────────

def test_the_chart_installs(lebanese):
    n = lebanese.execute(
        "SELECT COUNT(*) AS n FROM chart_of_accounts WHERE code LIKE '4%'").fetchone()["n"]

    assert n > 0
    row = lebanese.execute(
        "SELECT name, name_ar, is_postable FROM chart_of_accounts WHERE code='4111'").fetchone()
    assert row["name"] == "Ordinary customers"
    assert row["name_ar"] == "زبائن عاديون"
    assert row["is_postable"] == 1


def test_headings_are_marked_unpostable(lebanese):
    """41 is where customers live; a sale lands in 4111. Posting to the heading
    would double-count it against its own children."""
    heading = lebanese.execute(
        "SELECT is_postable FROM chart_of_accounts WHERE code='41'").fetchone()
    leaf = lebanese.execute(
        "SELECT is_postable FROM chart_of_accounts WHERE code='4111'").fetchone()

    assert heading["is_postable"] == 0
    assert leaf["is_postable"] == 1


def test_the_tree_is_connected(lebanese):
    """Every account hangs off the heading above it, so the chart renders as a
    tree rather than a flat list of numbers."""
    rows = lebanese.execute(
        "SELECT code, parent_code FROM chart_of_accounts "
        "WHERE code LIKE '4%' AND is_active=1").fetchall()
    codes = {r["code"] for r in rows}

    assert codes, "no active class-4 accounts"
    for r in rows:
        if len(r["code"]) > 1:
            assert r["parent_code"] == r["code"][:-1], r["code"]
            assert r["parent_code"] in codes, f"{r['code']} hangs off nothing"


def test_the_previous_chart_is_retired_not_deleted(lebanese):
    """An account is what historical entries point at, so none are removed —
    but a Lebanese business should not be offered 1100 Accounts Receivable
    beside 4111 زبائن عاديون."""
    old = lebanese.execute(
        "SELECT is_active FROM chart_of_accounts WHERE code='1100'").fetchone()

    assert old is not None, "the old account was deleted"
    assert old["is_active"] == 0


# ── The roles point somewhere real ───────────────────────────────────────────

@_pytest.mark.parametrize("role,expected", sorted(LB.ROLES.items()))
def test_every_role_resolves_to_its_lebanese_account(lebanese, role, expected):
    assert accounting.code(lebanese, role) == expected


def test_a_receivable_is_no_longer_1100(lebanese):
    """The headline difference. 1100 in this chart is not a receivable at all —
    class 1 is permanent capital."""
    assert accounting.code(lebanese, "receivable") == "4111"
    assert accounting.code(lebanese, "revenue") == "7011"
    assert accounting.code(lebanese, "cash") == "5312"


def test_vat_stops_being_one_account(lebanese):
    """This chart keeps deductible VAT on charges apart from VAT due on revenue,
    where the default nets both into one control account."""
    assert accounting.code(lebanese, "vat_input") == "4426"
    assert accounting.code(lebanese, "vat_output") == "4427"
    assert accounting.code(lebanese, "vat_control") == "4425"
    assert len({accounting.code(lebanese, r)
                for r in ("vat_input", "vat_output", "vat_control")}) == 3


# ── Selling something ────────────────────────────────────────────────────────

def test_a_sale_posts_into_the_lebanese_accounts(as_role, db):
    """The whole point: the same posting code, on a different chart, with no
    branch anywhere that knows which chart it is on."""
    LB.install(db)
    db.commit()

    client = as_role("superadmin")
    cid = client.post("/api/clients/", json={"name": "زبون تجريبي"}).json()["id"]
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Paracetamol", "quantity": 1, "unit_price": 100}]}).json()
    inv = created.get("invoice_id") or created.get("id")

    rows = {r["code"]: (r["debit"], r["credit"])
            for r in client.get("/api/accounting/trial-balance").json()["rows"]}

    # Raising the invoice books the claim: DR customers, CR deferred income.
    assert "4111" in rows, f"receivable did not land in 4111 — got {sorted(rows)}"
    assert rows["4111"][0] == _pytest.approx(100)
    assert rows["473"][1] == _pytest.approx(100)
    assert "1100" not in rows, "something is still hardcoded to the old chart"


def test_the_ledger_still_balances_on_this_chart(as_role, db):
    LB.install(db)
    db.commit()

    client = as_role("superadmin")
    cid = client.post("/api/clients/", json={"name": "زبون"}).json()["id"]
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Item", "quantity": 2, "unit_price": 75}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 150, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})

    body = client.get("/api/accounting/trial-balance").json()
    rows = {r["code"]: (r["debit"], r["credit"]) for r in body["rows"]}

    assert body["balanced"]
    assert rows["5312"][0] == _pytest.approx(150), "cash did not reach 5312"
    assert rows["7011"][1] == _pytest.approx(150), "revenue did not reach 7011"
    assert rows.get("4111", (0, 0))[0] - rows.get("4111", (0, 0))[1] == _pytest.approx(0)


# ── Not by accident ──────────────────────────────────────────────────────────

def test_installing_over_a_live_ledger_is_refused(as_role, db):
    """Re-pointing the roles under a business that has already posted leaves its
    balances split across two charts and no statement that reads correctly. That
    needs a cutover with an accountant, not a function call."""
    client = as_role("superadmin")
    cid = client.post("/api/clients/", json={"name": "Acme"}).json()["id"]
    client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Item", "quantity": 1, "unit_price": 10}]})

    with _pytest.raises(ValueError, match="split across two"):
        LB.install(db)


def test_installing_twice_is_harmless(lebanese):
    """Idempotent — re-running adds nothing and re-points the same roles."""
    before = lebanese.execute("SELECT COUNT(*) AS n FROM chart_of_accounts").fetchone()["n"]

    LB.install(lebanese)
    lebanese.commit()

    after = lebanese.execute("SELECT COUNT(*) AS n FROM chart_of_accounts").fetchone()["n"]
    assert after == before
    assert accounting.code(lebanese, "receivable") == "4111"


def test_the_default_chart_is_untouched_by_all_this(db):
    """A tenant that never asked for the Lebanese chart must not notice any of
    it existing."""
    assert accounting.code(db, "receivable") == accounting.AR
    assert accounting.code(db, "revenue") == accounting.REVENUE
    assert db.execute(
        "SELECT COUNT(*) AS n FROM chart_of_accounts WHERE code='4111'").fetchone()["n"] == 0
