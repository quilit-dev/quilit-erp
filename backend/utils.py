"""Shared utilities imported by all routers."""
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from fastapi import HTTPException
import math
import sqlite3


def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _today() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


# ════════════════════════════════════════════════════════════════════════════
# Money & tax — single source of truth
# ════════════════════════════════════════════════════════════════════════════
#
# Rounding policy
# ---------------
# All monetary amounts persisted to the database are rounded to **2 decimal
# places (cents) using ROUND_HALF_UP** — the rounding mode every Lebanese
# (and most other) tax authority expects on invoices. Doing this consistently
# is what guarantees that:
#
#     SUM(line.tax_amount) == document.tax_total
#
# down to the last cent. Helpers below use `Decimal` for the arithmetic so a
# 30-line invoice at 11% VAT doesn't accumulate the binary float drift that
# made the pre-refactor codebase show 1¢ header/line mismatches.
#
# Quantities and unit prices stay as floats — they are user-entered and may
# legitimately carry more precision than money (e.g. 0.125 kg, $1.4375/unit).
# We multiply in float, then promote to Decimal at the *line total* boundary,
# round to 2dp, and store.
#
# Two semantic flavours of "rate × base":
#
#   * EXCLUSIVE  — the line/document amount is net; VAT is added on top.
#                  Used by Invoices, Quotations, Purchases.
#                       tax = round(net × rate / 100)
#
#   * INCLUSIVE  — the line/document amount already contains VAT; it is
#                  extracted from the gross. Used by POS (retail prices are
#                  shelf-priced inclusive) and Expenses (a receipt's total is
#                  always what was actually paid).
#                       tax = round(gross × rate / (100 + rate))
#
# Tax-rate snapshot
# -----------------
# Every line stores the *value* of the rate at the moment the document was
# created (`tax_rate`, `tax_amount`). Changing the rate in the tax_rates table
# afterwards therefore can NEVER re-write history — historical reports stay
# stable and reproducible. All readers (VAT report, P&L, finance audit) MUST
# read the frozen snapshot fields, never recompute from `tax_rates`.

_TWO_PLACES = Decimal("0.01")


def money(v) -> float:
    """Round a money amount to 2 dp using bankers'-tax half-up. Use this
    whenever a computed amount is about to be stored or summed into a header
    total."""
    if v is None:
        return 0.0
    return float(Decimal(str(v)).quantize(_TWO_PLACES, rounding=ROUND_HALF_UP))


def get_tax_context(db: sqlite3.Connection) -> dict:
    """Resolve the active tax configuration once per request.

    Returns {enabled, rates: {id: {rate, tax_type, name}}, default_id}.
    """
    en = db.execute("SELECT value FROM settings WHERE key='tax_enabled'").fetchone()
    enabled = bool(en and en["value"] == "1")
    rates, default_id = {}, None
    try:
        for r in db.execute(
            "SELECT id, name, rate, tax_type, is_default FROM tax_rates WHERE is_active=1"
        ):
            rates[r["id"]] = {"rate": float(r["rate"] or 0),
                              "tax_type": r["tax_type"], "name": r["name"]}
            if r["is_default"]:
                default_id = r["id"]
    except sqlite3.OperationalError:
        pass  # tax_rates table not migrated yet
    return {"enabled": enabled, "rates": rates, "default_id": default_id}


def _pick_rate(ctx: dict, tax_rate_id, *, fallback_default: bool):
    """Resolve a rate id → (rid, rate%). Returns (None, 0.0) when the engine
    is disabled or the chosen id is unknown and no default fallback is wanted.
    """
    if not ctx["enabled"]:
        return (None, 0.0)
    rid = tax_rate_id if tax_rate_id in ctx["rates"] else (
        ctx["default_id"] if fallback_default else None
    )
    if rid not in ctx["rates"]:
        return (None, 0.0)
    return (rid, float(ctx["rates"][rid]["rate"] or 0))


def resolve_line_tax(ctx: dict, tax_rate_id, net):
    """Tax for an EXCLUSIVE-base line (sales / quote / purchase). `net` is the
    tax-exclusive line amount. Falls back to the default rate.
    Returns (tax_rate_id, tax_rate, tax_amount) — tax_amount rounded to cents."""
    rid, rate = _pick_rate(ctx, tax_rate_id, fallback_default=True)
    if rid is None or rate <= 0:
        return (rid, rate, 0.0)
    tax = Decimal(str(net or 0)) * Decimal(str(rate)) / Decimal("100")
    return (rid, rate, float(tax.quantize(_TWO_PLACES, rounding=ROUND_HALF_UP)))


def resolve_purchase_tax(ctx: dict, tax_rate_id, net):
    """Tax for a purchase line. Same exclusive-base model as sales lines."""
    return resolve_line_tax(ctx, tax_rate_id, net)


