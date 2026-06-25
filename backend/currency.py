"""Currency conversion helpers for the USD-functional / LBP-secondary model.

Every business amount is stored in USD (the functional currency). LBP is a
secondary currency the operator may quote prices or supplier costs in; those
get converted to USD at the rate in effect *at the moment they enter the
books* (sale time, receive time, item entry). This module centralises the
rate lookup that was previously copy-pasted across invoices/cash/hr/accounting
and the LBP→USD conversion with its guard rail.

Rate convention: `exchange_rates.rate` = LBP units per 1 USD (e.g. 89000), so
`usd = lbp / rate`.
"""
import sqlite3

from fastapi import HTTPException

from utils import money


def latest_rate(db: sqlite3.Connection):
    """Most recently recorded LBP-per-USD rate, or None if none is configured."""
    try:
        row = db.execute(
            "SELECT rate FROM exchange_rates ORDER BY id DESC LIMIT 1"
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    if not row or not row["rate"]:
        return None
    return float(row["rate"])


def resolve_rate(db: sqlite3.Connection, supplied=None) -> float:
    """Return a usable LBP/USD rate: the caller-supplied override when positive,
    else the latest stored rate. Raises 400 with operator guidance when neither
    is available — mirrors the message used by invoice payments so the UX is
    consistent across modules."""
    if supplied and float(supplied) > 0:
        return float(supplied)
    rate = latest_rate(db)
    if not rate:
        raise HTTPException(
            400,
            "An exchange rate is required for LBP amounts. No rate is "
            "configured — set one in Settings → Exchange Rate first.",
        )
    return rate


def to_usd(amount, currency, db: sqlite3.Connection, rate=None) -> float:
    """Convert `amount` in `currency` to USD, rounded to cents.

    USD passes through unchanged. LBP divides by the resolved rate. Any other
    currency is rejected — the system supports only USD + LBP."""
    cur = (currency or "USD").upper()
    if cur == "USD":
        return money(amount)
    if cur != "LBP":
        raise HTTPException(400, f"Unsupported currency '{currency}'.")
    return money(float(amount) / resolve_rate(db, rate))
