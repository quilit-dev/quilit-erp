"""Invoice-void regression coverage.

Voiding must succeed for unpaid, partially-paid, fully-paid, body-less and
project-linked invoices. The project-linked case guards against a 500
(IndexError) caused by the void handler reading a non-existent
`invoices.total` column while adjusting projects.actual_cost — an adjustment
that was itself wrong: invoices are project revenue and never feed
actual_cost (only expenses do, see routers/finance.py), so the block was
removed outright.
"""
import uuid


def _key():
    return str(uuid.uuid4())


def test_void_unpaid(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "V1"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl, "items": [{"name": "A", "quantity": 1, "unit_price": 100}]}).json()["id"]
    r = c.patch(f"/api/invoices/{iid}/void", json={"reason": "t"})
    assert r.status_code == 200, f"{r.status_code}: {r.text}"


def test_void_partially_paid(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "V2"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl, "items": [{"name": "A", "quantity": 1, "unit_price": 100}]}).json()["id"]
    c.post(f"/api/invoices/{iid}/payments",
           json={"amount": 40, "method": "Cash", "idempotency_key": _key()})
    r = c.patch(f"/api/invoices/{iid}/void", json={"reason": "t"})
    assert r.status_code == 200, f"{r.status_code}: {r.text}"


def test_void_fully_paid(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "V3"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl, "items": [{"name": "A", "quantity": 1, "unit_price": 100}]}).json()["id"]
    c.post(f"/api/invoices/{iid}/payments",
           json={"amount": 100, "method": "Bank", "idempotency_key": _key()})
    r = c.patch(f"/api/invoices/{iid}/void", json={"reason": "t"})
    assert r.status_code == 200, f"{r.status_code}: {r.text}"


def test_void_no_reason_body(make_client):
    """The UI might send no/empty body."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "V4"}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl, "items": [{"name": "A", "quantity": 1, "unit_price": 100}]}).json()["id"]
    r = c.patch(f"/api/invoices/{iid}/void", json={})
    assert r.status_code == 200, f"{r.status_code}: {r.text}"


def test_void_project_invoice(make_client, db):
    """Regression: voiding a project-linked invoice must not 500, and must
    leave projects.actual_cost untouched (invoices never fed it)."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "V5"}).json()["id"]
    pid = c.post("/api/projects/", json={
        "name": "VP", "client_id": cl, "status": "active",
        "actual_cost": 750}).json()["id"]
    iid = c.post("/api/invoices/", json={
        "client_id": cl, "project_id": pid,
        "items": [{"name": "A", "quantity": 1, "unit_price": 100}]}).json()["id"]
    r = c.patch(f"/api/invoices/{iid}/void", json={"reason": "t"})
    assert r.status_code == 200, f"{r.status_code}: {r.text}"

    cost = db.execute("SELECT actual_cost FROM projects WHERE id=?",
                      (pid,)).fetchone()["actual_cost"]
    assert float(cost or 0) == 750   # untouched by the void
