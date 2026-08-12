"""
Per-line discounts must survive an edit.

The create path wrote `discount`; the update path did not. So a line given a
discount kept it until anyone touched the document, at which point the column
silently reset to 0 while the stored total kept the discounted figure — an
invoice that no longer added up, and a customer quietly losing the reduction
they had been given. Quotations had the same omission plus a `total` recomputed
gross.

Money that changes when someone opens a record and saves it is the worst kind of
bug: nothing errors, and the wrong number looks deliberate.
"""


def _line_rows(app, table, fk, doc_id):
    import database
    con = database.get_connection() if hasattr(database, "get_connection") else None
    if con is None:
        import sqlite3, os
        con = sqlite3.connect(os.environ.get("DB_PATH", "erp.db"))
        con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(
        f"SELECT * FROM {table} WHERE {fk}=? ORDER BY id", (doc_id,))]
    return rows


ITEMS = [{"name": "Widget", "quantity": 2, "unit_price": 100, "discount": 25}]


def test_invoice_line_discount_survives_an_edit(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    inv = c.post("/api/invoices/", json={
        "client_id": cl["id"], "amount": 175, "items": ITEMS}).json()

    before = c.get(f"/api/invoices/{inv['id']}").json()
    assert [i.get("discount") for i in before["items"]] == [25]

    r = c.put(f"/api/invoices/{inv['id']}", json={
        "client_id": cl["id"], "amount": 175, "items": ITEMS,
        "version": before.get("version", 1)})
    assert r.status_code == 200, r.text

    after = c.get(f"/api/invoices/{inv['id']}").json()
    assert [i.get("discount") for i in after["items"]] == [25], \
        "the edit reset the line discount"


def test_quotation_line_discount_and_net_total_survive_an_edit(make_client):
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    created = c.post("/api/quotations/", json={
        "client_id": cl["id"], "amount": 175, "items": ITEMS})
    assert created.status_code in (200, 201), created.text
    qid = created.json()["id"]

    before = c.get(f"/api/quotations/{qid}").json()
    r = c.put(f"/api/quotations/{qid}", json={
        "client_id": cl["id"], "amount": 175, "items": ITEMS,
        "version": before.get("version", 1)})
    assert r.status_code == 200, r.text

    after = c.get(f"/api/quotations/{qid}").json()
    assert [i.get("discount") for i in after["items"]] == [25], \
        "the edit reset the line discount"
    # `total` is the line NET of the discount, matching the create path, so
    # historical reports tie to the pricing math rather than to a gross figure.
    assert [round(float(i.get("total") or 0), 2) for i in after["items"]] == [175.0], \
        "the edit wrote a gross total, ignoring the discount"


def test_zero_discount_is_still_written(make_client):
    """A line with no discount must store 0, not NULL — the PDF and the reports
    both read this column arithmetically."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme"}).json()
    plain = [{"name": "Widget", "quantity": 1, "unit_price": 50}]
    inv = c.post("/api/invoices/", json={
        "client_id": cl["id"], "amount": 50, "items": plain}).json()
    before = c.get(f"/api/invoices/{inv['id']}").json()
    c.put(f"/api/invoices/{inv['id']}", json={
        "client_id": cl["id"], "amount": 50, "items": plain,
        "version": before.get("version", 1)})
    after = c.get(f"/api/invoices/{inv['id']}").json()
    assert (after["items"][0].get("discount") or 0) == 0
