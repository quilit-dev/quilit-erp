"""
Pagination and server-side search on the three big list endpoints.

These lists were fetched whole by the UI, which then filtered and sorted in the
browser. Measured on PostgreSQL, the invoice list grew from 115 ms / 0.1 MB at
200 rows to 1,984 ms / 19.8 MB at 40,000 — on every page open, for every user.
`limit=50` stayed flat at ~96 ms across the same range.

The contract deliberately keeps BOTH shapes:

  * no `limit`  -> the plain array, byte-for-byte as before. Finance
    aggregators, exports and the current UI all depend on it, so adding
    pagination could not be allowed to change what they receive.
  * `limit=N`   -> a {items, total, limit, offset} envelope.

`total` is the count AFTER filtering, so a caller can render "showing 50 of
1,284" without a second request.
"""
import pytest


@pytest.fixture
def seeded(make_client):
    c = make_client("superadmin")
    cid = c.post("/api/clients/", json={"name": "Pagination Client"}).json()["id"]
    for i in range(12):
        c.post("/api/invoices/", json={
            "client_id": cid,
            "notes": "needle" if i == 3 else "",
            "items": [{"name": "Widget", "quantity": 1, "unit_price": 10 + i}]})
        c.post("/api/quotations/", json={
            "client_id": cid,
            "notes": "needle" if i == 4 else "",
            "items": [{"name": "Widget", "quantity": 1, "unit_price": 10 + i}]})
    return c


LISTS = ["/api/invoices/", "/api/quotations/", "/api/clients/"]


@pytest.mark.parametrize("path", LISTS)
def test_without_limit_the_response_is_unchanged(seeded, path):
    """The compatibility guarantee. Every existing caller passes no limit."""
    body = seeded.get(path).json()
    assert isinstance(body, list), f"{path} changed shape for existing callers"


@pytest.mark.parametrize("path", LISTS)
def test_limit_returns_an_envelope_with_a_true_total(seeded, path):
    full = len(seeded.get(path).json())
    body = seeded.get(f"{path}?limit=5").json()

    assert set(body) >= {"items", "total", "limit", "offset"}
    assert len(body["items"]) == min(5, full)
    assert body["total"] == full, "total must count the whole filtered set, not the page"
    assert body["limit"] == 5 and body["offset"] == 0


@pytest.mark.parametrize("path", LISTS)
def test_offset_walks_the_set_without_repeating(seeded, path):
    """A page boundary that repeats or skips a row is how a paginated ledger
    quietly loses an invoice."""
    first  = seeded.get(f"{path}?limit=5&offset=0").json()["items"]
    second = seeded.get(f"{path}?limit=5&offset=5").json()["items"]

    ids_a = [r["id"] for r in first]
    ids_b = [r["id"] for r in second]
    assert len(set(ids_a)) == len(ids_a), "duplicate rows within a page"
    assert not (set(ids_a) & set(ids_b)), "page 2 repeats rows from page 1"


@pytest.mark.parametrize("path", LISTS)
def test_limit_is_capped(seeded, path):
    """Otherwise `?limit=999999` is the unbounded fetch again, by another name."""
    body = seeded.get(f"{path}?limit=100000").json()
    assert body["limit"] <= 500


@pytest.mark.parametrize("path,term", [
    ("/api/invoices/",   "needle"),
    ("/api/quotations/", "needle"),
    ("/api/clients/",    "Pagination Client"),
])
def test_search_narrows_and_total_follows(seeded, path, term):
    """Search has to run server-side, or a paginated screen can only search the
    page it happens to be showing."""
    body = seeded.get(f"{path}?limit=50&search={term}").json()
    assert body["total"] >= 1
    assert body["total"] < 24, "search did not narrow the set"

    empty = seeded.get(f"{path}?limit=50&search=zzz-no-such-record").json()
    assert empty["total"] == 0 and empty["items"] == []


def test_invoice_search_matches_the_fields_the_ui_used_to(seeded):
    """The browser filter matched number, quote ref, client, project and notes.
    Moving it server-side must not quietly drop any of them."""
    all_inv = seeded.get("/api/invoices/").json()
    number  = all_inv[0]["invoice_number"]

    by_number = seeded.get(f"/api/invoices/?limit=50&search={number}").json()
    assert by_number["total"] == 1

    by_client = seeded.get("/api/invoices/?limit=50&search=Pagination Client").json()
    assert by_client["total"] == len(all_inv)

    by_notes = seeded.get("/api/invoices/?limit=50&search=needle").json()
    assert by_notes["total"] == 1


def test_search_combines_with_status(seeded):
    """Filters have to compose; a status filter that ignores search would show
    rows the operator has already filtered out."""
    body = seeded.get("/api/invoices/?limit=50&search=needle&status=Unpaid").json()
    assert body["total"] <= 1
