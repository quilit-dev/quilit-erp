"""The terms recorded against a customer have to actually govern something.

A financial ID, a preferred currency and an instalment permission were being
stored, validated and shown in the edit form, and read by nothing at all. A
setting that changes no behaviour is worse than a missing one: the operator
believes they have configured something.

These tests pin what each one now does, and — for the permission — that turning
it on was not a change of policy applied retroactively to customers who never
agreed to it.
"""
import uuid

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _client(c, **kw):
    body = {"name": kw.pop("name", "Terms Co")}
    body.update(kw)
    return c.post("/api/clients/", json=body).json()["id"]


def _invoice(c, cid, amount=300):
    created = c.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": "2026-06-30",
        "items": [{"name": "Item", "quantity": 1, "unit_price": amount}]}).json()
    return created.get("invoice_id") or created.get("id")


def _plan(c, inv, **kw):
    body = {"count": 4, "start_date": "2026-03-01", "frequency": "monthly"}
    body.update(kw)
    return c.post(f"/api/invoices/{inv}/plan", json=body)


# ── The instalment permission ────────────────────────────────────────────────

def test_a_plan_on_one_invoice_is_available_to_everybody(client):
    """Splitting a single document into agreed dates is how anybody sells
    anything of size. The customer setting is about their whole ACCOUNT going
    on terms, which is a different arrangement."""
    cid = _client(client, allow_installments=False)
    inv = _invoice(client, cid)

    assert _plan(client, inv).status_code == 200


def test_an_approved_customer_can_too(client):
    cid = _client(client, allow_installments=True)
    inv = _invoice(client, cid)

    assert _plan(client, inv).status_code == 200


def test_the_till_refuses_an_unapproved_customer_too(client):
    """Two doors onto the same decision. Guarding one is guarding neither."""
    client.post("/api/pos/session/open", json={"opening_float": 0})
    cid = _client(client, name="Counter Ltd", allow_installments=False)
    item = client.post("/api/inventory/", json={
        "name": "Thing", "quantity": 5, "unit_price": 300,
        "unit_cost": 100, "category": "Goods"}).json()["id"]

    r = client.post("/api/pos/checkout", json={
        "client_id": cid,
        "items": [{"name": "Thing", "inventory_id": item,
                   "quantity": 1, "unit_price": 300}],
        "payment_method": "Cash", "currency": "USD", "amount_tendered": 100,
        "idempotency_key": str(uuid.uuid4()),
        "installment_plan": {"down_payment": 100, "count": 4,
                             "frequency": "monthly", "start_date": "2026-04-01"}})

    assert r.status_code == 400
    assert "not approved" in r.text.lower()


def test_a_customer_added_without_saying_is_approved(client):
    """The flag arrived defaulting to off, which is right for a new column and
    wrong as a starting state: before it existed every customer could be put on
    a plan. A name-only entry must not silently be refused credit."""
    cid = client.post("/api/clients/", json={"name": "Quick Entry"}).json()["id"]
    inv = _invoice(client, cid)

    assert _plan(client, inv).status_code == 200


def test_the_migration_approves_customers_that_predate_the_flag(db):
    """Enforcing the flag without setting existing customers to what they
    already were would quietly withdraw instalments from the whole customer
    book. Written against the migration itself, because by the time the API is
    available every row has already been through it."""
    import database

    db.execute("INSERT INTO clients (name, allow_installments, created_at) "
               "VALUES ('Predates The Flag', 0, '2020-01-01')")
    db.execute("DELETE FROM schema_migrations WHERE name='159b_installments_backfill'")
    db.commit()

    database._run_migrations(db, db.cursor())

    row = db.execute("SELECT allow_installments AS a FROM clients "
                     "WHERE name='Predates The Flag'").fetchone()
    assert row["a"] == 1


def test_the_backfill_does_not_undo_a_deliberate_refusal(db):
    """It runs once. A second run would re-approve every customer somebody had
    deliberately stopped."""
    import database

    db.execute("INSERT INTO clients (name, allow_installments, created_at) "
               "VALUES ('Stopped On Purpose', 0, '2026-01-01')")
    db.commit()

    database._run_migrations(db, db.cursor())

    row = db.execute("SELECT allow_installments AS a FROM clients "
                     "WHERE name='Stopped On Purpose'").fetchone()
    assert row["a"] == 0


def test_a_plan_already_agreed_is_not_disturbed_by_withdrawing_permission(client, db):
    """Stopping a customer's credit is a decision about what happens next, not
    a reason to tear up an agreement they are halfway through."""
    cid = _client(client, allow_installments=True)
    inv = _invoice(client, cid)
    _plan(client, inv)

    db.execute("UPDATE clients SET allow_installments=0 WHERE id=?", (cid,))
    db.commit()

    plan = client.get(f"/api/invoices/{inv}/plan").json()
    assert len(plan["installments"]) == 4


# ── The terms travel to where they are needed ────────────────────────────────

def test_the_invoice_carries_the_customers_terms(client, db):
    """The screen that offers a plan has to know whether this customer may have
    one, and what shape they usually agree to."""
    # A customer set to euro is now INVOICED in euro, so the rate has to exist
    # before one can be raised for them. Without it the invoice is refused —
    # deliberately, since a euro invoice has no base value without a rate.
    db.execute("INSERT INTO exchange_rates (currency, rate, effective_date, created_at) "
               "VALUES ('EUR', 0.9, '2020-01-01', '2020-01-01')")
    db.commit()
    cid = _client(client, allow_installments=True, default_installment_count=6,
                  default_installment_frequency="monthly",
                  preferred_currency="EUR")
    inv = _invoice(client, cid)

    body = client.get(f"/api/invoices/{inv}").json()

    assert body["client_allow_installments"] == 1
    assert body["client_installment_count"] == 6
    assert body["client_installment_frequency"] == "monthly"
    assert body["client_preferred_currency"] == "EUR"


def test_the_customer_record_returns_what_was_entered(client):
    """The detail screen cannot show a field the API does not return."""
    cid = _client(client, financial_id="FIN-9", preferred_currency="EUR",
                  vat_status="exempt", allow_installments=True,
                  default_installment_count=3,
                  default_installment_frequency="quarterly")

    body = client.get(f"/api/clients/{cid}").json()

    assert body["financial_id"] == "FIN-9"
    assert body["preferred_currency"] == "EUR"
    assert body["vat_status"] == "exempt"
    assert body["default_installment_count"] == 3
    assert body["default_installment_frequency"] == "quarterly"
