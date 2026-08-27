"""
Notifications router.

Provides:
  GET    /api/notifications/          – list for current user + unread count
  GET    /api/notifications/count     – unread count only (fast poll endpoint)
  PATCH  /api/notifications/mark-all-read
  PATCH  /api/notifications/{id}/read
  DELETE /api/notifications/{id}
  DELETE /api/notifications/clear-read

System notifications (overdue invoices, tasks due soon) are generated lazily
when the list endpoint is called — no cron job required.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
from database import get_db
from permissions import require_auth
from utils import _now, _today, notify
from notif_messages import localize
import sqlite3

router = APIRouter()


# ── Role-based visibility ────────────────────────────────────────────────────
#
# Global notifications (user_id IS NULL) fan out to every authenticated user,
# but a sales rep has no business seeing a "purchase received" alert — clicking
# it would land them on /purchases which their role cannot reach. Each module-
# specific notification type is mapped to the RBAC module that owns it; a user
# whose role lacks `can_view` on that module never sees those rows. Types not
# present in this map (approvals, announcements, system, etc.) are user-
# targeted at notify() time and need no additional gating here.
NOTIFICATION_TYPE_MODULE = {
    # Sales / billing
    "invoice_paid":          "invoices",
    "payment_received":      "invoices",
    "invoice_overdue":       "invoices",
    # Goods a customer has paid for and not yet received. Gated on `pos`
    # because the till is where the promise was made and where the person who
    # made it works.
    "commitment_ready":      "pos",
    "commitment_cancelled":  "pos",
    # Instalments. An invoice plan is chased from the invoice and an
    # account plan from the customer, so each is gated on the module its
    # link lands in. installment_overdue was missing from this map
    # entirely, so it fanned out to roles that cannot open an invoice.
    "installment_due_soon":  "invoices",
    "installment_overdue":   "invoices",
    "account_plan_due_soon": "clients",
    "account_plan_overdue":  "clients",
    "quotation_accepted":    "quotations",
    # Operations / stock
    "low_stock":             "inventory",
    "low_stock_warehouse":   "inventory",
    "purchase_received":     "purchases",
    "transfer_dispatched":   "warehouses",
    "transfer_received":     "warehouses",
    "transfer_cancelled":    "warehouses",
    # Planning + CRM
    "task_due_soon":         "planning",
    "planning_event":        "planning",
    "deal_won":              "crm",
    "deal_lost":             "crm",
    "lead_converted":        "crm",
    # Manufacturing + Assets
    "production_completed":  "manufacturing",
    "asset_depreciated":     "assets",
    # Field service. Mapped to the module so a tenant that has not licensed
    # service never receives them — that filtering is the reason this table
    # exists rather than a bare list of type names.
    "service_job_scheduled": "service",
    "service_job_completed": "service",
    # Cash + Finance + Accounting
    "cash_variance":         "cash",
    "recurring_generated":   "expenses",
    "period_unlocked":       "accounting",
    "fx_rate_stale":         "accounting",
    # HR — leave + payroll + activities + contracts
    "leave_requested":       "hr",
    "leave_approved":        "hr",
    "leave_rejected":        "hr",
    "payroll_approved":      "hr",
    "payroll_paid":          "hr",
    "contract_expiring":     "hr_contracts",
    "hr_activity_reminder":  "hr_activities",
    # Recruitment
    "recruitment_status":    "recruitment",
    "recruitment_hired":     "recruitment",
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _gated_types(user: dict, db: sqlite3.Connection) -> list:
    """
    Return the list of notification types the caller must NOT see as global
    fan-outs. Superadmin and admin-tier roles see everything; everyone else
    is gated by their role's `can_view` permissions.

    A user-specific notification (user_id = caller) is always delivered even
    if its type is gated — the targeting at notify() time is the source of
    truth for those.
    """
    if user.get("is_superadmin") or user.get("is_admin"):
        return []
    role_id = user.get("role_id")
    if not role_id:
        # No role assigned → no module access → every module-gated type is hidden.
        return list(NOTIFICATION_TYPE_MODULE.keys())
    allowed = {
        r["module"] for r in db.execute(
            "SELECT module FROM role_permissions WHERE role_id=? AND can_view=1",
            (role_id,),
        ).fetchall()
    }
    return [t for t, mod in NOTIFICATION_TYPE_MODULE.items() if mod not in allowed]


def _gating_sql(gated: list) -> str:
    """
    Build the WHERE fragment that hides gated global notifications. Returns
    an empty string (a no-op) when nothing is gated so the fast path stays
    untouched. Caller appends `gated` to the parameter list.
    """
    if not gated:
        return ""
    placeholders = ",".join("?" * len(gated))
    # Keep user-targeted rows even if their type happens to be gated; only
    # global (user_id IS NULL) rows are filtered by module access.
    return f" AND NOT (user_id IS NULL AND type IN ({placeholders}))"


# How much warning an instalment gets before its date. Three days, the same
# runway a planning task gets — long enough to ring the customer, short enough
# that the reminder still means "this week".
PLAN_HORIZON_DAYS = 3


def _plan_horizon(today: str) -> str:
    from datetime import date, timedelta
    try:
        base = date.fromisoformat(today[:10])
    except ValueError:
        base = date.today()
    return (base + timedelta(days=PLAN_HORIZON_DAYS)).isoformat()


def _days_between(a: str, b: str) -> int:
    """Whole days from `a` to `b`, or 0 if either date is unreadable."""
    from datetime import date
    try:
        return (date.fromisoformat(str(b)[:10])
                - date.fromisoformat(str(a)[:10])).days
    except Exception:
        return 0


def _remind(db, *, due_type, overdue_type, msg_stem, link, entity_type,
            row, who, today, horizon, doc=None) -> None:
    """One instalment, reminded about at most once a day.

    Two events, not one. A payment coming up is a call to the customer; one
    that has passed is a debt. They are chased by different people and read
    differently, so a single "instalment" alert would collapse them into
    something nobody knows what to do with.
    """
    due = str(row["due_date"])[:10]
    if due < today[:10]:
        days = _days_between(due, today)
        notify(
            db,
            type=overdue_type,
            title=(f"Instalment {row['seq']} of {doc} is overdue" if doc
                   else f"Instalment {row['seq']} for {who} is overdue"),
            body=f"{who} — ${row['remaining']:,.2f} due {due}, {days}d overdue",
            msg=f"{msg_stem}_overdue",
            params={"seq": row["seq"], "doc": doc or who, "who": who,
                    "amount": row["remaining"], "date": due, "days": days},
            link=link, entity_type=entity_type, entity_id=row["id"],
            dedup_hours=24,
        )
        return
    if due > horizon:
        return
    days = _days_between(today, due)
    notify(
        db,
        type=due_type,
        title=(f"Instalment {row['seq']} of {doc} is due" if doc
               else f"Instalment {row['seq']} for {who} is due"),
        body=(f"{who} — ${row['remaining']:,.2f} due today" if days <= 0
              else f"{who} — ${row['remaining']:,.2f} due {due}, in {days}d"),
        msg=f"{msg_stem}_due_today" if days <= 0 else f"{msg_stem}_due_soon",
        params={"seq": row["seq"], "doc": doc or who, "who": who,
                "amount": row["remaining"], "date": due, "days": days},
        link=link, entity_type=entity_type, entity_id=row["id"],
        dedup_hours=24,
    )


def _plan_arrears(db, today: str) -> None:
    """Remind per INSTALMENT of an invoice plan — before its date and after.

    Which instalments are outstanding is derived from cumulative payments (see
    installments.allocate), so this reads the schedule and the invoice's total
    paid and needs no allocation state of its own.

    Deduped on the instalment's own entity id, so a client three months in
    arrears produces three reminders that each name their month, rather than
    one that names a lump sum.
    """
    import installments

    horizon = _plan_horizon(today)
    try:
        rows = db.execute(
            """SELECT i.id AS invoice_id, i.invoice_number, c.name AS client_name,
                      COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip
                                WHERE ip.invoice_id = i.id), 0) AS paid
               FROM invoices i
               LEFT JOIN clients c ON c.id = i.client_id
               WHERE i.voided_at IS NULL AND i.archived_at IS NULL
                 AND EXISTS (SELECT 1 FROM invoice_installments ins
                             WHERE ins.invoice_id = i.id
                               AND ins.due_date <= ?)""",
            (horizon,),
        ).fetchall()
    except Exception:
        # No such table on an install that has not migrated yet. Arrears
        # reminders are not worth failing the notifications list over.
        return

    for inv in rows:
        plan = installments.plan_for(db, inv["invoice_id"], inv["paid"],
                                     today=today)
        for row in plan:
            if row["status"] == installments.PAID:
                continue
            _remind(
                db, due_type="installment_due_soon",
                overdue_type="installment_overdue",
                msg_stem="installment",
                link=f"/invoices/{inv['invoice_id']}",
                entity_type="invoice_installment",
                row=row, who=inv["client_name"] or "Unknown client",
                doc=inv["invoice_number"], today=today, horizon=horizon,
            )


def _account_plan_reminders(db, today: str) -> None:
    """The same reminders for a plan against the customer's ACCOUNT.

    An account plan hangs off no invoice — it is the schedule the customer
    agreed to clear their balance on — so nothing in the invoice sweep can
    see it. Without this the dates are agreed, printed, and then never
    mentioned again by the system that agreed them.
    """
    import installments

    horizon = _plan_horizon(today)
    try:
        plans = db.execute(
            """SELECT p.id, p.client_id, c.name AS client_name
                 FROM client_payment_plans p
                 JOIN clients c ON c.id = p.client_id
                WHERE p.status = 'active' AND c.deleted_at IS NULL
                  AND EXISTS (SELECT 1 FROM client_plan_installments i
                               WHERE i.plan_id = p.id AND i.due_date <= ?)""",
            (horizon,),
        ).fetchall()
    except Exception:
        return

    for p in plans:
        state = installments.plan_state(db, p["client_id"], today=today)
        if not state:
            continue
        for row in state["installments"]:
            if row["status"] == installments.PAID:
                continue
            _remind(
                db, due_type="account_plan_due_soon",
                overdue_type="account_plan_overdue",
                msg_stem="account_plan",
                link=f"/clients/{p['client_id']}",
                entity_type="client_plan_installment",
                row=row, who=p["client_name"] or "Unknown client",
                today=today, horizon=horizon,
            )


def _generate_system_notifications(db: sqlite3.Connection) -> None:
    """
    Lazily generate system-level notifications for conditions that don't have
    a natural trigger point (overdue invoices, tasks due soon, low stock summary).
    Called once per list request — dedup prevents storm.
    """
    today = _today()

    # ── Overdue instalments ───────────────────────────────────────────────────
    # An invoice on a payment plan is chased per INSTALMENT. Its own due_date is
    # the last one, so an invoice-level sweep says nothing until the plan ends
    # and then flags the entire balance at once — it cannot tell you which month
    # was missed, which is the only thing worth knowing while a plan is running.
    _plan_arrears(db, today)
    _account_plan_reminders(db, today)

    # ── Overdue invoices ──────────────────────────────────────────────────────
    # Invoices WITHOUT a plan keep the original behaviour. Those with one are
    # excluded here so a client mid-plan is not chased twice for the same money,
    # once per instalment and once for the whole balance.
    overdue = db.execute(
        """SELECT i.id, i.invoice_number, i.amount, i.due_date, c.name AS client_name,
                  COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0) AS paid
           FROM invoices i
           LEFT JOIN clients c ON c.id = i.client_id
           WHERE i.voided_at IS NULL AND i.archived_at IS NULL
             AND i.due_date IS NOT NULL AND i.due_date < ?
             AND NOT EXISTS (SELECT 1 FROM invoice_installments ins
                             WHERE ins.invoice_id = i.id)""",
        (today,),
    ).fetchall()

    for inv in overdue:
        remaining = float(inv["amount"]) - float(inv["paid"])
        if remaining <= 0:
            continue
        days_overdue = 0
        try:
            from datetime import date
            due = date.fromisoformat(inv["due_date"][:10])
            days_overdue = (date.today() - due).days
        except Exception:
            continue
        notify(
            db,
            type="invoice_overdue",
            title=f"Invoice {inv['invoice_number']} is overdue",
            body=f"{inv['client_name'] or 'Unknown client'} — ${remaining:,.2f} outstanding, {days_overdue}d overdue",
            msg="invoice_overdue",
            params={"number": inv["invoice_number"], "client": inv["client_name"] or "Unknown client",
                    "amount": remaining, "days": days_overdue},
            link=f"/invoices/{inv['id']}",
            entity_type="invoice",
            entity_id=inv["id"],
            dedup_hours=24,
        )

    # ── Tasks due within 3 days ───────────────────────────────────────────────
    from datetime import date, timedelta
    soon = (date.today() + timedelta(days=3)).isoformat()
    tasks_due = db.execute(
        """SELECT t.id, t.name, t.end_date, t.status, pp.name AS project_name
           FROM planning_tasks t
           LEFT JOIN planning_projects pp ON pp.id = t.project_id
           WHERE t.archived_at IS NULL AND t.status != 'Done'
             AND t.end_date IS NOT NULL AND t.end_date <= ? AND t.end_date >= ?""",
        (soon, today),
    ).fetchall()

    for task in tasks_due:
        try:
            due_d = date.fromisoformat(task["end_date"][:10])
            days_left = (due_d - date.today()).days
        except Exception:
            continue
        label = "due today" if days_left == 0 else f"due in {days_left}d"
        notify(
            db,
            type="task_due_soon",
            title=f"Task due soon: {task['name']}",
            body=f"{task['project_name'] or 'No project'} — {label}",
            msg="task_due_soon",
            params={"name": task["name"], "project": task["project_name"] or "No project", "label": label},
            link="/planning",
            entity_type="task",
            entity_id=task["id"],
            dedup_hours=24,
        )

    # ── Employment contracts expiring within 30 days ─────────────────────────
    # Generates one alert per active contract whose end_date enters the
    # 30-day horizon — gives HR a runway to renew / terminate without the
    # surprise of a contract lapsing overnight. Dedup-safe across the day.
    horizon = (date.today() + timedelta(days=30)).isoformat()
    expiring = db.execute(
        """SELECT c.id, c.contract_number, c.end_date, e.full_name AS emp
           FROM hr_contracts c
           JOIN hr_employees e ON e.id = c.employee_id
           WHERE c.archived_at IS NULL AND c.status = 'Active'
             AND c.end_date IS NOT NULL
             AND c.end_date >= ? AND c.end_date <= ?""",
        (today, horizon),
    ).fetchall()
    for c in expiring:
        try:
            end = date.fromisoformat(c["end_date"][:10])
            days_left = (end - date.today()).days
        except Exception:
            continue
        notify(
            db,
            type="contract_expiring",
            title=f"Contract expiring: {c['emp']}",
            body=f"{c['contract_number'] or 'No #'} — ends in {days_left}d ({c['end_date'][:10]})",
            msg="contract_expiring",
            params={"emp": c["emp"], "number": c["contract_number"] or "No #",
                    "days": days_left, "date": c["end_date"][:10]},
            link="/hr",
            entity_type="hr_contract",
            entity_id=c["id"],
            dedup_hours=24,
        )

    # ── Stale exchange rate (LBP) ────────────────────────────────────────────
    # No new rate in 7+ days means every LBP cash posting still books at an
    # old spot. We surface this once a day so accounting can refresh before
    # FX exposure compounds.
    rate_row = db.execute(
        "SELECT id, rate, created_at FROM exchange_rates "
        "ORDER BY id DESC LIMIT 1"
    ).fetchone()
    stale_days = 7
    if rate_row:
        try:
            rate_d = date.fromisoformat((rate_row["created_at"] or "")[:10])
            age = (date.today() - rate_d).days
            if age >= stale_days:
                notify(
                    db,
                    type="fx_rate_stale",
                    title="USD ↔ LBP rate is stale",
                    body=f"Latest spot is {age} days old "
                         f"(1 USD = {rate_row['rate']:,.0f} LBP). Set a new rate in Settings.",
                    msg="fx_rate_stale",
                    params={"age": age, "rate": float(rate_row["rate"])},
                    link="/settings",
                    entity_type="exchange_rate",
                    entity_id=rate_row["id"],
                    dedup_hours=24,
                )
        except Exception:
            pass

    # ── Period not locked T+10 ───────────────────────────────────────────────
    # A month that ended more than 10 days ago without a period lock is a
    # bright red flag for an auditor — somebody could still backdate entries
    # into it. We post ONE alert per (year, month) pair, dedup-safe.
    grace = (date.today() - timedelta(days=10))
    unlocked = db.execute(
        """SELECT id, year, month FROM accounting_periods
           WHERE locked_at IS NULL
             AND (year < ? OR (year = ? AND month <= ?))""",
        (grace.year, grace.year, grace.month - 1 if grace.month > 1 else 12),
    ).fetchall()
    for p in unlocked:
        notify(
            db,
            type="period_unlocked",
            title=f"Period {p['year']:04d}-{p['month']:02d} is not locked",
            body="Lock the month from Accounting → Period Locks to prevent backdated entries.",
            msg="period_unlocked",
            params={"period": f"{p['year']:04d}-{p['month']:02d}"},
            link="/accounting",
            entity_type="accounting_period",
            entity_id=p["id"],
            dedup_hours=24,
        )


# ── Endpoints ─────────────────────────────────────────────────────────────────

# A notification with `deliver_at` in the future is held back from every
# read endpoint — only when wall-clock catches up does it surface in the
# bell or the list. NULL means "deliver immediately" (the default).
_DUE_CLAUSE = "(deliver_at IS NULL OR deliver_at <= datetime('now'))"


@router.get("/count")
def get_unread_count(
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """Fast poll endpoint — returns only the unread count."""
    gated = _gated_types(user, db)
    sql = (
        f"SELECT COUNT(*) FROM notifications "
        f"WHERE (user_id IS NULL OR user_id=?) AND is_read=0 AND {_DUE_CLAUSE}"
        f"{_gating_sql(gated)}"
    )
    params = [user["id"], *gated]
    count = db.execute(sql, params).fetchone()[0]
    return {"unread_count": count}


# Templated query bodies. The role-gating fragment is appended at query time
# because its placeholder count depends on the caller's role.
_NOTIF_COUNT_SQL_BASE = f"""
    SELECT COUNT(*) FROM notifications
     WHERE (user_id IS NULL OR user_id = ?)
       AND (? IS NULL OR is_read = 0)
       AND (? IS NULL OR type = ?)
       AND {_DUE_CLAUSE}
