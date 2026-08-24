"""
Instalment plans — an agreed payment schedule against ONE invoice.

A plan is a schedule, not a set of invoices. Splitting the debt into twelve
documents would split the revenue and VAT across twelve events, produce twelve
receipt vouchers, and leave no single record of the agreement. One invoice with
a schedule keeps the customer's document intact.

Nothing about the accounting changes. Revenue is already recognised on payment
and already allocated proportionally across revenue accounts (see
`accounting.revenue_split`), so a payment against instalment three posts exactly
as any partial payment does today, VAT carve-out included. What a plan adds is
DUE DATES the arrears reporting can see — an invoice carries one `due_date`, so
without a schedule a client twelve months into a plan is either entirely current
or entirely overdue, and the system cannot say which month they missed.

Which instalments are settled is DERIVED, never stored
------------------------------------------------------
The obvious model is an allocation table mapping payment → instalment. It is
also the part that rots: reversed payments, voids and edits each have to keep
allocations consistent, and when they do not, an invoice's instalments disagree
with its own balance.

So allocation is computed by comparing cumulative paid against cumulative
scheduled. A client who has paid 2,500 against 5 x 1,000 has settled one and
two, and half of three. The only number of record stays the invoice's own
`total_paid`, so the two cannot drift.

The cost is that a payment cannot be earmarked ("this one is for March").
Oldest-first is the normal rule for instalment plans, and adding earmarking
later is additive — the reverse would not be.
"""
from datetime import date, timedelta

from utils import money

# An instalment is settled when cumulative payments cover it. The tolerance
# absorbs cent-level rounding so a fully paid plan does not leave a 0.001
# remainder showing as "Partial" forever.
_CENT = 0.005

DUE = "Due"
OVERDUE = "Overdue"
PARTIAL = "Partial"
PAID = "Paid"


