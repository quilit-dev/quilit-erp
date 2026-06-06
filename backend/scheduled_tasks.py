"""
Periodic background tasks (Feature #1).

Each task is IDEMPOTENT — safe to run on any scheduler tick without double-acting,
because it dedups its own work (here, via the audit log). So the scheduler can run
them frequently and they still behave correctly. ``PERIODIC`` is the registry the
scheduler iterates per tenant.
"""
from datetime import datetime, timedelta

from utils import _today

# Synthetic actor for system-initiated audit rows (no logged-in user).
_SYSTEM_USER = {"id": None, "username": "system", "full_name": "Scheduler"}


def send_overdue_invoice_reminders(db, remind_every_days: int = 3) -> int:
    """Email a payment reminder for each overdue invoice that still has a balance
    and whose client has an email — at most once per ``remind_every_days`` (dedup
    via the audit log). Returns how many reminders were sent. No-op if email is
    disabled. Idempotent."""
    import mailer
    if not mailer.is_enabled(db):
        return 0
    import email_templates
    from routers.audit import log_action

    today = _today()
    cutoff = (datetime.utcnow() - timedelta(days=remind_every_days)
              ).strftime("%Y-%m-%d %H:%M:%S")

    rows = db.execute(
        """SELECT i.*, c.name AS client_name, c.email AS client_email
           FROM invoices i
           JOIN clients c ON i.client_id = c.id
           WHERE i.voided_at IS NULL
             AND i.due_date IS NOT NULL AND i.due_date < ?
             AND c.email IS NOT NULL AND c.email != ''""",
        (today,)).fetchall()

    sent = 0
    for row in rows:
        inv = dict(row)
        paid = db.execute(
            "SELECT COALESCE(SUM(amount), 0) AS p FROM invoice_payments WHERE invoice_id=?",
            (inv["id"],)).fetchone()["p"]
        remaining = float(inv.get("amount") or 0) - float(paid or 0)
        if remaining <= 0.01:
            continue                                   # fully paid — skip
        # Dedup: already reminded within the window?
        if db.execute(
            "SELECT 1 FROM audit_log WHERE module='invoice' AND action='reminder' "
            "AND record_id=? AND created_at >= ?", (inv["id"], cutoff)).fetchone():
            continue

        inv["total_paid"] = paid
        inv["remaining"] = remaining
        items = [dict(i) for i in db.execute(
            "SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id", (inv["id"],)
        ).fetchall()]
        _, html = email_templates.render_invoice(
            db, inv, items,
            message="This invoice is past its due date. "
                    "Please arrange payment at your earliest convenience.")
        num = inv.get("invoice_number") or inv["id"]
        mailer.send(db, inv["client_email"], f"Payment reminder — invoice {num}", html)
        log_action(db, _SYSTEM_USER, "reminder", "invoice", inv["id"],
                   f"Overdue reminder emailed to {inv['client_email']}")
        sent += 1

    db.commit()
    return sent


# (task_name, callable(db) -> int). The scheduler runs each per active tenant.
PERIODIC = [
    ("invoice.overdue_reminders", send_overdue_invoice_reminders),
]
