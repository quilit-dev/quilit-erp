"""Void cancels a document; archiving files the cancelled one away.

Two rules, applied to every section that can void — invoices, quotations,
purchases and expenses.

**Archiving requires a void first.** Before, archiving was independent, so a
live invoice could be hidden from the list while its money went on counting
towards the customer's balance, with nothing on screen to explain the total.
The archive now holds only things that have already been cancelled, which is
what makes it safe to stop looking at.

Each section previously had its own guard aimed at the same danger and each got
it backwards: invoices refused anything WITH PAYMENTS, purchases refused
anything Received or Paid. Both also refused a properly voided document — the
one thing that should be filed away.

**The archive is a separate list, not an extra slice of this one.** Ticking the
box swaps the list rather than widening it. Mixing archived rows in among live
ones made the archive impossible to review, and left one control meaning two
different things depending on the screen. The exception is deliberate and
carries a third value: `all`, for a screen that renders both as separate
sections.
"""
import uuid

import pytest


# ── helpers ─────────────────────────────────────────────────────────────────
def _client(c, name="AV Co"):
    return c.post("/api/clients/", json={"name": f"{name} {uuid.uuid4().hex[:5]}"}).json()["id"]


def _invoice(c, amount=500):
    r = c.post("/api/invoices/", json={
        "client_id": _client(c),
        "items": [{"name": "Job", "quantity": 1, "unit_price": amount}]})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _quotation(c, amount=400):
    r = c.post("/api/quotations/", json={
        "client_id": _client(c),
        "items": [{"name": "Offer", "quantity": 1, "unit_price": amount}]})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _purchase(c, status="Ordered"):
    item = c.post("/api/inventory/", json={
        "name": f"AV Item {uuid.uuid4().hex[:5]}", "product_type": "finished",
        "quantity": 0, "unit_cost": 0, "sale_price": 50}).json()["id"]
    r = c.post("/api/purchases/", json={
        "supplier": "Acme", "inventory_id": item, "product_name": "Thing",
        "quantity": 4, "unit_cost": 10, "status": status})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _expense(c, amount=120):
    r = c.post("/api/finance/expenses",
               json={"category": "Materials", "amount": amount})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


SECTIONS = ("invoice", "quotation", "purchase", "expense")


def _make(c, kind):
    return {"invoice": _invoice, "quotation": _quotation,
            "purchase": _purchase, "expense": _expense}[kind](c)


def _paths(kind, rid):
    base = {"invoice":   f"/api/invoices/{rid}",
            "quotation": f"/api/quotations/{rid}",
            "purchase":  f"/api/purchases/{rid}",
            "expense":   f"/api/finance/expenses/{rid}"}[kind]
    return base + "/void", base + "/archive", base + "/unarchive"


# ── the gate ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("kind", SECTIONS)
def test_a_live_document_cannot_be_archived(make_client, kind):
    c = make_client("superadmin")
    void, archive, _ = _paths(kind, _make(c, kind))

    r = c.patch(archive, json={})
    assert r.status_code == 400, r.text
    assert "void" in r.text.lower(), f"the message should say what to do: {r.text}"


@pytest.mark.parametrize("kind", SECTIONS)
def test_once_voided_it_can_be_archived(make_client, kind):
    c = make_client("superadmin")
    void, archive, _ = _paths(kind, _make(c, kind))

    assert c.patch(void, json={"reason": "test"}).status_code == 200
    assert c.patch(archive, json={}).status_code == 200


@pytest.mark.parametrize("kind", SECTIONS)
def test_archiving_can_be_undone(make_client, kind):
    c = make_client("superadmin")
    void, archive, unarchive = _paths(kind, _make(c, kind))
    assert c.patch(void, json={"reason": "test"}).status_code == 200
    assert c.patch(archive, json={}).status_code == 200

    assert c.patch(unarchive, json={}).status_code == 200


# ── the list swaps, rather than widening ────────────────────────────────────
def _ids(body):
    rows = body if isinstance(body, list) else body.get("items", body)
    return {r["id"] for r in rows}


