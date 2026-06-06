"""
Dashboard aggregator.

One endpoint, one round-trip — the dashboard pulls a wide cross-module summary
so the frontend doesn't have to fan out to a dozen endpoints. Every field is
permission-gated: a role that can't view a module gets `None` for its data, and
the frontend uses the `permissions` object to decide which cards to render.

When a new module is added to the ERP, add its gated counters/lists here
(check `_can(user, db, "<module>")` first) and surface the corresponding flag
in the `permissions` block — keeping the dashboard a single, cohesive snapshot
of the business rather than a stack of disconnected widgets.
"""
from fastapi import APIRouter, Depends
from database import get_db
from permissions import require_perm
from utils import _today
import sqlite3

router = APIRouter()


def _can(user, db, module):
    """Module-view check used to gate each section. Superadmin bypasses."""
    if user.get("is_superadmin"):
        return True
    rid = user.get("role_id")
    if not rid:
        return False
    p = db.execute(
        "SELECT can_view FROM role_permissions WHERE role_id=? AND module=?", (rid, module)
    ).fetchone()
    return bool(p and p["can_view"])


def _scalar(db: sqlite3.Connection, sql: str, params=()):
    """Run a single-value query and return the first column of the first row.
    Returns 0 when there is no row, so callers can do arithmetic safely."""
    row = db.execute(sql, params).fetchone()
    return row[0] if row else 0


