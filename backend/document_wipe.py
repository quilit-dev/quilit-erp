"""Removing a tenant's test till sales and quotations, ahead of an inventory wipe.

The inventory wipe refused on vertex: sixteen till-sale lines and eight
quotation lines pointed at items. The owner confirmed those are trial
entries. So this sweeps exactly those two kinds of document --- the POS sales
that carry an item line, with everything one creates (its invoice, invoice
lines, payment, ledger entries, receipt vouchers, returns, instalments), and
the quotations that carry an item line --- and nothing else. Ordinary
invoices, purchases, service jobs, projects, clients, cash reconciliations,
users and settings are not touched.

Same discipline as inventory_wipe:

* **What refers to the swept documents is read from the schema**, and any
  reference the sweep does not know how to unwind is a blocker: nothing is
  removed. The known references are handled one by one below, each with the
  reason it is safe.
* **A locked accounting period is a blocker.** Deleting a posted entry out of
  a closed month is the one thing an accountant can never be asked to accept.
* **Plan first, then the same plan inside the transaction.**

Only ever called from inventory_wipe.execute, after the operator typed the
tenant's name, and only for the documents that were blocking that wipe.
"""
from fastapi import HTTPException

import database

# Ledger sources a till sale creates. Anything else on the ledger stays.
_SALE_SOURCES = ("invoice", "pos_cogs")
_PAYMENT_SOURCES = ("invoice_payment",)


def _is_postgres() -> bool:
    return database.DB_BACKEND not in ("sqlite", "sqlite3")


def _ids(db, sql, params=()):
    return sorted({int(r[0]) for r in db.execute(sql, params).fetchall() if r[0] is not None})


def _in(ids):
    return "(" + ",".join(str(int(i)) for i in ids) + ")" if ids else "(NULL)"


