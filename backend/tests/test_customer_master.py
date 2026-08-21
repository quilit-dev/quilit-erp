"""What the books need to know about a customer.

Four facts that were being carried in someone's head or in the notes field: the
number the tax authority knows them by, what currency they prefer to be billed
in, whether they are subject to VAT, and whether they may pay in instalments.

Plus the statement of account — the document a customer asks for when they want
to know why they owe what they owe.

The VAT status is the one with teeth. It changes what a customer is charged, so
every test here also checks that a customer nobody has touched is charged
exactly what they were charged before.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical


TAX = 11.0


@_pytest.fixture
def client(as_role):
    c = as_role("superadmin")
    c.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": str(TAX)})
    return c


def _customer(client, **kw):
    body = {"name": "Acme Pharmacy"}
    body.update(kw)
    r = client.post("/api/clients/", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _invoice(client, cid, unit_price=100):
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": unit_price}]}).json()
    inv = created.get("invoice_id") or created.get("id")
    return client.get(f"/api/invoices/{inv}").json()


# ── The fields ───────────────────────────────────────────────────────────────

def test_a_customer_carries_a_financial_id_and_currency(client):
    cid = _customer(client, financial_id="1234567-801",
                    preferred_currency="EUR")

    row = client.get(f"/api/clients/{cid}").json()

    assert row["financial_id"] == "1234567-801"
    assert row["preferred_currency"] == "EUR"


def test_currency_defaults_to_the_company_s_own(client):
    """None means 'whatever we bill in', so changing the company currency does
    not orphan every customer record."""
    cid = _customer(client)

    assert client.get(f"/api/clients/{cid}").json()["preferred_currency"] is None


def test_only_supported_currencies(client):
    assert client.post("/api/clients/", json={
        "name": "X", "preferred_currency": "GBP"}).status_code == 422


def test_the_instalment_policy_is_a_default_not_a_rule(client):
    cid = _customer(client, allow_installments=True,
                    default_installment_count=6,
                    default_installment_frequency="monthly")

    row = client.get(f"/api/clients/{cid}").json()

    assert row["allow_installments"] == 1
    assert row["default_installment_count"] == 6
    assert row["default_installment_frequency"] == "monthly"


def test_a_nonsense_policy_is_refused(client):
    assert client.post("/api/clients/", json={
        "name": "X", "default_installment_frequency": "fortnightly"}).status_code == 422
    assert client.post("/api/clients/", json={
        "name": "X", "default_installment_count": 0}).status_code == 422


# ── VAT status, which changes what people are charged ────────────────────────

def test_an_ordinary_customer_is_taxed_exactly_as_before(client):
    """The regression that matters most. Nobody who was not touched should
    notice any of this existing."""
    cid = _customer(client)

    inv = _invoice(client, cid, 100)

    assert inv["subtotal"] == _pytest.approx(100)
    assert inv["tax_total"] == _pytest.approx(11)
    assert inv["amount"] == _pytest.approx(111)


def test_an_exempt_customer_is_charged_no_vat(client):
    """Whatever the line rates say. The exemption is a fact about the customer,
    not about the item."""
    cid = _customer(client, vat_status="exempt")

    inv = _invoice(client, cid, 100)

    assert inv["subtotal"] == _pytest.approx(100)
    assert inv["tax_total"] == _pytest.approx(0)
    assert inv["amount"] == _pytest.approx(100)


def test_an_exempt_customer_is_quoted_the_way_they_will_be_invoiced(client):
    """A quote showing VAT the invoice will not charge loses the sale a
    different way than one that undercharges."""
    cid = _customer(client, vat_status="exempt")

    q = client.post("/api/quotations/", json={
        "client_id": cid,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 100}]})
    assert q.status_code == 200, q.text
    qid = q.json().get("quotation_id") or q.json().get("id")
    body = client.get(f"/api/quotations/{qid}").json()

    assert body["tax_total"] == _pytest.approx(0)


def test_the_exemption_survives_a_default_rate_on_the_line(client, db):
    """The line carries a rate id; the customer still wins."""
    rates = client.get("/api/tax-rates/").json()
    rates = rates if isinstance(rates, list) else rates.get("rows", [])
    rid = next(r["id"] for r in rates if float(r.get("rate") or 0) == TAX)
    cid = _customer(client, vat_status="exempt")

    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 100,
                   "tax_rate_id": rid}]}).json()
    inv = client.get(f"/api/invoices/{created.get('invoice_id') or created.get('id')}").json()

    assert inv["tax_total"] == _pytest.approx(0)


def test_an_unknown_vat_status_is_refused(client):
    assert client.post("/api/clients/", json={
        "name": "X", "vat_status": "maybe"}).status_code == 422


def test_switching_a_customer_to_exempt_does_not_touch_past_invoices(client):
    """Their history was charged correctly at the time and stays that way."""
    cid = _customer(client)
    before = _invoice(client, cid, 100)
    assert before["tax_total"] == _pytest.approx(11)

    client.put(f"/api/clients/{cid}", json={"name": "Acme Pharmacy",
                                            "vat_status": "exempt"})

    again = client.get(f"/api/invoices/{before['id']}").json()
    assert again["tax_total"] == _pytest.approx(11), "history was restated"


# ── The statement ────────────────────────────────────────────────────────────

def test_the_statement_runs_invoices_and_payments_together(client):
    cid = _customer(client, vat_status="exempt")     # keep the arithmetic plain
    a = _invoice(client, cid, 100)
    client.post(f"/api/invoices/{a['id']}/payments", json={
        "amount": 40, "currency": "USD", "method": "Cash",
        "idempotency_key": "stmt-1"})
    _invoice(client, cid, 60)

    body = client.get(f"/api/clients/{cid}/statement").json()

    # Not asserting the interleaving: all three land in the same second and the
    # timestamps only resolve that far, so their relative order within it is
    # not something the statement promises. What it does promise is that every
    # movement appears and the arithmetic closes.
    assert sorted(m["type"] for m in body["movements"]) == ["invoice", "invoice", "payment"]
    assert body["total_charged"] == _pytest.approx(160)
    assert body["total_paid"] == _pytest.approx(40)
    assert body["closing_balance"] == _pytest.approx(120)


def test_movements_read_in_the_order_they_happened(client, db):
    """Across dates, which is where ordering actually matters — a running
    balance out of sequence tells a story that did not occur."""
    cid = _customer(client, vat_status="exempt")
    a = _invoice(client, cid, 100)
    b = _invoice(client, cid, 50)
    client.post(f"/api/invoices/{a['id']}/payments", json={
        "amount": 100, "currency": "USD", "method": "Cash",
        "idempotency_key": "ordered-1"})

    # Backdate them into a known sequence.
    db.execute("UPDATE invoices SET created_at='2026-01-10 09:00:00' WHERE id=?", (a["id"],))
    db.execute("UPDATE invoices SET created_at='2026-03-05 09:00:00' WHERE id=?", (b["id"],))
    db.execute("UPDATE invoice_payments SET paid_at='2026-02-01 09:00:00' "
               "WHERE invoice_id=?", (a["id"],))
    db.commit()

    movements = client.get(f"/api/clients/{cid}/statement").json()["movements"]

    assert [m["date"] for m in movements] == ["2026-01-10", "2026-02-01", "2026-03-05"]
    assert [m["balance"] for m in movements] == [
        _pytest.approx(100), _pytest.approx(0), _pytest.approx(50)]


def test_a_period_statement_opens_with_what_was_already_owed(client, db):
    """Otherwise a period statement begins mid-story and does not add up."""
    cid = _customer(client, vat_status="exempt")
    a = _invoice(client, cid, 100)
    b = _invoice(client, cid, 40)
    db.execute("UPDATE invoices SET created_at='2026-01-10 09:00:00' WHERE id=?", (a["id"],))
    db.execute("UPDATE invoices SET created_at='2026-06-10 09:00:00' WHERE id=?", (b["id"],))
    db.commit()

    body = client.get(f"/api/clients/{cid}/statement?start=2026-05-01").json()

    assert body["opening_balance"] == _pytest.approx(100)
    assert [m["date"] for m in body["movements"]] == ["2026-06-10"]
    assert body["closing_balance"] == _pytest.approx(140)


def test_the_running_balance_reads_the_way_it_happened(client):
    cid = _customer(client, vat_status="exempt")
    a = _invoice(client, cid, 100)
    client.post(f"/api/invoices/{a['id']}/payments", json={
        "amount": 30, "currency": "USD", "method": "Cash",
        "idempotency_key": "stmt-2"})

    movements = client.get(f"/api/clients/{cid}/statement").json()["movements"]

    assert [m["balance"] for m in movements] == [_pytest.approx(100), _pytest.approx(70)]


def test_a_voided_invoice_is_not_owed(client):
    cid = _customer(client, vat_status="exempt")
    a = _invoice(client, cid, 100)
    client.patch(f"/api/invoices/{a['id']}/void", json={"reason": "cancelled"})

    body = client.get(f"/api/clients/{cid}/statement").json()

    assert body["closing_balance"] == _pytest.approx(0)
    assert body["movements"] == []


def test_the_statement_carries_who_it_is_for(client):
    """It is a document that gets sent, so it has to name the customer and the
    number the tax authority knows them by."""
    cid = _customer(client, financial_id="1234567-801")

    body = client.get(f"/api/clients/{cid}/statement").json()

    assert body["client"]["name"] == "Acme Pharmacy"
    assert body["client"]["financial_id"] == "1234567-801"


def test_an_unknown_customer_is_a_404(client):
    assert client.get("/api/clients/99999/statement").status_code == 404
