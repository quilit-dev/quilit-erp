"""The Sales Pipeline report must not count quotations as sales.

A quotation is an offer. Adding every quote ever written into one "Total
Value" told the business it had sold things nobody had agreed to buy. The
report now splits live quotations into won, open and lost, and leaves voided
and cancelled ones out of the funnel altogether.
"""


def _quote(c, client_id, price):
    r = c.post("/api/quotations/", json={
        "client_id": client_id,
        "items": [{"name": "Banner", "quantity": 1, "unit_price": price}]})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _set_status(db, qid, status):
    db.execute("UPDATE quotations SET status=? WHERE id=?", (status, qid))
    db.commit()


def test_only_won_quotes_count_as_sold(as_role, db):
    c = as_role("superadmin")
    client = c.post("/api/clients/", json={"name": "Acme"}).json()["id"]

    draft    = _quote(c, client, 100)
    sent     = _quote(c, client, 200)
    rejected = _quote(c, client, 400)
    accepted = _quote(c, client, 800)
    invoiced = _quote(c, client, 1600)
    voided   = _quote(c, client, 3200)
    _set_status(db, sent, "Sent")
    _set_status(db, rejected, "Rejected")
    _set_status(db, accepted, "Accepted")
    _set_status(db, voided, "Voided")
    _set_status(db, invoiced, "Sent")
    r = c.post(f"/api/quotations/{invoiced}/convert-to-invoice")
    assert r.status_code == 200, r.text

    p = c.get("/api/reports/pipeline").json()

    # Won: accepted + the one turned into an invoice. Nothing else is "sold".
    assert p["won_count"] == 2 and p["won_value"] == 2400
    # Open: still in play, shown apart from what was won.
    assert p["open_count"] == 2 and p["open_value"] == 300
    assert p["lost_count"] == 1 and p["lost_value"] == 400
    # The voided quote is not in the funnel at all.
    assert p["total_count"] == 5
    assert all(s["status"] != "Voided" for s in p["by_status"])
    # Win rate is over decided quotes: 2 won of 3 decided.
    assert p["conversion_rate"] == 66.7
    # No single figure adds offers up as if they were sales.
    assert "total_value" not in p


def test_a_quote_invoiced_but_never_marked_accepted_still_counts_as_won(as_role, db):
    c = as_role("superadmin")
    client = c.post("/api/clients/", json={"name": "Acme"}).json()["id"]
    qid = _quote(c, client, 500)
    r = c.post(f"/api/quotations/{qid}/convert-to-invoice")
    assert r.status_code == 200, r.text
    # Older data: invoiced, but the quote's own status never moved on.
    _set_status(db, qid, "Sent")

    p = c.get("/api/reports/pipeline").json()
    assert p["won_count"] == 1 and p["won_value"] == 500
    assert p["open_count"] == 0


def test_a_voided_invoice_does_not_make_its_quote_won(as_role, db):
    c = as_role("superadmin")
    client = c.post("/api/clients/", json={"name": "Acme"}).json()["id"]
    qid = _quote(c, client, 500)
    inv = c.post(f"/api/quotations/{qid}/convert-to-invoice").json()
    inv_id = inv.get("invoice_id") or inv.get("id")
    db.execute("UPDATE invoices SET voided_at='2026-01-01 00:00:00' WHERE id=?", (inv_id,))
    _set_status(db, qid, "Sent")

    p = c.get("/api/reports/pipeline").json()
    assert p["won_count"] == 0
    assert p["open_count"] == 1 and p["open_value"] == 500


def test_top_clients_rank_by_what_they_bought(as_role, db):
    c = as_role("superadmin")
    big_talker = c.post("/api/clients/", json={"name": "Big Talker"}).json()["id"]
    buyer = c.post("/api/clients/", json={"name": "Buyer"}).json()["id"]
    _quote(c, big_talker, 10000)                     # quoted a lot, bought nothing
    _set_status(db, _quote(c, buyer, 300), "Accepted")

    top = c.get("/api/reports/pipeline").json()["top_clients"]
    assert top[0]["client_name"] == "Buyer" and top[0]["won_value"] == 300
    talker = next(t for t in top if t["client_name"] == "Big Talker")
    assert talker["won_value"] == 0 and talker["open_value"] == 10000
