"""Sales by address: where the customers who bought in a period are.

A customer's address is one free-text box, so a location here is that text as
typed, with the differences nobody means ignored: letter case, spaces, and a
stray comma or full stop at either end. "Hamra, Beirut" and "hamra,  beirut."
are one place; "Beirut - Hamra" is another, because only the person who typed
it knows it is the same street.

Sales are counted the way the Profit Summary counts them, so the two reports
agree: live, approved invoices raised in the period, less the credit notes
issued in it. `sales` is net of VAT; `gross` includes it. `collected` is money
actually received in the period (credit-note settlements are not money), and
`outstanding` is what is still unpaid on the period's own invoices.

Archived customers are left out, as in the Client Revenue report.

The address used is the customer's address today: the record keeps no history
of where a customer used to be.

Figures are in the company's own currency.
"""
from collections import Counter, defaultdict
from typing import Any, Dict, Optional

import returns
from utils import money

NO_ADDRESS = "no_address"   # a customer whose address box is empty
WALK_IN = "walk_in"         # a sale with no customer on it (a till sale)
_FIGURES = ("sales", "gross", "collected", "outstanding")
_TRIM = " ,.;-/"


def normalise(address: Optional[str]) -> str:
    """The grouping key for an address: lower case, single spaces, no
    punctuation hanging off either end. Empty for no address."""
    return " ".join(str(address or "").lower().split()).strip(_TRIM)


def _shown(address: str) -> str:
    return " ".join(str(address or "").split()).strip(_TRIM)


def _blank() -> Dict[str, float]:
    return {"invoices": 0, **{k: 0.0 for k in _FIGURES}}


def build(db, *, start: str, end: str, bf_i: str = "", bp_i=()) -> Dict[str, Any]:
    clients, archived = {}, set()
    for r in db.execute(
            "SELECT id, name, company, address, archived_at FROM clients").fetchall():
        if r["archived_at"]:
            archived.add(r["id"])
        else:
            clients[r["id"]] = dict(r)

    per_client: Dict[Optional[int], Dict[str, float]] = defaultdict(_blank)

    for r in db.execute(
            "SELECT i.client_id, i.subtotal, i.amount, "
            "       COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip "
            "                  WHERE ip.invoice_id = i.id), 0) AS paid "
            "  FROM invoices i "
            " WHERE i.voided_at IS NULL AND i.archived_at IS NULL "
            "   AND COALESCE(i.approval_status, '') <> 'Pending Approval' "
            "   AND DATE(i.created_at) BETWEEN ? AND ?" + bf_i,
            (start, end, *bp_i)).fetchall():
        c = per_client[r["client_id"]]
        gross = float(r["amount"] or 0)
        c["invoices"] += 1
        c["gross"] += gross
        c["sales"] += float(r["subtotal"]) if r["subtotal"] is not None else gross
        c["outstanding"] += max(0.0, gross - float(r["paid"] or 0))

    # Credit notes come off sales in the period they are issued, under the
    # customer of the invoice they reverse.
    for r in db.execute(
            "SELECT i.client_id, r.subtotal, r.total "
            "  FROM sales_returns r JOIN invoices i ON i.id = r.invoice_id "
            " WHERE r.voided_at IS NULL AND r.return_date BETWEEN ? AND ?" + bf_i,
            (start, end, *bp_i)).fetchall():
        c = per_client[r["client_id"]]
        c["sales"] -= float(r["subtotal"] or 0)
        c["gross"] -= float(r["total"] or 0)

    for r in db.execute(
            f"SELECT i.client_id, SUM(ip.amount) AS amount "
            f"  FROM {returns.CASH_RECEIPTS} ip JOIN invoices i ON i.id = ip.invoice_id "
            f" WHERE i.voided_at IS NULL AND i.archived_at IS NULL "
            f"   AND DATE(ip.paid_at) BETWEEN ? AND ?{bf_i} "
            f" GROUP BY i.client_id",
            (start, end, *bp_i)).fetchall():
        per_client[r["client_id"]]["collected"] += float(r["amount"] or 0)

    groups: Dict[str, Dict[str, Any]] = {}
    spellings: Dict[str, Counter] = defaultdict(Counter)
    for cid, fig in per_client.items():
        if not fig["invoices"] and not any(abs(fig[k]) > 0.005 for k in _FIGURES):
            continue
        # An archived customer is left out altogether, as in Client Revenue:
        # they are not a place the business sells to any more.
        if cid in archived:
            continue
        cl = clients.get(cid) if cid is not None else None
        if cl is None:
            key = kind = WALK_IN
        else:
            key = normalise(cl.get("address"))
            kind = "address" if key else NO_ADDRESS
            key = key or NO_ADDRESS
            if kind == "address":
                # Weighted by what each customer bought, so the place is
                # shown as its main customers wrote it, not by a coin toss.
                spellings[key][_shown(cl["address"])] += abs(fig["sales"]) + 1
        g = groups.setdefault(key, {
            "key": key, "kind": kind, "address": None, "customers": 0,
            **_blank(), "clients": []})
        for k in ("invoices", *_FIGURES):
            g[k] += fig[k]
        if cl is not None:
            g["customers"] += 1
            g["clients"].append({
                "id": cid, "name": cl["name"], "company": cl.get("company"),
                "address": cl.get("address"), "invoices": fig["invoices"],
                **{k: money(fig[k]) for k in _FIGURES}})

    rows = list(groups.values())
    total_sales = sum(g["sales"] for g in rows)
    for g in rows:
        if g["kind"] == "address":
            # The spelling its biggest customers used.
            g["address"] = spellings[g["key"]].most_common(1)[0][0]
        for k in _FIGURES:
            g[k] = money(g[k])
        g["share"] = round(g["sales"] / total_sales * 100, 1) if abs(total_sales) > 0.005 else None
        g["clients"].sort(key=lambda c: (-c["sales"], (c["name"] or "").lower()))
    # Real places first, biggest first; "no address" and walk-in sales last.
    rows.sort(key=lambda g: (g["kind"] != "address", -g["sales"], g["address"] or ""))

    return {
        "start": start, "end": end,
        "summary": {
            "locations": sum(1 for g in rows if g["kind"] == "address"),
            "customers": sum(g["customers"] for g in rows),
            "invoices": sum(g["invoices"] for g in rows),
            **{k: money(sum(g[k] for g in rows)) for k in _FIGURES},
            # The part of the period's sales with no address to put it under:
            # the figure that says how much of the picture is missing.
            "unlocated_sales": money(sum(g["sales"] for g in rows if g["kind"] != "address")),
        },
        "locations": rows,
    }
