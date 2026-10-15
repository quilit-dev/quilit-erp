"""Returns: credit notes against invoices, debit notes against purchases.

What a return has to get right is that every record of the same sale or
purchase still agrees afterwards --- the document's balance, the ledger, the
shelf, and the credit held for the customer or supplier --- and that it refuses
the cases that would make them disagree (returning more than was sold, voiding
the invoice underneath a credit note, undoing a credit that has been spent).
"""
import uuid

import pytest

pytestmark = pytest.mark.critical


# ── helpers ─────────────────────────────────────────────────────────────────
@pytest.fixture
def c(make_client):
    return make_client("superadmin")


def _gl(c, code):
    for r in c.get("/api/accounting/trial-balance").json()["rows"]:
        if r["code"] == code:
            return round(r["debit"] - r["credit"], 2)
    return 0.0


def _client(c):
    return c.post("/api/clients/", json={"name": "Returner " + uuid.uuid4().hex[:5]}).json()["id"]


def _zero_rate(c):
    rows = c.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    return next(r["id"] for r in rows if r.get("tax_type") == "zero")


def _invoice(c, client_id, items):
    r = c.post("/api/invoices/", json={"client_id": client_id, "items": items})
    assert r.status_code == 200, r.text
    iid = r.json().get("id") or r.json().get("invoice_id")
    return c.get(f"/api/invoices/{iid}").json()


def _two_line_invoice(c, cid=None):
    z = _zero_rate(c)
    cid = cid or _client(c)
    inv = _invoice(c, cid, [
        {"name": "Chair", "quantity": 4, "unit_price": 100, "tax_rate_id": z},
        {"name": "Table", "quantity": 1, "unit_price": 600, "tax_rate_id": z}])
    return inv, cid


def _lines(c, invoice_id):
    r = c.get(f"/api/returns/sales/invoice/{invoice_id}/returnable")
    assert r.status_code == 200, r.text
    return {l["name"]: l for l in r.json()["lines"]}


def _pay(c, invoice_id, amount, method="Cash"):
    r = c.post(f"/api/invoices/{invoice_id}/payments", json={"amount": amount, "method": method,
                                                            "idempotency_key": str(uuid.uuid4())})
    return r


def _return(c, invoice_id, lines, **extra):
    return c.post("/api/returns/sales", json={"invoice_id": invoice_id, "lines": lines, **extra})


def _balance(c, invoice_id):
    pays = c.get(f"/api/invoices/{invoice_id}/payments").json()
    inv = c.get(f"/api/invoices/{invoice_id}").json()
    return round(float(inv["amount"]) - sum(float(p["amount"]) for p in pays), 2)


# ── Credit notes on an unpaid invoice ────────────────────────────────────────
def test_returning_part_of_an_unpaid_invoice_cancels_that_much_of_the_claim(c):
    inv, _ = _two_line_invoice(c)                       # 400 + 600 = 1000
    ar0, dr0 = _gl(c, "1100"), _gl(c, "2400")
    chair = _lines(c, inv["id"])["Chair"]
    r = _return(c, inv["id"], [{"invoice_item_id": chair["invoice_item_id"], "quantity": 1}],
                reason="Scratched")
    assert r.status_code == 200, r.text
    assert r.json()["return_number"].startswith("CN-")

    assert _balance(c, inv["id"]) == 900
    assert _gl(c, "1100") == ar0 - 100, "the receivable comes down"
    assert _gl(c, "2400") == dr0 + 100, "and so does the revenue it had deferred"

    # Paying what is left earns exactly the goods the customer kept.
    rev0 = _gl(c, "4000")
    assert _pay(c, inv["id"], 900).status_code == 200
    assert _gl(c, "4000") == rev0 - 900
    assert _gl(c, "2400") == dr0 + 1000, "nothing deferred is left behind"
    assert c.get(f"/api/invoices/{inv['id']}").json()["payment_status"] == "Paid"


def test_cannot_return_more_than_was_sold(c):
    inv, _ = _two_line_invoice(c)
    chair = _lines(c, inv["id"])["Chair"]
    assert _return(c, inv["id"], [{"invoice_item_id": chair["invoice_item_id"],
                                   "quantity": 3}]).status_code == 200
    r = _return(c, inv["id"], [{"invoice_item_id": chair["invoice_item_id"], "quantity": 2}])
    assert r.status_code == 400 and "only 1" in r.text
    assert _lines(c, inv["id"])["Chair"]["returnable_quantity"] == 1


