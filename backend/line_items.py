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
                "SELECT id, barcode, unit FROM inventory WHERE id IN "
                "(" + ",".join("?" * len(ids)) + ")", tuple(ids)).fetchall()
            by_id = {r["id"]: (r["barcode"], r["unit"]) for r in rows}
        except sqlite3.Error:
            by_id = {}

    for i in items:
        barcode, unit = by_id.get(i.get("inventory_id")) or (None, None)
        i["barcode"] = barcode or None
        # The unit the line was sold in is stored on the line. A line written
        # before units were stored has none, and falls back to its stock
        # item's --- so an older invoice still prints "5 kg", not a bare 5.
        if not i.get("unit"):
            i["unit"] = unit or None
    return items


def unit_for(db: sqlite3.Connection, item) -> "str | None":
    """The unit to store on a new line: what the caller sent, else the
    stock item's own unit when the line was picked from stock, else none
    (a hand-typed line --- a delivery charge --- has no unit). Never raises."""
    given = getattr(item, "unit", None) if not isinstance(item, dict) else item.get("unit")
    if given and str(given).strip():
        return str(given).strip()[:20]
    inv_id = (getattr(item, "inventory_id", None) if not isinstance(item, dict)
              else item.get("inventory_id"))
    if not inv_id:
        return None
    try:
        row = db.execute("SELECT unit FROM inventory WHERE id=?", (inv_id,)).fetchone()
    except sqlite3.Error:
        return None
    return (row["unit"] or None) if row else None
