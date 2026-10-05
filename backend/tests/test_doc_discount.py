"""A discount on a whole invoice or quotation: "10% off" or "$100 off".

Taken off BEFORE VAT, spread across the lines by net, each line's share stored
on the line so the VAT, the ledger and every report read the discounted figure.
"""
import uuid

import pytest

import doc_discount

pytestmark = pytest.mark.critical


# ── the arithmetic ───────────────────────────────────────────────────────────
def test_percent_and_amount():
    assert doc_discount.total_for(1000, "percent", 10) == 100
    assert doc_discount.total_for(1000, "amount", 100) == 100
    # A fixed amount bigger than the document stops at the document.
    assert doc_discount.total_for(1000, "amount", 1500) == 1000
    # Nothing, or nonsense, takes nothing off.
    assert doc_discount.total_for(1000, None, 50) == 0
    assert doc_discount.total_for(1000, "percent", -5) == 0
    assert doc_discount.total_for(1000, "bogus", 5) == 0
    assert doc_discount.normalise("percent", 150) == ("percent", 100.0)


def test_shares_follow_the_lines_and_add_up_to_the_cent():
    shares = doc_discount.allocate([600, 300, 100], 100)
    assert shares == [60, 30, 10]
    odd = doc_discount.allocate([1, 1, 1], 1)          # a third of a dollar each
    assert round(sum(odd), 2) == 1.0
    assert doc_discount.allocate([50, 0], 80) == [50, 0], "no line goes below zero"


# ── through the API ──────────────────────────────────────────────────────────
@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Discount Co " + uuid.uuid4().hex[:4]}).json()["id"]


def _rate(client, pct):
    client.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    rows = client.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    if pct == 0:
        return next(r["id"] for r in rows if r.get("tax_type") == "zero")
    return next(r["id"] for r in rows if float(r.get("rate") or 0) == pct)


def _invoice(client, acme, items, **disc):
    r = client.post("/api/invoices/", json={"client_id": acme, "items": items, **disc})
    assert r.status_code == 200, r.text
    iid = r.json().get("id") or r.json().get("invoice_id")
    return client.get(f"/api/invoices/{iid}").json()


def test_ten_percent_off_a_thousand_dollar_invoice_without_vat(client, acme):
    zero = _rate(client, 0)
    inv = _invoice(client, acme, [{"name": "Work", "quantity": 1, "unit_price": 1000,
                                   "tax_rate_id": zero}],
                   discount_type="percent", discount_value=10)
    assert float(inv["discount_total"]) == pytest.approx(100)
    assert float(inv["subtotal"]) == pytest.approx(900)
    assert float(inv["amount"]) == pytest.approx(900)
    assert inv["discount_type"] == "percent" and float(inv["discount_value"]) == 10


def test_a_fixed_amount_off_and_vat_on_what_is_left(client, acme):
    vat = _rate(client, 11)
    inv = _invoice(client, acme, [{"name": "Work", "quantity": 1, "unit_price": 1000,
                                   "tax_rate_id": vat}],
                   discount_type="amount", discount_value=100)
    assert float(inv["subtotal"]) == pytest.approx(900)
    assert float(inv["tax_total"]) == pytest.approx(99), "VAT is on the discounted figure"
    assert float(inv["amount"]) == pytest.approx(999)


def test_lines_at_different_rates_are_each_taxed_on_their_share(client, acme, db):
    vat, zero = _rate(client, 11), _rate(client, 0)
    inv = _invoice(client, acme, [
        {"name": "Taxed",  "quantity": 1, "unit_price": 600, "tax_rate_id": vat},
        {"name": "Exempt", "quantity": 1, "unit_price": 400, "tax_rate_id": zero},
    ], discount_type="percent", discount_value=10)
    lines = {r["name"]: r for r in db.execute(
        "SELECT name, doc_discount, tax_amount FROM invoice_items WHERE invoice_id=?",
        (inv["id"],)).fetchall()}
    assert float(lines["Taxed"]["doc_discount"]) == pytest.approx(60)
    assert float(lines["Exempt"]["doc_discount"]) == pytest.approx(40)
    assert float(lines["Taxed"]["tax_amount"]) == pytest.approx(59.40)     # 11% of 540
    assert float(inv["amount"]) == pytest.approx(900 + 59.40)