def test_the_invoice_cannot_be_voided_under_a_credit_note(c):
    inv, _ = _two_line_invoice(c)
    chair = _lines(c, inv["id"])["Chair"]
    rid = _return(c, inv["id"], [{"invoice_item_id": chair["invoice_item_id"],
                                  "quantity": 1}]).json()["id"]
    assert c.patch(f"/api/invoices/{inv['id']}/void", json={"reason": "x"}).status_code == 409
    # The credit note's own row cannot be deleted as if it were a payment.
    pay = next(p for p in c.get(f"/api/invoices/{inv['id']}/payments").json()
               if p["method"] == "Credit note")
    assert c.delete(f"/api/invoices/{inv['id']}/payments/{pay['id']}").status_code == 409

    ar_before = _gl(c, "1100")
    assert c.patch(f"/api/returns/sales/{rid}/void", json={"reason": "typo"}).status_code == 200
    assert _balance(c, inv["id"]) == 1000
    assert _gl(c, "1100") == ar_before + 100
    assert c.patch(f"/api/invoices/{inv['id']}/void", json={"reason": "x"}).status_code == 200


# ── Credit notes on a paid invoice ───────────────────────────────────────────
def test_a_paid_invoice_must_choose_refund_or_credit(c):
    inv, _ = _two_line_invoice(c)
    assert _pay(c, inv["id"], 1000).status_code == 200
    chair = _lines(c, inv["id"])["Chair"]
    r = _return(c, inv["id"], [{"invoice_item_id": chair["invoice_item_id"], "quantity": 1}])
    assert r.status_code == 400 and "refund" in r.text


def test_a_cash_refund_takes_the_revenue_and_the_cash_back(c):
    inv, _ = _two_line_invoice(c)
    assert _pay(c, inv["id"], 1000).status_code == 200
    cash0, rev0 = _gl(c, "1000"), _gl(c, "4000")
    table = _lines(c, inv["id"])["Table"]
    r = _return(c, inv["id"], [{"invoice_item_id": table["invoice_item_id"], "quantity": 1}],
                settlement="refund", refund_method="Cash")
    assert r.status_code == 200, r.text
    assert _gl(c, "1000") == cash0 - 600
    assert _gl(c, "4000") == rev0 + 600, "revenue is debited back"
    # The invoice stays settled: the customer owes nothing and is owed nothing.
    assert _balance(c, inv["id"]) == 0


def test_credit_is_held_then_spent_on_the_next_invoice(c):
    inv, cid = _two_line_invoice(c)
    assert _pay(c, inv["id"], 1000).status_code == 200
    chair = _lines(c, inv["id"])["Chair"]
    rid = _return(c, inv["id"], [{"invoice_item_id": chair["invoice_item_id"], "quantity": 2}],
                  settlement="credit").json()["id"]
    assert c.get(f"/api/returns/credit/customer/{cid}").json()["balance"] == 200
    assert _gl(c, "2410") == -200, "a liability: money held for the customer"

    nxt = _invoice(c, cid, [{"name": "Lamp", "quantity": 1, "unit_price": 150,
                             "tax_rate_id": _zero_rate(c)}])
    assert _pay(c, nxt["id"], 300, "Customer credit").status_code == 400, \
        "more than the invoice"
    r = _pay(c, nxt["id"], 150, "Customer credit")
    assert r.status_code == 200, r.text
    assert c.get(f"/api/returns/credit/customer/{cid}").json()["balance"] == 50
    assert _gl(c, "2410") == -50

    # The credit note cannot be voided while its credit is spent...
    assert c.patch(f"/api/returns/sales/{rid}/void", json={}).status_code == 409
    # ...until the payment that spent it is removed, which gives it back.
    pay = next(p for p in c.get(f"/api/invoices/{nxt['id']}/payments").json()
               if p["method"] == "Customer credit")
    assert c.delete(f"/api/invoices/{nxt['id']}/payments/{pay['id']}").status_code == 200
    assert c.get(f"/api/returns/credit/customer/{cid}").json()["balance"] == 200
    assert c.patch(f"/api/returns/sales/{rid}/void", json={}).status_code == 200
    assert c.get(f"/api/returns/credit/customer/{cid}").json()["balance"] == 0
    assert _gl(c, "2410") == 0


def test_a_refund_is_not_counted_as_income(c):
    inv, _ = _two_line_invoice(c)
    assert _pay(c, inv["id"], 1000).status_code == 200
    table = _lines(c, inv["id"])["Table"]
    assert _return(c, inv["id"], [{"invoice_item_id": table["invoice_item_id"],
                                   "quantity": 1}], settlement="refund").status_code == 200
    # Income = 1000 in, 600 back out.
    summary = c.get("/api/finance/summary").json()
    assert round(float(summary["income"]), 2) == 400


