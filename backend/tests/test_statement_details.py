"""A statement of account carries what each invoice was for: its lines."""
import uuid

import pytest

pytestmark = pytest.mark.critical


@pytest.fixture
def c(make_client):
    return make_client("superadmin")


def _zero(c):
    rows = c.get("/api/tax-rates/").json()
    rows = rows if isinstance(rows, list) else rows.get("rows", [])
    return next(r["id"] for r in rows if r.get("tax_type") == "zero")


def test_each_invoice_lists_its_items_and_prices(c):
    cid = c.post("/api/clients/", json={"name": "Stmt " + uuid.uuid4().hex[:4]}).json()["id"]
    z = _zero(c)
    r = c.post("/api/invoices/", json={"client_id": cid, "items": [
        {"name": "Office chair", "quantity": 2, "unit_price": 100, "tax_rate_id": z},
        {"name": "Delivery", "quantity": 1, "unit_price": 20, "tax_rate_id": z}]})
    assert r.status_code == 200, r.text
    stmt = c.get(f"/api/clients/{cid}/statement").json()
    inv = next(m for m in stmt["movements"] if m["type"] == "invoice")
    assert [l["name"] for l in inv["lines"]] == ["Office chair", "Delivery"]
    chair = inv["lines"][0]
    assert chair["quantity"] == 2 and chair["unit_price"] == 100 and chair["net"] == 200
    assert sum(l["net"] + l["tax"] for l in inv["lines"]) == pytest.approx(inv["charged"])


def test_a_whole_invoice_discount_shows_on_the_lines(c):
    cid = c.post("/api/clients/", json={"name": "Stmt " + uuid.uuid4().hex[:4]}).json()["id"]
    r = c.post("/api/invoices/", json={"client_id": cid, "discount_type": "percent",
                                       "discount_value": 10, "items": [
        {"name": "Desk", "quantity": 1, "unit_price": 300, "tax_rate_id": _zero(c)}]})
    assert r.status_code == 200, r.text
    inv = next(m for m in c.get(f"/api/clients/{cid}/statement").json()["movements"]
               if m["type"] == "invoice")
    assert inv["lines"][0]["discount"] == 30 and inv["lines"][0]["net"] == 270
    assert inv["charged"] == 270


def test_payments_carry_no_lines(c):
    cid = c.post("/api/clients/", json={"name": "Stmt " + uuid.uuid4().hex[:4]}).json()["id"]
    iid = c.post("/api/invoices/", json={"client_id": cid, "items": [
        {"name": "Fan", "quantity": 1, "unit_price": 50, "tax_rate_id": _zero(c)}]}).json()["id"]
    c.post(f"/api/invoices/{iid}/payments", json={"amount": 50, "method": "Cash",
                                                  "idempotency_key": str(uuid.uuid4())})
    pay = next(m for m in c.get(f"/api/clients/{cid}/statement").json()["movements"]
               if m["type"] == "payment")
    assert "lines" not in pay
