"""
Reports router — cross-entity analytical reports for business intelligence.
"""
from fastapi import APIRouter, Depends, Query
from database import get_db
from permissions import require_perm
from utils import get_tax_context
from datetime import date
from typing import Optional
import sqlite3

router = APIRouter()


def _today():
    return date.today().isoformat()


def _year_start():
    return f"{date.today().year}-01-01"


# ── 1. Financial Summary ────────────────────────────────────────────────────
@router.get("/financial")
def report_financial(
    start: Optional[str] = Query(None),
    end:   Optional[str] = Query(None),
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    start = start or _year_start()
    end   = end   or _today()

    total_income = db.execute(
        """SELECT COALESCE(SUM(ip.amount), 0)
           FROM invoice_payments ip
           JOIN invoices i ON ip.invoice_id = i.id
           WHERE DATE(ip.paid_at) BETWEEN ? AND ?
             AND i.voided_at IS NULL AND i.archived_at IS NULL""",
        (start, end),
    ).fetchone()[0]

    total_expenses = db.execute(
        """SELECT COALESCE(SUM(amount), 0) FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()[0]

    inc_rows = db.execute(
        """SELECT strftime('%Y-%m', ip.paid_at) AS m, COALESCE(SUM(ip.amount), 0) AS v
           FROM invoice_payments ip
           JOIN invoices i ON ip.invoice_id = i.id
           WHERE DATE(ip.paid_at) BETWEEN ? AND ?
             AND i.voided_at IS NULL AND i.archived_at IS NULL
           GROUP BY m ORDER BY m""",
        (start, end),
    ).fetchall()

    exp_rows = db.execute(
        """SELECT strftime('%Y-%m', date) AS m, COALESCE(SUM(amount), 0) AS v
           FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?
           GROUP BY m ORDER BY m""",
        (start, end),
    ).fetchall()

    inc_map = {r["m"]: r["v"] for r in inc_rows}
    exp_map = {r["m"]: r["v"] for r in exp_rows}
    months  = sorted(set(inc_map) | set(exp_map))
    monthly = [
        {
            "month":    m,
            "income":   inc_map.get(m, 0),
            "expenses": exp_map.get(m, 0),
            "profit":   inc_map.get(m, 0) - exp_map.get(m, 0),
        }
        for m in months
    ]

    by_category = db.execute(
        """SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
           FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?
           GROUP BY category ORDER BY total DESC""",
        (start, end),
    ).fetchall()

    inv_totals = db.execute(
        """SELECT COALESCE(SUM(amount),0)    AS gross,
                  COALESCE(SUM(subtotal),0)  AS net,
                  COALESCE(SUM(tax_total),0) AS vat
           FROM invoices
           WHERE voided_at IS NULL AND archived_at IS NULL
             AND DATE(created_at) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()
    total_invoiced = float(inv_totals["gross"] or 0)

    # Net-of-VAT view: VAT is a pass-through, not income. We expose it so a
    # P&L reader can see "real" revenue/cost separately from the cash-flow
    # totals above. Expense net is computed line by line because each row's
    # `tax_amount` is the VAT extracted from its inclusive `amount`.
    exp_net_row = db.execute(
        """SELECT COALESCE(SUM(amount - tax_amount), 0) AS net,
                  COALESCE(SUM(tax_amount), 0)          AS vat
           FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()

    return {
        "total_income":    total_income,
        "total_expenses":  total_expenses,
        "net_profit":      total_income - total_expenses,
        "margin_pct":      round((total_income - total_expenses) / total_income * 100, 1) if total_income > 0 else 0,
        "total_invoiced":  total_invoiced,
        "outstanding":     max(0, total_invoiced - total_income),
        "monthly":         monthly,
        "by_category":     [dict(r) for r in by_category],
        # ── Net-of-VAT view (accrual-basis, derived from frozen snapshots) ─
        "invoiced_net":    round(float(inv_totals["net"] or 0), 2),
        "invoiced_vat":    round(float(inv_totals["vat"] or 0), 2),
        "expenses_net":    round(float(exp_net_row["net"] or 0), 2),
        "expenses_vat":    round(float(exp_net_row["vat"] or 0), 2),
    }


# ── 2. Project Profitability ────────────────────────────────────────────────
@router.get("/projects")
def report_projects(
    start:  Optional[str] = Query(None),
    end:    Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    start = start or _year_start()
    end   = end   or _today()

    rows = db.execute(
        """SELECT
               p.id, p.name, p.status, p.start_date, p.end_date,
               p.estimated_cost, p.expected_revenue, p.created_at,
               c.name AS client_name,
               COALESCE((
                   SELECT SUM(e.amount) FROM expenses e
                   WHERE e.project_id = p.id
                     AND e.archived_at IS NULL AND e.voided_at IS NULL
               ), 0) AS actual_expenses,
               COALESCE((
                   SELECT SUM(ip.amount) FROM invoice_payments ip
                   JOIN invoices i ON ip.invoice_id = i.id
                   WHERE i.project_id = p.id
                     AND i.voided_at IS NULL AND i.archived_at IS NULL
               ), 0) AS collected,
               COALESCE((
                   SELECT SUM(i.amount) FROM invoices i
                   WHERE i.project_id = p.id
                     AND i.voided_at IS NULL AND i.archived_at IS NULL
               ), 0) AS total_invoiced
           FROM projects p
           LEFT JOIN clients c ON p.client_id = c.id
           WHERE p.archived_at IS NULL
             AND (? IS NULL OR p.status = ?)
             AND DATE(p.created_at) BETWEEN ? AND ?
           ORDER BY p.created_at DESC""",
        (status, status, start, end),
    ).fetchall()

    result = []
    for r in rows:
        d = dict(r)
        revenue  = d["expected_revenue"] or 0
        expenses = d["actual_expenses"]  or 0
        profit   = revenue - expenses
        margin   = round(profit / revenue * 100, 1) if revenue > 0 else 0
        result.append({
            **d,
            "profit":     profit,
            "margin_pct": margin,
            "outstanding": max(0, d["total_invoiced"] - d["collected"]),
        })

    return result


# ── 3. Client Revenue ────────────────────────────────────────────────────────
@router.get("/clients")
def report_clients(
    start: Optional[str] = Query(None),
    end:   Optional[str] = Query(None),
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    start = start or _year_start()
    end   = end   or _today()

    rows = db.execute(
        """SELECT
               c.id, c.name, c.company, c.type,
               COUNT(DISTINCT p.id) AS project_count,
               COALESCE((
                   SELECT SUM(i.amount) FROM invoices i
                   WHERE i.client_id = c.id
                     AND i.voided_at IS NULL AND i.archived_at IS NULL
                     AND DATE(i.created_at) BETWEEN ? AND ?
               ), 0) AS total_invoiced,
               COALESCE((
                   SELECT SUM(ip.amount) FROM invoice_payments ip
                   JOIN invoices i2 ON ip.invoice_id = i2.id
                   WHERE i2.client_id = c.id
                     AND i2.voided_at IS NULL AND i2.archived_at IS NULL
                     AND DATE(ip.paid_at) BETWEEN ? AND ?
               ), 0) AS total_paid,
               COUNT(DISTINCT inv.id) AS invoice_count,
               COUNT(DISTINCT q.id) AS quote_count
           FROM clients c
           LEFT JOIN projects p
               ON p.client_id = c.id AND p.archived_at IS NULL
           LEFT JOIN invoices inv
               ON inv.client_id = c.id AND inv.voided_at IS NULL AND inv.archived_at IS NULL
               AND DATE(inv.created_at) BETWEEN ? AND ?
           LEFT JOIN quotations q
               ON q.client_id = c.id AND q.archived_at IS NULL
               AND DATE(q.created_at) BETWEEN ? AND ?
           WHERE c.archived_at IS NULL
           GROUP BY c.id
           ORDER BY total_paid DESC""",
        (start, end, start, end, start, end, start, end),
    ).fetchall()

    result = []
    for r in rows:
        d = dict(r)
        d["outstanding"] = max(0, d["total_invoiced"] - d["total_paid"])
        result.append(d)

    return result


# ── 4. Invoice Aging ─────────────────────────────────────────────────────────
@router.get("/invoice-aging")
def report_invoice_aging(
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    from datetime import datetime as dt

    today = date.today()

    invoices = db.execute(
        """SELECT
               i.id, i.invoice_number, i.amount, i.due_date, i.created_at,
               c.name AS client_name,
               p.name AS project_name,
               COALESCE((
                   SELECT SUM(ip.amount) FROM invoice_payments ip
                   WHERE ip.invoice_id = i.id
               ), 0) AS paid_amount
           FROM invoices i
           LEFT JOIN clients c ON i.client_id = c.id
           LEFT JOIN projects p ON i.project_id = p.id
           WHERE i.voided_at IS NULL AND i.archived_at IS NULL
             AND COALESCE((
                 SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id
             ), 0) < i.amount
           ORDER BY i.due_date""",
        (),
    ).fetchall()

    buckets = {"current": [], "1_30": [], "31_60": [], "61_90": [], "over_90": []}

    for inv in invoices:
        d = dict(inv)
        d["remaining"] = d["amount"] - d["paid_amount"]
        d["days_overdue"] = 0

        if not d["due_date"]:
            buckets["current"].append(d)
            continue

        try:
            due_d = dt.fromisoformat(str(d["due_date"])[:10]).date()
            overdue = (today - due_d).days
        except Exception:
            buckets["current"].append(d)
            continue

        d["days_overdue"] = max(0, overdue)

        if overdue <= 0:
            buckets["current"].append(d)
        elif overdue <= 30:
            buckets["1_30"].append(d)
        elif overdue <= 60:
            buckets["31_60"].append(d)
        elif overdue <= 90:
            buckets["61_90"].append(d)
        else:
            buckets["over_90"].append(d)

    summary = {
        k: {"count": len(v), "total": round(sum(x["remaining"] for x in v), 2)}
        for k, v in buckets.items()
    }

    all_invoices = [inv for lst in buckets.values() for inv in lst]
    all_invoices.sort(key=lambda x: x.get("days_overdue", 0), reverse=True)

    return {"summary": summary, "invoices": all_invoices}


# ── 5. Expense Analysis ─────────────────────────────────────────────────────
@router.get("/expenses")
def report_expenses(
    start:    Optional[str] = Query(None),
    end:      Optional[str] = Query(None),
    group_by: str = Query("category"),
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    start = start or _year_start()
    end   = end   or _today()

    if group_by == "project":
        rows = db.execute(
            """SELECT COALESCE(p.name, 'General / No Project') AS group_name,
                      COALESCE(SUM(e.amount), 0) AS total, COUNT(*) AS count
               FROM expenses e
               LEFT JOIN projects p ON e.project_id = p.id
               WHERE e.archived_at IS NULL AND e.voided_at IS NULL
                 AND DATE(e.date) BETWEEN ? AND ?
               GROUP BY group_name ORDER BY total DESC""",
            (start, end),
        ).fetchall()
    elif group_by == "month":
        rows = db.execute(
            """SELECT strftime('%Y-%m', date) AS group_name,
                      COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
               FROM expenses
               WHERE archived_at IS NULL AND voided_at IS NULL
                 AND DATE(date) BETWEEN ? AND ?
               GROUP BY group_name ORDER BY group_name""",
            (start, end),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT category AS group_name, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
               FROM expenses
               WHERE archived_at IS NULL AND voided_at IS NULL
                 AND DATE(date) BETWEEN ? AND ?
               GROUP BY group_name ORDER BY total DESC""",
            (start, end),
        ).fetchall()

    data = [dict(r) for r in rows]
    grand_total = sum(r["total"] for r in data)
    for r in data:
        r["pct"] = round(r["total"] / grand_total * 100, 1) if grand_total > 0 else 0

    count = db.execute(
        """SELECT COUNT(*) FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()[0]

    return {
        "total":     grand_total,
        "count":     count,
        "average":   round(grand_total / count, 2) if count > 0 else 0,
        "breakdown": data,
    }


# ── 6. Sales Pipeline ────────────────────────────────────────────────────────
@router.get("/pipeline")
def report_pipeline(
    start: Optional[str] = Query(None),
    end:   Optional[str] = Query(None),
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    start = start or _year_start()
    end   = end   or _today()

    by_status = db.execute(
        """SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS value
           FROM quotations
           WHERE archived_at IS NULL
             AND DATE(created_at) BETWEEN ? AND ?
           GROUP BY status ORDER BY count DESC""",
        (start, end),
    ).fetchall()

    totals = db.execute(
        """SELECT COUNT(*), COALESCE(SUM(total), 0) FROM quotations
           WHERE archived_at IS NULL AND DATE(created_at) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()

    converted = db.execute(
        """SELECT COUNT(*) FROM quotations
           WHERE archived_at IS NULL AND DATE(created_at) BETWEEN ? AND ?
             AND status IN ('Accepted', 'Invoiced')""",
        (start, end),
    ).fetchone()[0]

    total_count = totals[0] or 0
    total_value = totals[1] or 0

    top_clients = db.execute(
        """SELECT c.name AS client_name, COUNT(q.id) AS count,
                  COALESCE(SUM(q.total), 0) AS value
           FROM quotations q
           JOIN clients c ON q.client_id = c.id
           WHERE q.archived_at IS NULL
             AND DATE(q.created_at) BETWEEN ? AND ?
           GROUP BY c.id ORDER BY value DESC LIMIT 10""",
        (start, end),
    ).fetchall()

    monthly_quotes = db.execute(
        """SELECT strftime('%Y-%m', created_at) AS month,
                  COUNT(*) AS count, COALESCE(SUM(total), 0) AS value
           FROM quotations
           WHERE archived_at IS NULL
             AND DATE(created_at) BETWEEN ? AND ?
           GROUP BY month ORDER BY month""",
        (start, end),
    ).fetchall()

    return {
        "total_count":      total_count,
        "total_value":      total_value,
        "converted_count":  converted,
        "conversion_rate":  round(converted / total_count * 100, 1) if total_count > 0 else 0,
        "by_status":        [dict(r) for r in by_status],
        "top_clients":      [dict(r) for r in top_clients],
        "monthly":          [dict(r) for r in monthly_quotes],
    }


# ── 7. VAT Summary (Lebanon) ────────────────────────────────────────────────
@router.get("/vat")
def report_vat(
    start: Optional[str] = Query(None),
    end:   Optional[str] = Query(None),
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """VAT declaration figures for the period.

    Methodology
    -----------
    Every figure is read from the **frozen tax snapshot** that was written
    onto the document at creation — `invoice_items.tax_rate / .tax_amount`,
    `expenses.tax_rate / .tax_amount`, etc. The report never re-applies the
    current `tax_rates` table to historical data: changing a rate's value
    or deactivating it never rewrites already-issued documents.

    Output VAT  — invoices issued in the period, excluding voids and
                  archived. A POS refund voids the linked invoice, so
                  refunded sales are correctly excluded here.

    Input VAT   — expenses dated in the period, excluding voided/archived.
                  Purchases (PO) post a matching expense row when their
                  status reaches Paid, with the same tax snapshot — so
                  PO input VAT is included via that path without being
                  double-counted from the `purchases` table.

    Per-rate breakdown — taxable base + VAT for each active rate, plus a
    catch-all bucket for historical rates that have since been deactivated
    or had their value changed (handled gracefully by joining on the
    snapshot, not the live tax_rates table).
    """
    start = start or _year_start()
    end   = end   or _today()

    ctx      = get_tax_context(db)
    def_rate = ctx["rates"].get(ctx["default_id"], {}).get("rate", 0) if ctx["default_id"] else 0

    # ── Headline totals ────────────────────────────────────────────────────
    out_row = db.execute(
        """SELECT COALESCE(SUM(amount),0) AS gross, COALESCE(SUM(tax_total),0) AS vat
           FROM invoices
           WHERE voided_at IS NULL AND archived_at IS NULL
             AND DATE(created_at) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()
    inp_row = db.execute(
        """SELECT COALESCE(SUM(amount),0) AS gross, COALESCE(SUM(tax_amount),0) AS vat
           FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()

    def split(gross, vat):
        gross, vat = round(gross or 0, 2), round(vat or 0, 2)
        return {"gross": gross, "vat": vat, "net": round(gross - vat, 2)}

    out = split(out_row["gross"], out_row["vat"])
    inp = split(inp_row["gross"], inp_row["vat"])

    # ── Per-rate breakdown ─────────────────────────────────────────────────
    # We group by the *snapshot rate value* on the line so a historical rate
    # that was 10% and later edited to 11% still surfaces as "10%". Lines
    # with no rate / 0% are bucketed as "exempt or zero-rated".
    out_by_rate = db.execute(
        """SELECT ii.tax_rate AS rate,
                  COALESCE(SUM(ii.quantity * ii.unit_price), 0) AS base,
                  COALESCE(SUM(ii.tax_amount), 0)               AS vat
           FROM invoice_items ii
           JOIN invoices i ON ii.invoice_id = i.id
           WHERE i.voided_at IS NULL AND i.archived_at IS NULL
             AND DATE(i.created_at) BETWEEN ? AND ?
           GROUP BY ii.tax_rate ORDER BY ii.tax_rate""",
        (start, end),
    ).fetchall()
    inp_by_rate = db.execute(
        """SELECT tax_rate AS rate,
                  COALESCE(SUM(amount - tax_amount), 0) AS base,
                  COALESCE(SUM(tax_amount), 0)          AS vat
           FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?
           GROUP BY tax_rate ORDER BY tax_rate""",
        (start, end),
    ).fetchall()

    def _by_rate(rows):
        out = []
        for r in rows:
            rate = round(float(r["rate"] or 0), 4)
            out.append({
                "rate":  rate,
                "label": ("Exempt / zero-rated" if rate <= 0 else f"{rate:g}%"),
                "base":  round(float(r["base"] or 0), 2),
                "vat":   round(float(r["vat"] or 0), 2),
            })
        return out

    output_by_rate = _by_rate(out_by_rate)
    input_by_rate  = _by_rate(inp_by_rate)

    # ── Monthly timeline ───────────────────────────────────────────────────
    inc_rows = db.execute(
        """SELECT strftime('%Y-%m', created_at) AS m,
                  COALESCE(SUM(tax_total),0) AS v,
                  COALESCE(SUM(subtotal),0)  AS b
           FROM invoices
           WHERE voided_at IS NULL AND archived_at IS NULL
             AND DATE(created_at) BETWEEN ? AND ?
           GROUP BY m""",
        (start, end),
    ).fetchall()
    exp_rows = db.execute(
        """SELECT strftime('%Y-%m', date) AS m,
                  COALESCE(SUM(tax_amount),0)         AS v,
                  COALESCE(SUM(amount - tax_amount),0) AS b
           FROM expenses
           WHERE archived_at IS NULL AND voided_at IS NULL
             AND DATE(date) BETWEEN ? AND ?
           GROUP BY m""",
        (start, end),
    ).fetchall()
    inc_map = {r["m"]: {"v": r["v"], "b": r["b"]} for r in inc_rows}
    exp_map = {r["m"]: {"v": r["v"], "b": r["b"]} for r in exp_rows}
    monthly = []
    empty = {"v": 0, "b": 0}
    for m in sorted(set(inc_map) | set(exp_map)):
        ov = round(float(inc_map.get(m, empty)["v"] or 0), 2)
        iv = round(float(exp_map.get(m, empty)["v"] or 0), 2)
        ob = round(float(inc_map.get(m, empty)["b"] or 0), 2)
        ib = round(float(exp_map.get(m, empty)["b"] or 0), 2)
        monthly.append({
            "month": m,
            "output_base": ob, "output_vat": ov,
            "input_base":  ib, "input_vat":  iv,
            "net_vat":     round(ov - iv, 2),
        })

    return {
        "vat_enabled":    ctx["enabled"] or (out["vat"] + inp["vat"]) > 0,
        "rate":           round(def_rate, 4),     # legacy single-rate field
        "start":          start,
        "end":            end,
        "output":         out,
        "input":          inp,
        "net_vat":        round(out["vat"] - inp["vat"], 2),
        "monthly":        monthly,
        "output_by_rate": output_by_rate,
        "input_by_rate":  input_by_rate,
        "active_rates":   [
            {"id": rid, "name": r["name"], "rate": r["rate"], "tax_type": r["tax_type"]}
            for rid, r in ctx["rates"].items()
        ],
    }


# ── Inventory valuation by warehouse ────────────────────────────────────────
# Per Phase 3 of the multi-warehouse rollout. The valuation is intentionally
# computed at the COMPANY-WIDE unit cost (`inventory.unit_cost`) — not per-
# warehouse — because per-warehouse costing was deferred in the design ("we
# don't have a clear business need for warehouse-level costing yet"). Same
# item across warehouses is valued identically, only quantities differ. When
# that ever changes, this query is the single place to update.

@router.get("/inventory-by-warehouse")
def report_inventory_by_warehouse(
    user=Depends(require_perm("reports", "view")),
    db: sqlite3.Connection = Depends(get_db),
):
    """Inventory holdings + valuation per warehouse, plus a 'totals' row that
    sums across warehouses (matches the GL Inventory account by construction)."""
    # Pull every active warehouse and aggregate stock currently sitting there.
    # LEFT JOIN inventory_stock so an empty warehouse still appears as a row
    # with zero counts — the operator wants to see all locations.
    by_wh = db.execute(
        "SELECT w.id, w.code, w.name, w.type, w.is_default, "
        "       COALESCE(COUNT(s.inventory_id), 0)         AS sku_count, "
        "       COALESCE(SUM(s.quantity), 0)               AS qty_total, "
        "       COALESCE(SUM(s.quantity * COALESCE(i.unit_cost, 0)), 0) AS value "
        "FROM warehouses w "
        "LEFT JOIN inventory_stock s ON s.warehouse_id = w.id "
        "LEFT JOIN inventory i       ON i.id = s.inventory_id "
        "                            AND i.archived_at IS NULL AND i.deleted_at IS NULL "
        "WHERE w.is_active = 1 AND w.archived_at IS NULL "
        "GROUP BY w.id, w.code, w.name, w.type, w.is_default "
        "ORDER BY w.is_default DESC, w.code"
    ).fetchall()

    # Top SKUs by total value across the company, with the warehouse holding
    # the largest share so the operator can see "Pine planks are mostly in
    # MAIN; iron nails are split 60/40 between MAIN and BRANCH-A".
    top_skus = db.execute(
        "SELECT i.id, i.name, i.unit, i.category, "
        "       COALESCE(SUM(s.quantity), 0) AS qty_total, "
        "       i.unit_cost AS unit_cost, "
        "       COALESCE(SUM(s.quantity), 0) * COALESCE(i.unit_cost, 0) AS value, "
        "       ("
        "         SELECT w2.code FROM inventory_stock s2 "
        "         JOIN warehouses w2 ON w2.id = s2.warehouse_id "
        "         WHERE s2.inventory_id = i.id AND w2.is_active = 1 "
        "           AND w2.archived_at IS NULL "
        "         ORDER BY s2.quantity DESC LIMIT 1"
        "       ) AS top_warehouse_code "
        "FROM inventory i "
        "LEFT JOIN inventory_stock s ON s.inventory_id = i.id "
        "WHERE i.archived_at IS NULL AND i.deleted_at IS NULL "
        "GROUP BY i.id, i.name, i.unit, i.category, i.unit_cost "
        "HAVING COALESCE(SUM(s.quantity), 0) > 0 "
        "ORDER BY value DESC LIMIT 25"
    ).fetchall()

    rows = [dict(r) for r in by_wh]
    totals = {
        "sku_count": sum(r["sku_count"] for r in rows),
        "qty_total": round(sum(float(r["qty_total"] or 0) for r in rows), 2),
        "value":     round(sum(float(r["value"]     or 0) for r in rows), 2),
    }
    return {
        "warehouses": rows,
        "totals":     totals,
        "top_skus":   [dict(s) for s in top_skus],
    }