# ── Till sales: the goods come back ──────────────────────────────────────────
def _item(c, qty=20, cost=4, price=10):
    r = c.post("/api/inventory/", json={"name": "Mug " + uuid.uuid4().hex[:5],
                                        "quantity": qty, "unit_cost": cost,
                                        "sale_price": price})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _qty(c, item_id):
    return float(c.get(f"/api/inventory/{item_id}").json()["quantity"])


def _sell(c, item, qty, price=10):
    assert c.post("/api/pos/session/open", json={"opening_float": 0}).status_code in (200, 409)
    r = c.post("/api/pos/checkout", json={
        "items": [{"name": "Mug", "inventory_id": item, "quantity": qty, "unit_price": price}],
        "payment_method": "Cash", "amount_tendered": qty * price,
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    return r.json()


def test_a_till_return_puts_the_goods_back_at_their_cost(c):
    item = _item(c)
    sale = _sell(c, item, 5)
    inv_id = sale["invoice_id"]
    assert _qty(c, item) == 15
    stock0, cogs0 = _gl(c, "1200"), _gl(c, "5000")
    line = next(iter(_lines(c, inv_id).values()))
    assert line["can_restock"] and line["unit_cost"] == 4

    r = _return(c, inv_id, [{"invoice_item_id": line["invoice_item_id"], "quantity": 2,
                             "condition": "restock"}], settlement="refund")
    assert r.status_code == 200, r.text
    assert _qty(c, item) == 17
    assert _gl(c, "1200") == stock0 + 8
    assert _gl(c, "5000") == cogs0 - 8

    # A damaged unit comes back but not onto the shelf: its cost is a loss.
    loss0 = _gl(c, "6940")
    r = _return(c, inv_id, [{"invoice_item_id": line["invoice_item_id"], "quantity": 1,
                             "condition": "damaged"}], settlement="refund")
    assert r.status_code == 200, r.text
    assert _qty(c, item) == 17
    assert _gl(c, "6940") == loss0 + 4

    # The till's full return would now refund those lines twice.
    assert c.post(f"/api/pos/sales/{sale['id']}/return",
                  json={"reason": "x"}).status_code == 409


def test_voiding_a_till_return_takes_the_goods_back_out(c):
    item = _item(c)
    sale = _sell(c, item, 5)
    line = next(iter(_lines(c, sale["invoice_id"]).values()))
    rid = _return(c, sale["invoice_id"],
                  [{"invoice_item_id": line["invoice_item_id"], "quantity": 2}],
                  settlement="refund").json()["id"]
    assert _qty(c, item) == 17
    stock = _gl(c, "1200")
    assert c.patch(f"/api/returns/sales/{rid}/void", json={}).status_code == 200
    assert _qty(c, item) == 15
    assert _gl(c, "1200") == stock - 8


def test_an_ordinary_invoice_never_restocks(c):
    """inventory_id on an invoice line is a reference; the sale moved no stock."""
    item = _item(c)
    cid = _client(c)
    inv = _invoice(c, cid, [{"name": "Mug", "inventory_id": item, "quantity": 3,
                             "unit_price": 10, "tax_rate_id": _zero_rate(c)}])
    line = next(iter(_lines(c, inv["id"]).values()))
    assert line["can_restock"] is False
    before = _qty(c, item)
    assert _return(c, inv["id"], [{"invoice_item_id": line["invoice_item_id"], "quantity": 1,
                                   "condition": "restock"}]).status_code == 200
    assert _qty(c, item) == before


# ── Debit notes ──────────────────────────────────────────────────────────────
def _po(c, item, qty, cost, status="Paid", supplier="Acme"):
    r = c.post("/api/purchases/", json={
        "supplier": supplier, "inventory_id": item, "product_name": "Thing",
        "quantity": qty, "unit_cost": cost, "status": status})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _p_lines(c, pid):
    r = c.get(f"/api/returns/purchases/purchase/{pid}/returnable")
    assert r.status_code == 200, r.text
    return r.json()


def test_returning_paid_goods_to_the_supplier_for_a_refund(c):
    item = _item(c, qty=0, cost=0)
    pid = _po(c, item, 10, 7)
    assert _qty(c, item) == 10
    stock0, cash0 = _gl(c, "1200"), _gl(c, "1000")
    info = _p_lines(c, pid)
    line = info["lines"][0]
    r = c.post("/api/returns/purchases", json={
        "purchase_id": pid, "lines": [{"purchase_item_id": line["purchase_item_id"],
                                       "quantity": 3}],
        "settlement": "refund", "refund_method": "Cash"})
    assert r.status_code == 200, r.text
    assert r.json()["return_number"].startswith("DN-")
    assert _qty(c, item) == 7
    assert _gl(c, "1200") == stock0 - 21
    assert _gl(c, "1000") == cash0 + 21
    # The purchase cannot be voided underneath it.
    assert c.patch(f"/api/purchases/{pid}/void", json={"reason": "x"}).status_code == 409


def test_returning_unpaid_goods_reduces_what_is_owed(c):
    item = _item(c, qty=0, cost=0)
    pid = _po(c, item, 10, 5, status="Received")
    pay0 = _gl(c, "2000")
    line = _p_lines(c, pid)["lines"][0]
    r = c.post("/api/returns/purchases", json={
        "purchase_id": pid, "lines": [{"purchase_item_id": line["purchase_item_id"],
                                       "quantity": 4}]})
    assert r.status_code == 200, r.text
    assert _p_lines(c, pid)["outstanding"] == 30
    assert _gl(c, "2000") == pay0 + 20, "the payable comes down"


def test_supplier_credit_pays_the_next_order(c):
    item = _item(c, qty=0, cost=0)
    pid = _po(c, item, 10, 5, supplier="CreditCo")
    line = _p_lines(c, pid)["lines"][0]
    rid = c.post("/api/returns/purchases", json={
        "purchase_id": pid, "lines": [{"purchase_item_id": line["purchase_item_id"],
                                       "quantity": 2}],
        "settlement": "credit"}).json()["id"]
    bal = c.get("/api/returns/credit/supplier", params={"supplier": "CreditCo"}).json()
    assert bal["balance"] == 10

    nxt = _po(c, item, 4, 5, status="Received", supplier="CreditCo")
    pay0 = _gl(c, "2000")
    r = c.post(f"/api/purchases/{nxt}/payments", json={"amount": 10,
                                                        "payment_method": "Supplier credit"})
    assert r.status_code == 200, r.text
    assert _gl(c, "2000") == pay0 + 10
    assert c.get("/api/returns/credit/supplier",
                 params={"supplier": "CreditCo"}).json()["balance"] == 0
    assert c.patch(f"/api/returns/purchases/{rid}/void", json={}).status_code == 409


def test_cannot_return_goods_that_have_been_sold_on(c):
    item = _item(c, qty=0, cost=0)
    pid = _po(c, item, 5, 5)
    _sell(c, item, 4)
    line = _p_lines(c, pid)["lines"][0]
    assert line["returnable_quantity"] == 1
    r = c.post("/api/returns/purchases", json={
        "purchase_id": pid, "lines": [{"purchase_item_id": line["purchase_item_id"],
                                       "quantity": 2}], "settlement": "refund"})
    assert r.status_code == 400


# ── Permission ───────────────────────────────────────────────────────────────
def test_returns_need_their_own_permission(db):
    """Migration 195 gives `returns` to whoever had `invoices`, and nobody else."""
    rows = db.execute(
        "SELECT i.role_id, i.can_view AS iv, r.can_view AS rv "
        "  FROM role_permissions i LEFT JOIN role_permissions r "
        "    ON r.role_id = i.role_id AND r.module = 'returns' "
        " WHERE i.module = 'invoices'").fetchall()
    assert rows
    for row in rows:
        assert row["rv"] == row["iv"]


# ── VAT ──────────────────────────────────────────────────────────────────────
def test_vat_follows_what_the_customer_kept(c):
    """A taxed line returned before payment: the rest of the invoice, when paid,
    carries no VAT for it, and the VAT return takes it off in the return's
    period."""
    c.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    rows = c.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    vat = next(r["id"] for r in rows if float(r.get("rate") or 0) == 11)
    z = _zero_rate(c)
    inv = _invoice(c, _client(c), [
        {"name": "Taxed", "quantity": 1, "unit_price": 100, "tax_rate_id": vat},
        {"name": "Exempt", "quantity": 1, "unit_price": 100, "tax_rate_id": z}])
    assert float(inv["amount"]) == 211
    vat0 = _gl(c, "2100")
    taxed = _lines(c, inv["id"])["Taxed"]
    assert _return(c, inv["id"], [{"invoice_item_id": taxed["invoice_item_id"],
                                   "quantity": 1}]).status_code == 200
    assert _balance(c, inv["id"]) == 100
    assert _pay(c, inv["id"], 100).status_code == 200
    assert _gl(c, "2100") == vat0, "no VAT is collected on the exempt line that was kept"

    rep = c.get("/api/reports/vat").json()
    assert rep["output"]["vat"] == 0
    assert rep["output"]["net"] == 100
