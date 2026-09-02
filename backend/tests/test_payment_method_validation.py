"""A payment method is not free text.

At the till the METHOD decides whether the sale is settled. The rule used to be
"if it is cash, count it; otherwise it was charged exactly", which made the
dangerous branch the default: any word the system did not recognise meant paid
in full. A sale sent with method "Later" and nothing tendered completed, marked
itself Paid, recorded a payment that never happened, and debited cash that
never entered the drawer.

Two changes, and the second matters more than the first:

  * unknown methods are refused rather than interpreted;
  * the question is now "does this method settle itself?" rather than "is this
    cash?", so anything unanticipated falls to the SAFE branch and has to be
    tendered.

The second is what makes this hold if some future method is added and somebody
forgets to add it to the list.
"""
import uuid

import pytest


def _setup(c):
    item = c.post("/api/inventory/", json={
        "name": "PM Item", "product_type": "finished",
        "quantity": 20, "unit_cost": 4, "sale_price": 10}).json()["id"]
    cl = c.post("/api/clients/", json={"name": "PM Client"}).json()["id"]
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code == 200
    return item, cl


def _checkout(c, item, **extra):
    body = {"items": [{"name": "PM Item", "inventory_id": item,
                       "quantity": 2, "unit_price": 10}],
            "payment_method": "Cash", "amount_tendered": 20,
            "idempotency_key": str(uuid.uuid4())}
    body.update(extra)
    return c.post("/api/pos/checkout", json=body)


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return r["debit"] - r["credit"]
    return 0.0


# ── the defect ──────────────────────────────────────────────────────────────
@pytest.mark.parametrize("method", ["Later", "Credit", "On Account", "", "  ", "x"])
def test_an_unknown_method_cannot_pass_as_payment(make_client, method):
    c = make_client("superadmin")
    item, _ = _setup(c)
    r = _checkout(c, item, payment_method=method, amount_tendered=0)
    assert r.status_code == 400, f"{method!r} was accepted: {r.text[:160]}"


def test_it_invents_no_money_and_moves_no_stock(make_client):
    """The whole failure in one assertion set."""
    c = make_client("superadmin")
    item, _ = _setup(c)
    cash_before = _gl(c, "1000")

    r = _checkout(c, item, payment_method="Later", amount_tendered=0)
    assert r.status_code == 400, r.text

    assert _gl(c, "1000") == pytest.approx(cash_before), "cash was debited"
    assert c.get(f"/api/inventory/{item}").json()["quantity"] == pytest.approx(20)


def test_the_message_says_what_to_use_instead(make_client):
    c = make_client("superadmin")
    item, _ = _setup(c)
    r = _checkout(c, item, payment_method="Later", amount_tendered=0)
    assert "Cash" in r.text and "Card" in r.text


# ── the part that survives somebody forgetting the list ─────────────────────
def test_an_unknown_method_would_still_have_to_be_tendered(make_client):
    """Defence in depth: the fallback branch is the safe one now.

    `settles_exactly` answers yes only for the methods that genuinely do, so a
    method added to PAYMENT_METHODS but not to SETTLED_EXACTLY is treated as
    cash — counted and tendered — rather than as already paid.
    """
    import accounting
    assert accounting.settles_exactly("Later") is False
    assert accounting.settles_exactly("Other") is False
    assert accounting.settles_exactly("Cash") is False
    for m in accounting.SETTLED_EXACTLY:
        assert accounting.settles_exactly(m) is True
        assert m in accounting.PAYMENT_METHODS, f"{m} settles but is not a method"


# ── nothing legitimate broke ────────────────────────────────────────────────
def test_a_cash_sale_still_works(make_client):
    c = make_client("superadmin")
    item, _ = _setup(c)
    r = _checkout(c, item, payment_method="Cash", amount_tendered=20)
    assert r.status_code == 200, r.text
    assert r.json()["payment_status"] == "Paid"
    assert c.get(f"/api/inventory/{item}").json()["quantity"] == pytest.approx(18)


def test_cash_still_has_to_cover_the_total(make_client):
    c = make_client("superadmin")
    item, _ = _setup(c)
    r = _checkout(c, item, payment_method="Cash", amount_tendered=5)
    assert r.status_code == 400
    assert "tendered" in r.text.lower()


def test_cash_still_gives_change(make_client):
    c = make_client("superadmin")
    item, _ = _setup(c)
    r = _checkout(c, item, payment_method="Cash", amount_tendered=50)
    assert r.status_code == 200, r.text
    assert r.json()["change_given"] == pytest.approx(30)


@pytest.mark.parametrize("method", ["Card", "Bank Transfer", "Cheque"])
def test_a_settled_method_needs_nothing_tendered(make_client, method):
    """A terminal charges the exact amount; there is nothing to count out."""
    c = make_client("superadmin")
    item, _ = _setup(c)
    r = _checkout(c, item, payment_method=method, amount_tendered=0)
    assert r.status_code == 200, r.text
    assert r.json()["payment_status"] == "Paid"
    assert r.json()["change_given"] == pytest.approx(0)


def test_lowercase_spelling_is_accepted(make_client):
    """The UI sends 'Cash'; the check must not be a spelling test."""
    c = make_client("superadmin")
    item, _ = _setup(c)
    assert _checkout(c, item, payment_method="card",
                     amount_tendered=0).status_code == 200


# ── the invoice-payment path ────────────────────────────────────────────────
def test_an_invoice_payment_refuses_an_unknown_method(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "PM Inv"}).json()["id"]
    inv = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "Job", "quantity": 1, "unit_price": 100}]}).json()["id"]

    r = c.post(f"/api/invoices/{inv}/payments", json={
        "amount": 100, "method": "Later", "idempotency_key": "pm-1"})
    assert r.status_code == 400, r.text


@pytest.mark.parametrize("method", ["Cash", "Bank Transfer", "Cheque", "Card", "Other"])
def test_every_method_the_screens_offer_is_accepted(make_client, method):
    """PayoutModal and CustomerPaymentModal between them offer these five."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": f"PM {method}"}).json()["id"]
    inv = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "Job", "quantity": 1, "unit_price": 100}]}).json()["id"]

    r = c.post(f"/api/invoices/{inv}/payments", json={
        "amount": 100, "method": method, "idempotency_key": f"pm-{method}"})
    assert r.status_code == 200, r.text


def test_the_vocabulary_matches_the_money_router(make_client):
    """The two lists that have to agree, checked rather than assumed.

    `money_account_for` decides which account a method's money lands in, and it
    carries its own tuple of bank-settled methods. Building PAYMENT_METHODS
    from the UI alone missed "Bank" — a spelling that router has always
    honoured — and started refusing payments the system settles perfectly well.
    Three existing tests caught it; this one names the reason.
    """
    import re, inspect, accounting

    src = inspect.getsource(accounting.money_account_for)
    routed = set(re.findall(r'"([a-z ]+)"', src.split("in (")[1].split(")")[0]))
    settled = {m.lower() for m in accounting.SETTLED_EXACTLY}
    assert routed == settled, (
        f"money_account_for routes {sorted(routed)} to the bank but "
        f"SETTLED_EXACTLY says {sorted(settled)} — they must agree")

    # And everything that settles must be a method in the first place.
    known = {m.lower() for m in accounting.PAYMENT_METHODS}
    assert settled <= known
