"""
Concurrency tests for sensitive actions — approvals and finance.

SQLite serialises writers, so these probe for *logical* races: double-resolution
of an approval, and double-recording of an idempotent payment.
"""
import concurrent.futures as cf
import uuid
import pytest

from test_workflow_approvals import seed_request, status_of


def _parallel(callables):
    """Run zero-arg callables in parallel; return results in submission order."""
    with cf.ThreadPoolExecutor(max_workers=len(callables)) as ex:
        futures = [ex.submit(fn) for fn in callables]
        return [f.result() for f in futures]


@pytest.mark.concurrency
def test_concurrent_approval_does_not_double_resolve(db, make_client):
    """
    Two approvers hit the same single-step request at once. The request must
    end up resolved exactly once — never 500, never resolved twice.
    """
    req_id = seed_request(db, steps=["Manager"])
    super_c = make_client("superadmin")
    mgr_c   = make_client("Manager")

    results = _parallel([
        lambda: super_c.post(f"/api/approval-requests/{req_id}/approve", json={}),
        lambda: mgr_c.post(f"/api/approval-requests/{req_id}/approve", json={}),
    ])
    codes = [r.status_code for r in results]

    assert all(c < 500 for c in codes), f"concurrent approve crashed: {codes}"
    assert status_of(db, req_id) == "approved", f"final status not 'approved': {codes}"

    ok = sum(1 for c in codes if c == 200)
    assert ok == 1, (
        f"DOUBLE-RESOLUTION RACE: {ok} concurrent approvals both succeeded "
        f"(codes={codes}); the second should have been refused")


@pytest.mark.concurrency
def test_idempotent_payment_is_recorded_once(db, make_client):
    """Two concurrent payments with the SAME idempotency key -> one row only."""
    c = make_client("superadmin")
    cr = c.post("/api/clients/", json={"name": "Concurrency Co"})
    if cr.status_code not in (200, 201):
        pytest.skip(f"client create failed ({cr.status_code})")
    client_id = cr.json().get("id")

    inv = c.post("/api/invoices/", json={
        "client_id": client_id, "project_id": None,
        "items": [{"name": "Service", "quantity": 1, "unit_price": 1000}],
    })
    if inv.status_code not in (200, 201):
        pytest.skip(f"invoice create failed ({inv.status_code}): {inv.text[:160]}")
    inv_id = inv.json().get("id")

    key = str(uuid.uuid4())
    payment = {"amount": 100, "method": "Cash", "idempotency_key": key}
    c1, c2 = make_client("superadmin"), make_client("superadmin")
    results = _parallel([
        lambda: c1.post(f"/api/invoices/{inv_id}/payments", json=payment),
        lambda: c2.post(f"/api/invoices/{inv_id}/payments", json=payment),
    ])
    codes = [r.status_code for r in results]
    assert all(s < 500 for s in codes), f"concurrent payment crashed: {codes}"

    rows = db.execute(
        "SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id=? AND idempotency_key=?",
        (inv_id, key),
    ).fetchone()["n"]
    assert rows == 1, (
        f"IDEMPOTENCY FAILURE: {rows} payment rows written for one idempotency key "
        f"(codes={codes})")


@pytest.mark.concurrency
def test_parallel_distinct_payments_are_all_recorded(db, make_client):
    """Five distinct concurrent payments must all land — no lost writes under contention."""
    c = make_client("superadmin")
    cr = c.post("/api/clients/", json={"name": "Parallel Pay Co"})
    if cr.status_code not in (200, 201):
        pytest.skip(f"client create failed ({cr.status_code})")
    inv = c.post("/api/invoices/", json={
        "client_id": cr.json().get("id"), "project_id": None,
        "items": [{"name": "Big job", "quantity": 1, "unit_price": 10000}],
    })
    if inv.status_code not in (200, 201):
        pytest.skip(f"invoice create failed ({inv.status_code})")
    inv_id = inv.json().get("id")

    clients = [make_client("superadmin") for _ in range(5)]
    results = _parallel([
        (lambda cl=cl, i=i: cl.post(f"/api/invoices/{inv_id}/payments", json={
            "amount": 100, "method": "Cash", "idempotency_key": str(uuid.uuid4()),
        }))
        for i, cl in enumerate(clients)
    ])
    codes = [r.status_code for r in results]
    assert all(s < 500 for s in codes), f"a concurrent payment crashed: {codes}"

    total = db.execute(
        "SELECT COALESCE(SUM(amount),0) AS s FROM invoice_payments WHERE invoice_id=?", (inv_id,)
    ).fetchone()["s"]
    accepted = sum(1 for s in codes if s in (200, 201))
    assert total == accepted * 100, (
        f"LOST WRITE: {accepted} payments accepted but recorded total is {total}")
