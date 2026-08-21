"""Payment plans: an agreed schedule against one invoice.

A plan is a schedule, not a set of invoices — one customer document, several
agreed dates. The accounting is untouched: revenue is already recognised on
payment and split proportionally, so a payment against instalment three posts
exactly as any partial payment does. What a plan adds is DUE DATES the arrears
side can see.

Two things are worth pinning hardest, because both are silent when wrong:

  * The schedule must sum to the invoice total to the cent. A plan that does not
    add up leaves a final instalment nobody can settle, and nothing complains.
  * Settlement is DERIVED from cumulative payments, never stored. That is what
    keeps the plan from disagreeing with the invoice's own balance after a
    reversal or an edit — so the tests exercise it through real payments rather
    than by calling the allocator with made-up numbers.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

from datetime import date, timedelta

import pytest

import installments


# ── The schedule ─────────────────────────────────────────────────────────────

def test_the_parts_sum_to_the_whole():
    """1000 over 3 does not divide. The residue has to land somewhere explicit
    rather than being spread and hoped for, or the last instalment cannot be
    settled."""
    rows = installments.build_schedule(1000, 3, "2026-01-15")

    assert [a for _, _, a in rows] == [333.33, 333.33, 333.34]
    assert sum(a for _, _, a in rows) == pytest.approx(1000, abs=0.001)


@pytest.mark.parametrize("total,count", [(100, 3), (1000, 7), (55.55, 4),
                                         (0.03, 2), (123456.78, 12)])
def test_no_schedule_ever_loses_a_cent(total, count):
    rows = installments.build_schedule(total, count, "2026-03-31")

    assert sum(a for _, _, a in rows) == pytest.approx(total, abs=0.001)


def test_a_month_end_start_does_not_skip_february():
    """The 31st has no February. Clamping to the month end and then RETURNING to
    the 31st is what someone writing the schedule by hand would do; drifting to
    the 28th for the rest of the year is not."""
    rows = installments.build_schedule(500, 5, "2026-01-31")

    assert [d for _, d, _ in rows] == ["2026-01-31", "2026-02-28", "2026-03-31",
                                       "2026-04-30", "2026-05-31"]


def test_a_deposit_does_not_eat_an_instalment():
    """Money down, then N months — the deposit is NOT one of the N.

    Asking for four instalments with a deposit used to produce the deposit and
    three payments, so agreeing "$400 now then four months" quietly wrote a
    schedule nobody had agreed to.
    """
    rows = installments.build_schedule(1000, 4, "2026-01-10", first_amount=400)

    assert [a for _, _, a in rows] == [400, 150, 150, 150, 150]
    assert [d for _, d, _ in rows] == ["2026-01-10", "2026-02-10", "2026-03-10",
                                       "2026-04-10", "2026-05-10"]
    assert sum(a for _, _, a in rows) == pytest.approx(1000, abs=0.001)


def test_the_instalments_run_consecutively_after_the_deposit():
    """No gap: the deposit is taken today and the first instalment is next
    period, not the one after."""
    rows = installments.build_schedule(900, 3, "2026-01-31", first_amount=300)

    assert [d for _, d, _ in rows] == ["2026-01-31", "2026-02-28",
                                       "2026-03-31", "2026-04-30"]


def test_a_deposit_covering_everything_is_refused():
    """Nothing left to spread — that is a payment, not a plan."""
    with pytest.raises(ValueError, match="nothing to spread"):
        installments.build_schedule(1000, 3, "2026-01-10", first_amount=1000)


def test_quarterly_and_yearly_step_by_their_period():
    q = installments.build_schedule(400, 4, "2026-01-15", frequency="quarterly")
    y = installments.build_schedule(300, 3, "2026-01-15", frequency="yearly")

    assert [d for _, d, _ in q] == ["2026-01-15", "2026-04-15",
                                    "2026-07-15", "2026-10-15"]
    assert [d for _, d, _ in y] == ["2026-01-15", "2027-01-15", "2028-01-15"]


@pytest.mark.parametrize("kwargs", [
    {"count": 0},                                  # nothing to pay
    {"count": 3, "frequency": "fortnightly"},      # unsupported period
    {"count": 3, "first_amount": 5000},            # deposit exceeds the total
    {"count": 3, "first_amount": 0},
])
def test_a_nonsense_plan_is_refused(kwargs):
    kwargs.setdefault("count", 3)
    with pytest.raises(ValueError):
        installments.build_schedule(1000, kwargs.pop("count"),
                                    "2026-01-15", **kwargs)


# ── Derived settlement ───────────────────────────────────────────────────────

def _rows(*amounts, start="2026-01-15"):
    return [{"id": i + 1, "seq": i + 1, "due_date": d, "amount": a, "note": None}
            for i, (_, d, a) in enumerate(
                [(s, d, a) for (s, d, a) in
                 installments.build_schedule(sum(amounts), len(amounts), start)])]


def test_payments_settle_oldest_first():
    """2500 against 5 x 1000 settles one and two and half of three — the normal
    rule for an instalment plan, and the only one that needs no earmarking."""
    rows = _rows(*[1000] * 5)

    # 20 March: instalments 1-3 (15 Jan/Feb/Mar) are past their date, 4 and 5
    # are not. A date past ALL of them would make every unsettled row Overdue
    # and prove nothing about the boundary.
    out = installments.allocate(rows, 2500, today="2026-03-20")

    assert [r["status"] for r in out] == ["Paid", "Paid", "Overdue", "Due", "Due"]
    assert [r["paid"] for r in out] == [1000, 1000, 500, 0, 0]
    assert out[2]["remaining"] == 500


def test_overdue_outranks_partial():
    """A half-paid instalment past its date is still money owed today, and that
    is what the person chasing it needs to see."""
    rows = _rows(1000, 1000, start="2026-01-15")

    out = installments.allocate(rows, 1500, today="2026-03-01")

    assert out[1]["status"] == "Overdue"


def test_a_future_instalment_is_due_not_overdue():
    rows = _rows(1000, 1000, start="2026-01-15")

    out = installments.allocate(rows, 0, today="2026-01-01")

    assert [r["status"] for r in out] == ["Due", "Due"]


def test_a_fully_paid_plan_leaves_no_rounding_remainder():
    """333.33 + 333.33 + 333.34: paying 1000 must settle all three, not leave a
    third instalment showing 'Partial' by a hundredth of a cent forever."""
    rows = _rows(333.33, 333.33, 333.34)

    out = installments.allocate(rows, 1000, today="2027-01-01")

    assert [r["status"] for r in out] == ["Paid", "Paid", "Paid"]
    assert installments.next_due(out) is None


def test_next_due_is_the_oldest_still_owing():
    rows = _rows(*[1000] * 4)

    nxt = installments.next_due(installments.allocate(rows, 2000, today="2026-06-01"))

    assert nxt["seq"] == 3



# -- Through the API ----------------------------------------------------------

@pytest.fixture
def client(as_role):
    return as_role("superadmin")


@pytest.fixture
def acme(client):
    return client.post("/api/clients/", json={"name": "Instalment Co"}).json()["id"]


def _invoice(client, acme, amount=1200):
    created = client.post("/api/invoices/", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Machine", "quantity": 1, "unit_price": amount}]}).json()
    return created.get("invoice_id") or created.get("id")


def _plan(client, inv_id, **kw):
    body = {"count": 4, "start_date": "2026-01-15"}
    body.update(kw)
    return client.post(f"/api/invoices/{inv_id}/plan", json=body)


def test_a_plan_can_be_agreed_and_read_back(client, acme):
    inv_id = _invoice(client, acme, 1200)

    r = _plan(client, inv_id)
    assert r.status_code == 200, r.text

    plan = client.get(f"/api/invoices/{inv_id}/plan").json()["installments"]
    assert [x["amount"] for x in plan] == [300, 300, 300, 300]
    assert [x["due_date"] for x in plan] == ["2026-01-15", "2026-02-15",
                                             "2026-03-15", "2026-04-15"]


def test_the_plan_always_sums_to_the_invoice(client, acme):
    """The invoice total is the number of record; the schedule must reproduce it
    exactly or the last instalment can never be settled."""
    inv_id = _invoice(client, acme, 1000)

    _plan(client, inv_id, count=3)

    plan = client.get(f"/api/invoices/{inv_id}/plan").json()["installments"]
    total = client.get(f"/api/invoices/{inv_id}").json()["amount"]
    assert sum(x["amount"] for x in plan) == pytest.approx(total, abs=0.001)


def test_the_invoice_carries_its_plan(client, acme):
    """So the screen showing an invoice can show what was agreed without a
    second round trip, and `next_due` tells the collector what to chase."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)

    inv = client.get(f"/api/invoices/{inv_id}").json()

    assert len(inv["installments"]) == 4
    assert inv["next_due"]["seq"] == 1


