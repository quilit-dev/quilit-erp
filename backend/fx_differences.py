"""Every currency difference the books contain, and why it exists.

An accountant closing a period needs to answer one question about each of
these: *what happened here?* Not "there is 250 in account 6920" — which
transaction, at which two rates, on which dates, and has anybody looked at it.

Two kinds arise, and they are different in kind rather than in degree:

**Realised** — the money arrived. An invoice raised in euro at one rate and
settled at another brings in cash worth more or less than the claim was carried
at, and the gap is real: the company genuinely has that much more or less. It
is created by a payment and lives on the payment row that caused it.

**Unrealised** — nothing moved. Foreign notes in the drawer are simply worth
something different today than when they came in, and that difference reverses
itself the moment the rate moves back. It is created by a revaluation and lives
on the run that produced it.

Nothing here computes a difference. Both are already worked out and posted when
they arise — this assembles what was recorded, joins it to the documents and
entries around it, and lets an accountant mark that they have read it. That
distinction matters: a reconciliation screen that recalculates history would
disagree with the ledger the moment a rate was edited, and the ledger is the
record.
"""
import sqlite3
from typing import Optional

import denomination


REALIZED = "realized"
UNREALIZED = "unrealized"


def _reconciliation_map(db: sqlite3.Connection) -> dict:
    """Everything an accountant has signed off, keyed by (kind, ref)."""
    try:
        rows = db.execute(
            "SELECT r.kind, r.ref_id, r.status, r.note, r.reconciled_at, "
            "       u.full_name AS reconciled_by_name "
            "FROM fx_reconciliations r "
            "LEFT JOIN users u ON u.id = r.reconciled_by").fetchall()
    except sqlite3.Error:
        return {}
    return {(r["kind"], r["ref_id"]): dict(r) for r in rows}


def realized(db: sqlite3.Connection) -> list:
    """Differences created by settling a foreign invoice.

    One row per payment that moved value between the rate the claim was raised
    at and the rate the money arrived at. Payments that settled at the same
    rate produce nothing and are not differences.
    """
    rows = db.execute(
        """SELECT p.id            AS ref_id,
                  p.paid_at       AS occurred_at,
                  p.fx_difference AS difference,
                  p.txn_amount    AS txn_settled,
                  p.amount        AS base_obligation,
                  p.paid_currency AS tender_currency,
                  p.paid_amount   AS tender_amount,
                  p.exchange_rate AS settlement_rate,
                  p.method,
                  i.id            AS invoice_id,
                  i.invoice_number,
                  i.currency      AS currency,
                  i.exchange_rate AS recognition_rate,
                  i.txn_amount    AS invoice_txn_amount,
                  i.amount        AS invoice_base_amount,
                  i.created_at    AS recognised_at,
                  i.project_id,
                  c.id            AS client_id,
                  c.name          AS client_name,
                  b.id            AS bank_account_id,
                  b.name          AS bank_account_name,
                  je.id           AS journal_entry_id,
                  je.entry_number,
                  je.status       AS entry_status
             FROM invoice_payments p
             JOIN invoices  i ON i.id = p.invoice_id
        LEFT JOIN clients   c ON c.id = i.client_id
        LEFT JOIN bank_accounts b ON b.id = p.bank_account_id
        LEFT JOIN journal_entries je
               ON je.source_type = 'invoice_payment' AND je.source_id = p.id
            WHERE p.fx_difference IS NOT NULL
              AND (p.fx_difference > 0.005 OR p.fx_difference < -0.005)
         ORDER BY p.paid_at DESC, p.id DESC""").fetchall()

    out = []
    for r in rows:
        d = dict(r)
        d["kind"] = REALIZED
        # The value the claim was carried at, and what actually arrived. The
        # difference between them is the whole story.
        d["base_at_recognition"] = d.pop("base_obligation")
        d["base_at_settlement"] = round(
            float(d["base_at_recognition"] or 0) + float(d["difference"] or 0), 2)
        out.append(d)
    return out


