"""
Reports router — cross-entity analytical reports for business intelligence.
"""
from fastapi import APIRouter, Depends, Query
from database import get_db
from permissions import require_perm
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

    total_invoiced = db.execute(
        """SELECT COALESCE(SUM(amount), 0) FROM invoices
           WHERE voided_at IS NULL AND archived_at IS NULL
             AND DATE(created_at) BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()[0]

    return {
        "total_income":    total_income,
        "total_expenses":  total_expenses,
        "net_profit":      total_income - total_expenses,
        "margin_pct":      round((total_income - total_expenses) / total_income * 100, 1) if total_income > 0 else 0,
        "total_invoiced":  total_invoiced,
        "outstanding":     max(0, total_invoiced - total_income),
        "monthly":         monthly,
        "by_category":     [dict(r) for r in by_category],
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