def test_the_due_date_becomes_the_end_of_the_plan(client, acme):
    """Anything still reading a single date -- an export, an older report --
    should say the plan ends then, not that the whole balance was due on day
    one."""
    inv_id = _invoice(client, acme, 1200)

    _plan(client, inv_id)

    assert client.get(f"/api/invoices/{inv_id}").json()["due_date"] == "2026-04-15"


def test_a_payment_settles_instalments_in_order(client, acme):
    """The engine test proves the arithmetic; this proves the plan is wired to
    the invoice's REAL payments, so the two cannot disagree."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)

    client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 600, "currency": "USD", "method": "Cash",
        "idempotency_key": "inst-1"})

    inv = client.get(f"/api/invoices/{inv_id}").json()
    assert [x["status"] for x in inv["installments"][:2]] == ["Paid", "Paid"]
    assert inv["next_due"]["seq"] == 3


def test_a_plan_cannot_be_rewritten_once_money_has_arrived(client, acme):
    """Renegotiation is normal, but not silently: re-cutting a plan after three
    of twelve payments would turn that client into one of four, and nothing on
    screen would say so."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)
    client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 300, "currency": "USD", "method": "Cash",
        "idempotency_key": "inst-2"})

    r = _plan(client, inv_id, count=6)

    assert r.status_code == 409
    assert len(client.get(f"/api/invoices/{inv_id}/plan").json()["installments"]) == 4


