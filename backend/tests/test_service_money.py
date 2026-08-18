"""What a service job does to stock and to the ledger.

These are the invariants that can quietly corrupt books, so they live apart from
the CRUD tests and are written to fail loudly:

  * parts leave stock exactly once, and only if ALL of them can
  * the cost recognised equals the cost the stock was valued at
  * completion does NOT recognise revenue — that follows the payment
  * a cost posted and stock removed never disagree
"""
import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Acme Ltd"}).json()["id"]


def _item(client, name, qty, cost, price):
    return client.post("/api/inventory/", json={
        "name": name, "quantity": qty, "unit_cost": cost, "sale_price": price,
    }).json()["id"]


def _job(client, acme, items, expect=200, **extra):
    """Recording a service consumes its parts and posts their cost in the same
    call — there is no separate completion step to trigger it."""
    body = {"client_id": acme, "job_type": "Repair", "items": items}
    body.update(extra)
    r = client.post("/api/service/jobs", json=body)
    assert r.status_code == expect, r.text
    return r.json()


def _part(inv_id, name, qty, price):
    return {"line_type": "part", "inventory_id": inv_id, "name": name,
            "quantity": qty, "unit_price": price}


def _charge(name, price):
    return {"line_type": "charge", "name": name, "quantity": 1, "unit_price": price}


def _stock(client, inv_id):
    return client.get(f"/api/inventory/{inv_id}").json()["quantity"]


def _balance(client, code):
    """Net movement on one account (debit positive), from the trial balance."""
    body = client.get("/api/accounting/trial-balance").json()
    rows = body.get("rows") if isinstance(body, dict) else body
    for r in rows or []:
        if str(r.get("code")) == code:
            return float(r.get("debit") or 0) - float(r.get("credit") or 0)
    return 0.0


# ── Consumption ──────────────────────────────────────────────────────────────

def test_completing_a_job_takes_the_parts_out_of_stock(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [_part(belt, "Belt", 3, 12)])

    assert _stock(client, belt) == pytest.approx(7)


def test_a_labour_only_job_consumes_nothing(client, acme):
    job = _job(client, acme, [_charge("Labour", 150)])

    assert job["parts_cost"] == 0


def test_the_cost_recognised_is_the_cost_of_the_parts(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [_part(belt, "Belt", 3, 12), _charge("Labour", 100)])

    cogs = job["parts_cost"]

    # 3 units at the 4.00 COST, never the 12.00 sale price.
    assert cogs == pytest.approx(12)


def test_each_record_consumes_once(client, acme):
    """Recording is the only thing that moves stock, and it happens once per
    service. Two services for the same work are two consumptions — which is
    correct, and why cancelling exists to undo one."""
    belt = _item(client, "Belt", 10, 4, 12)

    _job(client, acme, [_part(belt, "Belt", 3, 12)])

    assert _stock(client, belt) == pytest.approx(7)


def test_a_service_it_cannot_stock_is_refused_whole(client, acme):
    """All or nothing. Consuming the first line and failing on the second would
    leave stock gone for a service that was never recorded."""
    plenty = _item(client, "Belt", 10, 4, 12)
    scarce = _item(client, "Bearing", 1, 20, 60)

    r = client.post("/api/service/jobs", json={
        "client_id": acme, "job_type": "Repair",
        "items": [_part(plenty, "Belt", 2, 12), _part(scarce, "Bearing", 5, 60)]})

    assert r.status_code == 400
    assert "not enough stock" in r.json()["detail"].lower()
    assert _stock(client, plenty) == pytest.approx(10), "the first line was consumed"
    assert _stock(client, scarce) == pytest.approx(1)
    # And no half-written service left behind.
    assert client.get("/api/service/jobs").json() == []


def test_two_lines_of_the_same_part_are_checked_together(client, acme):
    """Checking each line against on-hand separately would let 3 + 3 pass
    against 5 on hand and oversell the item."""
    belt = _item(client, "Belt", 5, 4, 12)

    r = client.post("/api/service/jobs", json={
        "client_id": acme, "job_type": "Repair",
        "items": [_part(belt, "Belt", 3, 12), _part(belt, "Belt", 3, 12)]})

    assert r.status_code == 400
    assert _stock(client, belt) == pytest.approx(5)


