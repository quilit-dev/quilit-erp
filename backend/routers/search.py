"""
Global search — queries all accessible modules for a given term.
Results are permission-filtered: only modules the user can view are searched.
Each module query is wrapped in try/except so a schema mismatch in one table
never silences results from all other tables.
"""
from fastapi import APIRouter, Depends, Query
from database import get_db
from permissions import require_auth
import sqlite3

router = APIRouter()

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


@router.get("/")
def search_all(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(5, ge=1, le=20),
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    term = f"%{q}%"
    results = []

    if _can(user, db, "clients"):
        try:
            rows = db.execute(
                "SELECT id, name, phone, email FROM clients"
                " WHERE deleted_at IS NULL AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "client",
                    "title":    r["name"],
                    "subtitle": r["email"] or r["phone"] or "",
                    "url":      f"/clients/{r['id']}",
                })
        except Exception:
            pass

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
            pass

    if _can(user, db, "invoices"):
        try:
            rows = db.execute(
                "SELECT i.id, i.invoice_number, i.amount, c.name AS client_name"
                " FROM invoices i LEFT JOIN clients c ON i.client_id = c.id"
                " WHERE i.deleted_at IS NULL AND (i.invoice_number LIKE ? OR c.name LIKE ?)"
                " LIMIT ?",
                (term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "invoice",
                    "title":    r["invoice_number"],
                    "subtitle": f"{r['client_name'] or ''} — ${r['amount']:,.2f}",
                    "url":      "/invoices",
                })
        except Exception:
            pass

    if _can(user, db, "quotations"):
        try:
            rows = db.execute(
                "SELECT q.id, q.quote_number, c.name AS client_name"
                " FROM quotations q LEFT JOIN clients c ON q.client_id = c.id"
                " WHERE q.deleted_at IS NULL AND (q.quote_number LIKE ? OR c.name LIKE ?)"
                " LIMIT ?",
                (term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "quotation",
                    "title":    r["quote_number"],
                    "subtitle": r["client_name"] or "",
                    "url":      "/quotations",
                })
        except Exception:
            pass

    if _can(user, db, "inventory"):
        try:
            rows = db.execute(
                "SELECT id, name, category, supplier FROM inventory"
                " WHERE deleted_at IS NULL AND (name LIKE ? OR category LIKE ? OR supplier LIKE ?)"
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
            pass

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
            pass

    if _can(user, db, "suppliers"):
        try:
            rows = db.execute(
                "SELECT id, name, contact_name, email FROM suppliers"
                " WHERE deleted_at IS NULL AND (name LIKE ? OR contact_name LIKE ? OR email LIKE ?)"
                " LIMIT ?",
                (term, term, term, limit),
            ).fetchall()
            for r in rows:
                results.append({
                    "id":       r["id"],
                    "type":     "supplier",
                    "title":    r["name"],
                    "subtitle": r["contact_name"] or r["email"] or "",
                    "url":      f"/suppliers/{r['id']}",
                })
        except Exception:
            pass

    return {"q": q, "count": len(results), "results": results}