def test_an_unpaid_plan_can_be_renegotiated(client, acme):
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)

    assert _plan(client, inv_id, count=6).status_code == 200
    assert len(client.get(f"/api/invoices/{inv_id}/plan").json()["installments"]) == 6


def test_removing_a_plan_leaves_the_payments_unexplained(client, acme):
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)
    client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 300, "currency": "USD", "method": "Cash",
        "idempotency_key": "inst-3"})

    assert client.delete(f"/api/invoices/{inv_id}/plan").status_code == 409


def test_an_invoice_without_a_plan_is_unchanged(client, acme):
    """A plan is opt-in. Every invoice that has none must behave exactly as
    before -- empty list, nothing to chase."""
    inv_id = _invoice(client, acme, 1200)

    inv = client.get(f"/api/invoices/{inv_id}").json()

    assert inv["installments"] == []
    assert inv["next_due"] is None


# -- Arrears ------------------------------------------------------------------

def _past_plan(client, acme, count=3, amount=900):
    """A plan whose instalments are all in the past, so it is in arrears now."""
    inv_id = _invoice(client, acme, amount)
    start = (date.today() - timedelta(days=200)).isoformat()
    _plan(client, inv_id, count=count, start_date=start)
    return inv_id


def _notifications(client):
    body = client.get("/api/notifications/").json()
    if isinstance(body, list):
        return body
    return body.get("rows") or body.get("notifications") or []


def test_arrears_are_chased_per_instalment(client, acme):
    """The whole point of the feature. An invoice carries ONE due_date, which
    under a plan is the final instalment -- so an invoice-level sweep says
    nothing for a year and then flags the entire balance, never naming the month
    that was missed."""
    _past_plan(client, acme, count=3)

    arrears = [n for n in _notifications(client)
               if n.get("type") == "installment_overdue"]

    assert len(arrears) == 3, "one reminder per missed instalment"
    assert all(str(n.get("entity_type")) == "invoice_installment" for n in arrears)


def test_a_planned_invoice_is_not_also_chased_as_a_whole(client, acme):
    """Otherwise the same money is chased twice -- once per instalment and once
    for the full balance -- and the notification list becomes noise."""
    _past_plan(client, acme)

    assert not [n for n in _notifications(client)
                if n.get("type") == "invoice_overdue"]


def test_settled_instalments_are_not_chased(client, acme):
    inv_id = _past_plan(client, acme, count=3, amount=900)
    client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 600, "currency": "USD", "method": "Cash",
        "idempotency_key": "inst-4"})

    arrears = [n for n in _notifications(client)
               if n.get("type") == "installment_overdue"]

    assert len(arrears) == 1


# -- Aging --------------------------------------------------------------------

def _aging(client):
    return client.get("/api/reports/invoice-aging").json()


def test_aging_uses_the_missed_instalment_not_the_end_of_the_plan(client, acme):
    """Aged by the invoice's own due_date, a client six months into a plan and
    three months in arrears reads as CURRENT -- the single date is the final
    instalment, months away. That is the bug this replaces."""
    # A plan that is still RUNNING: it began 200 days ago and has 12 monthly
    # instalments, so its final one -- the invoice's own due_date -- is months
    # in the future. Aged by that single date the client is entirely current
    # despite six missed payments. A plan short enough to have finished would
    # age correctly either way and prove nothing.
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id, count=12,
          start_date=(date.today() - timedelta(days=200)).isoformat())
    assert client.get(f"/api/invoices/{inv_id}").json()["due_date"] > date.today().isoformat()

    summary = _aging(client)["summary"]

    assert summary["over_90"]["total"] > 0, "missed instalments must age"