def test_consumption_leaves_a_readable_stock_movement(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [_part(belt, "Belt", 3, 12)])

    moves = client.get(f"/api/inventory/{belt}/movements").json()
    mine = [m for m in moves if m["type"] == "service"]

    assert len(mine) == 1
    assert mine[0]["delta"] == pytest.approx(-3)
    # The job number, so the stock history explains itself without a join.
    assert mine[0]["reference"] == job["job_number"]


# ── The ledger ───────────────────────────────────────────────────────────────

def test_completion_posts_cost_and_no_revenue(client, acme):
    """Completion is a cost event. Recognising revenue here would book income
    the customer has not paid, and double-count it when they do."""
    belt = _item(client, "Belt", 10, 4, 12)
    cogs_before = _balance(client, "5000")
    rev_before = _balance(client, "4000") + _balance(client, "4100")

    job = _job(client, acme, [_part(belt, "Belt", 3, 12), _charge("Labour", 100)])

    assert _balance(client, "5000") - cogs_before == pytest.approx(12)
    assert (_balance(client, "4000")
            + _balance(client, "4100")) == pytest.approx(rev_before)


def test_the_cost_entry_credits_inventory_by_the_same_amount(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    inv_before = _balance(client, "1200")

    job = _job(client, acme, [_part(belt, "Belt", 3, 12)])

    # DR COGS / CR Inventory — the asset falls by exactly what the cost rose by.
    assert _balance(client, "1200") - inv_before == pytest.approx(-12)


def test_a_labour_only_job_posts_no_entry(client, acme):
    """post_entry rejects an all-zero entry, so it must not be handed one."""
    before = _balance(client, "5000")
    job = _job(client, acme, [_charge("Labour", 150)])

    assert _balance(client, "5000") == pytest.approx(before)


def test_stock_leaving_and_cost_posted_never_disagree(client, acme):
    """The pairing that must hold across several jobs: every unit that left the
    warehouse is valued in the ledger, and nothing else is."""
    belt = _item(client, "Belt", 100, 4, 12)
    cogs_before = _balance(client, "5000")
    stock_before = _stock(client, belt)

    for qty in (1, 5, 3):
        job = _job(client, acme, [_part(belt, "Belt", qty, 12)])

    units_gone = stock_before - _stock(client, belt)

    assert units_gone == pytest.approx(9)
    assert _balance(client, "5000") - cogs_before == pytest.approx(units_gone * 4)


def test_the_job_records_the_cost_it_posted(client, acme):
    """So a manager can read margin off the job without opening the GL."""
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [_part(belt, "Belt", 3, 12), _charge("Labour", 100)])

    d = client.get(f"/api/service/jobs/{job['id']}").json()

    assert d["parts_cost"] == pytest.approx(12)
    assert d["subtotal"] == pytest.approx(136)      # 3 x 12 parts + 100 labour
    assert d["total"] == pytest.approx(d["subtotal"] + d["tax_total"])


def test_cancelling_puts_the_parts_back(client, acme):
    belt = _item(client, "Belt", 10, 4, 12)
    job = _job(client, acme, [_part(belt, "Belt", 3, 12)])
    assert _stock(client, belt) == pytest.approx(7)

    r = client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "mistake"})

    assert r.status_code == 200, r.text
    assert _stock(client, belt) == pytest.approx(10)


def test_cancelling_reverses_the_cost(client, acme):
    """Net zero on both sides: the cost was recognised and then unrecognised."""
    belt = _item(client, "Belt", 10, 4, 12)
    cogs_before = _balance(client, "5000")
    inv_before = _balance(client, "1200")

    job = _job(client, acme, [_part(belt, "Belt", 3, 12)])
    client.post(f"/api/service/jobs/{job['id']}/cancel", json={"reason": "mistake"})

    assert _balance(client, "5000") == pytest.approx(cogs_before)
    assert _balance(client, "1200") == pytest.approx(inv_before)
