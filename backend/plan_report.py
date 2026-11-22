"""The Payment Plans report: every instalment agreement, how it is going, and
what it will bring in.

Two kinds of plan exist and the report shows them side by side, because to the
person chasing payments they are the same thing — a customer who agreed to pay
on dates:

* an ACCOUNT plan (`client_payment_plans`) schedules a customer's whole
  balance; what has been paid against it is the account payments made under it;
* an INVOICE plan (`invoice_installments`) schedules one invoice; what has
  been paid is that invoice's payments.

Nothing new is stored. Which instalments are settled is derived the same way
everywhere in the system — cumulative paid against cumulative scheduled,
oldest first (`installments.allocate`) — so this report agrees with the plan
panel on the customer, the invoice, and the Invoice Aging report.

Figures are in the company's own currency.
"""
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

import installments
from utils import money

CENT = 0.005

ON_TRACK, LATE, COMPLETED, CANCELLED = "on_track", "late", "completed", "cancelled"
# An invoice plan on an invoice that a later ACCOUNT plan took in. Agreeing the
# whole account on terms is the newer agreement and covers that debt, so the
# invoice plan is shown for reference but counted nowhere: the same money must
# not be owed twice in the totals. If the account plan is cancelled, it counts
# again.
COVERED = "covered"
STATUSES = (ON_TRACK, LATE, COMPLETED, CANCELLED, COVERED)
# "open" is what needs attention: everything not yet finished or cancelled.
FILTERS = ("open", *STATUSES, "all")

BUCKETS = (("1_30", 1, 30), ("31_60", 31, 60), ("61_90", 61, 90), ("over_90", 91, None))


def _frequency(dues: List[str]) -> str:
    """An invoice plan does not store how it was generated; read it back off
    the dates. Anything irregular (edited dates, a deposit) is 'custom'."""
    if len(dues) < 2:
        return "single"
    steps = set()
    for a, b in zip(dues, dues[1:]):
        da, db = date.fromisoformat(a[:10]), date.fromisoformat(b[:10])
        steps.add((db.year - da.year) * 12 + db.month - da.month)
    if len(steps) == 1:
        return {1: "monthly", 3: "quarterly", 12: "yearly"}.get(steps.pop(), "custom")
    return "custom"


def _bucket(days: int) -> Optional[str]:
    for key, lo, hi in BUCKETS:
        if days >= lo and (hi is None or days <= hi):
            return key
    return None


def _summarise(lines: List[Dict[str, Any]], today: str, start: str, end: str,
               cancelled: bool) -> Dict[str, Any]:
    """What one plan amounts to: progress, arrears, the next payment, and what
    falls due in the chosen period."""
    total = money(sum(l["amount"] for l in lines))
    paid = money(sum(l["paid"] for l in lines))
    remaining = money(total - paid)
    overdue = [l for l in lines if l["status"] == installments.OVERDUE]
    open_lines = [l for l in lines if l["remaining"] > CENT]
    nxt = next((l for l in open_lines if str(l["due_date"])[:10] >= today), None)
    oldest_overdue = overdue[0] if overdue else None
    days_late = ((date.fromisoformat(today) - date.fromisoformat(str(oldest_overdue["due_date"])[:10])).days
                 if oldest_overdue else 0)

    if cancelled:
        status = CANCELLED
    elif remaining <= CENT:
        status = COMPLETED
    elif overdue:
        status = LATE
    else:
        status = ON_TRACK

    dues = [str(l["due_date"])[:10] for l in lines]
    return {
        "status": status,
        "count": len(lines),
        "paid_count": sum(1 for l in lines if l["remaining"] <= CENT),
        "total": total,
        "paid": paid,
        "remaining": remaining,
        "progress": round(paid / total * 100, 1) if total > CENT else 100.0,
        "overdue": money(sum(l["remaining"] for l in overdue)),
        "overdue_count": len(overdue),
        "days_late": days_late,
        "next_due_date": nxt["due_date"] if nxt else None,
        "next_due_amount": nxt["remaining"] if nxt else 0.0,
        "first_due": dues[0] if dues else None,
        "last_due": dues[-1] if dues else None,
        "frequency": _frequency(dues),
        "due_in_period": money(sum(l["remaining"] for l in lines
                                   if start <= str(l["due_date"])[:10] <= end)),
        "scheduled_in_period": money(sum(l["amount"] for l in lines
                                         if start <= str(l["due_date"])[:10] <= end)),
        "installments": lines,
    }


