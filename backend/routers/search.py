"""
Global search — queries every accessible module for a given term.

Coverage is intentionally broad ("every detail in every module"): each entity is
matched across all of its meaningful text columns — names, codes, numbers,
statuses, notes/descriptions, contact details — and, where it matters, across
its child rows too (e.g. an invoice matches on its line-item names).

Results are permission-filtered: a module is only searched when the caller can
view it. Module-gated entities use the role's `can_view`; admin-only config
(tax rates, approval policies) and sensitive cross-cutting data (approval
requests) require administrative access; superadmin sees everything.

Each query is wrapped in try/except so a schema mismatch in one table never
silences results from all the others. Failures are logged with a traceback so a
broken query stays diagnosable instead of being silently swallowed.
"""
import logging
from fastapi import APIRouter, Depends, Query
from database import get_db
from permissions import require_auth, can_view as permissions_can_view
import branch_access
import sqlite3

router = APIRouter()
logger = logging.getLogger("erp.search")


# Module-view gate for showing/hiding a section. The shared implementation lives
# in permissions.py; this alias keeps the call sites below unchanged.
_can = permissions_can_view


def _admin(user: dict) -> bool:
    """True for vendor superadmins and admin-tier roles. Gates admin-only
    config and sensitive cross-module data, mirroring `require_admin`."""
    return bool(user.get("is_superadmin") or user.get("admin_access"))


def _money(v) -> str:
    try:
        return f"${(v or 0):,.2f}"
    except Exception:
        return "$0.00"


def _join(*bits) -> str:
    """Join the non-empty bits with an em dash for a tidy subtitle."""
    return " — ".join(str(b) for b in bits if b not in (None, "", 0))


def _clip(s, n: int = 70) -> str:
    """Collapse whitespace and truncate free-text fields for subtitles."""
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


