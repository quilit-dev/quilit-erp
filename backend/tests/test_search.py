"""
Global search — deep-link URLs (open the exact record) + newly covered modules.
"""
import uuid


def test_invoice_result_deep_links_to_record(make_client):
    c = make_client("superadmin")
    cid = c.post("/api/clients/", json={"name": "Search Co"}).json()["id"]
    inv = c.post("/api/invoices/", json={
        "client_id": cid,
        "items": [{"name": "WidgetXYZ", "quantity": 1, "unit_price": 50}],
    }).json()
    invid = inv["id"]
    num = c.get(f"/api/invoices/{invid}").json()["invoice_number"]

    res = c.get("/api/search/", params={"q": num}).json()["results"]
    hit = next((r for r in res if r["type"] == "invoice" and r["id"] == invid), None)
    assert hit is not None, f"invoice not found in search for {num}"
    assert f"focus={invid}" in hit["url"], f"expected deep link, got {hit['url']}"


def test_invoice_line_item_text_finds_invoice(make_client):
    c = make_client("superadmin")
    cid = c.post("/api/clients/", json={"name": "LineItem Co"}).json()["id"]
    token = "itm" + uuid.uuid4().hex[:8]
    inv = c.post("/api/invoices/", json={
        "client_id": cid,
        "items": [{"name": token, "quantity": 2, "unit_price": 10}],
    }).json()
    res = c.get("/api/search/", params={"q": token}).json()["results"]
    assert any(r["type"] == "invoice" and r["id"] == inv["id"] for r in res)


def test_attendance_note_is_searchable(make_client):
    c = make_client("superadmin")
    eid = c.post("/api/hr/employees", json={"full_name": "Attend Sample"}).json()["id"]
    token = "att" + uuid.uuid4().hex[:8]
    r = c.post("/api/hr/attendance", json={
        "employee_id": eid, "date": "2026-06-10", "status": "Late", "note": token})
    assert r.status_code in (200, 201), r.text
    res = c.get("/api/search/", params={"q": token}).json()["results"]
    assert any(r["type"] == "attendance" for r in res), "attendance note not searchable"


def test_payroll_run_is_searchable(make_client):
    c = make_client("superadmin")
    c.post("/api/hr/employees", json={"full_name": "Pay Sample"})
    r = c.post("/api/hr/payroll/runs",
               json={"period_start": "2099-01-01", "period_end": "2099-01-31"})
    assert r.status_code in (200, 201), r.text
    res = c.get("/api/search/", params={"q": "2099-01"}).json()["results"]
    assert any(r["type"] == "payroll_run" for r in res), "payroll run not searchable"

# ── Case ────────────────────────────────────────────────────────────

# Reported from production: a product added as "Ink Tube" could not be found by
# searching "ink tube". SQLite's LIKE ignores ASCII case and Postgres's does
# not, and every search in the app is a LIKE — so the app behaved one way on a
# laptop and the other way for the customer.
#
# On SQLite these pass whether or not the dialect translates anything; the
# translation itself is pinned in test_db_compat.py. They are here because the
# behaviour is what was actually asked for, and because a Postgres run of this
# suite is where they bite.

def _cased(c, name):
    c.post("/api/inventory/", json={"name": name, "quantity": 3,
                                    "sale_price": 10, "unit": "pcs"})


def test_a_product_is_found_however_it_is_typed(make_client):
    c = make_client("superadmin")
    _cased(c, "Ink Tube")

    for q in ("Ink Tube", "ink tube", "INK TUBE", "ink", "TUBE", "nk tu"):
        rows = c.get("/api/inventory/", params={"search": q}).json()
        rows = rows.get("items") if isinstance(rows, dict) else rows
        names = [r["name"] for r in (rows or [])]
        assert "Ink Tube" in names, f"searching {q!r} did not find it"


def test_global_search_matches_the_same_way(make_client):
    c = make_client("superadmin")
    _cased(c, "Toner Cartridge")

    for q in ("toner cartridge", "TONER", "Cartridge"):
        titles = [r["title"]
                  for r in c.get("/api/search/", params={"q": q}).json()["results"]]
        assert "Toner Cartridge" in titles, f"searching {q!r} did not find it"


def test_a_client_is_found_however_it_is_typed(make_client):
    """Not an inventory quirk — the same operator runs every search there is."""
    c = make_client("superadmin")
    c.post("/api/clients/", json={"name": "Beirut Printing House"})

    for q in ("beirut printing", "BEIRUT", "printing house"):
        names = [r["name"] for r in c.get("/api/clients/",
                                          params={"search": q}).json()]
        assert "Beirut Printing House" in names, f"searching {q!r} did not find it"


def test_search_still_narrows(make_client):
    """Case-insensitive, not indiscriminate: a term that matches nothing still
    returns nothing, or the fix would have traded one wrong answer for another."""
    c = make_client("superadmin")
    _cased(c, "Ribbon Spool")

    rows = c.get("/api/inventory/", params={"search": "zzz-no-such-item"}).json()
    rows = rows.get("items") if isinstance(rows, dict) else rows

    assert [r["name"] for r in (rows or [])] == []
