"""What a journal entry came from, and where to go to look at it.

Every posting carries `(source_type, source_id)`, which is enough for the code
that wrote it and nothing at all for the person reading the ledger. "expense
#4127" is not an answer to "what is this $840?".

This turns that pair into three things a reader can use: a **label** (the
document's own number, the one printed on the paper), a **route** into the app,
and the id needed to open it. It is deliberately read-only and deliberately
tolerant — a source whose document has since been deleted resolves to a label
without a route rather than raising, because a ledger that refuses to render
because one invoice was purged is worse than one that says "invoice #40 (no
longer present)".

The routes follow the deep-link convention the global search already uses:
`/<page>?focus=<id>`, read by `useFocusId` on the far side.

Not every source is a document. Closing entries, revaluations, manual entries
and reversals have no paper behind them; they resolve to a label and no route,
which is the honest answer.
"""
import sqlite3
from typing import Optional


class _Doc:
    """One source type: where its document lives and how to name it."""

    def __init__(self, table, number_col, page=None, *, id_col="id",
                 via=None, fallback=None):
        self.table      = table
        self.number_col = number_col   # the column carrying the human number
        self.page       = page         # frontend route, or None if unreachable
        self.id_col     = id_col
        # Some sources point at a child row (a payment) while the document a
        # reader wants is its parent (the invoice). `via` names the column
        # holding the parent id, and the route is built from that instead.
        self.via        = via
        self.fallback   = fallback     # label when the number column is empty


# Journal source types only. Stock movements use their own `source_type`
# vocabulary in a different column and are not resolved here.
SOURCES: dict[str, _Doc] = {
    "invoice":          _Doc("invoices", "invoice_number", "/invoices"),
    # A payment's document is the invoice it settled.
    "invoice_payment":  _Doc("invoice_payments", None, "/invoices", via="invoice_id"),
    "expense":          _Doc("expenses", "description", "/expenses",
                             fallback="Expense"),
    "depreciation":     _Doc("expenses", "description", "/expenses",
                             fallback="Depreciation"),
    "prepaid_payment":  _Doc("expenses", "description", "/expenses",
                             fallback="Paid in advance"),
    "purchase":         _Doc("purchases", "po_number", "/purchases"),
    # Paying a supplier is its own entry now — a deposit before the goods
    # arrive, the balance after — so the money side of a purchase no longer
    # lives inside the receipt. Its document is the purchase it settles, the
    # same way a payment's document is the invoice it settles.
    "purchase_payment": _Doc("purchase_payments", None, "/purchases",
                             via="purchase_id"),
    # POS sales and service jobs are invoices by the time they reach the GL.
    "pos_cogs":         _Doc("invoices", "invoice_number", "/invoices"),
    "service_cogs":     _Doc("service_jobs", "job_number", "/service"),
    "payroll":          _Doc("hr_payroll_runs", "period_start", None,
                             fallback="Payroll run"),
    # Buying an asset and selling it are entries against the register itself,
    # not against an expense row the way a depreciation charge is.
    "asset_acquisition": _Doc("fixed_assets", "asset_code", "/fixed-assets",
                              fallback="Asset acquired"),
    "asset_disposal":    _Doc("fixed_assets", "asset_code", "/fixed-assets",
                              fallback="Asset disposed"),
    # The opening entry covers every asset at once, so it points at no single
    # one of them.
    "asset_opening":     _Doc("fixed_assets", None, "/fixed-assets",
                              fallback="Assets brought onto the books"),
}


def _row(db: sqlite3.Connection, doc: _Doc, source_id: int):
    cols = {doc.id_col}
    if doc.number_col:
        cols.add(doc.number_col)
    if doc.via:
        cols.add(doc.via)
    try:
        return db.execute(
            f"SELECT {', '.join(sorted(cols))} FROM {doc.table} "
            f"WHERE {doc.id_col}=?", (source_id,)).fetchone()
    except sqlite3.Error:
        # A table that does not exist in this tenant (an unbought module) is a
        # missing document, not a server error.
        return None


def describe(db: sqlite3.Connection, source_type: Optional[str],
             source_id: Optional[int]) -> Optional[dict]:
    """Resolve one posting's origin.

    Returns None when there is nothing to resolve — a manual entry, a closing
    entry, a revaluation. Otherwise a dict with `type`, `label`, and, when the
    document is still there and reachable, `route`.
    """
    if not source_type or source_id is None:
        return None

    doc = SOURCES.get(source_type)
    if doc is None:
        return {"type": source_type, "id": source_id, "label": None,
                "route": None, "exists": None}

    row = _row(db, doc, source_id)
    if row is None:
        return {"type": source_type, "id": source_id,
                "label": doc.fallback, "route": None, "exists": False}

    # The id to open: the parent document when this posting hangs off a child.
    target = row[doc.via] if doc.via else source_id

    label = None
    if doc.number_col:
        label = (row[doc.number_col] or "").strip() or None
    elif doc.via:
        # A payment names itself by the invoice it settled.
        parent = db.execute("SELECT invoice_number FROM invoices WHERE id=?",
                            (target,)).fetchone()
        label = (parent["invoice_number"] if parent else None) or None

    route = None
    if doc.page and target is not None:
        route = f"{doc.page}?focus={target}"

    return {"type": source_type, "id": source_id, "label": label or doc.fallback,
            "route": route, "exists": True}


# ── The other direction ──────────────────────────────────────────────────────
# "Show me the accounting behind this invoice" is the question an operator
# actually asks, and it is not the inverse of a single row: one document can
# produce several postings — an invoice raises revenue, relieves cost of goods
# when it came from the till, and gains one more posting per payment against it.

def postings_for(db: sqlite3.Connection, document: str,
                 doc_id: int) -> list[tuple[str, int]]:
    """Every `(source_type, source_id)` pair a document could have produced."""
    if document == "invoice":
        pairs = [("invoice", doc_id), ("pos_cogs", doc_id)]
        try:
            pairs += [("invoice_payment", r["id"]) for r in db.execute(
                "SELECT id FROM invoice_payments WHERE invoice_id=?", (doc_id,))]
        except sqlite3.Error:
            pass
        return pairs
    if document == "expense":
        # The three ways a cost reaches the ledger, all keyed on the expense row.
        return [("expense", doc_id), ("depreciation", doc_id),
                ("prepaid_payment", doc_id)]
    if document == "purchase":
        pairs = [("purchase", doc_id)]
        try:
            pairs += [("purchase_payment", r["id"]) for r in db.execute(
                "SELECT id FROM purchase_payments WHERE purchase_id=?", (doc_id,))]
        except sqlite3.Error:
            # The table predates nothing that matters here: an install mid
            # upgrade simply has no payments to show.
            pass
        return pairs
    if document == "payroll_run":
        return [("payroll", doc_id)]
    if document == "service_job":
        pairs = [("service_cogs", doc_id)]
        try:
            # The link lives on the invoice, and only the live one counts —
            # a voided invoice's postings were reversed with it.
            row = db.execute(
                "SELECT id FROM invoices WHERE service_job_id=? "
                "AND voided_at IS NULL", (doc_id,)).fetchone()
            if row:
                pairs += postings_for(db, "invoice", row["id"])
        except sqlite3.Error:
            pass
        return pairs
    return []


DOCUMENTS = ("invoice", "expense", "purchase", "payroll_run", "service_job")
