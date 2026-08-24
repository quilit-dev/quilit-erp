"""The cross-module scan the insight panel reads.

It used to see only what the Finance page had already fetched, so it could
talk about income and expenses and nothing else. The things a business
actually comes unstuck on — stock nobody has moved, a repair nobody invoiced,
one customer who is most of the revenue — were in tables it never opened.

Two properties matter more than any single figure here. It must never invent
one: a module the caller cannot see is absent from the response, not zero,
because zero is a claim about the business. And it must never fall over: this
sits on a page load, and a tenant missing a table for a module it has not
licensed has to degrade to no signal.
"""
import uuid
from datetime import date, timedelta

import pytest as _pytest

pytestmark = _pytest.mark.critical


@_pytest.fixture
def client(as_role):
    return as_role("superadmin")


def _scan(c, **params):
    r = c.get("/api/insights/", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _client_id(c, name="Insight Co"):
    return c.post("/api/clients/", json={"name": name}).json()["id"]


def _item(c, **kw):
    body = {"name": "Widget", "quantity": 10, "sale_price": 50,
            "unit_cost": 20, "category": "Goods"}
    body.update(kw)
    return c.post("/api/inventory/", json=body).json()["id"]


def _invoice(c, cid, amount=500, **kw):
    body = {"client_id": cid, "amount": 0,
            "due_date": kw.pop("due_date", str(date.today() + timedelta(days=30))),
            "items": [{"name": "Goods", "quantity": 1, "unit_price": amount}]}
    body.update(kw)
    r = c.post("/api/invoices/", json=body).json()
    return r.get("invoice_id") or r.get("id")


def _ago(days):
    return (date.today() - timedelta(days=days)).isoformat()


# ── It reaches every module ──────────────────────────────────────────────────

def test_the_scan_covers_every_module_the_caller_can_see(client):
    body = _scan(client)

    for block in ("inventory", "sales", "receivables", "quotations",
                  "purchases", "service", "projects", "crm", "hr",
                  "manufacturing"):
        assert block in body, f"{block} missing from the scan"


def test_it_says_what_it_read(client):
    """A panel claiming to have analysed the business has to be able to say
    how much of it, or the claim is worth less than saying nothing."""
    _client_id(client)
    _item(client)

    scan = _scan(client)["scanned"]

    assert scan["modules"] >= 1
    assert scan["records"] >= 1
    assert scan["from"] and scan["to"]


def test_a_module_the_caller_cannot_see_is_absent_not_zero(as_role):
    """Zero is a statement about the business. Absent is a statement about
    the reader, and only one of them is true here."""
    body = as_role("Sales").get("/api/insights/").json()

    assert "hr" not in body
    assert "sales" in body        # a sales rep does see their own module


def test_it_needs_a_login(app):
    from fastapi.testclient import TestClient
    with TestClient(app) as anon:
        assert anon.get("/api/insights/").status_code in (401, 403)


# ── Inventory ────────────────────────────────────────────────────────────────

def test_stock_sitting_still_is_measured_by_value_not_count(client):
    """Twenty cheap items gathering dust is not the same problem as one
    expensive one, and only the value tells them apart."""
    _item(client, name="Slow mover", quantity=10, unit_cost=100)

    inv = _scan(client)["inventory"]

    assert inv["dead_value"] == _pytest.approx(1000, abs=0.01)
    assert inv["dead_count"] == 1
    assert inv["dead_share"] is not None


def test_an_item_that_sold_recently_is_not_dead_stock(client):
    cid = _client_id(client)
    item = _item(client, name="Fast mover", quantity=10, unit_cost=100)
    client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0, "due_date": str(date.today()),
        "items": [{"name": "Fast mover", "inventory_id": item,
                   "quantity": 1, "unit_price": 150}]})

    inv = _scan(client)["inventory"]

    assert inv["dead_count"] == 0


def test_items_below_their_reorder_point_are_counted(client):
    _item(client, name="Nearly out", quantity=2, min_stock=10)

    inv = _scan(client)["inventory"]

    assert inv["below_reorder"] == 1
    assert inv["below_reorder_top"] == "Nearly out"


def test_an_item_priced_under_its_cost_is_found(client):
    """Every sale of one of these loses money, and nothing else in the system
    says so."""
    _item(client, name="Loss leader", unit_cost=80, sale_price=50)

    inv = _scan(client)["inventory"]

    assert inv["under_cost"] == 1
    assert inv["under_cost_top"] == "Loss leader"


# ── Sales and receivables ────────────────────────────────────────────────────

