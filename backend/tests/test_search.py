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