def _columns_pointing_at(db, table, id_names):
    """(table, column) pairs whose column is named like a key to `table`
    --- `invoice_id`, `pos_sale_id`... --- plus the declared foreign keys.
    Both, for the same reason inventory_wipe unions them."""
    found = set()
    if _is_postgres():
        for r in db.execute(
            "SELECT tc.table_name, kcu.column_name "
            "  FROM information_schema.table_constraints tc "
            "  JOIN information_schema.key_column_usage kcu "
            "    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema "
            "  JOIN information_schema.constraint_column_usage ccu "
            "    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema "
            " WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema() "
            "   AND ccu.table_name = ? AND ccu.column_name = 'id'", (table,)).fetchall():
            found.add((r["table_name"], r["column_name"]))
        for name in id_names:
            for r in db.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                " WHERE table_schema = current_schema() AND column_name = ?", (name,)).fetchall():
                found.add((r["table_name"], r["column_name"]))
    else:
        tables = [r["name"] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        for t in tables:
            for fk in db.execute(f"PRAGMA foreign_key_list('{t}')").fetchall():
                if fk[2] == table and (fk[4] in (None, "id")):
                    found.add((t, fk[3]))
            for col in db.execute(f"PRAGMA table_info('{t}')").fetchall():
                if col[1] in id_names:
                    found.add((t, col[1]))
    found.discard((table, "id"))
    return sorted(found)


def collect(db) -> dict:
    """The documents that block the inventory wipe and everything hanging off
    them, as id sets, plus the blockers that stop this sweep itself."""
    sales = set(_ids(db, "SELECT DISTINCT pos_sale_id FROM pos_sale_items WHERE inventory_id IS NOT NULL"))
    # A corrected sale and the one that replaced it are one story: take both
    # directions of the amended_from link until nothing new turns up.
    while True:
        more = set(_ids(db, f"SELECT id FROM pos_sales WHERE amended_from IN {_in(sales)}")) \
             | set(_ids(db, f"SELECT amended_from FROM pos_sales WHERE id IN {_in(sales)}"))
        if more <= sales:
            break
        sales |= more
    invoices = set(_ids(db, f"SELECT invoice_id FROM pos_sales WHERE id IN {_in(sales)}"))
    payments = set(_ids(db, f"SELECT id FROM invoice_payments WHERE invoice_id IN {_in(invoices)}"))
    cust_payments = set(_ids(db, f"SELECT customer_payment_id FROM invoice_payments WHERE id IN {_in(payments)}"))
    quotations = set(_ids(db, "SELECT DISTINCT quotation_id FROM quotation_items WHERE inventory_id IS NOT NULL"))

    entries = set()
    if invoices:
        entries |= set(_ids(db,
            f"SELECT id FROM journal_entries WHERE source_type IN {_in_str(_SALE_SOURCES)} "
            f"AND source_id IN {_in(invoices)}"))
    if payments:
        entries |= set(_ids(db,
            f"SELECT id FROM journal_entries WHERE source_type IN {_in_str(_PAYMENT_SOURCES)} "
            f"AND source_id IN {_in(payments)}"))
    # Their reversals (a returned test sale) go with them.
    if entries:
        entries |= set(_ids(db, f"SELECT id FROM journal_entries WHERE reverses_id IN {_in(entries)}"))

    blockers = {}

    # A customer payment that also settled an invoice we are NOT sweeping is
    # real money against a real document.
    if cust_payments:
        n = db.execute(
            f"SELECT COUNT(*) AS n FROM invoice_payments WHERE customer_payment_id IN {_in(cust_payments)} "
            f"AND invoice_id NOT IN {_in(invoices)}").fetchone()["n"]
        if n:
            blockers["customer_payments shared with other invoices"] = int(n)

    # A locked month may not lose an entry.
    if entries:
        try:
            from routers.finance import _check_period_locked
            for r in db.execute(f"SELECT DISTINCT substr(entry_date,1,7) AS ym FROM journal_entries "
                                f"WHERE id IN {_in(entries)}").fetchall():
                _check_period_locked(db, (r["ym"] or "") + "-01")
        except HTTPException as e:
            blockers["locked accounting period"] = str(e.detail)

    # Anything else pointing at what we sweep, that we do not know how to
    # unwind, stops us. `handled` is every (table, column) the execute path
    # deletes or clears; a new table pointing at invoices lands here as a
    # blocker until somebody decides what it means.
    handled = {
        ("pos_sale_items", "pos_sale_id"), ("pos_returns", "pos_sale_id"), ("pos_sales", "amended_from"),
        ("pos_sales", "invoice_id"), ("pos_returns", "invoice_id"), ("invoice_items", "invoice_id"),
        ("invoice_payments", "invoice_id"), ("invoice_installments", "invoice_id"),
        ("receipt_vouchers", "invoice_id"), ("sale_commitments", "invoice_id"),
        ("journal_entry_lines", "journal_entry_id"), ("journal_entries", "reverses_id"),
        ("journal_entries", "reversed_by"), ("quotation_items", "quotation_id"),
        ("invoices", "quotation_id"), ("crm_deals", "quotation_id"), ("projects", "source_quotation_id"),
        ("invoice_payments", "customer_payment_id"), ("pos_sale_items", "invoice_item_id"),
        ("sale_commitments", "invoice_item_id"),
    }
    targets = [("invoices", invoices, ("invoice_id",)), ("pos_sales", sales, ("pos_sale_id",)),
               ("quotations", quotations, ("quotation_id",)),
               ("journal_entries", entries, ("journal_entry_id",)),
               ("invoice_payments", payments, ("payment_id", "invoice_payment_id"))]
    for table, ids, names in targets:
        if not ids:
            continue
        for t, c in _columns_pointing_at(db, table, names):
            if (t, c) in handled:
                continue
            n = db.execute(f"SELECT COUNT(*) AS n FROM {t} WHERE {c} IN {_in(ids)}").fetchone()["n"]
            if n:
                blockers[f"{t}.{c}"] = int(n)
    # An invoice raised from a service job is not a till sale, whatever its
    # lines say; it stays, and so does everything with it.
    if invoices:
        n = db.execute(f"SELECT COUNT(*) AS n FROM invoices WHERE id IN {_in(invoices)} "
                       f"AND service_job_id IS NOT NULL").fetchone()["n"]
        if n:
            blockers["invoices.service_job_id"] = int(n)

    return {
        "sales": sorted(sales), "invoices": sorted(invoices), "payments": sorted(payments),
        "customer_payments": sorted(cust_payments), "quotations": sorted(quotations),
        "journal_entries": sorted(entries), "blockers": blockers,
    }


def _in_str(values):
    return "(" + ",".join("'" + v.replace("'", "''") + "'" for v in values) + ")"


def summary(c: dict) -> dict:
    return {"sales": len(c["sales"]), "invoices": len(c["invoices"]), "payments": len(c["payments"]),
            "quotations": len(c["quotations"]), "journal_entries": len(c["journal_entries"]),
            "blockers": c["blockers"]}


def execute(db, c: dict) -> dict:
    """Remove what collect() found. Caller owns the transaction and has
    already refused on blockers; this refuses again regardless."""
    if c["blockers"]:
        raise HTTPException(409, "Documents cannot be swept: "
                            + ", ".join(f"{k} ({v})" for k, v in sorted(c["blockers"].items())))
    removed = {}
    # Never swallow a failed statement: on Postgres one failure aborts the
    # whole transaction and every statement after it is silently ignored,
    # which is exactly how a sweep would come out half done. A table this
    # install has not migrated to is skipped by name instead.
    tables = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

    def run(label, sql):
        table = sql.split()[2] if sql.upper().startswith("DELETE") else sql.split()[1]
        if table not in tables:
            return
        cur = db.execute(sql)
        removed[label] = removed.get(label, 0) + (cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0)

    sales, invoices, payments = c["sales"], c["invoices"], c["payments"]
    entries, quotations, custp = c["journal_entries"], c["quotations"], c["customer_payments"]

    # Promotions: give back the units these sales consumed against the cap.
    if sales:
        for r in db.execute(f"SELECT promotion_id, SUM(quantity) AS q FROM pos_sale_items "
                            f"WHERE pos_sale_id IN {_in(sales)} AND promotion_id IS NOT NULL "
                            f"GROUP BY promotion_id").fetchall():
            q = int(r["q"] or 0)
            db.execute("UPDATE promotions SET used_quantity = "
                       "CASE WHEN used_quantity > ? THEN used_quantity - ? ELSE 0 END WHERE id = ?",
                       (q, q, r["promotion_id"]))

    # The ledger, lines first.
    if entries:
        run("journal_entry_lines", f"DELETE FROM journal_entry_lines WHERE journal_entry_id IN {_in(entries)}")
        run("journal_entries", f"UPDATE journal_entries SET reversed_by = NULL WHERE reversed_by IN {_in(entries)}")
        run("journal_entries", f"DELETE FROM journal_entries WHERE id IN {_in(entries)}")
    # The till.
    if sales:
        run("pos_returns", f"DELETE FROM pos_returns WHERE pos_sale_id IN {_in(sales)}")
        run("pos_sale_items", f"DELETE FROM pos_sale_items WHERE pos_sale_id IN {_in(sales)}")
        run("pos_sales", f"UPDATE pos_sales SET amended_from = NULL WHERE amended_from IN {_in(sales)}")
        run("pos_sales", f"DELETE FROM pos_sales WHERE id IN {_in(sales)}")
    # The invoices behind the sales.
    if invoices:
        run("sale_commitments", f"DELETE FROM sale_commitments WHERE invoice_id IN {_in(invoices)}")
        run("receipt_vouchers", f"DELETE FROM receipt_vouchers WHERE invoice_id IN {_in(invoices)}")
        run("invoice_installments", f"DELETE FROM invoice_installments WHERE invoice_id IN {_in(invoices)}")
        run("invoice_payments", f"DELETE FROM invoice_payments WHERE invoice_id IN {_in(invoices)}")
        run("invoice_items", f"DELETE FROM invoice_items WHERE invoice_id IN {_in(invoices)}")
        for t, col in (("attachments", "entity_id"), ("communications_log", "entity_id"),
                       ("document_shares", "entity_id")):
            run(t, f"DELETE FROM {t} WHERE entity_type IN ('invoice','invoices') AND {col} IN {_in(invoices)}")
        run("documents", f"DELETE FROM documents WHERE record_type = 'invoice' AND record_id IN {_in(invoices)}")
        run("invoices", f"DELETE FROM invoices WHERE id IN {_in(invoices)}")
    if custp:
        # Only those left with no allocation --- the shared ones were blockers.
        run("customer_payments", f"DELETE FROM customer_payments WHERE id IN {_in(custp)} AND id NOT IN "
                                 f"(SELECT customer_payment_id FROM invoice_payments WHERE customer_payment_id IS NOT NULL)")
    # The quotations.
    if quotations:
        run("invoices", f"UPDATE invoices SET quotation_id = NULL WHERE quotation_id IN {_in(quotations)}")
        run("crm_deals", f"UPDATE crm_deals SET quotation_id = NULL WHERE quotation_id IN {_in(quotations)}")
        run("projects", f"UPDATE projects SET source_quotation_id = NULL WHERE source_quotation_id IN {_in(quotations)}")
        run("quotation_items", f"DELETE FROM quotation_items WHERE quotation_id IN {_in(quotations)}")
        for t, col in (("attachments", "entity_id"), ("communications_log", "entity_id"),
                       ("document_shares", "entity_id")):
            run(t, f"DELETE FROM {t} WHERE entity_type IN ('quotation','quotations') AND {col} IN {_in(quotations)}")
        run("documents", f"DELETE FROM documents WHERE record_type = 'quotation' AND record_id IN {_in(quotations)}")
        run("quotations", f"DELETE FROM quotations WHERE id IN {_in(quotations)}")
    return removed