"""

_NOTIF_LIST_SQL_BASE = f"""
    SELECT * FROM notifications
     WHERE (user_id IS NULL OR user_id = ?)
       AND (? IS NULL OR is_read = 0)
       AND (? IS NULL OR type = ?)
       AND {_DUE_CLAUSE}
"""

_NOTIF_LIST_SUFFIX = """
     ORDER BY is_read ASC, created_at DESC
     LIMIT ? OFFSET ?
"""


@router.get("/")
def list_notifications(
    limit:  int = Query(60, ge=1, le=200),
    offset: int = Query(0, ge=0),
    unread_only: bool = Query(False),
    type_filter: Optional[str] = Query(None),
    lang: Optional[str] = Query(None),
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    # Lazily generate system-level alerts
    try:
        _generate_system_notifications(db)
        db.commit()
    except Exception:
        pass

    gated = _gated_types(user, db)
    gating_sql = _gating_sql(gated)

    # Positional binds shared by the count and list queries, in clause order.
    base_params = [
        user["id"],
        1 if unread_only else None,
        type_filter, type_filter,
    ]

    total = db.execute(
        _NOTIF_COUNT_SQL_BASE + gating_sql,
        base_params + gated,
    ).fetchone()[0]

    unread_count = db.execute(
        f"SELECT COUNT(*) FROM notifications "
        f"WHERE (user_id IS NULL OR user_id=?) AND is_read=0 AND {_DUE_CLAUSE}"
        f"{gating_sql}",
        [user["id"], *gated],
    ).fetchone()[0]

    rows = db.execute(
        _NOTIF_LIST_SQL_BASE + gating_sql + _NOTIF_LIST_SUFFIX,
        base_params + gated + [limit, offset],
    ).fetchall()

    out = []
    for r in rows:
        d = dict(r)
        d["title"], d["body"] = localize(d, lang)
        out.append(d)

    return {
        "notifications": out,
        "unread_count":  unread_count,
        "total":         total,
    }


@router.patch("/mark-all-read")
def mark_all_read(
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    now = _now()
    db.execute(
        "UPDATE notifications SET is_read=1, read_at=? WHERE (user_id IS NULL OR user_id=?) AND is_read=0",
        (now, user["id"]),
    )
    db.commit()
    return {"ok": True}


@router.patch("/{notif_id}/read")
def mark_one_read(
    notif_id: int,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    db.execute(
        "UPDATE notifications SET is_read=1, read_at=? WHERE id=? AND (user_id IS NULL OR user_id=?)",
        (_now(), notif_id, user["id"]),
    )
    db.commit()
    return {"ok": True}


@router.delete("/clear-read")
def clear_read_notifications(
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    db.execute(
        "DELETE FROM notifications WHERE (user_id IS NULL OR user_id=?) AND is_read=1",
        (user["id"],),
    )
    db.commit()
    return {"ok": True}


@router.delete("/{notif_id}")
def delete_notification(
    notif_id: int,
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    db.execute(
        "DELETE FROM notifications WHERE id=? AND (user_id IS NULL OR user_id=?)",
        (notif_id, user["id"]),
    )
    db.commit()
    return {"ok": True}