def test_the_ledger_earns_the_discounted_revenue(client, acme, db):
    zero = _rate(client, 0)
    inv = _invoice(client, acme, [{"name": "Work", "quantity": 1, "unit_price": 1000,
                                   "tax_rate_id": zero}],
                   discount_type="percent", discount_value=10)
    r = client.post(f"/api/invoices/{inv['id']}/payments", json={
        "amount": 900, "currency": "USD", "method": "Cash",
        "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    credited = db.execute(
        "SELECT COALESCE(SUM(l.credit),0) c FROM journal_entry_lines l "
        "  JOIN journal_entries e ON e.id = l.journal_entry_id "
        "  JOIN chart_of_accounts a ON a.id = l.account_id "
        " WHERE e.source_type='invoice_payment' AND a.type='Income'").fetchone()["c"]
    assert float(credited) == pytest.approx(900)


def test_editing_an_invoice_can_change_or_remove_the_discount(client, acme):
    zero = _rate(client, 0)
    inv = _invoice(client, acme, [{"name": "Work", "quantity": 1, "unit_price": 1000,
                                   "tax_rate_id": zero}],
                   discount_type="percent", discount_value=10)
    body = {"client_id": acme, "version": inv["version"],
            "items": [{"name": "Work", "quantity": 1, "unit_price": 1000, "tax_rate_id": zero}],
            "discount_type": "amount", "discount_value": 250}
    assert client.put(f"/api/invoices/{inv['id']}", json=body).status_code == 200
    after = client.get(f"/api/invoices/{inv['id']}").json()
    assert float(after["amount"]) == pytest.approx(750)
    body.update(version=after["version"], discount_type=None, discount_value=None)
    assert client.put(f"/api/invoices/{inv['id']}", json=body).status_code == 200
    cleared = client.get(f"/api/invoices/{inv['id']}").json()
    assert float(cleared["amount"]) == pytest.approx(1000)
    assert float(cleared["discount_total"] or 0) == 0


def test_a_discount_bigger_than_the_invoice_is_refused_as_a_zero_invoice(client, acme):
    zero = _rate(client, 0)
    r = client.post("/api/invoices/", json={
        "client_id": acme, "items": [{"name": "W", "quantity": 1, "unit_price": 100,
                                      "tax_rate_id": zero}],
        "discount_type": "amount", "discount_value": 500})
    assert r.status_code == 400, "a free invoice is not raised by accident"


def test_an_invoice_without_a_discount_is_exactly_as_before(client, acme, db):
    vat = _rate(client, 11)
    inv = _invoice(client, acme, [{"name": "Work", "quantity": 2, "unit_price": 50,
                                   "tax_rate_id": vat}])
    assert float(inv["amount"]) == pytest.approx(111)
    assert float(inv.get("discount_total") or 0) == 0
    assert inv.get("discount_type") is None


def test_a_quotation_takes_the_discount_and_carries_it_to_the_invoice(client, acme):
    zero = _rate(client, 0)
    r = client.post("/api/quotations/", json={
        "client_id": acme,
        "items": [{"name": "Work", "quantity": 1, "unit_price": 1000, "tax_rate_id": zero}],
        "discount_type": "percent", "discount_value": 15})
    assert r.status_code in (200, 201), r.text
    qid = r.json()["id"]
    q = client.get(f"/api/quotations/{qid}").json()
    assert float(q["discount_total"]) == pytest.approx(150)
    assert float(q["total"]) == pytest.approx(850)

    conv = client.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert conv.status_code == 200, conv.text
    inv = client.get(f"/api/invoices/{conv.json()['invoice_id']}").json()
    assert inv["discount_type"] == "percent" and float(inv["discount_total"]) == pytest.approx(150)
    assert float(inv["amount"]) == pytest.approx(850)


def test_a_fixed_discount_on_a_foreign_currency_invoice_is_in_that_currency(client, acme, db):
    zero = _rate(client, 0)
    r = client.post("/api/invoices/", json={
        "client_id": acme, "currency": "EUR", "exchange_rate": 0.9,
        "items": [{"name": "Work", "quantity": 1, "unit_price": 900, "tax_rate_id": zero}],
        "discount_type": "amount", "discount_value": 90})
    assert r.status_code == 200, r.text
    iid = r.json().get("id") or r.json().get("invoice_id")
    row = db.execute("SELECT * FROM invoices WHERE id=?", (iid,)).fetchone()
    assert float(row["txn_discount_total"]) == pytest.approx(90)        # EUR
    assert float(row["txn_amount"]) == pytest.approx(810)
    # The base side is the same discount, converted.
    assert float(row["discount_total"]) == pytest.approx(float(row["amount"]) / 810 * 90, abs=0.02)
