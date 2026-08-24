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


# ── One schedule over a whole account ────────────────────────────────────────

def plan_account(db, *, client_id, count, frequency="monthly", start=None,
                 note=None, now=None):
    """Put everything a customer still owes on one agreed schedule.

    A plan on one invoice is a negotiation about one document. This is the
    other thing people mean by instalments: the customer owes several bills and
    agrees to clear the lot over N payments.

    The schedule is built once over the combined balance and then walked across
    the invoices, oldest first — so a single instalment can finish one invoice
    and start the next, which is exactly what happens when the money arrives
    and is allocated oldest-first. Each invoice ends up with its own rows, so
    arrears reporting, the statement and the invoice screen all read a plan
    they already understand and none of them learns a new concept.

    Rows on a part-paid invoice open with what has already been settled, dated
    today, because the engine decides which instalments are covered by
    comparing cumulative paid against cumulative scheduled — a schedule that
    did not account for money already received would show settled instalments
    as outstanding for ever.
    """
    from utils import _now
    now = now or _now()
    today = now[:10]

    rows = db.execute(
        """SELECT i.id, i.invoice_number, i.amount,
                  COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                            WHERE p.invoice_id = i.id), 0) AS paid
             FROM invoices i
            WHERE i.client_id = ? AND i.voided_at IS NULL
              AND i.archived_at IS NULL
              AND COALESCE(i.approval_status,'') != 'Pending Approval'
         ORDER BY COALESCE(i.due_date, i.created_at), i.id""",
        (client_id,)).fetchall()

    open_rows = []
    for r in rows:
        remaining = money(float(r["amount"]) - float(r["paid"]))
        if remaining > _CENT:
            open_rows.append((r, remaining))
    if not open_rows:
        raise ValueError("This customer has nothing outstanding to schedule.")

    # An agreement already being kept is not ours to overwrite. One with no
    # money against it is a draft and can be replaced.
    for r, _ in open_rows:
        has_plan = db.execute(
            "SELECT 1 FROM invoice_installments WHERE invoice_id=?",
            (r["id"],)).fetchone()
        if has_plan and float(r["paid"]) > _CENT:
            raise ValueError(
                f"{r['invoice_number']} is already on a plan that has been "
                "paid against. Remove that plan first if the terms have "
                "genuinely changed.")

    total = money(sum(rem for _, rem in open_rows))
    schedule = build_schedule(total, count, start or today, frequency=frequency)

    # Walk the schedule across the invoices. An instalment that overruns one
    # invoice finishes it and carries the rest to the next.
    queue = [[due, amount] for _, due, amount in schedule]
    written = []
    qi = 0
    for r, remaining in open_rows:
        left = remaining
        seq = 1
        db.execute("DELETE FROM invoice_installments WHERE invoice_id=?", (r["id"],))

        already = money(float(r["paid"]))
        if already > _CENT:
            db.execute(
                "INSERT INTO invoice_installments "
                "(invoice_id, seq, due_date, amount, note, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (r["id"], seq, today, already, note, now))
            seq += 1

        last_due = today
        while left > _CENT and qi < len(queue):
            due, avail = queue[qi]
            take = money(min(left, avail))
            db.execute(
                "INSERT INTO invoice_installments "
                "(invoice_id, seq, due_date, amount, note, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (r["id"], seq, str(due), take, note, now))
            seq += 1
            last_due = str(due)
            left = money(left - take)
            queue[qi][1] = money(avail - take)
            if queue[qi][1] <= _CENT:
                qi += 1

        # Anything still reading a single date says the plan ends then, rather
        # than claiming the whole balance was due on day one.
        db.execute("UPDATE invoices SET due_date=? WHERE id=?", (last_due, r["id"]))
        written.append({"invoice_id": r["id"],
                        "invoice_number": r["invoice_number"],
                        "scheduled": money(remaining), "last_due": last_due})

    return {"total": total, "instalments": len(schedule),
            "first_due": str(schedule[0][1]), "last_due": str(schedule[-1][1]),
            "invoices": written}


def account_plan(db, client_id, today=None):
    """Everything a customer owes, on the dates they agreed, as one schedule.

    The rows live per invoice because that is what arrears reporting, the
    statement and the invoice screen all read. Nobody agreeing terms thinks in
    those terms though: they agreed four payments, and they want to see four
    payments. So the rows are gathered back into the schedule the customer was
    actually given, by date.

    Instalments falling on the same date are one payment as far as the customer
    is concerned, and are shown as one — with the invoices it covers named,
    because that is the question asked when a payment is short.
    """
    from utils import _now
    today = today or _now()[:10]

    rows = db.execute(
        """SELECT i.id, i.invoice_number, i.amount,
                  COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                            WHERE p.invoice_id = i.id), 0) AS paid
             FROM invoices i
            WHERE i.client_id = ? AND i.voided_at IS NULL
              AND i.archived_at IS NULL
         ORDER BY COALESCE(i.due_date, i.created_at), i.id""",
        (client_id,)).fetchall()

    by_date = {}
    for r in rows:
        for line in plan_for(db, r["id"], float(r["paid"]), today=today):
            slot = by_date.setdefault(str(line["due_date"]), {
                "due_date": str(line["due_date"]), "amount": 0.0,
                "paid": 0.0, "invoices": [], "statuses": set(),
            })
            slot["amount"] = money(slot["amount"] + float(line["amount"]))
            slot["paid"] = money(slot["paid"] + float(line.get("paid") or 0))
            slot["statuses"].add(line["status"])
            if r["invoice_number"] not in [i["invoice_number"]
                                           for i in slot["invoices"]]:
                slot["invoices"].append({"invoice_id": r["id"],
                                         "invoice_number": r["invoice_number"]})

    out = []
    for slot in sorted(by_date.values(), key=lambda s: s["due_date"]):
        st = slot.pop("statuses")
        # One date is one payment to the customer, so its state is the least
        # settled of the parts: anything still owing makes the whole date owing.
        slot["status"] = (PAID if st == {PAID}
                          else OVERDUE if OVERDUE in st
                          else PARTIAL if (PARTIAL in st or PAID in st)
                          else DUE)
        out.append(slot)

    scheduled = money(sum(s["amount"] for s in out))
    settled = money(sum(s["paid"] for s in out))
    return {
        "installments": out,
        "count": len(out),
        "total": scheduled,
        "paid": settled,
        "remaining": money(scheduled - settled),
        "next_due": next((s for s in out if s["status"] != PAID), None),
    }
