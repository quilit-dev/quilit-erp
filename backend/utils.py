"""Shared utilities imported by all routers."""
from datetime import datetime
import sqlite3, json


def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _today() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def _get_tax_multiplier(db: sqlite3.Connection) -> float:
    """Return (1 + tax_rate/100) if tax is enabled in settings, else 1.0."""
    tax_enabled = db.execute("SELECT value FROM settings WHERE key='tax_enabled'").fetchone()
    if not tax_enabled or tax_enabled["value"] != "1":
        return 1.0
    tax_rate_row = db.execute("SELECT value FROM settings WHERE key='default_tax_rate'").fetchone()
    try:
        rate = float(tax_rate_row["value"]) if tax_rate_row else 0.0
    except (TypeError, ValueError):
        rate = 0.0
    return 1.0 + rate / 100.0


def notify(
    db: sqlite3.Connection,
    *,
    user_id=None,
    type: str = "system",
    title: str,
    body: str = None,
    link: str = None,
    entity_type: str = None,
    entity_id: int = None,
    dedup_hours: int = 0,
) -> None:
    """
    Insert a notification row. Call BEFORE db.commit() to include in the same transaction.
    dedup_hours > 0: skip insertion if an identical (type, entity_id) notification
    was already created within that many hours (prevents repeat alerts).
    """
    if dedup_hours > 0 and entity_id is not None:
        recent = db.execute(
            """SELECT id FROM notifications
               WHERE type=? AND entity_id=?
                 AND created_at >= datetime('now', ?)""",
            (type, entity_id, f"-{dedup_hours} hours"),
        ).fetchone()
        if recent:
            return
    try:
        db.execute(
            """INSERT INTO notifications
                   (user_id, type, title, body, link, entity_type, entity_id, is_read, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)""",
            (user_id, type, title, body, link, entity_type, entity_id, _now()),
        )
    except Exception:
        pass  # never let a notification failure break the main operation

# Approval-workflow logic lives in approval_engine.py (policy evaluation,
# workflow execution, notification routing and entity resolution).
