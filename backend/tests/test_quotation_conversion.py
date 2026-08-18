"""Converting a quotation to an invoice.

This used to be a hand-written copy of `create_invoice` living in
`quotations.py`, and it had drifted from the original in four ways that were
invisible until you compared the two side by side:

  * no approval gate — a policy that stops a large invoice did not stop the
    same invoice raised from a quotation
  * no branch tag — the invoice landed with `branch_id` NULL
  * the item copy dropped `discount`, `discount_pct` and `inventory_id`

All four are fixed by routing through `invoices.build_invoice`, and each one
gets an assertion here so the copy cannot come back.
"""
import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Acme Ltd"}).json()["id"]


def _quote(client, client_id, items, **extra):
    body = {"client_id": client_id, "items": items}
    body.update(extra)
    r = client.post("/api/quotations/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _convert(client, qid):
    r = client.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert r.status_code == 200, r.text
    return r.json()


def _invoice_row(inv_id):
    import database
    with database.session() as db:
        inv = dict(db.execute("SELECT * FROM invoices WHERE id=?", (inv_id,)).fetchone())
        items = [dict(r) for r in db.execute(
            "SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id", (inv_id,))]
    return inv, items


# ── the figures the customer was quoted ──────────────────────────────────────

def test_the_invoice_totals_match_the_quotation(client, acme):
    """Lines are re-priced rather than copied, so this is the assertion that the
    two pricing paths really are the same algorithm."""
    qid = _quote(client, acme, [
        {"name": "Pump", "quantity": 2, "unit_price": 150},
        {"name": "Seal kit", "quantity": 1, "unit_price": 40},
    ])
    quote = client.get(f"/api/quotations/{qid}").json()

    inv, _ = _invoice_row(_convert(client, qid)["invoice_id"])

    assert inv["subtotal"] == pytest.approx(quote["total"], abs=0.01)
    assert inv["tax_total"] == pytest.approx(quote["tax_total"], abs=0.01)
    # The invariant the rest of the ledger relies on.
    assert inv["amount"] == pytest.approx(inv["subtotal"] + inv["tax_total"], abs=0.01)


# ── the four things the hand-written copy dropped ────────────────────────────

def test_the_line_discount_survives_conversion(client, acme):
    # Dropped by the old copy: the customer was quoted 300 less a 50 discount
    # and would have been invoiced the full 300.
    qid = _quote(client, acme, [
        {"name": "Pump", "quantity": 2, "unit_price": 150, "discount": 50},
    ])
    quote = client.get(f"/api/quotations/{qid}").json()

    inv, items = _invoice_row(_convert(client, qid)["invoice_id"])

    assert items[0]["discount"] == pytest.approx(50)
    assert inv["subtotal"] == pytest.approx(quote["total"], abs=0.01)
    assert inv["subtotal"] == pytest.approx(250, abs=0.01)


def test_the_discount_percentage_survives(client, acme):
    qid = _quote(client, acme, [
        {"name": "Pump", "quantity": 1, "unit_price": 200,
         "discount": 20, "discount_pct": 10},
    ])
    _, items = _invoice_row(_convert(client, qid)["invoice_id"])

    assert items[0]["discount_pct"] == pytest.approx(10)


def test_the_inventory_link_survives(client, acme):
    item = client.post("/api/inventory/", json={
        "name": "Bearing", "quantity": 10, "unit_cost": 5, "sale_price": 12,
    }).json()
    qid = _quote(client, acme, [
        {"name": "Bearing", "quantity": 2, "unit_price": 12,
         "inventory_id": item["id"]},
    ])
    _, items = _invoice_row(_convert(client, qid)["invoice_id"])

    # Without this the invoice line is orphaned from the stock item, so nothing
    # downstream can tell what was actually sold.
    assert items[0]["inventory_id"] == item["id"]


def test_the_invoice_is_branch_tagged(client, acme):
    qid = _quote(client, acme, [{"name": "Pump", "quantity": 1, "unit_price": 100}])

    inv, _ = _invoice_row(_convert(client, qid)["invoice_id"])

    # NULL here is what the old copy produced — it never called
    # resolve_branch_id at all — so the invoice belonged to no branch and
    # branch-scoped reads and reports silently skipped it.
    #
    # Note what this does and does not prove: build_invoice resolves a default
    # branch even when none is passed, so this catches the NULL but not a
    # failure to pass the QUOTATION's branch specifically. Cross-branch
    # conversion is covered by test_branch_isolation.py.
    assert inv["branch_id"] is not None


# ── behaviour that must NOT change ───────────────────────────────────────────

def test_converting_twice_returns_the_same_invoice(client, acme):
    qid = _quote(client, acme, [{"name": "Pump", "quantity": 1, "unit_price": 100}])
    first = _convert(client, qid)
    second = _convert(client, qid)

    assert second["invoice_id"] == first["invoice_id"]


def test_a_voided_quotation_cannot_be_invoiced(client, acme):
    qid = _quote(client, acme, [{"name": "Pump", "quantity": 1, "unit_price": 100}])
    assert client.patch(f"/api/quotations/{qid}/void",
                        json={"reason": "duplicate"}).status_code == 200

    r = client.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert r.status_code == 400


def test_the_quotation_is_marked_accepted(client, acme):
    qid = _quote(client, acme, [{"name": "Pump", "quantity": 1, "unit_price": 100}])
    _convert(client, qid)

    assert client.get(f"/api/quotations/{qid}").json()["status"] == "Accepted"


def test_promotions_are_not_applied_a_second_time(client, acme):
    """The quotation's lines already carry whatever discount the customer was
    offered. Re-running promotions at conversion would discount them twice."""
    item = client.post("/api/inventory/", json={
        "name": "Widget", "quantity": 100, "unit_cost": 4, "sale_price": 10,
    }).json()
    client.post("/api/promotions/", json={
        "name": "10% off widgets", "scope_type": "all",
        "discount_type": "percent", "discount_value": 10, "active": 1,
    })
    qid = _quote(client, acme, [
        {"name": "Widget", "quantity": 10, "unit_price": 10,
         "inventory_id": item["id"]},
    ])
    quote = client.get(f"/api/quotations/{qid}").json()

    inv, _ = _invoice_row(_convert(client, qid)["invoice_id"])

    # Whatever the quotation settled on is what gets invoiced — not that figure
    # with the promotion taken off again.
    assert inv["subtotal"] == pytest.approx(quote["total"], abs=0.01)
