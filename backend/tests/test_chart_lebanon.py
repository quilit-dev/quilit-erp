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
    # No VAT on the line, so this is a sale NOT subject to VAT: 7012, not 7011.
    assert rows["7012"][1] == _pytest.approx(150), "exempt revenue did not reach 7012"
    assert "7011" not in rows, "an untaxed sale landed in Sales subject to VAT"
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


# ── Keeping a tenant on the chart current ────────────────────────────────────
# `install` seeds the chart once and `reconcile_active` retires strangers
# afterwards. Neither ADDS. An account that joins the chart in a later release
# --- 425 for staff advances --- would never reach a tenant that installed the
# chart before it existed, and `status()` would then report that tenant as NOT
# on the chart at all, because every account and role must be present. So a
# migration pass ends with ensure_current, which inserts what is missing and
# points every role where the chart says.

def test_ensure_current_adds_an_account_that_joined_the_chart_later(lebanese):
    db = lebanese
    # Pretend this tenant installed the chart before 425 existed.
    db.execute("DELETE FROM chart_of_accounts WHERE code = '425'")
    db.execute("DELETE FROM account_roles WHERE role = 'employee_advance'")
    db.commit()
    assert not LB.status(db)["installed"], "setup: the tenant should read as behind"

    assert LB.ensure_current(db) == 2          # one account, one role
    db.commit()

    assert LB.status(db)["installed"], "still not on the chart after ensure_current"
    assert accounting.code(db, "employee_advance") == "425"
    row = db.execute("SELECT is_active, is_postable FROM chart_of_accounts "
                     "WHERE code = '425'").fetchone()
    assert row["is_active"] == 1 and row["is_postable"] == 1


def test_ensure_current_re_points_a_role_left_on_the_default_chart(lebanese):
    """The migration that adds 1260 inserts it with INSERT OR IGNORE on every
    tenant. On a Lebanese one, reconcile_active then retires 1260 --- but the
    ROLE would still point at it, and a salary advance would post to a retired
    account. ensure_current moves the role to 425."""
    db = lebanese
    db.execute("UPDATE account_roles SET code = '1260' WHERE role = 'employee_advance'")
    db.commit()
    assert accounting.code(db, "employee_advance") == "1260"

    LB.ensure_current(db)
    db.commit()
    assert accounting.code(db, "employee_advance") == "425"


def test_ensure_current_is_a_no_op_on_the_default_chart(db):
    """A tenant NOT on the Lebanese chart must be left exactly alone --- it
    must not gain 4111 beside 1100."""
    before = db.execute("SELECT COUNT(*) AS n FROM chart_of_accounts").fetchone()["n"]
    assert LB.ensure_current(db) == 0
    after = db.execute("SELECT COUNT(*) AS n FROM chart_of_accounts").fetchone()["n"]
    assert after == before


def test_ensure_current_is_idempotent(lebanese):
    assert LB.ensure_current(lebanese) == 0


# ── Turnover is split by VAT liability ───────────────────────────────────────
# 7011 is a sale subject to VAT, 7012 one that is not. A business that is not
# registered for VAT charges none, and every sale it makes belongs in 7012 ---
# it landed in 7011 because the role pointed there whatever the line's tax.

def _rate_ids(client):
    """The seeded 11% rate and the zero rate. With tax on, a line that names
    no rate gets the default, so 'exempt' has to be said explicitly."""
    client.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    rows = client.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    std = next(x for x in rows if float(x.get("rate") or 0) == 11.0)["id"]
    zero = next(x for x in rows if x.get("tax_type") == "zero")["id"]
    return std, zero


def _paid_sale(client, cid, items):
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "items": items}).json()
    inv = created.get("invoice_id") or created.get("id")
    full = client.get(f"/api/invoices/{inv}").json()
    r = client.post(f"/api/invoices/{inv}/payments", json={
        "amount": full["amount"], "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return inv


def _tb(client):
    return {r["code"]: (r["debit"], r["credit"])
            for r in client.get("/api/accounting/trial-balance").json()["rows"]}


def test_a_taxed_sale_is_subject_to_vat_and_an_untaxed_one_is_not(as_role, db):
    LB.install(db)
    db.commit()
    client = as_role("superadmin")
    vat, zero = _rate_ids(client)
    cid = client.post("/api/clients/", json={"name": "زبون"}).json()["id"]

    _paid_sale(client, cid, [
        {"name": "Taxed",  "quantity": 1, "unit_price": 100, "tax_rate_id": vat},
        {"name": "Exempt", "quantity": 1, "unit_price": 40, "tax_rate_id": zero},
    ])
    rows = _tb(client)
    assert rows["7011"][1] == _pytest.approx(100), "the taxed line belongs in 7011"
    assert rows["7012"][1] == _pytest.approx(40), "the untaxed line belongs in 7012"
    assert rows["4427"][1] == _pytest.approx(11), "VAT due is on the taxed line only"


def test_untaxed_labour_is_a_service_not_subject_to_vat(as_role, db):
    LB.install(db)
    db.commit()
    client = as_role("superadmin")
    cid = client.post("/api/clients/", json={"name": "زبون"}).json()["id"]

    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Labour", "quantity": 1, "unit_price": 60}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    # The service module names the labour account when it raises the invoice.
    db.execute("UPDATE invoice_items SET revenue_account='7131' WHERE invoice_id=?", (inv,))
    db.commit()
    r = client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 60, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    rows = _tb(client)
    assert rows["7132"][1] == _pytest.approx(60)
    assert "7131" not in rows


def test_an_account_the_accountant_named_is_kept_as_named(as_role, db):
    """Only the DEFAULT account of each kind is re-routed. A line pointed at
    some other income account by hand goes exactly where it was pointed."""
    LB.install(db)
    db.commit()
    client = as_role("superadmin")
    cid = client.post("/api/clients/", json={"name": "زبون"}).json()["id"]
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Sundry", "quantity": 1, "unit_price": 25}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    db.execute("UPDATE invoice_items SET revenue_account='76' WHERE invoice_id=?", (inv,))
    db.commit()
    client.post(f"/api/invoices/{inv}/payments", json={
        "amount": 25, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    rows = _tb(client)
    assert rows["76"][1] == _pytest.approx(25)
    assert "7012" not in rows and "7011" not in rows


def test_the_exempt_roles_reach_a_tenant_that_installed_earlier(lebanese):
    """ensure_current is what carries a role added later onto a live tenant."""
    lebanese.execute("DELETE FROM account_roles WHERE role IN "
                     "('revenue_exempt','service_revenue_exempt')")
    lebanese.commit()
    assert LB.ensure_current(lebanese) >= 2
    assert accounting.code(lebanese, "revenue_exempt") == "7012"
    assert accounting.code(lebanese, "service_revenue_exempt") == "7132"