def test_only_the_arrears_age_not_the_whole_balance(client, acme):
    """The other half of the same mistake. One missed payment does not make the
    entire plan overdue -- money not yet due stays current, or the aging report
    overstates arrears by the length of the plan."""
    inv_id = _invoice(client, acme, 1200)
    start = (date.today() - timedelta(days=40)).isoformat()
    # Starting 40 days back, monthly: instalments 1 and 2 are past their date
    # (the second falls 9-12 days ago whatever the month length), 3 and 4 are
    # not. So 600 is genuinely in arrears and 600 is not yet owed.
    _plan(client, inv_id, count=4, start_date=start)

    summary = _aging(client)["summary"]

    aged = summary["1_30"]["total"] + summary["31_60"]["total"]
    assert aged == pytest.approx(600, abs=0.01)
    assert summary["current"]["total"] == pytest.approx(600, abs=0.01)


def test_the_aged_and_current_halves_still_add_up_to_the_debt(client, acme):
    """Splitting a row is only safe if nothing is lost or double-counted."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id, count=4,
          start_date=(date.today() - timedelta(days=40)).isoformat())

    body = _aging(client)
    total = sum(b["total"] for b in body["summary"].values())

    assert total == pytest.approx(1200, abs=0.01)
    keys = [r["row_key"] for r in body["invoices"]]
    assert len(set(keys)) == len(keys), \
        "split rows need distinct keys or React collapses them"


def test_an_unplanned_invoice_ages_exactly_as_before(client, acme):
    """The regression guard: everything without a plan must behave as it did.

    The PUT sends the WHOLE invoice because the endpoint takes an InvoiceCreate
    and replaces the record -- a partial body silently zeroes the amount, and an
    invoice worth nothing is not overdue, so this test would pass for the wrong
    reason.
    """
    inv_id = _invoice(client, acme, 500)
    client.put(f"/api/invoices/{inv_id}", json={
        "client_id": acme, "amount": 0,
        "items": [{"name": "Machine", "quantity": 1, "unit_price": 500}],
        "due_date": (date.today() - timedelta(days=45)).isoformat()})

    rows = _aging(client)["invoices"]
    row = next(r for r in rows if r["id"] == inv_id)

    assert row["days_overdue"] == 45
    assert row["remaining"] == pytest.approx(500, abs=0.01)


# -- The customer's own copy --------------------------------------------------

def _share(client, inv_id):
    """A public link for an invoice, and the payload behind it.

    A share is minted by /send -- there is no separate "create link" endpoint;
    the link IS the send. The token is returned only in the URL and only once,
    since the database stores its hash.
    """
    r = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv_id, "channel": "whatsapp",
        # Explicit, because the client in these tests has no phone on file and
        # /send refuses rather than minting a link with nowhere to go.
        "to": "96171234567"})
    assert r.status_code == 200, r.text
    token = r.json()["url"].rsplit("/", 1)[-1]
    return client.get(f"/api/communications/public/{token}")


def test_the_share_link_carries_the_schedule(client, acme):
    """The single thing a customer on a plan most needs from a link: what is due
    next, and whether they are behind."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)

    body = _share(client, inv_id).json()

    assert [r["seq"] for r in body["installments"]] == [1, 2, 3, 4]
    assert body["installments"][0]["amount"] == 300


def test_the_shared_plan_agrees_with_the_shared_balance(client, acme):
    """Both blocks are printed on the same page. If the schedule said one thing
    and the balance another, the customer would be the one to notice."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)
    client.post(f"/api/invoices/{inv_id}/payments", json={
        "amount": 600, "currency": "USD", "method": "Cash",
        "idempotency_key": "share-1"})

    body = _share(client, inv_id).json()

    settled = sum(r["paid"] for r in body["installments"])
    assert settled == pytest.approx(sum(p["amount"] for p in body["payments"]),
                                    abs=0.01)


def test_the_shared_plan_leaks_no_internal_ids(client, acme):
    """The payload is an allow-list on purpose: the token is a bearer URL that
    gets forwarded, so nothing internal rides along. An instalment's row id
    tells an outsider nothing they need."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)

    body = _share(client, inv_id).json()

    for row in body["installments"]:
        assert set(row.keys()) == {"seq", "due_date", "amount",
                                   "paid", "remaining", "status"}


def test_the_share_link_still_withholds_contact_details(client, acme):
    """The pinned privacy rule, re-checked here because this change widened the
    payload -- the last time it was widened, this broke."""
    inv_id = _invoice(client, acme, 1200)
    _plan(client, inv_id)

    body = _share(client, inv_id).json()

    assert set(body["client"].keys()) == {"name"}


def test_an_invoice_without_a_plan_shares_an_empty_one(client, acme):
    inv_id = _invoice(client, acme, 1200)

    assert _share(client, inv_id).json()["installments"] == []
