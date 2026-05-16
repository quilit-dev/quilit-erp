from fastapi import APIRouter, Depends
from database import get_db
from permissions import require_perm
from utils import _today
import sqlite3

router = APIRouter()

def _can(user, db, module):
    if user.get("is_superadmin"):
        return True
    rid = user.get("role_id")
    if not rid:
        return False
    p = db.execute(
        "SELECT can_view FROM role_permissions WHERE role_id=? AND module=?", (rid, module)
    ).fetchone()
    return bool(p and p["can_view"])

@router.get("/")
def dashboard(user=Depends(require_perm("dashboard", "view")), db: sqlite3.Connection = Depends(get_db)):
    show_projects   = _can(user, db, "projects")
    show_quotes     = _can(user, db, "quotations")
    show_invoices   = _can(user, db, "invoices")
    show_finance    = _can(user, db, "finance")
    show_inventory  = _can(user, db, "inventory")

    active_projects = db.execute(
        "SELECT COUNT(*) AS c FROM projects"
        " WHERE status IN ('In Progress', 'Approved') AND deleted_at IS NULL"
    ).fetchone()["c"] if show_projects else None

    pending_quotes = db.execute(
        "SELECT COUNT(*) AS c FROM quotations"
        " WHERE status IN ('Draft', 'Sent') AND deleted_at IS NULL"
    ).fetchone()["c"] if show_quotes else None

    # Unpaid invoices — exclude soft-deleted invoices
    unpaid = db.execute(
        """SELECT COUNT(*) AS c,
                  COALESCE(SUM(i.amount -
                    COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                               WHERE ip.invoice_id = i.id), 0)
                  ), 0) AS total
           FROM invoices i
           WHERE i.deleted_at IS NULL
             AND i.amount > COALESCE(
                 (SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0
             )"""
    ).fetchone()

    monthly_income = db.execute(
        """SELECT COALESCE(SUM(ip.amount), 0) AS total
           FROM invoice_payments ip JOIN invoices i ON ip.invoice_id = i.id
           WHERE i.deleted_at IS NULL
             AND strftime('%Y-%m', ip.paid_at) = strftime('%Y-%m', 'now')"""
    ).fetchone()["total"] if show_finance or show_invoices else None

    monthly_expenses = db.execute(
        """SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
           WHERE deleted_at IS NULL
             AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now')"""
    ).fetchone()["total"] if show_finance else None

    low_stock = db.execute(
        "SELECT COUNT(*) AS c FROM inventory"
        " WHERE deleted_at IS NULL AND quantity <= min_stock AND min_stock > 0"
    ).fetchone()["c"] if show_inventory else None

    recent_projects = db.execute(
        """SELECT p.id, p.name, p.status, p.estimated_cost, c.name AS client_name
           FROM projects p LEFT JOIN clients c ON p.client_id = c.id
           WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 5"""
    ).fetchall() if show_projects else []

    recent_invoices_raw = db.execute(
        """SELECT i.id, i.invoice_number, i.amount,
                  COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                             WHERE ip.invoice_id = i.id), 0) AS total_paid,
                  c.name AS client_name
           FROM invoices i LEFT JOIN clients c ON i.client_id = c.id
           WHERE i.deleted_at IS NULL ORDER BY i.created_at DESC LIMIT 5"""
    ).fetchall() if show_invoices else []

    result_invoices = []
    for r in recent_invoices_raw:
        d = dict(r)
        paid = float(d["total_paid"]); amt = float(d["amount"])
        d["paid_amount"]    = paid
        d["payment_status"] = "Paid" if paid >= amt - 0.001 else "Partial" if paid > 0 else "Unpaid"
        result_invoices.append(d)

    overdue = db.execute(
        """SELECT COUNT(*) AS c,
                  COALESCE(SUM(i.amount -
                    COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                               WHERE ip.invoice_id = i.id), 0)), 0) AS total
           FROM invoices i
           WHERE i.deleted_at IS NULL AND i.due_date IS NOT NULL AND i.due_date < ?
             AND i.amount > COALESCE(
                 (SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0)""",
        (_today(),),
    ).fetchone() if show_invoices else None

    monthly_chart = db.execute(
        """SELECT strftime('%Y-%m', ip.paid_at) AS month, COALESCE(SUM(ip.amount),0) AS income
           FROM invoice_payments ip JOIN invoices i ON ip.invoice_id = i.id
           WHERE i.deleted_at IS NULL GROUP BY month ORDER BY month DESC LIMIT 6"""
    ).fetchall() if show_finance or show_invoices else []

    return {
        "active_projects":        active_projects,
        "pending_quotes":         pending_quotes,
        "unpaid_invoices_count":  unpaid["c"]      if show_invoices else None,
        "unpaid_invoices_amount": unpaid["total"]   if show_invoices else None,
        "overdue_invoices_count":  overdue["c"]     if overdue else None,
        "overdue_invoices_amount": overdue["total"] if overdue else None,
        "monthly_income":         monthly_income,
        "monthly_expenses":       monthly_expenses,
        "monthly_profit":         (monthly_income - monthly_expenses) if (monthly_income is not None and monthly_expenses is not None) else None,
        "low_stock_alerts":       low_stock,
        "recent_projects":        [dict(r) for r in recent_projects],
        "recent_invoices":        result_invoices,
        "monthly_chart":          [dict(r) for r in monthly_chart],
        "permissions": {
            "finance": show_finance, "invoices": show_invoices,
            "projects": show_projects, "quotes": show_quotes, "inventory": show_inventory,
        },
    }