def test_one_customer_carrying_the_revenue_is_named(client):
    """Concentration is a risk nobody notices while the invoices are being
    paid."""
    big = _client_id(client, "Big Co")
    small = _client_id(client, "Small Co")
    _invoice(client, big, 9000)
    _invoice(client, small, 1000)

    sales = _scan(client, start=_ago(30))["sales"]

    assert sales["top_client"] == "Big Co"
    assert sales["top_client_share"] == _pytest.approx(90, abs=1)


def test_days_sales_outstanding_is_reported(client):
    """The one receivables figure that is comparable month to month."""
    cid = _client_id(client)
    _invoice(client, cid, 3000)

    ar = _scan(client, start=_ago(30))["receivables"]

    assert ar["outstanding"] == _pytest.approx(3000, abs=0.01)
    assert ar["dso"] is not None and ar["dso"] > 0


def test_nothing_billed_means_no_dso_rather_than_a_wrong_one(client):
    """Dividing by a period that billed nothing gives infinity, which would
    render as a number somebody might act on."""
    ar = _scan(client, start=_ago(30))["receivables"]

    assert ar["dso"] is None


# ── Work that was done and never billed ──────────────────────────────────────

def test_a_completed_service_job_with_no_invoice_is_surfaced(client, db):
    """Revenue already earned, sitting idle because nobody raised the
    paperwork. It is the most directly convertible number in the scan.

    Completion normally raises the invoice itself; this is the tenant that has
    that turned off, and the job whose auto-invoice was refused by an approval
    policy or a credit limit — where the work quietly stays unbilled."""
    db.execute("INSERT OR REPLACE INTO settings (key, value) "
               "VALUES ('service_auto_invoice', '0')")
    db.commit()
    cid = _client_id(client)
    eq = client.post("/api/service/equipment",
                     json={"client_id": cid, "name": "Machine"}).json()["id"]
    job = client.post("/api/service/jobs", json={
        "client_id": cid, "equipment_id": eq, "job_type": "Repair",
        "items": [{"line_type": "charge", "name": "Labour",
                   "quantity": 1, "unit_price": 250}]}).json()["id"]
    client.post(f"/api/service/jobs/{job}/start", json={})
    client.post(f"/api/service/jobs/{job}/complete", json={})

    svc = _scan(client)["service"]

    assert svc["uninvoiced"] == 1
    assert svc["uninvoiced_value"] == _pytest.approx(250, abs=0.01)


# ── Purchases ────────────────────────────────────────────────────────────────

def test_an_order_never_received_is_found(client, db):
    """Either the goods never came or somebody forgot to receive them. The
    books are wrong either way, and nothing else chases it."""
    item = _item(client)
    po = client.post("/api/purchases/", json={
        "supplier": "Slow Supplier", "inventory_id": item,
        "product_name": "Widget", "quantity": 5, "unit_cost": 20,
        "status": "Ordered"}).json()["id"]
    db.execute("UPDATE purchases SET ordered_at=? WHERE id=?", (_ago(60), po))
    db.commit()

    pur = _scan(client, start=_ago(90))["purchases"]

    assert pur["stuck_orders"] == 1
    assert pur["stuck_value"] == _pytest.approx(100, abs=0.01)


def test_a_recent_order_is_not_chased(client):
    item = _item(client)
    client.post("/api/purchases/", json={
        "supplier": "Fine Supplier", "inventory_id": item,
        "product_name": "Widget", "quantity": 5, "unit_cost": 20,
        "status": "Ordered"})

    assert _scan(client, start=_ago(90))["purchases"]["stuck_orders"] == 0


# ── It does not fall over ────────────────────────────────────────────────────

def test_an_empty_business_scans_cleanly(client):
    """Every ratio divides by something that can be zero on day one."""
    body = _scan(client)

    assert body["scanned"]["records"] >= 0
    assert body["sales"]["discount_share"] is None
    assert body["quotations"]["win_rate"] is None


def test_a_missing_table_degrades_to_no_signal(client, db, monkeypatch):
    """A tenant provisioned before a module existed must lose that module's
    signals, not the whole panel."""
    import insights

    def boom(*a, **kw):
        raise Exception("no such table")

    monkeypatch.setattr(insights, "_rows", lambda *a, **kw: [])
    monkeypatch.setattr(insights, "_one", lambda *a, **kw: 0)

    r = client.get("/api/insights/")

    assert r.status_code == 200


def test_the_scan_writes_nothing(client, db):
    before = db.execute("SELECT COUNT(*) AS n FROM audit_log").fetchone()["n"]

    _scan(client)

    assert db.execute("SELECT COUNT(*) AS n FROM audit_log").fetchone()["n"] == before
