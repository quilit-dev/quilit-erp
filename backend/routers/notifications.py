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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _user_filter(user_id: int) -> tuple:
    """WHERE clause that selects global (NULL) and user-specific notifications."""
    return "(user_id IS NULL OR user_id = ?)", (user_id,)


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

@router.get("/count")
def get_unread_count(
    user=Depends(require_auth),
    db: sqlite3.Connection = Depends(get_db),
):
    """Fast poll endpoint — returns only the unread count."""
    count = db.execute(
        "SELECT COUNT(*) FROM notifications WHERE (user_id IS NULL OR user_id=?) AND is_read=0",
        (user["id"],),
    ).fetchone()[0]
    return {"unread_count": count}


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

    where = ["(user_id IS NULL OR user_id = ?)"]
    params: list = [user["id"]]

    if unread_only:
        where.append("is_read = 0")
    if type_filter:
        where.append("type = ?")
        params.append(type_filter)

    where_sql = " AND ".join(where)

    total = db.execute(
        f"SELECT COUNT(*) FROM notifications WHERE {where_sql}", params
    ).fetchone()[0]

    unread_count = db.execute(
        "SELECT COUNT(*) FROM notifications WHERE (user_id IS NULL OR user_id=?) AND is_read=0",
        (user["id"],),
    ).fetchone()[0]

    rows = db.execute(
        f"""SELECT * FROM notifications WHERE {where_sql}
            ORDER BY is_read ASC, created_at DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
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
