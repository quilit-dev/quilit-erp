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

    `first_amount` covers the common deposit-then-instalments arrangement: the
    deposit is instalment one and the remainder is divided across the rest.
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
        if count == 1 and abs(first - total) > _CENT:
            raise ValueError("A single-instalment plan must equal the total.")

    rows = []
    if first is not None and count > 1:
        rows.append((1, start, first))
        rest, remaining_count, offset = money(total - first), count - 1, 1
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