def _account_plans(db, today: str) -> List[Tuple[Dict[str, Any], List[Dict[str, Any]], bool]]:
    rows = db.execute(
        """SELECT p.id, p.client_id, p.total, p.frequency, p.status, p.note,
                  p.created_at, p.closed_at, c.name AS client_name
             FROM client_payment_plans p
             JOIN clients c ON c.id = p.client_id
            WHERE p.status IN ('active', 'cancelled')
            ORDER BY p.id""").fetchall()
    out = []
    for p in rows:
        inst = db.execute(
            "SELECT id, seq, due_date, amount FROM client_plan_installments "
            "WHERE plan_id = ? ORDER BY seq", (p["id"],)).fetchall()
        if not inst:
            continue
        lines = installments.allocate(inst, installments.paid_against(db, p["id"]), today=today)
        covers = (installments.covered_invoice_ids(db, p["client_id"], p["created_at"])
                  if p["status"] == "active" else [])
        head = {
            "covers_invoice_ids": covers,
            "key": f"account-{p['id']}", "kind": "account", "plan_id": p["id"],
            "client_id": p["client_id"], "client_name": p["client_name"],
            "reference": f"Account plan #{p['id']}", "invoice_id": None,
            "note": p["note"], "created_at": p["created_at"], "closed_at": p["closed_at"],
            "stored_frequency": p["frequency"],
        }
        out.append((head, lines, p["status"] == "cancelled"))
    return out


def _invoice_plans(db, today: str, bf_i: str, bp_i) -> List[Tuple[Dict[str, Any], List[Dict[str, Any]], bool]]:
    rows = db.execute(
        f"""SELECT i.id, i.invoice_number, i.client_id, i.created_at,
                   c.name AS client_name,
                   COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                             WHERE ip.invoice_id = i.id), 0) AS paid
              FROM invoices i
              LEFT JOIN clients c ON c.id = i.client_id
             WHERE i.voided_at IS NULL AND i.archived_at IS NULL
               AND COALESCE(i.approval_status, '') != 'Pending Approval'
               AND EXISTS (SELECT 1 FROM invoice_installments t WHERE t.invoice_id = i.id){bf_i}
             ORDER BY i.id""", tuple(bp_i)).fetchall()
    out = []
    for r in rows:
        lines = installments.plan_for(db, r["id"], r["paid"], today=today)
        if not lines:
            continue
        head = {
            "key": f"invoice-{r['id']}", "kind": "invoice", "plan_id": None,
            "client_id": r["client_id"], "client_name": r["client_name"] or "Walk-in",
            "reference": r["invoice_number"], "invoice_id": r["id"],
            "note": None, "created_at": r["created_at"], "closed_at": None,
            "stored_frequency": None,
        }
        out.append((head, lines, False))
    return out