@pytest.mark.parametrize("kind,url", [
    ("invoice",   "/api/invoices/"),
    ("quotation", "/api/quotations/"),
    ("purchase",  "/api/purchases/"),
    ("expense",   "/api/finance/expenses"),
])
def test_the_archive_is_its_own_list(make_client, kind, url):
    """Live rows and archived ones are never shown together."""
    c = make_client("superadmin")
    live = _make(c, kind)
    filed = _make(c, kind)
    void, archive, _ = _paths(kind, filed)
    assert c.patch(void, json={"reason": "test"}).status_code == 200
    assert c.patch(archive, json={}).status_code == 200

    default = _ids(c.get(url).json())
    assert live in default
    assert filed not in default, "an archived row is still in the working list"

    only = _ids(c.get(url, params={"archived": "only"}).json())
    assert filed in only
    assert live not in only, "the archive view is showing live rows too"


def test_a_screen_that_needs_both_can_ask_for_both(make_client):
    """The warehouse admin renders active and archived as separate tables, and
    is the reason this is three values rather than a checkbox."""
    c = make_client("superadmin")
    code = f"AV{uuid.uuid4().hex[:4].upper()}"
    r = c.post("/api/warehouses/", json={"code": code, "name": "Archive Test"})
    assert r.status_code in (200, 201), r.text
    wid = r.json()["id"]
    assert c.patch(f"/api/warehouses/{wid}/archive", json={}).status_code == 200

    codes = lambda mode: {w["code"] for w in c.get(
        "/api/warehouses/", params={"archived": mode} if mode else {}).json()}
    assert code not in codes(None)
    assert code in codes("only")
    assert code in codes("all")
    assert len(codes("all")) > len(codes("only")), "'all' should span both"


def test_an_unknown_mode_is_refused(make_client):
    """A typo must not quietly fall back to a different list."""
    c = make_client("superadmin")
    assert c.get("/api/invoices/", params={"archived": "sometimes"}).status_code == 422


# ── what archiving must NOT do ──────────────────────────────────────────────
def test_archiving_an_expense_does_not_re_reverse_the_project_cost(make_client, db):
    """Void already reverses the contribution; archiving used to do it again.

    The two were independent before, so each did its own bookkeeping. Now that
    archiving always follows a void, the adjustment archiving used to make
    would subtract the same money a second time and quietly halve the project's
    recorded cost.
    """
    c = make_client("superadmin")
    cl = _client(c, "AV Proj")
    pr = c.post("/api/projects/", json={"name": "AV Project", "client_id": cl})
    assert pr.status_code in (200, 201), pr.text
    project_id = pr.json()["id"]

    r = c.post("/api/finance/expenses",
               json={"category": "Materials", "amount": 300, "project_id": project_id})
    assert r.status_code in (200, 201), r.text
    eid = r.json()["id"]

    cost = lambda: float(db.execute(
        "SELECT COALESCE(actual_cost, 0) AS c FROM projects WHERE id=?",
        (project_id,)).fetchone()["c"])
    assert cost() == pytest.approx(300)

    assert c.patch(f"/api/finance/expenses/{eid}/void",
                   json={"reason": "test"}).status_code == 200
    after_void = cost()
    assert after_void == pytest.approx(0), "the void should reverse the contribution"

    assert c.patch(f"/api/finance/expenses/{eid}/archive", json={}).status_code == 200
    assert cost() == pytest.approx(after_void), "archiving subtracted the cost twice"


def test_archiving_leaves_the_ledger_alone(make_client):
    """Voiding is what reverses money. Archiving only files the record."""
    c = make_client("superadmin")
    inv = _invoice(c, 500)
    assert c.patch(f"/api/invoices/{inv}/void",
                   json={"reason": "test"}).status_code == 200

    def tb():
        body = c.get("/api/accounting/trial-balance").json()
        return body["balanced"], {r["code"]: (r["debit"], r["credit"]) for r in body["rows"]}

    before = tb()
    assert c.patch(f"/api/invoices/{inv}/archive", json={}).status_code == 200
    assert tb() == before, "archiving moved money"
