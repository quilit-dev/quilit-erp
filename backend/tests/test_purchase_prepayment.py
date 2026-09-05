"""Paying for a purchase before the goods arrive.

Receiving and paying used to be one ladder — Ordered, then Received, then Paid —
so "the money has gone" could not be said without also saying "the goods are
here". A pre-ordered delivery, paid up front and shipped weeks later, could only
be entered by marking it Received, which put stock on the shelf that was still
in the supplier's warehouse. Every count, every valuation and every availability
check was then wrong until the lorry turned up.

They are two independent facts now, and a purchase takes any number of payments.
What each test below is really guarding is that the four records of the same
money keep agreeing:

  * the shelf (stock only moves on receipt, never on payment),
  * the supplier's advance account 1250 (money out, goods not yet in),
  * the payable 2000 (goods in, money not yet out),
  * cash, which may only ever show what actually left the bank.

`status` is a computed label over those facts. The three original words keep
their original meanings — a purchase that is received and settled is still
"Paid" — and the two new ones describe states that could not happen before.
"""
import uuid

import pytest


# ── helpers ─────────────────────────────────────────────────────────────────
ADV, INV, AP, CASH, VAT = "1250", "1200", "2000", "1000", "2100"


def _item(c, name, qty=0, cost=0, price=100):
    r = c.post("/api/inventory/", json={
        "name": f"{name} {uuid.uuid4().hex[:6]}", "product_type": "finished",
        "quantity": qty, "unit_cost": cost, "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _po(c, item, qty, cost, status="Ordered", tax_rate_id=None):
    body = {"supplier": "Preorder Co", "inventory_id": item,
            "product_name": "Thing", "quantity": qty, "unit_cost": cost,
            "status": status}
    if tax_rate_id is not None:
        body["tax_rate_id"] = tax_rate_id
    r = c.post("/api/purchases/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _pay(c, pid, amount, **extra):
    return c.post(f"/api/purchases/{pid}/payments",
                  json={"amount": amount, **extra})


def _receive(c, pid):
    return c.patch(f"/api/purchases/{pid}/status", json={"status": "Received"})


def _get(c, pid):
    r = c.get(f"/api/purchases/{pid}")
    assert r.status_code == 200, r.text
    return r.json()


def _stock(db, item):
    r = db.execute("SELECT quantity, unit_cost FROM inventory WHERE id=?",
                   (item,)).fetchone()
    return round(float(r["quantity"]), 4), round(float(r["unit_cost"]), 4)


def _gl(c, code):
    """Debit minus credit. A liability account therefore reads NEGATIVE when
    something is owed, which is why the assertions below subtract."""
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 4)
    return 0.0


def _taxed_rate(c):
    """A rate that actually charges something.

    The seeded default can be 0%, and a test whose VAT assertions all compare
    zero to zero passes whatever the code does — which is the failure mode
    these assertions exist to catch.
    """
    rows = c.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    r = next((x for x in rows if float(x.get("rate") or 0) > 0), None)
    assert r, "no non-zero tax rate is seeded"
    return r["id"]


# ── paying before the goods arrive ──────────────────────────────────────────
def test_paying_up_front_moves_money_and_not_stock(make_client, db):
    """The whole point. Money leaves; nothing arrives on the shelf."""
    c = make_client("superadmin")
    item = _item(c, "PP Pre")
    adv0, cash0, inv0 = _gl(c, ADV), _gl(c, CASH), _gl(c, INV)
    pid = _po(c, item, 10, 10)

    assert _pay(c, pid, 100).status_code == 200

    assert _stock(db, item)[0] == pytest.approx(0), \
        "paying for a pre-order must not book goods that are still at the supplier"
    assert _gl(c, CASH) - cash0 == pytest.approx(-100.0, abs=0.01)
    assert _gl(c, ADV) - adv0 == pytest.approx(100.0, abs=0.01), \
        "the money is an asset — a claim on the supplier — until the goods come"
    assert _gl(c, INV) - inv0 == pytest.approx(0.0, abs=0.01), \
        "nothing is in stock, so nothing may be in the inventory account"
    assert _get(c, pid)["status"] == "Prepaid"
    assert _get(c, pid)["outstanding"] == pytest.approx(0.0, abs=0.01)


def test_receiving_a_prepaid_order_turns_the_advance_into_stock(make_client, db):
    c = make_client("superadmin")
    item = _item(c, "PP Land")
    adv0, cash0, inv0 = _gl(c, ADV), _gl(c, CASH), _gl(c, INV)
    pid = _po(c, item, 10, 10)
    assert _pay(c, pid, 100).status_code == 200

    assert _receive(c, pid).status_code == 200

    assert _stock(db, item) == (10.0, 10.0)
    assert _gl(c, INV) - inv0 == pytest.approx(100.0, abs=0.01)
    assert _gl(c, ADV) - adv0 == pytest.approx(0.0, abs=0.01), \
        "the delivery is what the advance was for, so the delivery clears it"
    assert _gl(c, CASH) - cash0 == pytest.approx(-100.0, abs=0.01), \
        "no money moves on receipt — it moved when it was paid"
    assert _get(c, pid)["status"] == "Paid"


def test_a_deposit_leaves_a_balance_that_receipt_turns_into_a_debt(make_client, db):
    """Half now, half on delivery — the ordinary shape of a pre-order."""
    c = make_client("superadmin")
    item = _item(c, "PP Dep")
    adv0, ap0, cash0 = _gl(c, ADV), _gl(c, AP), _gl(c, CASH)
    pid = _po(c, item, 10, 10)

    assert _pay(c, pid, 40).status_code == 200
    got = _get(c, pid)
    assert got["status"] == "Deposit Paid"
    assert got["outstanding"] == pytest.approx(60.0, abs=0.01)
    assert _gl(c, ADV) - adv0 == pytest.approx(40.0, abs=0.01)

    assert _receive(c, pid).status_code == 200
    assert _gl(c, ADV) - adv0 == pytest.approx(0.0, abs=0.01), "the deposit is used up"
    assert _gl(c, AP) - ap0 == pytest.approx(-60.0, abs=0.01), \
        "and what was not covered by it is owed"
    assert _get(c, pid)["status"] == "Received"

    assert _pay(c, pid, 60).status_code == 200
    assert _gl(c, AP) - ap0 == pytest.approx(0.0, abs=0.01)
    assert _gl(c, CASH) - cash0 == pytest.approx(-100.0, abs=0.01)
    assert _get(c, pid)["status"] == "Paid"
    assert _get(c, pid)["outstanding"] == pytest.approx(0.0, abs=0.01)


def test_the_supplier_cannot_be_paid_more_than_the_order_is_worth(make_client):
    c = make_client("superadmin")
    pid = _po(c, _item(c, "PP Over"), 10, 10)
    assert _pay(c, pid, 60).status_code == 200

    r = _pay(c, pid, 60)
    assert r.status_code == 400
    assert "40" in r.text, "the message should name what is actually outstanding"
    assert _get(c, pid)["paid_total"] == pytest.approx(60.0, abs=0.01), \
        "a refusal must leave the record alone"


def test_a_payment_dated_with_nonsense_is_refused(make_client):
    """The date reaches the journal entry and the period lock verbatim.

    A bad one posts into a month that does not exist and is then a chore to
    find and unpick, so it is stopped at the door rather than at the ledger.
    """
    c = make_client("superadmin")
    pid = _po(c, _item(c, "PP Date"), 10, 10)
    r = _pay(c, pid, 50, paid_at="not-a-date")
    assert r.status_code == 400
    assert _get(c, pid)["paid_total"] == pytest.approx(0.0, abs=0.01)
    # A real one is accepted and kept.
    assert _pay(c, pid, 50, paid_at="2026-09-01").status_code == 200
    assert _get(c, pid)["payments"][0]["paid_at"].startswith("2026-09-01")


def test_a_settled_purchase_takes_no_further_payment(make_client):
    c = make_client("superadmin")
    pid = _po(c, _item(c, "PP Done"), 5, 10)
    assert _pay(c, pid, 50).status_code == 200
    assert _pay(c, pid, 1).status_code == 400


# ── the VAT lands with the goods ────────────────────────────────────────────
def test_input_vat_is_claimed_when_the_goods_arrive_not_when_they_are_paid_for(make_client):
    """The tax invoice comes with the delivery, so the reclaim waits for it.

    Claiming input tax on the payment date would put it in a period with no
    supporting invoice, which is the first thing an auditor asks for.
    """
    c = make_client("superadmin")
    assert c.put("/api/settings/",
                 json={"tax_enabled": "1", "default_tax_rate": "11"}).status_code == 200
    rate = _taxed_rate(c)
    vat0 = _gl(c, VAT)
    pid = _po(c, _item(c, "PP Vat"), 10, 10, tax_rate_id=rate)
    gross = _get(c, pid)["grand_total"]
    assert gross > 100.0, "setup: the default rate has to actually charge something"

    assert _pay(c, pid, gross).status_code == 200
    assert _gl(c, VAT) - vat0 == pytest.approx(0.0, abs=0.01), \
        "paying in advance claims no input tax"

    assert _receive(c, pid).status_code == 200
    assert _gl(c, VAT) - vat0 == pytest.approx(gross - 100.0, abs=0.01), \
        "the delivery is what brings the reclaim"


def test_the_purchase_shows_every_entry_it_produced(make_client):
    """"What did this do to the books?" now has more than one answer.

    A purchase used to produce exactly one journal entry, so the postings panel
    could look it up by (source_type, source_id) and stop. The money side is
    its own entry now, and one keyed to the PAYMENT rather than the purchase —
    so without teaching the resolver about it, the panel would show the goods
    arriving and no sign of the money that paid for them.
    """
    c = make_client("superadmin")
    pid = _po(c, _item(c, "PP Trail"), 10, 10)
    assert _pay(c, pid, 40).status_code == 200
    assert _receive(c, pid).status_code == 200
    assert _pay(c, pid, 60).status_code == 200

    r = c.get(f"/api/accounting/for/purchase/{pid}")
    assert r.status_code == 200, r.text
    kinds = [e["source_type"] for e in r.json()["entries"]]
    assert kinds.count("purchase") == 1, "the receipt"
    assert kinds.count("purchase_payment") == 2, "the deposit and the balance"


# ── undoing it ──────────────────────────────────────────────────────────────
def test_voiding_a_prepaid_order_gives_the_money_back(make_client, db):
    c = make_client("superadmin")
    item = _item(c, "PP Void")
    adv0, cash0 = _gl(c, ADV), _gl(c, CASH)
    pid = _po(c, item, 10, 10)
    assert _pay(c, pid, 100).status_code == 200

    r = c.patch(f"/api/purchases/{pid}/void", json={"reason": "supplier cancelled"})
    assert r.status_code == 200, r.text
    assert r.json()["refunded"] == pytest.approx(100.0, abs=0.01)
    assert _gl(c, ADV) - adv0 == pytest.approx(0.0, abs=0.01)
    assert _gl(c, CASH) - cash0 == pytest.approx(0.0, abs=0.01), \
        "the money comes back out of the supplier's advance account"
    assert _get(c, pid)["paid_total"] == pytest.approx(0.0, abs=0.01)


def test_a_payment_can_be_taken_back_while_the_goods_are_still_coming(make_client):
    c = make_client("superadmin")
    adv0, cash0 = _gl(c, ADV), _gl(c, CASH)
    pid = _po(c, _item(c, "PP Undo"), 10, 10)
    assert _pay(c, pid, 100).status_code == 200
    pay_id = _get(c, pid)["payments"][0]["id"]

    r = c.patch(f"/api/purchases/{pid}/payments/{pay_id}/void",
                json={"reason": "keyed against the wrong order"})
    assert r.status_code == 200, r.text
    assert _gl(c, ADV) - adv0 == pytest.approx(0.0, abs=0.01)
    assert _gl(c, CASH) - cash0 == pytest.approx(0.0, abs=0.01)
    assert _get(c, pid)["status"] == "Ordered"


def test_an_advance_cannot_be_unpicked_once_the_goods_have_landed(make_client):
    """The receipt has already spent it against the delivery.

    Reversing it on its own would leave 1250 holding a credit balance with
    nothing to explain it — money the books say a supplier owes us, against a
    delivery we have. The purchase has to be voided so both go together.
    """
    c = make_client("superadmin")
    pid = _po(c, _item(c, "PP Locked"), 10, 10)
    assert _pay(c, pid, 100).status_code == 200
    pay_id = _get(c, pid)["payments"][0]["id"]
    assert _receive(c, pid).status_code == 200

    r = c.patch(f"/api/purchases/{pid}/payments/{pay_id}/void", json={"reason": "x"})
    assert r.status_code == 400
    assert "void the purchase" in r.text.lower()


# ── what must not have changed ──────────────────────────────────────────────
def test_receive_then_mark_paid_still_works_exactly_as_it_did(make_client, db):
    """The old two-button flow is what every existing caller uses."""
    c = make_client("superadmin")
    item = _item(c, "PP Old")
    cash0, inv0, ap0 = _gl(c, CASH), _gl(c, INV), _gl(c, AP)
    pid = _po(c, item, 10, 10)

    assert _receive(c, pid).status_code == 200
    assert _stock(db, item) == (10.0, 10.0)
    assert _get(c, pid)["status"] == "Received"

    assert c.patch(f"/api/purchases/{pid}/status",
                   json={"status": "Paid"}).status_code == 200
    assert _get(c, pid)["status"] == "Paid"
    assert _gl(c, INV) - inv0 == pytest.approx(100.0, abs=0.01)
    assert _gl(c, CASH) - cash0 == pytest.approx(-100.0, abs=0.01)
    assert _gl(c, AP) - ap0 == pytest.approx(0.0, abs=0.01), \
        "settled in full, so nothing is left owing"
    assert _get(c, pid)["payments"][0]["amount"] == pytest.approx(100.0, abs=0.01), \
        "'Mark paid' is a payment like any other, and is recorded as one"


def test_a_purchase_created_already_paid_records_the_payment(make_client, db):
    """The shape the seed data and 25 test files post."""
    c = make_client("superadmin")
    item = _item(c, "PP Born")
    cash0 = _gl(c, CASH)
    pid = _po(c, item, 4, 25, status="Paid")

    got = _get(c, pid)
    assert got["status"] == "Paid"
    assert got["outstanding"] == pytest.approx(0.0, abs=0.01)
    assert _stock(db, item)[0] == pytest.approx(4)
    assert _gl(c, CASH) - cash0 == pytest.approx(-100.0, abs=0.01)


def test_a_prepaid_order_can_still_be_received_despite_forward_only_status(make_client):
    """'Prepaid' is not further along the ladder than 'Received'.

    Status is forward-only to stop a settled purchase being walked backwards
    into one that has posted nothing. Ranking the money labels above 'Received'
    would have made a paid pre-order impossible to receive — refused by the
    very guard that is supposed to protect it.
    """
    c = make_client("superadmin")
    pid = _po(c, _item(c, "PP Rank"), 10, 10)
    assert _pay(c, pid, 100).status_code == 200
    assert _get(c, pid)["status"] == "Prepaid"
    assert _receive(c, pid).status_code == 200


# ── the migration ───────────────────────────────────────────────────────────
def test_history_gets_exactly_one_payment_and_never_two(make_client, db):
    """The backfill runs from _ensure_pg_post_baseline, on EVERY boot.

    An unguarded pass would invent a second payment for every historical
    purchase — doubling what the books say each supplier has been given, with
    nothing failing.
    """
    import database

    c = make_client("superadmin")
    pid = _po(c, _item(c, "PP Hist"), 10, 10, status="Paid")
    before = db.execute(
        "SELECT COUNT(*) n FROM purchase_payments WHERE purchase_id=?",
        (pid,)).fetchone()["n"]
    assert before == 1

    raw = db._conn if hasattr(db, "_conn") else db
    raw.execute(database._PURCHASE_PAYMENTS_BACKFILL)
    raw.execute(database._PURCHASE_PAID_TOTAL_BACKFILL)
    raw.commit()

    after = db.execute(
        "SELECT COUNT(*) n FROM purchase_payments WHERE purchase_id=?",
        (pid,)).fetchone()["n"]
    assert after == 1, "the backfill duplicated a payment on a second pass"
    assert _get(c, pid)["paid_total"] == pytest.approx(100.0, abs=0.01)


def test_a_folded_payment_is_not_treated_as_an_advance(make_client, db):
    """Rows the migration invented carry no journal entry of their own.

    Their money is already inside the purchase's entry, posted when it was
    marked Paid under the old model. Counting one as an advance would credit
    1250 at receipt for money that never went through it, and restating such a
    purchase would then credit a payable that nothing ever settles.
    """
    c = make_client("superadmin")
    item = _item(c, "PP Fold")
    adv0, cash0 = _gl(c, ADV), _gl(c, CASH)
    pid = _po(c, item, 10, 10, status="Paid")
    # Reconstruct the shape migration 174c produces: a payment row whose money
    # is inside the PURCHASE's entry, with no entry of its own. Creating the
    # purchase as Paid posts both, so the payment's entry is removed here —
    # which is exactly what a purchase settled before this release looks like.
    db.execute("UPDATE purchase_payments SET applied_as='folded', "
               " folded_into_purchase=1 WHERE purchase_id=?", (pid,))
    db.execute("DELETE FROM journal_entry_lines WHERE journal_entry_id IN "
               "(SELECT id FROM journal_entries WHERE source_type='purchase_payment')")
    db.execute("DELETE FROM journal_entries WHERE source_type='purchase_payment'")
    db.commit()
    assert _gl(c, CASH) - cash0 == pytest.approx(0.0, abs=0.01),         "setup: the legacy shape has the cash credit inside the purchase entry"

    # A cost correction reverses the purchase entry and posts it again, which
    # is the path that reads these flags.
    r = c.put(f"/api/purchases/{pid}", json={
        "items": [{"inventory_id": item, "product_name": "Thing",
                   "quantity": 10, "unit_cost": 10}]})
    assert r.status_code == 200, r.text
    assert _gl(c, ADV) - adv0 == pytest.approx(0.0, abs=0.01), \
        "a folded payment never touched the advance account and must not now"
    assert _gl(c, CASH) - cash0 == pytest.approx(-100.0, abs=0.01)


def test_history_that_never_recorded_a_receipt_date_is_not_read_as_prepaid(make_client, db):
    """`received_at` was written only by the move to 'Received'.

    A purchase created already Paid never got one, and seeded history has none
    at all — while its stock was credited and its ledger entry posted. Once
    settlement reads that column, an empty one means "not yet delivered", so
    every such row would relabel itself Prepaid, join the money-with-suppliers
    figure, and take its next payment into 1250 Advances instead of against
    what is owed. The goods are on the shelf; the books have to say so.
    """
    import database

    c = make_client("superadmin")
    item = _item(c, "PP Old Row")
    pid = _po(c, item, 10, 10, status="Paid")
    # The shape the old code left behind: goods in, no date saying when.
    db.execute("UPDATE purchases SET received_at=NULL WHERE id=?", (pid,))
    db.commit()

    raw = db._conn if hasattr(db, "_conn") else db
    raw.execute(database._PURCHASE_RECEIVED_AT_BACKFILL)
    raw.commit()

    row = db.execute("SELECT received_at, stock_updated FROM purchases WHERE id=?",
                     (pid,)).fetchone()
    assert row["received_at"], "a purchase whose stock was credited HAS been received"

    # And an order genuinely still in transit is left alone.
    open_pid = _po(c, _item(c, "PP Still Coming"), 10, 10)
    assert _pay(c, open_pid, 50).status_code == 200
    raw.execute(database._PURCHASE_RECEIVED_AT_BACKFILL)
    raw.commit()
    assert db.execute("SELECT received_at FROM purchases WHERE id=?",
                      (open_pid,)).fetchone()["received_at"] is None
    assert _get(c, open_pid)["status"] == "Deposit Paid"