def build(db, *, start: str, end: str, status: str = "open", today: Optional[str] = None,
          bf_i: str = "", bp_i=()) -> Dict[str, Any]:
    """The whole report. `start`/`end` pick the plans running in the period
    (any instalment due in it) plus every plan still in arrears, whatever its
    dates — an overdue debt does not stop mattering because the period moved."""
    today = today or date.today().isoformat()
    if status not in FILTERS:
        status = "open"

    plans: List[Tuple[Dict, List, bool]] = []
    # Account plans cover a customer's whole balance, which spans branches.
    # A branch-scoped view shows only that branch's invoice plans rather than
    # reveal another branch's customer balances.
    if not bf_i:
        plans += _account_plans(db, today)
    plans += _invoice_plans(db, today, bf_i, bp_i)

    # Which invoices a live account plan has taken in, and by which plan.
    covered_by = {}
    for head, _lines, cancelled in plans:
        if head["kind"] == "account" and not cancelled:
            for inv_id in head.get("covers_invoice_ids", []):
                covered_by[inv_id] = head["reference"]

    rows = []
    for head, lines, cancelled in plans:
        s = _summarise(lines, today, start, end, cancelled)
        head["covered_by"] = covered_by.get(head["invoice_id"]) if head["kind"] == "invoice" else None
        if head["covered_by"]:
            s["status"] = COVERED
        if head["kind"] == "account":
            ids = set(head.pop("covers_invoice_ids", []))
            # The invoice plans this account plan took in, named on its row.
            head["covers"] = [h["reference"] for h, _l, _c in plans
                              if h["kind"] == "invoice" and h["invoice_id"] in ids]
        if s["frequency"] in ("custom", "single") and head["stored_frequency"]:
            s["frequency"] = head["stored_frequency"]
        head.pop("stored_frequency", None)
        runs_in_period = bool(s["first_due"]) and s["first_due"] <= end and s["last_due"] >= start
        if not (runs_in_period or s["overdue"] > CENT):
            continue
        rows.append({**head, **s})

    # Totals are over the plans in the period, before the status filter, so
    # the cards describe the portfolio and the filter only narrows the table.
    live = [r for r in rows if r["status"] not in (CANCELLED, COVERED)]
    aging = {"current": {"count": 0, "total": 0.0},
             **{k: {"count": 0, "total": 0.0} for k, _, _ in BUCKETS}}
    forecast: Dict[str, Dict[str, float]] = {}
    due_to_date = paid_to_date = 0.0
    for r in live:
        for l in r["installments"]:
            when = str(l["due_date"])[:10]
            if when <= today:
                due_to_date += l["amount"]
                paid_to_date += l["paid"]
            if l["remaining"] <= CENT:
                continue
            if l["status"] == installments.OVERDUE:
                key = _bucket((date.fromisoformat(today) - date.fromisoformat(when)).days)
            else:
                key = "current"
            aging[key]["count"] += 1
            aging[key]["total"] = money(aging[key]["total"] + l["remaining"])
            if start <= when <= end:
                m = when[:7]
                f = forecast.setdefault(m, {"month": m, "due": 0.0, "count": 0})
                f["due"] = money(f["due"] + l["remaining"])
                f["count"] += 1

    summary = {
        "plans": len(live),
        "on_track": sum(1 for r in live if r["status"] == ON_TRACK),
        "late": sum(1 for r in live if r["status"] == LATE),
        "completed": sum(1 for r in live if r["status"] == COMPLETED),
        "cancelled": sum(1 for r in rows if r["status"] == CANCELLED),
        "covered": sum(1 for r in rows if r["status"] == COVERED),
        "scheduled": money(sum(r["total"] for r in live)),
        "collected": money(sum(r["paid"] for r in live)),
        "outstanding": money(sum(r["remaining"] for r in live)),
        "overdue": money(sum(r["overdue"] for r in live)),
        "overdue_installments": sum(r["overdue_count"] for r in live),
        "due_in_period": money(sum(r["due_in_period"] for r in live)),
        "scheduled_in_period": money(sum(r["scheduled_in_period"] for r in live)),
        # Of everything that has fallen due so far, the share actually paid.
        # The figure a collections manager is judged on.
        "collection_rate": round(paid_to_date / due_to_date * 100, 1) if due_to_date > CENT else None,
    }

    if status == "open":
        shown = [r for r in rows if r["status"] in (ON_TRACK, LATE)]
    elif status == "all":
        shown = rows
    else:
        shown = [r for r in rows if r["status"] == status]
    # Worst first: the longest in arrears, then the most overdue, then the
    # soonest payment — the order a collector works the list in.
    shown.sort(key=lambda r: (-r["days_late"], -r["overdue"],
                              r["next_due_date"] or "9999-12-31", (r["client_name"] or "").lower()))

    return {
        "as_of": today, "start": start, "end": end, "status": status,
        "summary": summary,
        "aging": aging,
        "forecast": sorted(forecast.values(), key=lambda f: f["month"]),
        "plans": shown,
    }
