"""The currency a document was agreed in, and its value in the company's books.

Two different questions get confused constantly, so they are named apart here:

  transaction currency  what the customer agreed, and what their invoice,
                        receipt and statement must say. EUR 5,000 stays
                        EUR 5,000 forever.
  base currency         what the company keeps its books and reports in.
                        Everything aggregates here, so a dashboard covering
                        customers in three currencies means something.

A document records BOTH, plus the rate that connects them, taken on the day it
was recognised. Storing the rate — rather than looking it up when someone
reads the document later — is what stops a rate entered next month from
restating an invoice issued today. That is not a nicety: a receivable that
changes value every time somebody edits a rate table is not a receivable.

The base figures live in the columns that were always there (`amount`,
`subtotal`, …), so every report, balance and ledger posting in the system goes
on reading exactly what it read before. The transaction figures live beside
them in `txn_*`, and a NULL there means the document is in the base currency
and the base figure is the original — which is true of every row written before
this existed. Nothing historical is rewritten.
"""
import sqlite3
from typing import Optional

import currency as currency_mod
from utils import money


class RateUnavailable(Exception):
    """No rate is configured for a currency on the date it is needed."""


def base_currency() -> str:
    """The currency the books are kept in.

    Note this is NOT the `default_currency` setting, which controls what
    printed documents display and can be changed freely. This is the ledger's
    own currency, and changing it would mean re-denominating every posting
    ever made.
    """
    return currency_mod.FUNCTIONAL


def resolve(db: sqlite3.Connection, cur: Optional[str], on_date=None,
            rate: Optional[float] = None) -> tuple[str, float]:
    """Settle on a currency and the rate to base for `on_date`.

    An explicit `rate` wins and is stored as given: when somebody keys in the
    rate actually agreed rather than the one in the table, that is a decision a
    person made and the document should record it, not quietly overwrite it
    with the official figure.
    """
    cur = (cur or base_currency()).upper()
    if cur not in currency_mod.SUPPORTED:
        raise RateUnavailable(
            f"Unsupported currency '{cur}'. This system handles "
            + ", ".join(currency_mod.SUPPORTED) + ".")
    if cur == base_currency():
        return cur, 1.0
    if rate and float(rate) > 0:
        return cur, float(rate)

    found = currency_mod.rate_on(db, cur, on_date)
    if not found or found <= 0:
        raise RateUnavailable(
            f"No {cur} exchange rate is configured for {on_date or 'today'}. "
            f"Set one in Settings → Exchange Rate first.")
    return cur, float(found)


def to_base(amount, rate: float) -> float:
    """A transaction-currency amount in base currency.

    Rates are held as units of the currency per one unit of base, so this
    divides — the same direction `currency.to_usd` has always used.
    """
    if amount is None:
        return None
    return money(float(amount) / float(rate or 1))


def to_txn(base_amount, rate: float) -> float:
    """A base amount expressed in the transaction currency."""
    if base_amount is None:
        return None
    return money(float(base_amount) * float(rate or 1))


def is_base(cur: Optional[str]) -> bool:
    return (cur or base_currency()).upper() == base_currency()


def describe(row, *, base_field: str, txn_field: str) -> dict:
    """How one document's money should be presented.

    Returns the transaction figure and currency for anything customer-facing,
    and the base figure for anything internal. A row with no transaction
    currency is in the base currency, and both answers are the same number —
    which is what makes every existing document keep displaying as it did.
    """
    cur = (_get(row, "currency") or base_currency()).upper()
    base_amount = _get(row, base_field)
    txn_amount = _get(row, txn_field)
    if txn_amount is None:
        txn_amount = base_amount
    return {
        "currency": cur,
        "amount": txn_amount,          # what the customer sees
        "base_currency": base_currency(),
        "base_amount": base_amount,    # what the company reports
        "exchange_rate": _get(row, "exchange_rate") or 1.0,
    }


def _get(row, key):
    """Read a column that may not exist on this row (older SELECTs, or a
    tenant whose migration has not run yet)."""
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


# ── Settling a foreign invoice ───────────────────────────────────────────────
# An invoice recognised at one rate and paid at another leaves a difference,
# and that difference is a realised gain or loss on the day the money arrives.
# It is not a rounding error to be swept up: EUR 5,000 recognised at 1.10 is a
# claim for USD 5,500, and if it settles when the euro is worth 1.05 the
# company received USD 5,250 for a 5,500 claim and is USD 250 worse off.
#
# Three currencies can be in play and they are worth naming apart:
#
#   invoice currency    what the customer owes.        EUR
#   tender currency     what they actually handed over. could be USD
#   base currency       what the books are kept in.     USD

def settle(db: sqlite3.Connection, *, invoice_currency, invoice_rate,
           tender_currency, tender_amount, tender_rate, on_date=None) -> dict:
    """Work out what one payment settles, and what it costs in exchange.

    Returns the obligation settled in the invoice's currency, that obligation
    valued at the rate the invoice was RECOGNISED at (which is what relieves
    the receivable), the base value of the money actually received, and the
    difference between the two.

    A positive difference is a gain: more cash arrived than the claim was
    carried at.
    """
    invoice_currency = (invoice_currency or base_currency()).upper()
    tender_currency = (tender_currency or base_currency()).upper()
    invoice_rate = float(invoice_rate or 1)

    # What the money is worth in the company's own currency — the cash that
    # actually landed, which is what the bank or the till really received.
    cash_base = to_base(tender_amount, tender_rate or 1)

    if tender_currency == invoice_currency:
        # The ordinary case: they paid in the currency they were billed in, so
        # the obligation settled is exactly what they handed over.
        txn_settled = money(tender_amount)
    else:
        # They paid in something else. How much of the debt that clears is a
        # question about today's rate between the two, and the honest route is
        # through base: cash_base is what it is worth now, and the debt is
        # denominated at the invoice's own currency.
        rate_now = (1.0 if invoice_currency == base_currency()
                    else currency_mod.rate_on(db, invoice_currency, on_date))
        if not rate_now or rate_now <= 0:
            raise RateUnavailable(
                f"No {invoice_currency} rate is configured for "
                f"{on_date or 'today'}, so it cannot be said how much of this "
                f"{invoice_currency} invoice a {tender_currency} payment "
                "settles.")
        txn_settled = money(cash_base * float(rate_now))

    # The receivable was raised at the recognition rate, so that is the rate it
    # has to be relieved at. Anything else leaves a balance that never clears.
    obligation_base = to_base(txn_settled, invoice_rate)

    return {
        "txn_settled": txn_settled,
        "obligation_base": obligation_base,
        "cash_base": cash_base,
        "fx_difference": money(cash_base - obligation_base),
    }