def unrealized(db: sqlite3.Connection) -> list:
    """Differences created by revaluing a foreign balance nobody has spent.

    One row per revaluation run. The run records what was counted and what the
    books said, so the figure can be explained without re-deriving it.
    """
    try:
        rows = db.execute(
            """SELECT f.id             AS ref_id,
                      f.as_of          AS occurred_at,
                      f.difference,
                      f.currency,
                      f.account_code,
                      f.counted_amount AS tender_amount,
                      f.exchange_rate  AS settlement_rate,
                      f.book_base      AS base_at_recognition,
                      f.counted_base   AS base_at_settlement,
                      f.note,
                      f.created_at,
                      f.journal_entry_id,
                      a.name           AS account_name,
                      je.entry_number,
                      je.status        AS entry_status
                 FROM fx_revaluation_runs f
            LEFT JOIN chart_of_accounts a ON a.code = f.account_code
            LEFT JOIN journal_entries je ON je.id = f.journal_entry_id
             ORDER BY f.as_of DESC, f.id DESC""").fetchall()
    except sqlite3.Error:
        return []

    out = []
    for r in rows:
        d = dict(r)
        d["kind"] = UNREALIZED
        d["tender_currency"] = d["currency"]
        # A revaluation has no counterparty and no document: it is the
        # company's own holding being restated.
        d.setdefault("client_id", None)
        d.setdefault("client_name", None)
        d.setdefault("invoice_id", None)
        d.setdefault("invoice_number", None)
        d["recognition_rate"] = None
        out.append(d)
    return out


def collect(db: sqlite3.Connection, *, start: Optional[str] = None,
            end: Optional[str] = None, currency: Optional[str] = None,
            kind: Optional[str] = None, direction: Optional[str] = None,
            client_id: Optional[int] = None, project_id: Optional[int] = None,
            account_code: Optional[str] = None,
            bank_account_id: Optional[int] = None,
            status: Optional[str] = None) -> dict:
    """Every difference matching the filters, newest first, with totals.

    Assembled in Python rather than as one union query because the two kinds
    come from genuinely different shapes — a payment against an invoice, and a
    count against an account — and forcing them into one SELECT would mean a
    column list where half is NULL on every row and no reader could tell which
    half mattered.
    """
    recon = _reconciliation_map(db)
    rows = []
    if kind in (None, REALIZED):
        rows.extend(realized(db))
    if kind in (None, UNREALIZED):
        rows.extend(unrealized(db))

    for r in rows:
        mark = recon.get((r["kind"], r["ref_id"]))
        r["reconciled"] = bool(mark)
        r["reconciled_at"] = mark["reconciled_at"] if mark else None
        r["reconciled_by_name"] = mark["reconciled_by_name"] if mark else None
        r["reconcile_note"] = mark["note"] if mark else None
        # Posted the moment it arose; an entry that was reversed says so
        # rather than vanishing, because a reversal is part of the story.
        r["posting_status"] = (
            "reversed" if r.get("entry_status") == "reversed"
            else "posted" if r.get("journal_entry_id")
            else "unposted")
        r["direction"] = "gain" if float(r["difference"] or 0) > 0 else "loss"

    def keep(r):
        day = str(r.get("occurred_at") or "")[:10]
        if start and day < start[:10]:
            return False
        if end and day > end[:10]:
            return False
        if currency and (r.get("currency") or "").upper() != currency.upper():
            return False
        if direction and r["direction"] != direction:
            return False
        if client_id and r.get("client_id") != client_id:
            return False
        if project_id and r.get("project_id") != project_id:
            return False
        if account_code and (r.get("account_code") or "") != account_code:
            return False
        if bank_account_id and r.get("bank_account_id") != bank_account_id:
            return False
        if status == "reconciled" and not r["reconciled"]:
            return False
        if status == "open" and r["reconciled"]:
            return False
        if status in ("posted", "reversed", "unposted") and r["posting_status"] != status:
            return False
        return True

    rows = [r for r in rows if keep(r)]
    rows.sort(key=lambda r: (str(r.get("occurred_at") or ""), r["ref_id"]),
              reverse=True)

    gains = round(sum(float(r["difference"]) for r in rows
                      if float(r["difference"]) > 0), 2)
    losses = round(sum(float(r["difference"]) for r in rows
                       if float(r["difference"]) < 0), 2)
    return {
        "rows": rows,
        "base_currency": denomination.base_currency(),
        "summary": {
            "count": len(rows),
            "gains": gains,
            "losses": losses,
            "net": round(gains + losses, 2),
            "realized": round(sum(float(r["difference"]) for r in rows
                                  if r["kind"] == REALIZED), 2),
            "unrealized": round(sum(float(r["difference"]) for r in rows
                                    if r["kind"] == UNREALIZED), 2),
            "unreconciled": sum(1 for r in rows if not r["reconciled"]),
        },
    }
