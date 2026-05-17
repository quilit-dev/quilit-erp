"""
Edge cases — invalid IDs, malformed bodies, dangling relations, partial rights.

The universal guarantee under test: the API answers with a *deliberate* 4xx,
never a 5xx and never a null-reference crash.
"""
import pytest

MISSING_ID = 999999


@pytest.mark.edge
@pytest.mark.parametrize("path", [
    "/api/clients/999999",
    "/api/projects/999999",
    "/api/invoices/999999",
    "/api/quotations/999999",
    "/api/suppliers/999999",
    "/api/users/999999",
    "/api/approval-requests/999999",
])
def test_missing_record_is_404_not_500(path, make_client):
    r = make_client("superadmin").get(path)
    assert r.status_code != 500, f"{path} crashed on a missing record"
    assert r.status_code == 404, f"{path} -> {r.status_code} (expected 404)"


@pytest.mark.edge
def test_non_integer_id_never_5xx(make_client):
    r = make_client("superadmin").get("/api/clients/not-a-number")
    assert r.status_code < 500, f"non-integer id crashed: {r.status_code}"
    assert r.status_code in (404, 422)


@pytest.mark.edge
@pytest.mark.parametrize("path", ["/api/clients/", "/api/projects/", "/api/suppliers/"])
def test_empty_create_body_is_422_not_500(path, make_client):
    r = make_client("superadmin").post(path, json={})
    assert r.status_code < 500, f"{path} crashed on empty body"
    assert r.status_code in (400, 422), f"{path} -> {r.status_code}"


@pytest.mark.edge
def test_invoice_with_dangling_client_fails_cleanly(make_client):
    """An invoice referencing a non-existent client must not 500."""
    r = make_client("superadmin").post("/api/invoices/", json={
        "client_id": MISSING_ID,
        "project_id": None,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 10}],
    })
    assert r.status_code < 500, f"dangling client_id crashed: {r.status_code} {r.text[:200]}"


@pytest.mark.edge
def test_project_with_dangling_client_fails_cleanly(make_client):
    r = make_client("superadmin").post("/api/projects/", json={
        "name": "Orphan project", "client_id": MISSING_ID,
    })
    assert r.status_code < 500, f"dangling client_id crashed: {r.status_code} {r.text[:200]}"


@pytest.mark.edge
@pytest.mark.parametrize("verb", ["approve", "reject", "force-approve", "cancel"])
def test_workflow_action_on_missing_request_is_404(verb, make_client):
    r = make_client("superadmin").post(f"/api/approval-requests/{MISSING_ID}/{verb}", json={})
    assert r.status_code != 500, f"{verb} on missing request crashed"
    assert r.status_code == 404, f"{verb} on missing request -> {r.status_code}"


@pytest.mark.edge
def test_deleted_relation_does_not_crash_listing(db, make_client):
    """
    Soft-delete a client that still owns a project, then list projects.
    The join must tolerate the orphaned relation (no crash, no 5xx).
    """
    c = make_client("superadmin")
    cr = c.post("/api/clients/", json={"name": "Soon Deleted"})
    if cr.status_code not in (200, 201):
        pytest.skip(f"could not create client to set up the test ({cr.status_code})")
    client_id = cr.json().get("id")
    c.post("/api/projects/", json={"name": "Stranded project", "client_id": client_id})
    # soft-delete the client directly
    db.execute("UPDATE clients SET deleted_at=datetime('now') WHERE id=?", (client_id,))
    db.commit()
    r = c.get("/api/projects/")
    assert r.status_code < 500, f"listing projects with an orphaned client crashed: {r.status_code}"


@pytest.mark.edge
def test_partial_permission_blocks_write_but_not_read(make_client):
    """Viewer has clients.view but not clients.create — read 200, write 403."""
    c = make_client("Viewer")
    assert c.get("/api/clients/").status_code == 200
    w = c.post("/api/clients/", json={"name": "Viewer Co"})
    assert w.status_code == 403, f"Viewer wrote a client -> {w.status_code} (expected 403)"


@pytest.mark.edge
def test_oversized_search_query_never_5xx(make_client):
    r = make_client("superadmin").get("/api/search/", params={"q": "x" * 500})
    assert r.status_code < 500, f"oversized search query crashed: {r.status_code}"