@router.get("/")
def dashboard(user=Depends(require_perm("dashboard", "view")), db: sqlite3.Connection = Depends(get_db)):
    # ── Module-view gates ────────────────────────────────────────────────
    show_projects      = _can(user, db, "projects")
    show_quotes        = _can(user, db, "quotations")
    show_invoices      = _can(user, db, "invoices")
    show_finance       = _can(user, db, "finance")
    show_inventory     = _can(user, db, "inventory")
    show_pos           = _can(user, db, "pos")
    show_cash          = _can(user, db, "cash")
    show_manufacturing = _can(user, db, "manufacturing")
    show_hr            = _can(user, db, "hr")
    show_recruitment   = _can(user, db, "recruitment")
    show_crm           = _can(user, db, "crm")
    show_assets        = _can(user, db, "assets")
    show_planning      = _can(user, db, "planning")
    show_expenses      = _can(user, db, "expenses")
    show_purchases     = _can(user, db, "purchases")
    show_warehouses    = _can(user, db, "warehouses") or _can(user, db, "inventory")

    uid = user.get("id")

    # ── Projects / Quotations / Inventory ────────────────────────────────
    active_projects = _scalar(db,
        "SELECT COUNT(*) FROM projects"
        " WHERE status IN ('In Progress', 'Approved') AND deleted_at IS NULL"
    ) if show_projects else None

    pending_quotes = _scalar(db,
        "SELECT COUNT(*) FROM quotations"
        " WHERE status IN ('Draft', 'Sent') AND deleted_at IS NULL"
    ) if show_quotes else None

    low_stock = _scalar(db,
        "SELECT COUNT(*) FROM inventory"
        " WHERE deleted_at IS NULL AND quantity <= min_stock AND min_stock > 0"
    ) if show_inventory else None

    # ── Invoices: unpaid + overdue (both shown when invoices visible) ────
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
    ).fetchone() if show_invoices else None

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

    # ── Finance: monthly income / expenses + 6-month chart ───────────────
    monthly_income = _scalar(db,
        """SELECT COALESCE(SUM(ip.amount), 0)
           FROM invoice_payments ip JOIN invoices i ON ip.invoice_id = i.id
           WHERE i.deleted_at IS NULL
             AND strftime('%Y-%m', ip.paid_at) = strftime('%Y-%m', 'now')"""
    ) if (show_finance or show_invoices) else None

    monthly_expenses = _scalar(db,
        """SELECT COALESCE(SUM(amount), 0) FROM expenses
           WHERE deleted_at IS NULL
             AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now')"""
    ) if show_finance else None

    monthly_chart = db.execute(
        """SELECT strftime('%Y-%m', ip.paid_at) AS month, COALESCE(SUM(ip.amount),0) AS income
           FROM invoice_payments ip JOIN invoices i ON ip.invoice_id = i.id
           WHERE i.deleted_at IS NULL GROUP BY month ORDER BY month DESC LIMIT 6"""
    ).fetchall() if (show_finance or show_invoices) else []

    # ── POS: today's sales (count + USD total + last sale time) ──────────
    pos_today = db.execute(
        """SELECT COUNT(*) AS c, COALESCE(SUM(total_usd),0) AS total,
                  MAX(created_at) AS last_at
           FROM pos_sales
           WHERE date(created_at) = date('now')
             AND COALESCE(status,'completed') != 'voided'"""
    ).fetchone() if show_pos else None

    # ── Cash: open sessions + last reconciliation status ─────────────────
    cash_summary = None
    if show_cash:
        open_sessions = _scalar(db,
            "SELECT COUNT(*) FROM cash_reconciliations WHERE status = 'open'"
        )
        total_drawers = _scalar(db,
            "SELECT COUNT(*) FROM cash_drawers WHERE is_active = 1"
        )
        # Last reconciliation across all drawers — surface variance if any
        last = db.execute(
            """SELECT cr.business_date, cr.status, cr.variance, d.name AS drawer
               FROM cash_reconciliations cr
               LEFT JOIN cash_drawers d ON cr.drawer_id = d.id
               ORDER BY cr.business_date DESC, cr.id DESC LIMIT 1"""
        ).fetchone()
        cash_summary = {
            "open_sessions": open_sessions,
            "total_drawers": total_drawers,
            "last_drawer":   (last["drawer"] if last else None),
            "last_status":   (last["status"] if last else None),
            "last_variance": (float(last["variance"] or 0) if last else 0),
            "last_date":     (last["business_date"] if last else None),
        }

    # ── Manufacturing: in-flight production orders + scheduled today ─────
    mfg_summary = None
    if show_manufacturing:
        in_flight = _scalar(db,
            "SELECT COUNT(*) FROM production_orders"
            " WHERE archived_at IS NULL AND status IN ('Draft','Confirmed','In Progress')"
        )
        in_progress = _scalar(db,
            "SELECT COUNT(*) FROM production_orders"
            " WHERE archived_at IS NULL AND status = 'In Progress'"
        )
        due_soon = _scalar(db,
            "SELECT COUNT(*) FROM production_orders"
            " WHERE archived_at IS NULL AND status IN ('Draft','Confirmed','In Progress')"
            "   AND due_date IS NOT NULL AND date(due_date) <= date('now','+7 days')"
        )
        mfg_summary = {
            "in_flight":   in_flight,
            "in_progress": in_progress,
            "due_soon":    due_soon,
        }

    # ── HR: headcount + on-leave today + pending leave requests ──────────
    hr_summary = None
    if show_hr:
        headcount = _scalar(db,
            "SELECT COUNT(*) FROM hr_employees"
            " WHERE archived_at IS NULL AND status IN ('Active','On Leave')"
        )
        on_leave = _scalar(db,
            "SELECT COUNT(*) FROM hr_leave_requests"
            " WHERE status = 'Approved'"
            "   AND date('now') BETWEEN date(start_date) AND date(end_date)"
        )
        pending_leave = _scalar(db,
            "SELECT COUNT(*) FROM hr_leave_requests WHERE status = 'Pending'"
        )
        hr_summary = {
            "headcount":     headcount,
            "on_leave":      on_leave,
            "pending_leave": pending_leave,
        }

    # ── Recruitment: open positions + active pipeline ────────────────────
    rec_summary = None
    if show_recruitment:
        open_positions = _scalar(db,
            "SELECT COUNT(*) FROM recruitment_positions"
            " WHERE archived_at IS NULL AND status = 'Open'"
        )
        active_applicants = _scalar(db,
            "SELECT COUNT(*) FROM recruitment_applicants"
            " WHERE archived_at IS NULL AND status NOT IN ('Rejected','Hired','Accepted','Withdrawn')"
        )
        rec_summary = {
            "open_positions":    open_positions,
            "active_applicants": active_applicants,
        }

    # ── CRM: pipeline value + new leads (this month) + deals won ─────────
    crm_summary = None
    if show_crm:
        # Open pipeline = anything that isn't Won/Lost (no won_at/lost_at)
        pipeline = db.execute(
            """SELECT COUNT(*) AS c, COALESCE(SUM(value),0) AS total
               FROM crm_deals
               WHERE archived_at IS NULL AND won_at IS NULL AND lost_at IS NULL"""
        ).fetchone()
        won_month = db.execute(
            """SELECT COUNT(*) AS c, COALESCE(SUM(value),0) AS total
               FROM crm_deals
               WHERE won_at IS NOT NULL
                 AND strftime('%Y-%m', won_at) = strftime('%Y-%m','now')"""
        ).fetchone()
        new_leads = _scalar(db,
            """SELECT COUNT(*) FROM crm_leads
               WHERE archived_at IS NULL
                 AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')"""
        )
        crm_summary = {
            "pipeline_count": pipeline["c"],
            "pipeline_value": float(pipeline["total"] or 0),
            "won_count":      won_month["c"],
            "won_value":      float(won_month["total"] or 0),
            "new_leads":      new_leads,
        }

    # ── Fixed assets: register size + book value ─────────────────────────
    assets_summary = None
    if show_assets:
        agg = db.execute(
            """SELECT COUNT(*) AS c,
                      COALESCE(SUM(acquisition_cost),0) AS cost,
                      COALESCE(SUM(accumulated_depreciation),0) AS depr
               FROM fixed_assets
               WHERE archived_at IS NULL AND status IN ('Active','In Service')"""
        ).fetchone()
        assets_summary = {
            "count":      agg["c"],
            "book_value": float((agg["cost"] or 0) - (agg["depr"] or 0)),
        }

    # ── Planning: today's events + upcoming milestones ───────────────────
    planning_summary = None
    if show_planning:
        events_today = _scalar(db,
            """SELECT COUNT(*) FROM planning_events
               WHERE archived_at IS NULL
                 AND date('now') BETWEEN date(start_date) AND date(COALESCE(end_date, start_date))"""
        )
        upcoming_milestones = _scalar(db,
            """SELECT COUNT(*) FROM planning_milestones
               WHERE archived_at IS NULL AND reached_at IS NULL
                 AND due_date IS NOT NULL
                 AND date(due_date) BETWEEN date('now') AND date('now','+14 days')"""
        )
        planning_summary = {
            "events_today":        events_today,
            "upcoming_milestones": upcoming_milestones,
        }

    # ── Warehouses (only when the user has any visibility on inventory) ──
    warehouses_summary = None
    if show_warehouses:
        # The warehouse most at risk: the one with the highest count of items
        # below their min_stock. Surfaces the "where do I need to restock?"
        # question at a glance without filtering through Inventory by hand.
        active_warehouses = _scalar(db,
            "SELECT COUNT(*) FROM warehouses "
            "WHERE is_active = 1 AND archived_at IS NULL"
        )
        in_transit = _scalar(db,
            "SELECT COUNT(*) FROM stock_transfers WHERE status = 'In Transit'"
        )
        # Top warehouse by low-stock SKU count. NULL when no warehouse has any.
        lowest = db.execute(
            "SELECT w.code, w.name, COUNT(*) AS low_count "
            "FROM inventory_stock s "
            "JOIN warehouses w ON w.id = s.warehouse_id "
            "JOIN inventory i  ON i.id = s.inventory_id "
            "WHERE w.is_active = 1 AND w.archived_at IS NULL "
            "  AND i.archived_at IS NULL AND i.deleted_at IS NULL "
            "  AND i.min_stock > 0 AND s.quantity <= i.min_stock "
            "GROUP BY w.id, w.code, w.name "
            "ORDER BY low_count DESC LIMIT 1"
        ).fetchone()
        warehouses_summary = {
            "active":            active_warehouses,
            "in_transit":        in_transit,
            "lowest_code":       (lowest["code"]      if lowest else None),
            "lowest_name":       (lowest["name"]      if lowest else None),
            "lowest_low_count":  (lowest["low_count"] if lowest else 0),
        }

    # ── Approvals & Notifications & Announcements (always auth-only) ─────
    # Every authenticated user sees their own pending approvals / unread items.
    my_pending_approvals = _scalar(db,
        """SELECT COUNT(DISTINCT ar.id)
           FROM approval_requests ar
           JOIN approval_steps st
             ON st.request_id = ar.id AND st.step_number = ar.current_step
           WHERE ar.status = 'pending'
             AND (st.approver_user_id = ?
                  OR st.approver_role IN (SELECT name FROM roles WHERE id = ?))""",
        (uid, user.get("role_id") or -1),
    ) if uid else 0

    unread_notifications = _scalar(db,
        "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0",
        (uid,),
    ) if uid else 0

    unread_announcements = _scalar(db,
        """SELECT COUNT(*) FROM announcement_recipients r
           JOIN announcements a ON a.id = r.announcement_id
           WHERE r.user_id = ? AND r.read_at IS NULL AND a.archived_at IS NULL""",
        (uid,),
    ) if uid else 0

    # ── Recent lists ─────────────────────────────────────────────────────
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

    # Upcoming planning events for the agenda widget (next 7 days)
    upcoming_events = []
    if show_planning:
        upcoming_events = [dict(r) for r in db.execute(
            """SELECT id, title, start_date, start_time, color, all_day
               FROM planning_events
               WHERE archived_at IS NULL
                 AND date(start_date) BETWEEN date('now') AND date('now','+7 days')
               ORDER BY date(start_date), COALESCE(start_time,'00:00') LIMIT 5"""
        ).fetchall()]

    return {
        # ── Existing fields (kept backward-compatible) ───────────────────
        "active_projects":         active_projects,
        "pending_quotes":          pending_quotes,
        "unpaid_invoices_count":   unpaid["c"]      if unpaid else None,
        "unpaid_invoices_amount":  unpaid["total"]  if unpaid else None,
        "overdue_invoices_count":  overdue["c"]     if overdue else None,
        "overdue_invoices_amount": overdue["total"] if overdue else None,
        "monthly_income":          monthly_income,
        "monthly_expenses":        monthly_expenses,
        "monthly_profit":          (monthly_income - monthly_expenses) if (monthly_income is not None and monthly_expenses is not None) else None,
        "low_stock_alerts":        low_stock,
        "recent_projects":         [dict(r) for r in recent_projects],
        "recent_invoices":         result_invoices,
        "monthly_chart":           [dict(r) for r in monthly_chart],

        # ── New cross-module summaries ───────────────────────────────────
        "pos":              dict(pos_today) if pos_today else None,
        "cash":             cash_summary,
        "manufacturing":    mfg_summary,
        "hr":               hr_summary,
        "recruitment":      rec_summary,
        "crm":              crm_summary,
        "assets":           assets_summary,
        "planning":         planning_summary,
        "warehouses":       warehouses_summary,
        "upcoming_events":  upcoming_events,

        # ── Always-on personal counters ──────────────────────────────────
        "my_pending_approvals": my_pending_approvals,
        "unread_notifications": unread_notifications,
        "unread_announcements": unread_announcements,
        "current_user_name":    user.get("full_name") or user.get("username") or "",

        # ── Permission map for the frontend ──────────────────────────────
        "permissions": {
            "finance":       show_finance,
            "invoices":      show_invoices,
            "projects":      show_projects,
            "quotes":        show_quotes,
            "inventory":     show_inventory,
            "pos":           show_pos,
            "cash":          show_cash,
            "manufacturing": show_manufacturing,
            "hr":            show_hr,
            "recruitment":   show_recruitment,
            "crm":           show_crm,
            "assets":        show_assets,
            "planning":      show_planning,
            "expenses":      show_expenses,
            "purchases":     show_purchases,
            "warehouses":    show_warehouses,
        },
    }
