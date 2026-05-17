"""
Global search — queries all accessible modules for a given term.
Results are permission-filtered: only modules the user can view are searched.
Each module query is wrapped in try/except so a schema mismatch in one table
never silences results from all other tables. Failures are logged (with the
traceback) instead of being silently swallowed, so a broken query is diagnosable.
"""
import logging
from fastapi import APIRouter, Depends, Query
from database import get_db
from permissions import require_auth
import sqlite3

router = APIRouter()
logger = logging.getLogger("erp.search")

def _can(user: dict, db: sqlite3.Connection, module: str) -> bool:
    if user.get("is_superadmin"):
        return True
    rid = user.get("role_id")
    if not rid:
        return False
    p = db.execute(
        "SELECT can_view FROM role_permissions WHERE role_id=? AND module=?",
        (rid, module),
    ).fetchone()
    return bool(p and p["can_view"])


def _money(v) -> str:
    try:
        return f"${(v or 0):,.2f}"
    except Exception:
        return "$0.00"


@router.get("/")
def search_all(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(5, ge=1, le=20),
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    term = f"%{q}%"
    results = []

    # ── Clients ───────────────────────────────────────────────────────────
    if _can(user, db, "clients"):
        try:
            rows = db.execute(
                "SELECT id, name, company, phone, email FROM clients"
                " WHERE deleted_at IS NULL"
                "   AND (name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?)"
                " LIMIT ?",
                (term, term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "client",
                    "title":    r["name"],
                    "subtitle": r["company"] or r["email"] or r["phone"] or "",
                    "url":      f"/clients/{r['id']}",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Projects ──────────────────────────────────────────────────────────
    if _can(user, db, "projects"):
        try:
            rows = db.execute(
                "SELECT p.id, p.name, p.status, c.name AS client_name"
                " FROM projects p LEFT JOIN clients c ON p.client_id = c.id"
                " WHERE p.deleted_at IS NULL AND (p.name LIKE ? OR p.status LIKE ?)"
                " LIMIT ?",
                (term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "project",
                    "title":    r["name"],
                    "subtitle": f"{r['status']} — {r['client_name'] or ''}",
                    "url":      f"/projects/{r['id']}",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Invoices ──────────────────────────────────────────────────────────
    if _can(user, db, "invoices"):
        try:
            rows = db.execute(
                "SELECT i.id, i.invoice_number, i.amount, i.notes, c.name AS client_name"
                " FROM invoices i LEFT JOIN clients c ON i.client_id = c.id"
                " WHERE i.deleted_at IS NULL"
                "   AND (i.invoice_number LIKE ? OR c.name LIKE ? OR i.notes LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "invoice",
                    "title":    r["invoice_number"],
                    "subtitle": f"{r['client_name'] or ''} — {_money(r['amount'])}",
                    "url":      "/invoices",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Quotations ────────────────────────────────────────────────────────
    if _can(user, db, "quotations"):
        try:
            rows = db.execute(
                "SELECT q.id, q.quote_number, q.project_name, q.total, c.name AS client_name"
                " FROM quotations q LEFT JOIN clients c ON q.client_id = c.id"
                " WHERE q.deleted_at IS NULL"
                "   AND (q.quote_number LIKE ? OR c.name LIKE ? OR q.project_name LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "quotation",
                    "title":    r["quote_number"],
                    "subtitle": r["client_name"] or r["project_name"] or "",
                    "url":      "/quotations",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Inventory ─────────────────────────────────────────────────────────
    if _can(user, db, "inventory"):
        try:
            rows = db.execute(
                "SELECT id, name, category, supplier FROM inventory"
                " WHERE deleted_at IS NULL"
                "   AND (name LIKE ? OR category LIKE ? OR supplier LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "inventory",
                    "title":    r["name"],
                    "subtitle": f"{r['category'] or ''}{(' — ' + r['supplier']) if r['supplier'] else ''}",
                    "url":      "/inventory",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Purchases ─────────────────────────────────────────────────────────
    if _can(user, db, "purchases"):
        try:
            rows = db.execute(
                "SELECT id, po_number, product_name, supplier, status FROM purchases"
                " WHERE deleted_at IS NULL"
                "   AND (po_number LIKE ? OR product_name LIKE ? OR supplier LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "purchase",
                    "title":    r["po_number"],
                    "subtitle": f"{r['product_name'] or ''}{(' — ' + r['supplier']) if r['supplier'] else ''}",
                    "url":      "/purchases",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Suppliers ─────────────────────────────────────────────────────────
    if _can(user, db, "suppliers"):
        try:
            rows = db.execute(
                "SELECT id, name, contact_name, phone, email FROM suppliers"
                " WHERE deleted_at IS NULL"
                "   AND (name LIKE ? OR contact_name LIKE ? OR phone LIKE ? OR email LIKE ?)"
                " LIMIT ?",
                (term, term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "supplier",
                    "title":    r["name"],
                    "subtitle": r["contact_name"] or r["email"] or r["phone"] or "",
                    "url":      f"/suppliers/{r['id']}",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Expenses ──────────────────────────────────────────────────────────
    if _can(user, db, "expenses"):
        try:
            rows = db.execute(
                "SELECT e.id, e.category, e.description, e.amount, e.date,"
                "       p.name AS project_name"
                " FROM expenses e LEFT JOIN projects p ON e.project_id = p.id"
                " WHERE e.deleted_at IS NULL AND e.archived_at IS NULL"
                "   AND (e.category LIKE ? OR e.description LIKE ? OR p.name LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                title = r["description"] or r["category"] or "Expense"
                bits = [r["category"] or "", _money(r["amount"])]
                if r["project_name"]:
                    bits.append(r["project_name"])
                results.append({
                    "id":       r["id"],
                    "type":     "expense",
                    "title":    title,
                    "subtitle": " — ".join(b for b in bits if b),
                    "url":      "/expenses",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── CRM — Leads ───────────────────────────────────────────────────────
    if _can(user, db, "crm"):
        try:
            rows = db.execute(
                "SELECT id, name, company, email, phone, status FROM crm_leads"
                " WHERE archived_at IS NULL"
                "   AND (name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ?)"
                " LIMIT ?",
                (term, term, term, term, limit),
            ).fetchall()
            for r in rows:
                bits = [r["company"] or r["email"] or r["phone"] or "", r["status"] or ""]
                results.append({
                    "id":       r["id"],
                    "type":     "lead",
                    "title":    r["name"],
                    "subtitle": " — ".join(b for b in bits if b),
                    "url":      "/crm",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

        # ── CRM — Deals ───────────────────────────────────────────────────
        try:
            rows = db.execute(
                "SELECT d.id, d.title, d.stage, d.value, c.name AS client_name"
                " FROM crm_deals d LEFT JOIN clients c ON d.client_id = c.id"
                " WHERE d.archived_at IS NULL AND (d.title LIKE ? OR c.name LIKE ?)"
                " LIMIT ?",
                (term, term, limit),
            ).fetchall()
            for r in rows:
                bits = [r["stage"] or "", _money(r["value"])]
                if r["client_name"]:
                    bits.append(r["client_name"])
                results.append({
                    "id":       r["id"],
                    "type":     "deal",
                    "title":    r["title"],
                    "subtitle": " — ".join(b for b in bits if b),
                    "url":      "/crm",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

        # ── CRM — Contacts ────────────────────────────────────────────────
        try:
            rows = db.execute(
                "SELECT id, name, title, email, phone FROM crm_contacts"
                " WHERE archived_at IS NULL"
                "   AND (name LIKE ? OR title LIKE ? OR email LIKE ? OR phone LIKE ?)"
                " LIMIT ?",
                (term, term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "contact",
                    "title":    r["name"],
                    "subtitle": r["title"] or r["email"] or r["phone"] or "",
                    "url":      "/crm",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── HR — Employees ────────────────────────────────────────────────────
    if _can(user, db, "hr"):
        try:
            rows = db.execute(
                "SELECT id, employee_code, full_name, job_title, email, phone, status"
                " FROM hr_employees"
                " WHERE archived_at IS NULL"
                "   AND (full_name LIKE ? OR employee_code LIKE ? OR job_title LIKE ?"
                "        OR email LIKE ? OR phone LIKE ?)"
                " LIMIT ?",
                (term, term, term, term, term, limit),
            ).fetchall()
            for r in rows:
                bits = [r["job_title"] or "", r["employee_code"] or "", r["status"] or ""]
                results.append({
                    "id":       r["id"],
                    "type":     "employee",
                    "title":    r["full_name"],
                    "subtitle": " — ".join(b for b in bits if b),
                    "url":      "/hr",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Planning — Projects & Tasks ───────────────────────────────────────
    if _can(user, db, "planning"):
        try:
            rows = db.execute(
                "SELECT id, name, status FROM planning_projects"
                " WHERE archived_at IS NULL AND (name LIKE ? OR status LIKE ?)"
                " LIMIT ?",
                (term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "planning",
                    "title":    r["name"],
                    "subtitle": r["status"] or "",
                    "url":      "/planning",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

        try:
            rows = db.execute(
                "SELECT t.id, t.name, t.status, t.priority, pp.name AS project_name"
                " FROM planning_tasks t"
                " LEFT JOIN planning_projects pp ON t.project_id = pp.id"
                " WHERE t.archived_at IS NULL AND (t.name LIKE ? OR t.status LIKE ?)"
                " LIMIT ?",
                (term, term, limit),
            ).fetchall()
            for r in rows:
                bits = [r["status"] or "", r["project_name"] or ""]
                results.append({
                    "id":       r["id"],
                    "type":     "task",
                    "title":    r["name"],
                    "subtitle": " — ".join(b for b in bits if b),
                    "url":      "/planning",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    # ── Users (superadmin only) ───────────────────────────────────────────
    if user.get("is_superadmin"):
        try:
            rows = db.execute(
                "SELECT id, username, full_name, email FROM users"
                " WHERE deleted_at IS NULL"
                "   AND (username LIKE ? OR full_name LIKE ? OR email LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "user",
                    "title":    r["full_name"] or r["username"],
                    "subtitle": f"@{r['username']}" + (f" — {r['email']}" if r["email"] else ""),
                    "url":      "/users",
                })
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)

    return {"q": q, "count": len(results), "results": results}
