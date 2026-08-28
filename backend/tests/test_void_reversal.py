"""Voiding an invoice undoes all of it — the money AND the goods.

The money half already worked: the receivable came off, payments were reversed,
VAT and deferred revenue went with them. The goods half did not. A voided POS
sale left stock deducted and its cost sitting in COGS against no revenue, so
the books reported a loss the size of stock the business still owned — and
balanced perfectly while doing it, which is why nothing caught it.

These tests pin both halves together.
"""
import uuid

import pytest

CENT = 0.011


def _key():
    return str(uuid.uuid4())


def _bal(c):
    tb = c.get("/api/accounting/trial-balance").json()
    return tb, {r["code"]: (r["debit"], r["credit"]) for r in tb["rows"]}


def _stock(c, item):
    return c.get(f"/api/inventory/{item}").json()["quantity"]


def _item(c, name, qty=10, cost=4, price=10):
    r = c.post("/api/inventory/", json={"name": name, "product_type": "finished",
                                        "quantity": qty, "unit_cost": cost,
                                        "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _pos_sale(c, item, qty=3, price=10, **extra):
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code == 200
    body = {"items": [{"name": "VR Item", "inventory_id": item,
                       "quantity": qty, "unit_price": price}],
            "payment_method": "Cash", "amount_tendered": qty * price,
            "idempotency_key": _key()}
    body.update(extra)
    r = c.post("/api/pos/checkout", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── the defect this file exists for ─────────────────────────────────────────
def test_voiding_a_pos_invoice_puts_the_goods_back(make_client):
    c = make_client("superadmin")
    item = _item(c, "VR Item")
    sale = _pos_sale(c, item, qty=3)

    assert _stock(c, item) == pytest.approx(7)
    _, before = _bal(c)
    assert before["5000"][0] == pytest.approx(12, abs=CENT)   # 3 × $4 cost

    r = c.patch(f"/api/invoices/{sale['invoice_id']}/void", json={"reason": "test"})
    assert r.status_code == 200, r.text

    # The goods are back...
    assert _stock(c, item) == pytest.approx(10)
    # ...and so is their cost. Revenue and COGS both return to nothing; a
    # reversal that moved only one of them would leave a phantom profit or loss.
    tb, after = _bal(c)
    assert after.get("5000", (0, 0))[0] == pytest.approx(0, abs=CENT)
    assert after.get("4000", (0, 0))[1] == pytest.approx(0, abs=CENT)
    assert after.get("1000", (0, 0))[0] == pytest.approx(0, abs=CENT)
    assert tb["balanced"] is True


def test_the_reversal_is_posted_not_deleted(make_client, db):
    """History stays: the void adds entries, it does not remove any."""
    c = make_client("superadmin")
    item = _item(c, "VR Audit")
    sale = _pos_sale(c, item, qty=2)

    before = db.execute("SELECT COUNT(*) n FROM journal_entries").fetchone()["n"]
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200
    after = db.execute("SELECT COUNT(*) n FROM journal_entries").fetchone()["n"]
    assert after > before, "a void must ADD reversing entries"

    # The original sale's own entries are all still there, untouched.
    assert db.execute(
        "SELECT COUNT(*) n FROM journal_entries WHERE source_type='pos_cogs'"
    ).fetchone()["n"] >= 1
    # And the payment record survives for audit.
    assert db.execute(
        "SELECT COUNT(*) n FROM invoice_payments WHERE invoice_id=?",
        (sale["invoice_id"],)).fetchone()["n"] >= 1
    # The stock going back is a movement in its own right, not an edit.
    assert db.execute(
        "SELECT COUNT(*) n FROM stock_movements WHERE type='return'"
    ).fetchone()["n"] >= 1


def test_goods_cannot_be_restocked_twice(make_client, db):
    """Void then return, or return then void — the goods go back once."""
    c = make_client("superadmin")
    item = _item(c, "VR Once")
    sale = _pos_sale(c, item, qty=3)
    sale_id = db.execute("SELECT id FROM pos_sales WHERE invoice_id=?",
                         (sale["invoice_id"],)).fetchone()["id"]

    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200
    assert _stock(c, item) == pytest.approx(10)

    # The return now refuses: the invoice it would reverse is already voided.
    second = c.post(f"/api/pos/sales/{sale_id}/return", json={"reason": "again"})
    assert second.status_code == 400, second.text
    assert _stock(c, item) == pytest.approx(10), "restocked twice"

    # And voiding again is refused too.
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "again"}).status_code == 400
    assert _stock(c, item) == pytest.approx(10)


def test_pos_return_still_works_after_the_refactor(make_client, db):
    """The return path now shares the void's restock code — same outcome."""
    c = make_client("superadmin")
    item = _item(c, "VR Return")
    sale = _pos_sale(c, item, qty=4)
    sale_id = db.execute("SELECT id FROM pos_sales WHERE invoice_id=?",
                         (sale["invoice_id"],)).fetchone()["id"]

    assert _stock(c, item) == pytest.approx(6)
    r = c.post(f"/api/pos/sales/{sale_id}/return", json={"reason": "changed mind"})
    assert r.status_code == 200, r.text

    assert _stock(c, item) == pytest.approx(10)
    tb, after = _bal(c)
    assert after.get("4000", (0, 0))[1] == pytest.approx(0, abs=CENT)
    assert after.get("5000", (0, 0))[0] == pytest.approx(0, abs=CENT)
    assert tb["balanced"] is True


def test_an_ordinary_invoice_void_moves_no_stock(make_client):
    """A plain invoice never took goods out, so a void must not put any in."""
    c = make_client("superadmin")
    item = _item(c, "VR Untouched", qty=5)
    cl = c.post("/api/clients/", json={"name": "VR Client"}).json()["id"]
    inv = c.post("/api/invoices/", json={
        "client_id": cl,
        "items": [{"name": "Consulting", "quantity": 1, "unit_price": 500,
                   "inventory_id": item}]})
    assert inv.status_code in (200, 201), inv.text

    assert c.patch(f"/api/invoices/{inv.json()['id']}/void",
                   json={"reason": "test"}).status_code == 200
    assert _stock(c, item) == pytest.approx(5), "invented stock from thin air"


def test_voiding_cancels_what_was_promised(make_client, db):
    """A back-ordered line on a voided sale is no longer owed to anybody."""
    c = make_client("superadmin")
    item = _item(c, "VR Short", qty=1)
    cl = c.post("/api/clients/", json={"name": "VR Waiting"}).json()["id"]
    sale = _pos_sale(c, item, qty=5, client_id=cl, allow_backorder=True)
    assert sale["commitments"], "expected a commitment on the short line"

    assert c.get("/api/commitments/").json(), "should be awaiting before the void"
    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200

    # Nobody is left waiting for goods on a sale that no longer exists.
    assert c.get("/api/commitments/").json() == []
    assert db.execute(
        "SELECT status FROM sale_commitments WHERE invoice_id=?",
        (sale["invoice_id"],)).fetchone()["status"] == "cancelled"
    # The deferred revenue behind the promise went back with the payment.
    _, after = _bal(c)
    assert after.get("2400", (0, 0))[1] == pytest.approx(0, abs=CENT)


def test_a_cancelled_promise_releases_its_reservation(make_client, db):
    """Stock put aside for a promised order returns to free stock on a void."""
    c = make_client("superadmin")
    item = _item(c, "VR Held", qty=1)
    cl = c.post("/api/clients/", json={"name": "VR Holder"}).json()["id"]
    sale = _pos_sale(c, item, qty=3, client_id=cl, allow_backorder=True)

    # Stock arrives and is allocated to the waiting customer.
    po = c.post("/api/purchases/", json={
        "supplier": "VR Mill", "inventory_id": item,
        "product_name": "VR Held", "quantity": 2, "unit_cost": 4})
    assert c.patch(f"/api/purchases/{po.json()['id']}/status",
                   json={"status": "Paid"}).status_code == 200
    held = db.execute(
        "SELECT quantity_allocated q FROM sale_commitments WHERE invoice_id=?",
        (sale["invoice_id"],)).fetchone()["q"]
    assert held > 0, "the arriving stock should have been put aside"

    assert c.patch(f"/api/invoices/{sale['invoice_id']}/void",
                   json={"reason": "test"}).status_code == 200
    assert db.execute(
        "SELECT quantity_allocated q FROM sale_commitments WHERE invoice_id=?",
        (sale["invoice_id"],)).fetchone()["q"] == pytest.approx(0)


def test_voiding_a_service_invoice_keeps_the_parts_out(make_client, db):
    """Not billing for the work does not un-fit the parts.

    They went into the customer's equipment. Getting them back is the job's
    own `reopen` — a separate, deliberate act that says the work did not
    happen. Void must leave stock and cost exactly where they are, or the two
    paths together return every part twice.
    """
    c = make_client("superadmin")
    part = _item(c, "VR Part", qty=10, cost=4, price=10)
    cl = c.post("/api/clients/", json={"name": "VR Service Client"}).json()["id"]

    job = c.post("/api/service/jobs", json={
        "client_id": cl, "reported_fault": "Making a noise",
        "items": [{"line_type": "part", "inventory_id": part, "name": "VR Part",
                   "quantity": 3, "unit_price": 10},
                  {"line_type": "charge", "name": "Labour",
                   "quantity": 1, "unit_price": 50}]})
    assert job.status_code in (200, 201), job.text
    job_id = job.json()["id"]

    done = c.post(f"/api/service/jobs/{job_id}/complete")
    assert done.status_code == 200, done.text
    invoice_id = (done.json().get("invoice") or {}).get("invoice_id")
    assert invoice_id, done.json()

    assert _stock(c, part) == pytest.approx(7)
    _, before = _bal(c)
    assert before["5000"][0] == pytest.approx(12, abs=CENT)

    assert c.patch(f"/api/invoices/{invoice_id}/void",
                   json={"reason": "test"}).status_code == 200

    # The parts stay used and stay costed.
    assert _stock(c, part) == pytest.approx(7), "the void returned parts it should not"
    _, after = _bal(c)
    assert after["5000"][0] == pytest.approx(12, abs=CENT)

    # Reopening is what returns them — once.
    assert c.post(f"/api/service/jobs/{job_id}/reopen").status_code == 200
    assert _stock(c, part) == pytest.approx(10)
    tb, end = _bal(c)
    assert end.get("5000", (0, 0))[0] == pytest.approx(0, abs=CENT)
    assert tb["balanced"] is True


def test_a_reopened_job_cannot_have_its_invoice_unvoided(make_client, db):
    """Its parts are back in the warehouse; the bill must not come back."""
    c = make_client("superadmin")
    part = _item(c, "VR NoUnvoid", qty=10, cost=4, price=10)
    cl = c.post("/api/clients/", json={"name": "VR NU Client"}).json()["id"]
    job = c.post("/api/service/jobs", json={
        "client_id": cl, "reported_fault": "Fault",
        "items": [{"line_type": "part", "inventory_id": part, "name": "VR NoUnvoid",
                   "quantity": 2, "unit_price": 10}]})
    job_id = job.json()["id"]
    done = c.post(f"/api/service/jobs/{job_id}/complete")
    invoice_id = (done.json().get("invoice") or {}).get("invoice_id")

    assert c.patch(f"/api/invoices/{invoice_id}/void",
                   json={"reason": "test"}).status_code == 200
    assert c.post(f"/api/service/jobs/{job_id}/reopen").status_code == 200
    assert _stock(c, part) == pytest.approx(10)

    back = c.patch(f"/api/invoices/{invoice_id}/unvoid", json={})
    assert back.status_code == 400, back.text
    assert _stock(c, part) == pytest.approx(10)


def test_a_done_jobs_invoice_can_still_be_unvoided(make_client):
    """Voided by mistake, job untouched: the bill comes back, stock unchanged."""
    c = make_client("superadmin")
    part = _item(c, "VR Oops", qty=10, cost=4, price=10)
    cl = c.post("/api/clients/", json={"name": "VR Oops Client"}).json()["id"]
    job = c.post("/api/service/jobs", json={
        "client_id": cl, "reported_fault": "Fault",
        "items": [{"line_type": "part", "inventory_id": part, "name": "VR Oops",
                   "quantity": 2, "unit_price": 10}]})
    done = c.post(f"/api/service/jobs/{job.json()['id']}/complete")
    invoice_id = (done.json().get("invoice") or {}).get("invoice_id")

    assert c.patch(f"/api/invoices/{invoice_id}/void",
                   json={"reason": "mistake"}).status_code == 200
    back = c.patch(f"/api/invoices/{invoice_id}/unvoid", json={})
    assert back.status_code == 200, back.text
    assert _stock(c, part) == pytest.approx(8)
