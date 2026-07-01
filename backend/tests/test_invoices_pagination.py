"""
Backward-compatible pagination on the invoices list.

No `limit` → the full array, exactly as before (the UI + finance aggregators
depend on that). `limit` → a {items, total, limit, offset} envelope, with the
count staying correct even under the post-derivation `status` filter.
"""


def _mk_invoices(c, n, amount=100):
    for _ in range(n):
        r = c.post("/api/invoices/", json={"amount": amount})
        assert r.status_code in (200, 201), r.text


def test_no_limit_returns_plain_array(as_role):
    c = as_role("superadmin")
    _mk_invoices(c, 3)
    body = c.get("/api/invoices/").json()
    assert isinstance(body, list)
    assert len(body) >= 3


def test_limit_returns_envelope_and_total(as_role):
    c = as_role("superadmin")
    _mk_invoices(c, 5)
    body = c.get("/api/invoices/?limit=2").json()
    assert isinstance(body, dict)
    assert set(body) == {"items", "total", "limit", "offset"}
    assert len(body["items"]) == 2
    assert body["total"] >= 5
    assert body["limit"] == 2 and body["offset"] == 0


def test_offset_walks_the_pages(as_role):
    c = as_role("superadmin")
    _mk_invoices(c, 5)
    p1 = c.get("/api/invoices/?limit=2&offset=0").json()["items"]
    p2 = c.get("/api/invoices/?limit=2&offset=2").json()["items"]
    ids1 = {i["id"] for i in p1}
    ids2 = {i["id"] for i in p2}
    assert ids1 and ids2 and ids1.isdisjoint(ids2)   # distinct pages


def test_limit_is_capped(as_role):
    c = as_role("superadmin")
    _mk_invoices(c, 2)
    body = c.get("/api/invoices/?limit=99999").json()
    assert body["limit"] == 500          # capped, not the requested 99999


def test_status_filter_total_is_post_filter_count(as_role):
    c = as_role("superadmin")
    _mk_invoices(c, 4)                    # all Unpaid, none Void
    body = c.get("/api/invoices/?status=Void&limit=10").json()
    assert body["total"] == 0            # count reflects the derived-status filter
    assert body["items"] == []
