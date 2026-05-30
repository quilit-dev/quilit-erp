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
    "invoice_paid":         "invoices",
    "payment_received":     "invoices",
    "invoice_overdue":      "invoices",
    "low_stock":            "inventory",
    "purchase_received":    "purchases",
    "quotation_accepted":   "quotations",
    "task_due_soon":        "planning",
    "planning_event":       "planning",
    "deal_won":             "crm",
    "deal_lost":            "crm",
    "lead_converted":       "crm",
    "production_completed": "manufacturing",
    "asset_depreciated":    "assets",
    "cash_variance":        "cash",
    "recruitment_status":   "recruitment",
    "recruitment_hired":    "recruitment",
    "hr_activity_reminder": "hr_activities",
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


def _generate_system_notifications(db: sqlite3.Connection) -> None:
    """
    Lazily generate system-level notifications for conditions that don't have
    a natural trigger point (overdue invoices, tasks due soon, low stock summary).
    Called once per list request — dedup prevents storm.
    """
    today = _today()

    # ── Overdue invoices ──────────────────────────────────────────────────────
    overdue = db.execute(
        """SELECT i.id, i.invoice_number, i.amount, i.due_date, c.name AS client_name,
                  COALESCE((SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.id), 0) AS paid
           FROM invoices i
           LEFT JOIN clients c ON c.id = i.client_id
           WHERE i.voided_at IS NULL AND i.archived_at IS NULL
             AND i.due_date IS NOT NULL AND i.due_date < ?""",
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
            link="/planning",
            entity_type="task",
            entity_id=task["id"],
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

    return {
        "notifications": [dict(r) for r in rows],
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
