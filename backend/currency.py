"""Currency conversion for a USD-functional book with foreign currencies beside it.

Every business amount is stored in USD. LBP and EUR are currencies the operator
may quote, tender or be billed in; those convert to USD at the rate in effect on
the date the transaction belongs to.

Rate convention: `exchange_rates.rate` is units of that currency per 1 USD —
89,000 for LBP, 0.92 for EUR — so `usd = amount / rate` in every case.

**Effective dating.** A rate carries the date it takes effect, and a lookup asks
for the rate in force on the transaction's own date rather than the newest one
in the table. Entering last month's invoice today must not convert it at today's
rate.

This cannot restate anything already posted. Amounts are stored converted, so
history was fixed at the moment it was written; the date only decides which rate
a NEW conversion picks up. A rate entered with no effective date, or a lookup
with no date, still gets the latest — which is exactly what the system did
before, so nothing changes for a business that never touches the dates.
"""
import sqlite3

from fastapi import HTTPException

from utils import money

# USD is functional. The others are what a Lebanese business actually handles.
FUNCTIONAL = "USD"
SUPPORTED = ("USD", "LBP", "EUR")


def is_supported(currency) -> bool:
    return (currency or "").upper() in SUPPORTED


def rate_on(db: sqlite3.Connection, currency: str, on_date=None):
    """The rate for `currency` in force on `on_date`, or None if there is none.

    Picks the most recent rate whose effective date is on or before the
    transaction's date. Falling back to the newest row when nothing qualifies
    matters for the first months of a currency's life: rates entered before
    anyone thought to backdate them should still convert something dated
    earlier, rather than refusing and blocking the sale.
    """
    cur = (currency or "").upper()
    if cur == FUNCTIONAL:
        return 1.0
    try:
        if on_date:
            row = db.execute(
                "SELECT rate FROM exchange_rates "
                " WHERE UPPER(COALESCE(currency,'LBP')) = ? "
                "   AND effective_date IS NOT NULL AND effective_date <= ? "
                " ORDER BY effective_date DESC, id DESC LIMIT 1",
                (cur, str(on_date)[:10]),
            ).fetchone()
            if row and row["rate"]:
                return float(row["rate"])
        row = db.execute(
            "SELECT rate FROM exchange_rates "
            " WHERE UPPER(COALESCE(currency,'LBP')) = ? "
            " ORDER BY effective_date DESC, id DESC LIMIT 1",
            (cur,),
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    if not row or not row["rate"]:
        return None
    return float(row["rate"])


def latest_rate(db: sqlite3.Connection):
    """Most recently recorded LBP-per-USD rate, or None if none is configured.

    Kept because several modules ask for "the rate" without a transaction in
    hand — a live quote on a form, a drawer count. Anything posting to the
    ledger should use `rate_on` with the date it is posting under.
    """
    return rate_on(db, "LBP")


def resolve_rate(db: sqlite3.Connection, supplied=None, currency="LBP",
                 on_date=None) -> float:
    """A usable rate: the caller's override when positive, else the stored one.

    The override wins because the operator was there. A cashier handed LBP at a
    rate the street agreed on has better information than a table someone
    updated on Monday.
    """
    if supplied and float(supplied) > 0:
        return float(supplied)
    rate = rate_on(db, currency, on_date)
    if not rate:
        cur = (currency or "").upper()
        raise HTTPException(
            400,
            f"An exchange rate is required for {cur} amounts. No rate is "
            f"configured — set one in Settings → Exchange Rate first.",
        )
    return rate


def to_usd(amount, currency, db: sqlite3.Connection, rate=None, on_date=None) -> float:
    """Convert `amount` in `currency` to USD, rounded to cents.

    USD passes through. Anything else divides by the rate in force on
    `on_date`, or the latest when no date is given.
    """
    cur = (currency or FUNCTIONAL).upper()
    if cur == FUNCTIONAL:
        return money(amount)
    if cur not in SUPPORTED:
        raise HTTPException(
            400,
            f"Unsupported currency '{currency}'. This system handles "
            + ", ".join(SUPPORTED) + ".",
        )
    return money(float(amount) / resolve_rate(db, rate, cur, on_date))


def from_usd(amount_usd, currency, db: sqlite3.Connection, rate=None, on_date=None) -> float:
    """The other direction: what `amount_usd` is worth in `currency`.

    Needed to show a customer their own currency on a document, and to price a
    receipt in the currency it will be settled in.
    """
    cur = (currency or FUNCTIONAL).upper()
    if cur == FUNCTIONAL:
        return money(amount_usd)
    if cur not in SUPPORTED:
        raise HTTPException(
            400,
            f"Unsupported currency '{currency}'. This system handles "
            + ", ".join(SUPPORTED) + ".",
        )
    converted = float(amount_usd) * resolve_rate(db, rate, cur, on_date)
    # LBP has no subunit in practice — a bill is never quoted in piastres.
    return round(converted) if cur == "LBP" else money(converted)