def resolve_inclusive_tax(ctx: dict, tax_rate_id, gross):
    """Tax for a tax-INCLUSIVE line (POS / retail). `gross` is the price the
    customer actually pays; VAT is extracted from it:
        tax = gross * rate / (100 + rate)
    Falls back to the default rate.
    Returns (tax_rate_id, tax_rate, tax_amount) — tax_amount rounded to cents."""
    rid, rate = _pick_rate(ctx, tax_rate_id, fallback_default=True)
    if rid is None or rate <= 0:
        return (rid, rate, 0.0)
    g = Decimal(str(gross or 0))
    r = Decimal(str(rate))
    tax = g * r / (Decimal("100") + r)
    return (rid, rate, float(tax.quantize(_TWO_PLACES, rounding=ROUND_HALF_UP)))


def resolve_expense_tax(ctx: dict, tax_rate_id, gross):
    """Tax for an expense. `gross` is the total paid (tax-inclusive), so VAT
    is EXTRACTED. NO default fallback — an expense is tax-free unless a rate
    is explicitly chosen by the user (matches receipt-driven workflow).
    Returns (tax_rate_id, tax_rate, tax_amount) — tax_amount rounded to cents."""
    rid, rate = _pick_rate(ctx, tax_rate_id, fallback_default=False)
    if rid is None or rate <= 0:
        return (rid, rate, 0.0)
    g = Decimal(str(gross or 0))
    r = Decimal(str(rate))
    tax = g * r / (Decimal("100") + r)
    return (rid, rate, float(tax.quantize(_TWO_PLACES, rounding=ROUND_HALF_UP)))


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
    deliver_at: str = None,
) -> "Optional[int]":
    """
    Insert a notification row. Call BEFORE db.commit() to include in the same transaction.

    dedup_hours > 0
        Skip insertion if an identical (type, entity_id) notification was already
        created within that many hours (prevents repeat alerts).
    deliver_at
        Optional 'YYYY-MM-DD HH:MM:SS' timestamp. The row is inserted now but the
        notifications list endpoint hides it until the wall-clock catches up.
        Used by reminder workflows (HR Activities) to schedule a future ping
        without needing a background scheduler.

    Returns the newly inserted notification id, or None on dedup-skip / error.
    """
    if dedup_hours > 0 and entity_id is not None:
        # Cutoff computed in Python (UTC, matching SQLite's datetime('now')) so the
        # query is a portable plain-string comparison — byte-identical on SQLite
        # and Postgres (avoids SQLite-only datetime('now', <modifier>) date math).
        cutoff = (datetime.utcnow() - timedelta(hours=dedup_hours)).strftime("%Y-%m-%d %H:%M:%S")
        recent = db.execute(
            """SELECT id FROM notifications
               WHERE type=? AND entity_id=? AND created_at >= ?""",
            (type, entity_id, cutoff),
        ).fetchone()
        if recent:
            return None
    try:
        cur = db.execute(
            """INSERT INTO notifications
                   (user_id, type, title, body, link, entity_type, entity_id,
                    is_read, created_at, deliver_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
            (user_id, type, title, body, link, entity_type, entity_id,
             _now(), deliver_at),
        )
        return cur.lastrowid
    except Exception:
        return None  # never let a notification failure break the main operation

# Approval-workflow logic lives in approval_engine.py (policy evaluation,
# workflow execution, notification routing and entity resolution).


# ════════════════════════════════════════════════════════════════════════════
# Inventory quantity validation
# ════════════════════════════════════════════════════════════════════════════
#
# Business rule: inventory moves in whole units only — no fractional pieces
# can be inserted, deducted, sold, purchased, produced or consumed. This is
# enforced at every endpoint that touches stock so the rule can't be bypassed
# by hitting a different router. Manufacturing's *derived* requirements are
# rounded up via math.ceil (see routers/manufacturing.py); these helpers
# guard the *user-supplied* quantities themselves.

def _is_whole(v) -> bool:
    """True iff v is a whole-number value (e.g. 3, 3.0, '3', '3.0')."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    if math.isnan(f) or math.isinf(f):
        return False
    # Tolerate the float-binary noise that creeps in via JSON (3.0000000004).
    return abs(f - round(f)) < 1e-9


def validate_int_qty(value, label: str = "Quantity") -> int:
    """Validate a stock-affecting quantity is a whole number; return it as int.

    Rejects fractional values with HTTP 400 — caller decides whether sign or
    zero are acceptable for their context (POS quantity must be > 0; a stock
    adjustment delta may be negative). The check is purely about *integrality*.
    """
    if value is None or not _is_whole(value):
        raise HTTPException(
            400,
            f"{label} must be a whole number — inventory is tracked in whole units only."
        )
    return int(round(float(value)))
