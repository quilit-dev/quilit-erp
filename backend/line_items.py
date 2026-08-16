"""Enrichment shared by invoice, quotation and share-link line items.

A line item stores the name and price as they were at the moment the document
was raised — deliberately, so editing a product later never rewrites history on
a document a customer already holds. Anything that is a property of the PRODUCT
rather than of the sale therefore has to be looked up through `inventory_id`.

The barcode is the first of those. It is printed on the document for companies
that stock barcoded goods, so a warehouse can match a line to a shelf without
reading the description.
"""
import sqlite3


def attach_barcodes(db: sqlite3.Connection, items: list) -> list:
    """Add `barcode` to each line item, resolved through its inventory link.

    One query for the whole document, not one per line. Items typed in by hand —
    a delivery charge, a one-off service — have no inventory link and get None,
    which is what makes the column render a dash instead of a stale code.

    Mutates and returns `items`. Never raises: a document that cannot show a
    barcode is a smaller problem than a document that will not open.
    """
    if not items:
        return items

    ids = {i.get("inventory_id") for i in items if i.get("inventory_id")}
    by_id = {}
    if ids:
        try:
            rows = db.execute(
                "SELECT id, barcode FROM inventory WHERE id IN "
                "(" + ",".join("?" * len(ids)) + ")", tuple(ids)).fetchall()
            by_id = {r["id"]: r["barcode"] for r in rows}
        except sqlite3.Error:
            by_id = {}

    for i in items:
        i["barcode"] = by_id.get(i.get("inventory_id")) or None
    return items
