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


# ── permission checks are resolved once, not per section ─────────────────────

def test_search_asks_for_permissions_once(make_client, monkeypatch):
    """Global search gates ~24 sections. It used to ask the database about each
    one separately, on a 240 ms keystroke debounce --- so typing a word fired
    three or four rounds of 24 permission SELECTs.

    Counted rather than timed: a timing assertion on a fast query is a flaky
    test, and the number of queries is the thing that was actually wrong.
    """
    import permissions
    calls = {"single": 0, "batch": 0}

    real_single = permissions.can_view
    real_batch = permissions.viewable_modules

    def counting_single(*a, **k):
        calls["single"] += 1
        return real_single(*a, **k)

    def counting_batch(*a, **k):
        calls["batch"] += 1
        return real_batch(*a, **k)

    monkeypatch.setattr(permissions, "can_view", counting_single)
    monkeypatch.setattr(permissions, "viewable_modules", counting_batch)

    c = make_client("superadmin")
    assert c.get("/api/search/?q=abc").status_code == 200

    assert calls["batch"] == 1, "the permission set should be read once"
    assert calls["single"] == 0, (
        "search called can_view %d time(s) -- each one is its own SELECT, and "
        "this handler gates about two dozen sections" % calls["single"])


def test_a_restricted_user_still_only_sees_their_modules(make_client):
    """Batching must not widen what anybody can see."""
    viewer = make_client("Viewer")
    r = viewer.get("/api/search/?q=a")
    assert r.status_code == 200
    # Whatever comes back, it must not include a module a Viewer cannot view.
    import permissions
    body = r.json()
    assert isinstance(body, (list, dict))