@router.get("/")
def search_all(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(5, ge=1, le=20),
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    term = f"%{q}%"
    results: list[dict] = []

    def run(sql: str, params: tuple, build):
        """Execute one entity query and append its built results. Isolated so a
        single failing table never kills the whole search."""
        try:
            for r in db.execute(sql, params).fetchall():
                item = build(r)
                if item:
                    results.append(item)
        except Exception:
            logger.warning("global search: a module query failed", exc_info=True)
            # The isolation above is only real on SQLite. PostgreSQL aborts the
            # whole transaction on a failed statement and refuses everything
            # after it ("current transaction is aborted"), so ONE broken query
            # silently emptied every section that followed it. Roll back so the
            # connection is usable again and the next module still runs.
            try:
                db.rollback()
            except Exception:
                pass

    # ── Clients ───────────────────────────────────────────────────────────
    if _can(user, db, "clients"):
        run(
            "SELECT id, name, company, phone, email, type FROM clients"
            " WHERE deleted_at IS NULL AND ("
            "   name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?"
            "   OR address LIKE ? OR notes LIKE ? OR type LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "client", "title": r["name"],
                "subtitle": _join(r["company"], r["email"], r["phone"], r["type"]),
                "url": f"/clients/{r['id']}",
            },
        )

    # ── Projects ──────────────────────────────────────────────────────────
    if _can(user, db, "projects"):
        run(
            "SELECT p.id, p.name, p.status, p.location, c.name AS client_name"
            " FROM projects p LEFT JOIN clients c ON p.client_id = c.id"
            " WHERE p.deleted_at IS NULL AND ("
            "   p.name LIKE ? OR p.status LIKE ? OR p.location LIKE ?"
            "   OR p.description LIKE ? OR c.name LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "project", "title": r["name"],
                "subtitle": _join(r["status"], r["client_name"], r["location"]),
                "url": f"/projects/{r['id']}",
            },
        )

    # Global search reached across branches: a scoped manager searching a
    # term found other branches' invoices and quotations, complete with
    # client name and amount, even though those records 404 when opened.
    _bf_i, _bp_i = branch_access.branch_filter(user, db, column="i.branch_id")
    _bf_q, _bp_q = branch_access.branch_filter(user, db, column="q.branch_id")

    # ── Invoices (+ line items) ───────────────────────────────────────────
    if _can(user, db, "invoices"):
        run(
            "SELECT i.id, i.invoice_number, i.amount, c.name AS client_name"
            " FROM invoices i LEFT JOIN clients c ON i.client_id = c.id"
            " WHERE i.deleted_at IS NULL"
            + _bf_i +
            " AND ("
            "   i.invoice_number LIKE ? OR c.name LIKE ? OR i.notes LIKE ?"
            "   OR i.void_reason LIKE ?"
            "   OR EXISTS (SELECT 1 FROM invoice_items it"
            "              WHERE it.invoice_id = i.id AND it.name LIKE ?))"
            " LIMIT ?",
            tuple(_bp_i) + (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "invoice", "title": r["invoice_number"],
                "subtitle": _join(r["client_name"], _money(r["amount"])),
                "url": f"/invoices?focus={r['id']}",
            },
        )

    # ── Quotations (+ line items) ─────────────────────────────────────────
    if _can(user, db, "quotations"):
        run(
            "SELECT q.id, q.quote_number, q.project_name, q.total, c.name AS client_name"
            " FROM quotations q LEFT JOIN clients c ON q.client_id = c.id"
            " WHERE q.deleted_at IS NULL"
            + _bf_q +
            " AND ("
            "   q.quote_number LIKE ? OR c.name LIKE ? OR q.project_name LIKE ?"
            "   OR q.notes LIKE ?"
            "   OR EXISTS (SELECT 1 FROM quotation_items qi"
            "              WHERE qi.quotation_id = q.id AND qi.name LIKE ?))"
            " LIMIT ?",
            tuple(_bp_q) + (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "quotation", "title": r["quote_number"],
                "subtitle": _join(r["client_name"], r["project_name"], _money(r["total"])),
                "url": f"/quotations?focus={r['id']}",
            },
        )

    # ── Inventory ─────────────────────────────────────────────────────────
    if _can(user, db, "inventory"):
        run(
            "SELECT id, name, category, supplier, barcode, unit FROM inventory"
            " WHERE deleted_at IS NULL AND ("
            "   name LIKE ? OR category LIKE ? OR supplier LIKE ?"
            "   OR barcode LIKE ? OR unit LIKE ? OR product_type LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "inventory", "title": r["name"],
                "subtitle": _join(r["category"], r["supplier"], r["barcode"]),
                "url": f"/inventory?focus={r['id']}",
            },
        )

    # ── Purchases ─────────────────────────────────────────────────────────
    if _can(user, db, "purchases"):
        run(
            "SELECT id, po_number, product_name, supplier, status, category FROM purchases"
            " WHERE deleted_at IS NULL AND ("
            "   po_number LIKE ? OR product_name LIKE ? OR supplier LIKE ?"
            "   OR category LIKE ? OR notes LIKE ? OR status LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "purchase", "title": r["po_number"],
                "subtitle": _join(r["product_name"], r["supplier"], r["status"]),
                "url": f"/purchases?focus={r['id']}",
            },
        )

    # ── Suppliers ─────────────────────────────────────────────────────────
    if _can(user, db, "suppliers"):
        run(
            "SELECT id, name, contact_name, phone, email FROM suppliers"
            " WHERE deleted_at IS NULL AND ("
            "   name LIKE ? OR contact_name LIKE ? OR phone LIKE ?"
            "   OR email LIKE ? OR notes LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "supplier", "title": r["name"],
                "subtitle": _join(r["contact_name"], r["email"], r["phone"]),
                "url": f"/suppliers/{r['id']}",
            },
        )

    # ── Expenses ──────────────────────────────────────────────────────────
    if _can(user, db, "expenses"):
        run(
            "SELECT e.id, e.category, e.description, e.amount, e.payment_method,"
            "       p.name AS project_name"
            " FROM expenses e LEFT JOIN projects p ON e.project_id = p.id"
            " WHERE e.deleted_at IS NULL AND e.archived_at IS NULL AND ("
            "   e.category LIKE ? OR e.description LIKE ? OR p.name LIKE ?"
            "   OR e.payment_method LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "expense",
                "title": r["description"] or r["category"] or "Expense",
                "subtitle": _join(r["category"], _money(r["amount"]), r["project_name"]),
                "url": f"/expenses?focus={r['id']}",
            },
        )

        # Recurring expense templates (same module gate as expenses)
        run(
            "SELECT id, name, category, amount, frequency, is_active"
            " FROM recurring_expenses"
            " WHERE archived_at IS NULL AND ("
            "   name LIKE ? OR category LIKE ? OR description LIKE ?)"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "recurring", "title": r["name"],
                "subtitle": _join(r["category"], r["frequency"], _money(r["amount"]),
                                  None if r["is_active"] else "paused"),
                "url": "/expenses",
            },
        )

    # ── CRM — Leads ───────────────────────────────────────────────────────
    if _can(user, db, "crm"):
        run(
            "SELECT id, name, company, email, phone, status FROM crm_leads"
            " WHERE archived_at IS NULL AND ("
            "   name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ?"
            "   OR source LIKE ? OR status LIKE ? OR notes LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "lead", "title": r["name"],
                "subtitle": _join(r["company"] or r["email"] or r["phone"], r["status"]),
                "url": "/crm",
            },
        )

        # CRM — Deals
        run(
            "SELECT d.id, d.title, d.stage, d.value, c.name AS client_name"
            " FROM crm_deals d LEFT JOIN clients c ON d.client_id = c.id"
            " WHERE d.archived_at IS NULL AND ("
            "   d.title LIKE ? OR c.name LIKE ? OR d.stage LIKE ?"
            "   OR d.notes LIKE ? OR d.lost_reason LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "deal", "title": r["title"],
                "subtitle": _join(r["stage"], _money(r["value"]), r["client_name"]),
                "url": "/crm",
            },
        )

        # CRM — Contacts
        run(
            "SELECT id, name, title, email, phone FROM crm_contacts"
            " WHERE archived_at IS NULL AND ("
            "   name LIKE ? OR title LIKE ? OR email LIKE ? OR phone LIKE ?"
            "   OR notes LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "contact", "title": r["name"],
                "subtitle": _join(r["title"], r["email"], r["phone"]),
                "url": "/crm",
            },
        )

        # CRM — Activities
        run(
            "SELECT id, type, subject, description, outcome FROM crm_activities"
            " WHERE archived_at IS NULL AND ("
            "   subject LIKE ? OR description LIKE ? OR type LIKE ? OR outcome LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "crm_activity",
                "title": r["subject"] or (r["type"] or "Activity").title(),
                "subtitle": _join((r["type"] or "").title(), _clip(r["description"])),
                "url": "/crm",
            },
        )

    # ── HR — Employees ────────────────────────────────────────────────────
    if _can(user, db, "hr"):
        run(
            "SELECT e.id, e.employee_code, e.full_name, e.job_title, e.status,"
            "       d.name AS dept"
            " FROM hr_employees e LEFT JOIN hr_departments d ON e.department_id = d.id"
            " WHERE e.archived_at IS NULL AND ("
            "   e.full_name LIKE ? OR e.employee_code LIKE ? OR e.job_title LIKE ?"
            "   OR e.email LIKE ? OR e.phone LIKE ? OR e.address LIKE ?"
            "   OR e.notes LIKE ? OR e.employment_type LIKE ? OR d.name LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "employee", "title": r["full_name"],
                "subtitle": _join(r["job_title"], r["dept"], r["employee_code"], r["status"]),
                "url": "/hr",
            },
        )

        # HR — Departments
        run(
            "SELECT id, name, description FROM hr_departments"
            " WHERE archived_at IS NULL AND (name LIKE ? OR description LIKE ?)"
            " LIMIT ?",
            (term, term, limit),
            lambda r: {
                "id": r["id"], "type": "department", "title": r["name"],
                "subtitle": _clip(r["description"]), "url": "/hr",
            },
        )

        # HR — Leave requests
        run(
            "SELECT l.id, l.leave_type, l.status, l.start_date, l.end_date,"
            "       l.reason, e.full_name AS emp"
            " FROM hr_leave_requests l"
            " LEFT JOIN hr_employees e ON l.employee_id = e.id"
            " WHERE l.leave_type LIKE ? OR l.reason LIKE ? OR l.status LIKE ?"
            "    OR e.full_name LIKE ?"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "leave",
                "title": _join(r["emp"], r["leave_type"]) or "Leave request",
                "subtitle": _join(r["status"], r["start_date"], r["end_date"]),
                "url": "/hr",
            },
        )

        # HR — Payroll runs (by pay period / status)
        run(
            "SELECT id, period_start, period_end, status FROM hr_payroll_runs"
            " WHERE archived_at IS NULL AND ("
            "   period_start LIKE ? OR period_end LIKE ? OR status LIKE ?)"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "payroll_run",
                "title": _join(r["period_start"], "→", r["period_end"]) or "Payroll run",
                "subtitle": _join("Payroll", r["status"]),
                "url": "/hr",
            },
        )

        # HR — Attendance (free-text note only — status words would flood results)
        run(
            "SELECT a.id, a.date, a.status, a.note, e.full_name AS emp"
            " FROM hr_attendance a LEFT JOIN hr_employees e ON a.employee_id = e.id"
            " WHERE a.note LIKE ?"
            " LIMIT ?",
            (term, limit),
            lambda r: {
                "id": r["id"], "type": "attendance",
                "title": _join(r["emp"], r["date"]) or "Attendance",
                "subtitle": _join(r["status"], _clip(r["note"])),
                "url": "/hr",
            },
        )

    # ── HR — Contracts ────────────────────────────────────────────────────
    if _can(user, db, "hr_contracts"):
        run(
            "SELECT c.id, c.contract_number, c.contract_type, c.job_title, c.status,"
            "       e.full_name AS emp"
            " FROM hr_contracts c LEFT JOIN hr_employees e ON c.employee_id = e.id"
            " WHERE c.archived_at IS NULL AND ("
            "   c.contract_number LIKE ? OR c.job_title LIKE ? OR c.contract_type LIKE ?"
            "   OR e.full_name LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "contract",
                "title": r["contract_number"] or _join(r["emp"], "contract"),
                "subtitle": _join(r["emp"], r["job_title"], r["contract_type"], r["status"]),
                "url": "/hr",
            },
        )

    # ── HR — Activities ───────────────────────────────────────────────────
    if _can(user, db, "hr_activities"):
        run(
            "SELECT id, activity_type, subject, description, location, status"
            " FROM hr_activities"
            " WHERE archived_at IS NULL AND ("
            "   subject LIKE ? OR description LIKE ? OR location LIKE ?"
            "   OR activity_type LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "hr_activity",
                "title": r["subject"] or (r["activity_type"] or "Activity").title(),
                "subtitle": _join((r["activity_type"] or "").title(), r["status"], r["location"]),
                "url": "/hr-activities",
            },
        )

    # ── Recruitment — Positions & Applicants ──────────────────────────────
    if _can(user, db, "recruitment"):
        run(
            "SELECT id, title, location, status FROM recruitment_positions"
            " WHERE archived_at IS NULL AND ("
            "   title LIKE ? OR location LIKE ? OR description LIKE ?"
            "   OR requirements LIKE ? OR status LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "position", "title": r["title"],
                "subtitle": _join(r["location"], r["status"]), "url": "/recruitment",
            },
        )

        run(
            "SELECT id, full_name, email, phone, status, source FROM recruitment_applicants"
            " WHERE archived_at IS NULL AND ("
            "   full_name LIKE ? OR email LIKE ? OR phone LIKE ?"
            "   OR source LIKE ? OR notes LIKE ? OR status LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "applicant", "title": r["full_name"],
                "subtitle": _join(r["status"], r["email"], r["phone"]),
                "url": "/recruitment",
            },
        )

    # ── Planning — Projects, Tasks, Milestones & Events ───────────────────
    if _can(user, db, "planning"):
        run(
            "SELECT id, name, status FROM planning_projects"
            " WHERE archived_at IS NULL AND ("
            "   name LIKE ? OR status LIKE ? OR description LIKE ?)"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "planning", "title": r["name"],
                "subtitle": r["status"] or "", "url": "/planning",
            },
        )

        run(
            "SELECT t.id, t.name, t.status, pp.name AS project_name"
            " FROM planning_tasks t"
            " LEFT JOIN planning_projects pp ON t.project_id = pp.id"
            " WHERE t.archived_at IS NULL AND ("
            "   t.name LIKE ? OR t.status LIKE ? OR t.description LIKE ?)"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "task", "title": r["name"],
                "subtitle": _join(r["status"], r["project_name"]), "url": "/planning",
            },
        )

        run(
            "SELECT m.id, m.name, m.due_date, pp.name AS project_name"
            " FROM planning_milestones m"
            " LEFT JOIN planning_projects pp ON m.project_id = pp.id"
            " WHERE m.archived_at IS NULL AND m.name LIKE ?"
            " LIMIT ?",
            (term, limit),
            lambda r: {
                "id": r["id"], "type": "milestone", "title": r["name"],
                "subtitle": _join(r["project_name"], r["due_date"]), "url": "/planning",
            },
        )

        run(
            "SELECT id, title, description, start_date FROM planning_events"
            " WHERE archived_at IS NULL AND (title LIKE ? OR description LIKE ?)"
            " LIMIT ?",
            (term, term, limit),
            lambda r: {
                "id": r["id"], "type": "event", "title": r["title"],
                "subtitle": _join(r["start_date"], _clip(r["description"])),
                "url": "/planning",
            },
        )

    # ── Manufacturing — Production orders, BOMs, Work centers, Resources ──
    if _can(user, db, "manufacturing"):
        run(
            "SELECT po.id, po.order_number, po.status, i.name AS output_name"
            " FROM production_orders po"
            " LEFT JOIN inventory i ON po.output_inventory_id = i.id"
            " WHERE po.archived_at IS NULL AND ("
            "   po.order_number LIKE ? OR i.name LIKE ? OR po.notes LIKE ?"
            "   OR po.status LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "production", "title": r["order_number"],
                "subtitle": _join(r["status"], r["output_name"]), "url": "/manufacturing",
            },
        )

        run(
            "SELECT b.id, b.name, b.version, i.name AS output_name"
            " FROM boms b LEFT JOIN inventory i ON b.output_inventory_id = i.id"
            " WHERE b.archived_at IS NULL AND ("
            "   b.name LIKE ? OR i.name LIKE ? OR b.notes LIKE ?)"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "bom", "title": r["name"],
                "subtitle": _join(f"v{r['version']}" if r["version"] else None, r["output_name"]),
                "url": "/manufacturing",
            },
        )

        run(
            "SELECT id, code, name, type FROM work_centers"
            " WHERE archived_at IS NULL AND ("
            "   code LIKE ? OR name LIKE ? OR type LIKE ? OR notes LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "work_center", "title": r["name"],
                "subtitle": _join(r["code"], r["type"]), "url": "/manufacturing",
            },
        )

        run(
            "SELECT id, name, cost_type, hourly_rate FROM manufacturing_resources"
            " WHERE archived_at IS NULL AND (name LIKE ? OR notes LIKE ? OR cost_type LIKE ?)"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "resource", "title": r["name"],
                "subtitle": _join(r["cost_type"], _money(r["hourly_rate"]) + "/h" if r["hourly_rate"] else None),
                "url": "/manufacturing",
            },
        )

    # ── Fixed Assets ──────────────────────────────────────────────────────
    if _can(user, db, "assets"):
        run(
            "SELECT id, asset_code, name, category, status, acquisition_cost"
            " FROM fixed_assets"
            " WHERE archived_at IS NULL AND ("
            "   asset_code LIKE ? OR name LIKE ? OR category LIKE ?"
            "   OR description LIKE ? OR status LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "asset", "title": r["name"],
                "subtitle": _join(r["asset_code"], r["category"], r["status"],
                                  _money(r["acquisition_cost"])),
                "url": "/fixed-assets",
            },
        )

    # ── Service — jobs and the equipment they are done on ─────────────────
    # Both are searchable because a technician arrives knowing one of two
    # things: the job number on the docket, or the machine in front of them.
    if _can(user, db, "service"):
        run(
            "SELECT j.id, j.job_number, j.job_type, j.status, j.reported_fault,"
            "       c.name AS client_name, e.name AS equipment_name"
            " FROM service_jobs j"
            " LEFT JOIN clients c ON c.id = j.client_id"
            " LEFT JOIN service_equipment e ON e.id = j.equipment_id"
            " WHERE j.archived_at IS NULL AND ("
            "   j.job_number LIKE ? OR j.job_type LIKE ? OR j.status LIKE ?"
            "   OR j.reported_fault LIKE ? OR j.work_done LIKE ?"
            "   OR c.name LIKE ? OR e.name LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "service_job",
                "title": r["job_number"] or "Service job",
                "subtitle": _join(r["client_name"], r["equipment_name"],
                                  r["job_type"], r["status"],
                                  _clip(r["reported_fault"])),
                "url": "/service",
            },
        )
        run(
            "SELECT e.id, e.name, e.manufacturer, e.model, e.serial_number,"
            "       c.name AS client_name"
            " FROM service_equipment e LEFT JOIN clients c ON c.id = e.client_id"
            " WHERE e.archived_at IS NULL AND ("
            "   e.name LIKE ? OR e.manufacturer LIKE ? OR e.model LIKE ?"
            "   OR e.serial_number LIKE ? OR e.location LIKE ? OR c.name LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "equipment", "title": r["name"],
                "subtitle": _join(r["client_name"], r["manufacturer"], r["model"],
                                  r["serial_number"]),
                "url": "/service",
            },
        )

    # ── Accounting — Chart of accounts & Journal entries ──────────────────
    if _can(user, db, "accounting"):
        run(
            "SELECT id, code, name, type, subtype FROM chart_of_accounts"
            " WHERE code LIKE ? OR name LIKE ? OR type LIKE ?"
            "    OR subtype LIKE ? OR description LIKE ?"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "account", "title": _join(r["code"], r["name"]),
                "subtitle": _join((r["type"] or "").title(), r["subtype"]),
                # Its ledger, which is what you want when you search an
                # account — not the Overview tab, where it does not appear.
                "url": f"/accounting?tab=ledger&focus={r['id']}",
            },
        )

        run(
            "SELECT id, entry_number, entry_date, memo, source_type, status"
            " FROM journal_entries"
            " WHERE entry_number LIKE ? OR memo LIKE ? OR source_type LIKE ?"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "journal",
                "title": r["entry_number"] or f"Entry #{r['id']}",
                "subtitle": _join(r["entry_date"], _clip(r["memo"]), r["status"]),
                "url": f"/accounting?tab=journal&focus={r['id']}",
            },
        )

    # ── Tax rates (admin config) ──────────────────────────────────────────
    if _admin(user):
        run(
            "SELECT id, name, rate, tax_type, is_active FROM tax_rates"
            " WHERE name LIKE ? OR tax_type LIKE ?"
            " LIMIT ?",
            (term, term, limit),
            lambda r: {
                "id": r["id"], "type": "tax_rate", "title": r["name"],
                "subtitle": _join(f"{r['rate']}%", (r["tax_type"] or "").title(),
                                  None if r["is_active"] else "inactive"),
                "url": "/settings",
            },
        )

    # ── POS — Sales ───────────────────────────────────────────────────────
    if _can(user, db, "pos"):
        run(
            "SELECT s.id, s.cashier_name, s.payment_method, s.total_usd, s.status,"
            "       i.invoice_number"
            " FROM pos_sales s LEFT JOIN invoices i ON s.invoice_id = i.id"
            " WHERE i.invoice_number LIKE ? OR s.cashier_name LIKE ?"
            "    OR s.payment_method LIKE ?"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "pos_sale",
                "title": r["invoice_number"] or f"Sale #{r['id']}",
                "subtitle": _join(r["cashier_name"], r["payment_method"], _money(r["total_usd"]),
                                  r["status"] if r["status"] and r["status"] != "completed" else None),
                "url": "/pos",
            },
        )

    # ── Cash — Drawers ────────────────────────────────────────────────────
    if _can(user, db, "cash"):
        run(
            "SELECT id, name, is_active, auto_capture FROM cash_drawers"
            " WHERE name LIKE ?"
            " LIMIT ?",
            (term, limit),
            lambda r: {
                "id": r["id"], "type": "cash_drawer", "title": r["name"],
                "subtitle": _join("default" if r["auto_capture"] else None,
                                  "active" if r["is_active"] else "inactive"),
                "url": "/cash",
            },
        )

    # ── Warehouses + Stock Transfers ──────────────────────────────────────
    # Warehouses are accessible to everyone (the operational forms list them
    # all), so we don't gate by `warehouses` view permission — but row-level
    # access is honoured: a user restricted to BRANCH-A won't see MAIN come
    # up in search. Stock transfers similarly check both endpoints.
    try:
        import warehouse_access as wha
        accessible = wha.accessible_ids(user, db)   # None means "all"
        wh_filter, wh_params = "", []
        if accessible is not None:
            if not accessible:
                accessible = {-1}    # forces empty result
            placeholders = ",".join("?" for _ in accessible)
            wh_filter = f" AND id IN ({placeholders})"
            wh_params = list(accessible)
        run(
            "SELECT id, code, name, type FROM warehouses"
            " WHERE archived_at IS NULL AND (code LIKE ? OR name LIKE ? OR type LIKE ?)"
            f"{wh_filter}"
            " LIMIT ?",
            (term, term, term, *wh_params, limit),
            lambda r: {
                "id": r["id"], "type": "warehouse",
                "title": f"{r['code']} · {r['name']}",
                "subtitle": r["type"],
                "url": "/warehouses",
            },
        )

        # Transfers — visible if the caller can access either endpoint.
        tx_join, tx_params = "", []
        if accessible is not None:
            placeholders = ",".join("?" for _ in accessible)
            tx_join = (
                f" AND (t.from_warehouse_id IN ({placeholders}) "
                f"      OR t.to_warehouse_id IN ({placeholders}))"
            )
            tx_params = list(accessible) + list(accessible)
        run(
            "SELECT t.id, t.transfer_number, t.status, "
            "       fw.code AS from_code, tw.code AS to_code "
            "FROM stock_transfers t "
            "LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id "
            "LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id "
            "WHERE (t.transfer_number LIKE ? OR fw.code LIKE ? OR tw.code LIKE ?)"
            f"{tx_join}"
            " LIMIT ?",
            (term, term, term, *tx_params, limit),
            lambda r: {
                "id": r["id"], "type": "stock_transfer",
                "title": r["transfer_number"],
                "subtitle": _join(f"{r['from_code']} → {r['to_code']}", r["status"]),
                "url": "/warehouses",
            },
        )
    except Exception:
        logger.warning("global search: warehouse query failed", exc_info=True)

    # ── Announcements ─────────────────────────────────────────────────────
    # Scope to the caller's recipient roster — exactly how the inbox gates
    # visibility — so audience-targeted announcements never leak via search.
    # Superadmins (who manage announcements) may search across all of them.
    def _ann(r):
        return {
            "id": r["id"], "type": "announcement", "title": r["title"],
            "subtitle": _join((r["priority"] or "").title(), _clip(r["body"])),
            "url": "/announcements",
        }

    if user.get("is_superadmin"):
        run(
            "SELECT id, title, body, priority FROM announcements"
            " WHERE archived_at IS NULL AND (title LIKE ? OR body LIKE ?)"
            " LIMIT ?",
            (term, term, limit), _ann,
        )
    elif user.get("id"):
        run(
            "SELECT a.id, a.title, a.body, a.priority FROM announcements a"
            " JOIN announcement_recipients r"
            "   ON r.announcement_id = a.id AND r.user_id = ?"
            " WHERE a.archived_at IS NULL AND (a.title LIKE ? OR a.body LIKE ?)"
            " LIMIT ?",
            (user["id"], term, term, limit), _ann,
        )

    # ── Approval policies (admin config) ──────────────────────────────────
    if _admin(user):
        run(
            "SELECT id, name, description, module, trigger_action, is_active"
            " FROM approval_policies"
            " WHERE name LIKE ? OR description LIKE ? OR module LIKE ?"
            "    OR trigger_action LIKE ?"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "approval_policy", "title": r["name"],
                "subtitle": _join(r["module"], r["trigger_action"],
                                  None if r["is_active"] else "inactive"),
                "url": "/approval-policies",
            },
        )

        # Approval requests carry entity snapshots (amounts, salaries) — keep
        # them admin-only, even though the requests list itself is auth-gated.
        run(
            "SELECT id, policy_name, entity_label, module, status FROM approval_requests"
            " WHERE policy_name LIKE ? OR entity_label LIKE ? OR module LIKE ?"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "approval_request",
                "title": r["entity_label"] or r["policy_name"] or f"Request #{r['id']}",
                "subtitle": _join(r["module"], r["status"]),
                "url": "/approvals",
            },
        )

    # ── Users (superadmin only) ───────────────────────────────────────────
    if user.get("is_superadmin"):
        run(
            "SELECT id, username, full_name, email, role FROM users"
            " WHERE deleted_at IS NULL AND ("
            "   username LIKE ? OR full_name LIKE ? OR email LIKE ? OR role LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "user",
                "title": r["full_name"] or r["username"],
                "subtitle": _join(f"@{r['username']}", r["email"], r["role"]),
                "url": "/users",
            },
        )

    # ── Roles (admin only) ────────────────────────────────────────────────
    # The roles screen and its permission matrix are admin-gated, so role
    # search results are too — exposing role names to an operator would leak
    # the org's permission topology.
    if _admin(user):
        run(
            "SELECT id, name, description, is_admin, is_system FROM roles"
            " WHERE name LIKE ? OR description LIKE ?"
            " LIMIT ?",
            (term, term, limit),
            lambda r: {
                "id": r["id"], "type": "role", "title": r["name"],
                "subtitle": _join(
                    "admin" if r["is_admin"] else None,
                    "system" if r["is_system"] else None,
                    _clip(r["description"]),
                ),
                "url": "/roles",
            },
        )

    # ── Notifications (per-user) ──────────────────────────────────────────
    # Notifications are per-recipient — never expose another user's inbox.
    # Surfaces the title + body so an operator can find an old alert by its
    # contents (e.g. searching the entity name that fired it).
    if user.get("id"):
        run(
            "SELECT id, title, body, type, entity_type, link, is_read"
            " FROM notifications"
            " WHERE user_id = ? AND (title LIKE ? OR body LIKE ? OR type LIKE ?)"
            " ORDER BY created_at DESC"
            " LIMIT ?",
            (user["id"], term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "notification", "title": r["title"],
                "subtitle": _join(
                    (r["type"] or "").replace("_", " ").title() if r["type"] else None,
                    None if r["is_read"] else "unread",
                    _clip(r["body"]),
                ),
                # Notifications carry their own deep-link in `link`; fall back to
                # the inbox page if absent so the result is still navigable.
                "url": r["link"] or "/notifications",
            },
        )

    # ── Accounting periods, fiscal years & FX history ─────────────────────
    # These are surfaced on the Accounting page (period locks panel, FX panel,
    # year-end close). Gating on `accounting` view permission keeps closing
    # status, rate history and locked-month metadata out of operator search.
    if _can(user, db, "accounting"):
        # Search a YYYY-MM "period code" so an operator can type "2026-03".
        # `printf` is SQLite-only and does not exist in PostgreSQL, so this
        # query raised there — and, before the rollback above, took every
        # section after it down with it. The YYYY-MM code is matched in Python
        # instead: the table holds twelve rows a year, so reading it whole
        # costs nothing and needs no dialect-specific formatting.
        _code = term.strip("%").lower()
        run(
            "SELECT id, year, month, locked_at, locked_by FROM accounting_periods"
            " WHERE CAST(year AS TEXT) LIKE ? OR locked_by LIKE ?"
            " ORDER BY year DESC, month DESC"
            " LIMIT ?",
            (term, term, limit),
            lambda r: {
                "id": r["id"], "type": "accounting_period",
                "title": f"{r['year']:04d}-{r['month']:02d}",
                "subtitle": _join(
                    "locked" if r["locked_at"] else "open",
                    f"by {r['locked_by']}" if r["locked_by"] else None,
                ),
                "url": "/accounting",
            },
        )

        # The "2026-03" form, matched in Python (see the note above). Skipped
        # when the term has no digits, so an ordinary word search does not read
        # the table at all.
        if any(ch.isdigit() for ch in _code):
            _seen = {item["id"] for item in results
                     if item.get("type") == "accounting_period"}
            run(
                "SELECT id, year, month, locked_at, locked_by FROM accounting_periods"
                " ORDER BY year DESC, month DESC",
                (),
                lambda r: None if (
                    r["id"] in _seen
                    or _code not in f"{r['year']:04d}-{r['month']:02d}"
                ) else {
                    "id": r["id"], "type": "accounting_period",
                    "title": f"{r['year']:04d}-{r['month']:02d}",
                    "subtitle": _join(
                        "locked" if r["locked_at"] else "open",
                        f"by {r['locked_by']}" if r["locked_by"] else None,
                    ),
                    "url": "/accounting",
                },
            )

        run(
            "SELECT year, status, net_income, closed_at, notes FROM fiscal_years"
            " WHERE CAST(year AS TEXT) LIKE ? OR status LIKE ? OR notes LIKE ?"
            " ORDER BY year DESC"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["year"], "type": "fiscal_year",
                "title": f"FY {r['year']}",
                "subtitle": _join(
                    r["status"],
                    _money(r["net_income"]) if r["net_income"] is not None else None,
                ),
                "url": "/accounting",
            },
        )

        run(
            "SELECT id, rate, set_by_name, note, created_at FROM exchange_rates"
            " WHERE CAST(rate AS TEXT) LIKE ? OR set_by_name LIKE ? OR note LIKE ?"
            " ORDER BY created_at DESC"
            " LIMIT ?",
            (term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "exchange_rate",
                "title": f"1 USD = {r['rate']:,.0f} LBP",
                "subtitle": _join(r["created_at"], r["set_by_name"], _clip(r["note"])),
                "url": "/settings",
            },
        )

    # ── Recruitment — Interviews & Offers ─────────────────────────────────
    # The applicant search above is the spine; interviews and offers are the
    # next layer the recruiter looks for ("find the offer letter I sent to
    # candidate X") — so they share the same recruitment view permission.
    if _can(user, db, "recruitment"):
        run(
            "SELECT i.id, i.interview_type, i.scheduled_at, i.status, i.location,"
            "       i.decision, i.notes, a.full_name AS applicant_name"
            " FROM recruitment_interviews i"
            " LEFT JOIN recruitment_applicants a ON a.id = i.applicant_id"
            " WHERE i.interview_type LIKE ? OR i.location LIKE ?"
            "    OR i.notes LIKE ? OR i.decision LIKE ? OR a.full_name LIKE ?"
            " ORDER BY i.scheduled_at DESC"
            " LIMIT ?",
            (term, term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "interview",
                "title": _join(r["applicant_name"], (r["interview_type"] or "").title())
                         or "Interview",
                "subtitle": _join(r["status"], r["scheduled_at"], r["location"]),
                "url": "/recruitment",
            },
        )

        run(
            "SELECT o.id, o.offer_number, o.job_title, o.status, o.salary,"
            "       o.salary_currency, a.full_name AS applicant_name"
            " FROM recruitment_offers o"
            " LEFT JOIN recruitment_applicants a ON a.id = o.applicant_id"
            " WHERE o.archived_at IS NULL AND ("
            "   o.offer_number LIKE ? OR o.job_title LIKE ? OR o.status LIKE ?"
            "   OR a.full_name LIKE ?)"
            " LIMIT ?",
            (term, term, term, term, limit),
            lambda r: {
                "id": r["id"], "type": "offer",
                "title": r["offer_number"] or _join(r["applicant_name"], "offer"),
                "subtitle": _join(
                    r["applicant_name"], r["job_title"], r["status"],
                    f"{r['salary']:,.0f} {r['salary_currency'] or 'USD'}"
                    if r["salary"] is not None else None,
                ),
                "url": "/recruitment",
            },
        )

    # ── Documents (quotation/invoice generated PDFs) ──────────────────────
    # `documents` rows are PDF snapshots attached to invoices, quotations and
    # projects — visible to operators who can view at least one of the parent
    # modules. The body is HTML so we only match the title + record_type to
    # keep this cheap and avoid scanning serialized blobs.
    if (_can(user, db, "invoices") or _can(user, db, "quotations")
            or _can(user, db, "projects")):
        run(
            "SELECT id, title, record_type, record_id FROM documents"
            " WHERE title LIKE ? OR record_type LIKE ?"
            " ORDER BY created_at DESC"
            " LIMIT ?",
            (term, term, limit),
            lambda r: {
                "id": r["id"], "type": "document",
                "title": r["title"] or f"Document #{r['id']}",
                "subtitle": _join((r["record_type"] or "").title(),
                                  f"#{r['record_id']}" if r["record_id"] else None),
                # Documents tab lives on the matching record page — fall back
                # to the list view if the record is gone.
                "url": (
                    f"/clients/{r['record_id']}"  if r["record_type"] == "client"  else
                    f"/projects/{r['record_id']}" if r["record_type"] == "project" else
                    "/invoices"                   if r["record_type"] == "invoice" else
                    "/quotations"                 if r["record_type"] == "quotation" else
                    "/archives"
                ),
            },
        )

    return {"q": q, "count": len(results), "results": results}