def add_months(d: date, n: int) -> date:
    """`d` plus n calendar months, clamped to the end of the target month.

    A plan starting on the 31st must not skip February. Clamping means the 31st
    becomes the 28th (or 29th) and then continues from the original day, which
    is what a person writing the schedule by hand would do.
    """
    y, m = divmod(d.year * 12 + (d.month - 1) + n, 12)
    m += 1
    if m == 12:
        last = 31
    else:
        last = (date(y + (m == 12), (m % 12) + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(d.day, last))


def build_schedule(total, count, start, frequency="monthly", first_amount=None):
    """The rows for a plan: [(seq, due_date, amount), ...].

    Every instalment is equal except the LAST, which absorbs the rounding
    residue. A plan whose parts do not sum to the invoice total leaves a final
    instalment nobody can settle, so the residue has to land somewhere explicit
    rather than being spread and hoped for.

    `first_amount` covers the common deposit-then-instalments arrangement. The
    deposit is taken on the start date and `count` instalments follow it, so
    "$400 down then four monthly" is five rows: the deposit is not one of the
    four. It carries seq 1 and the instalments run from seq 2, which keeps a
    plan's rows numbered in the order the customer pays them.
    """
    total = money(total)
    if count < 1:
        raise ValueError("A plan needs at least one instalment.")
    if total <= 0:
        raise ValueError("A plan needs a positive total.")

    step = {"monthly": 1, "quarterly": 3, "yearly": 12}.get(frequency)
    if step is None:
        raise ValueError("Frequency must be monthly, quarterly or yearly.")

    if isinstance(start, str):
        start = date.fromisoformat(start[:10])

    first = money(first_amount) if first_amount is not None else None
    if first is not None:
        if first <= 0 or first > total:
            raise ValueError("The first payment must be between zero and the total.")
        if abs(first - total) <= _CENT:
            raise ValueError(
                "A deposit covering the whole invoice leaves nothing to spread. "
                "Record it as a payment instead of a plan.")

    rows = []
    if first is not None:
        # The deposit does not eat an instalment. Asking for four instalments
        # with money down means the deposit AND four payments — it used to mean
        # the deposit and three, so agreeing "$400 now then four months" quietly
        # produced a schedule nobody had agreed to.
        rows.append((1, start, first))
        rest, remaining_count, offset = money(total - first), count, 1
    else:
        rest, remaining_count, offset = total, count, 0

    if remaining_count:
        each = money(rest / remaining_count)
        for i in range(remaining_count):
            seq = offset + i + 1
            due = add_months(start, step * (offset + i))
            rows.append((seq, due, each))

    # The last instalment carries the residue, so the plan sums exactly.
    booked = money(sum(a for _, _, a in rows))
    if abs(booked - total) > 0:
        seq, due, amt = rows[-1]
        rows[-1] = (seq, due, money(amt + (total - booked)))

    return [(seq, due.isoformat(), amt) for seq, due, amt in rows]


def allocate(rows, total_paid, today=None):
    """Annotate each instalment with what cumulative payments have settled.

    `rows` are the stored instalments (seq, due_date, amount, ...) in order.
    Returns dicts carrying `paid`, `remaining` and `status`.
    """
    today = today or date.today().isoformat()
    left = money(total_paid or 0)
    out = []
    for r in rows:
        amount = money(r["amount"])
        applied = money(min(left, amount))
        left = money(left - applied)
        remaining = money(amount - applied)

        if remaining <= _CENT:
            status = PAID
        elif str(r["due_date"])[:10] < str(today)[:10]:
            # Overdue outranks partial: a half-paid instalment past its date is
            # still money owed today, and that is what the person chasing it
            # needs to see.
            status = OVERDUE
        elif applied > _CENT:
            status = PARTIAL
        else:
            status = DUE

        out.append({
            "id": r["id"] if "id" in r.keys() else None,
            "seq": r["seq"],
            "due_date": r["due_date"],
            "amount": amount,
            "paid": applied,
            "remaining": remaining,
            "status": status,
            "note": r["note"] if "note" in r.keys() else None,
        })
    return out


def plan_for(db, invoice_id, total_paid, today=None):
    """The allocated plan for one invoice, or [] when it has none."""
    rows = db.execute(
        "SELECT id, seq, due_date, amount, note FROM invoice_installments "
        "WHERE invoice_id = ? ORDER BY seq", (invoice_id,)).fetchall()
    if not rows:
        return []
    return allocate(rows, total_paid, today=today)


def next_due(plan):
    """The instalment a chaser cares about: the oldest one still owing."""
    for row in plan:
        if row["status"] != PAID:
            return row
    return None


# ══════════════════════════════════════════════════════════════════════════════
# A PLAN AGAINST THE ACCOUNT
# ══════════════════════════════════════════════════════════════════════════════
# A customer owing 4,000 who agrees to eight payments of 500 has agreed ONE
# thing. The plan is theirs, not their invoices': it tracks the account balance,
# and each payment against it is an ordinary account payment allocated
# oldest-first across whatever is open at the time.
#
# That separation is what makes it survive contact with a real ledger. An
# invoice raised after the plan is simply part of the balance the plan is
# working down. One voided does not tear a hole in a schedule. And the customer
# can be shown the eight payments they actually agreed to, because that is what
# is stored.
#
# Which instalments are settled is DERIVED, exactly as it is for an invoice
# plan: cumulative paid against the plan versus cumulative scheduled. Nothing
# marks an instalment paid, so nothing can disagree with the payments.

def active_plan(db, client_id):
    """The customer's live plan, or None."""
    return db.execute(
        "SELECT * FROM client_payment_plans "
        "WHERE client_id=? AND status='active' ORDER BY id DESC LIMIT 1",
        (client_id,)).fetchone()


def paid_against(db, plan_id) -> float:
    """What has been paid against this plan, in the company's currency."""
    row = db.execute(
        "SELECT COALESCE(SUM(amount), 0) AS n FROM customer_payments "
        "WHERE plan_id=?", (plan_id,)).fetchone()
    return money(row["n"] or 0)


def create_plan(db, *, client_id, total, count, frequency="monthly",
                start=None, note=None, created_by=None, now=None):
    """Agree a schedule against what the customer owes.

    `total` is the balance being scheduled — normally everything outstanding
    once the payment being taken now has been applied.
    """
    from utils import _now
    now = now or _now()
    if active_plan(db, client_id):
        raise ValueError(
            "This customer is already on a payment plan. Cancel it first if "
            "the terms have changed — two live agreements about one balance "
            "is not something anybody agreed to.")

    rows = build_schedule(total, count, start or now[:10], frequency=frequency)

    cur = db.execute(
        "INSERT INTO client_payment_plans "
        "(client_id, total, frequency, status, note, created_at, created_by) "
        "VALUES (?,?,?,'active',?,?,?)",
        (client_id, money(total), frequency, note, now, created_by))
    plan_id = cur.lastrowid
    for seq, due, amount in rows:
        db.execute(
            "INSERT INTO client_plan_installments (plan_id, seq, due_date, amount) "
            "VALUES (?,?,?,?)", (plan_id, seq, str(due), amount))
    return plan_id


def plan_state(db, client_id, today=None):
    """The customer's plan, with each instalment's state worked out.

    Returns None when there is no live plan.
    """
    from utils import _now
    today = today or _now()[:10]
    plan = active_plan(db, client_id)
    if not plan:
        return None

    rows = db.execute(
        "SELECT id, seq, due_date, amount FROM client_plan_installments "
        "WHERE plan_id=? ORDER BY seq", (plan["id"],)).fetchall()
    paid = paid_against(db, plan["id"])
    lines = allocate(rows, paid, today=today)

    scheduled = money(sum(float(r["amount"]) for r in rows))
    return {
        "id": plan["id"],
        "total": money(plan["total"]),
        "frequency": plan["frequency"],
        "note": plan["note"],
        "created_at": plan["created_at"],
        "installments": lines,
        "count": len(lines),
        "paid": paid,
        "remaining": money(scheduled - paid),
        "next_due": next_due(lines),
        # Settled by its own terms. The account may still owe something — a new
        # invoice raised after the plan was agreed is not part of it — so the
        # two figures are reported separately rather than conflated.
        "settled": paid >= money(scheduled) - _CENT,
    }


def close_plan(db, plan_id, *, status="cancelled", closed_by=None, now=None):
    """End a plan. The payments made against it stay exactly where they are."""
    from utils import _now
    db.execute(
        "UPDATE client_payment_plans SET status=?, closed_at=?, closed_by=? "
        "WHERE id=? AND status='active'",
        (status, now or _now(), closed_by, plan_id))
