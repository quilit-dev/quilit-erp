"""
API contract tests — the HTTP/REST surface itself, independent of business logic.

Where the smoke suite asserts "nothing 500s" and the edge suite probes invalid
records, this layer pins down the *protocol contract* every client relies on:

  * unknown routes 404, unsupported methods 405 — never 5xx
  * malformed / wrong-typed request bodies are refused with a deliberate 4xx
  * list endpoints return JSON (array or paginated object) with a JSON content-type
  * a create echoes back a resource with an id
  * error responses carry a JSON `detail` envelope
  * the auth/session contract: who-am-i, bad token, logout, login failures

These are intentionally convention-tolerant (this app returns 200 for creates and
maps IntegrityError -> 400) but strict on the one universal guarantee: a
well-formed-but-wrong request gets a 4xx, never a server crash.
"""
import pytest
from auth_utils import COOKIE_NAME
from helpers.catalog import MODULE_VIEW_ENDPOINTS


# ── Routing contract ──────────────────────────────────────────────────────────
@pytest.mark.api
def test_unknown_api_route_is_404(make_client):
    r = make_client("superadmin").get("/api/this-route-does-not-exist")
    assert r.status_code == 404, f"unknown route -> {r.status_code} (expected 404)"


@pytest.mark.api
@pytest.mark.parametrize("method,path", [
    ("DELETE", "/api/auth/login"),   # login is POST-only
    ("PUT",    "/api/auth/me"),       # me is GET-only
    ("PATCH",  "/api/clients/"),      # collection is GET/POST only
    ("DELETE", "/api/clients/"),      # collection has no DELETE
])
def test_unsupported_method_is_405_not_5xx(method, path, make_client):
    r = make_client("superadmin").request(method, path)
    assert r.status_code < 500, f"{method} {path} crashed: {r.status_code}"
    assert r.status_code == 405, f"{method} {path} -> {r.status_code} (expected 405)"


@pytest.mark.api
def test_options_preflight_never_5xx(client):
    """A CORS preflight (OPTIONS) must be handled gracefully, never crash."""
    r = client.options("/api/clients/")
    assert r.status_code < 500, f"OPTIONS preflight crashed: {r.status_code}"


# ── Request-body contract ──────────────────────────────────────────────────────
@pytest.mark.api
def test_malformed_json_body_is_4xx_not_500(make_client):
    """Body that is not valid JSON must be refused deliberately, not crash."""
    c = make_client("superadmin")
    r = c.post("/api/clients/", content=b"{not valid json",
               headers={"Content-Type": "application/json"})
    assert r.status_code < 500, f"malformed JSON crashed: {r.status_code} {r.text[:160]}"
    assert r.status_code in (400, 422), f"malformed JSON -> {r.status_code}"


@pytest.mark.api
def test_wrong_typed_field_is_4xx_not_500(make_client):
    """A non-numeric quantity on an invoice line is a client error, never a 500."""
    c = make_client("superadmin")
    cid = c.post("/api/clients/", json={"name": "Typed Co"}).json().get("id")
    r = c.post("/api/invoices/", json={
        "client_id": cid, "project_id": None,
        "items": [{"name": "Widget", "quantity": "not-a-number", "unit_price": 10}],
    })
    assert r.status_code < 500, f"wrong-typed field crashed: {r.status_code} {r.text[:160]}"
    assert r.status_code in (400, 422), f"wrong-typed field -> {r.status_code}"


@pytest.mark.api
def test_extra_unknown_fields_do_not_500(make_client):
    """Unexpected extra keys must not crash the parser."""
    c = make_client("superadmin")
    r = c.post("/api/clients/", json={"name": "Extra Co", "totally_unknown": {"x": [1, 2]}})
    assert r.status_code < 500, f"extra fields crashed: {r.status_code} {r.text[:160]}"


# ── Response-shape contract ────────────────────────────────────────────────────
@pytest.mark.api
@pytest.mark.parametrize("module,path", sorted(MODULE_VIEW_ENDPOINTS.items()))
def test_list_endpoints_return_json_collection(module, path, make_client):
    """Every module 'view' endpoint returns JSON (array or paginated object)."""
    r = make_client("superadmin").get(path)
    assert r.status_code == 200, f"{module} list -> {r.status_code}"
    assert "application/json" in r.headers.get("content-type", ""), \
        f"{module} list content-type: {r.headers.get('content-type')!r}"
    body = r.json()
    assert isinstance(body, (list, dict)), f"{module} list returned {type(body).__name__}"


@pytest.mark.api
def test_create_returns_id_of_persisted_resource(make_client):
    """A successful create returns a JSON object carrying the new resource's id."""
    c = make_client("superadmin")
    r = c.post("/api/clients/", json={"name": "Echo Co"})
    assert r.status_code in (200, 201), f"create -> {r.status_code}: {r.text[:160]}"
    body = r.json()
    assert isinstance(body, dict) and body.get("id"), f"create body missing id: {body}"
    # The id must address a real, fetchable resource.
    got = c.get(f"/api/clients/{body['id']}")
    assert got.status_code == 200, f"created id {body['id']} not fetchable: {got.status_code}"
    assert got.json().get("name") == "Echo Co", f"persisted name mismatch: {got.json()}"


@pytest.mark.api
def test_error_response_has_json_detail_envelope(make_client):
    """4xx errors carry a JSON body with a `detail` field (FastAPI convention)."""
    r = make_client("superadmin").get("/api/clients/999999")
    assert r.status_code == 404
    assert "application/json" in r.headers.get("content-type", "")
    assert "detail" in r.json(), f"error body missing 'detail': {r.json()}"


# ── Pagination / query-param robustness ────────────────────────────────────────
@pytest.mark.api
@pytest.mark.parametrize("qs", [
    {"limit": 999999, "offset": 0},
    {"limit": -1},
    {"offset": -10},
    {"limit": "abc"},
    {"page": 0},
])
def test_query_param_extremes_never_5xx(qs, make_client):
    r = make_client("superadmin").get("/api/invoices/", params=qs)
    assert r.status_code < 500, f"invoices?{qs} crashed: {r.status_code} {r.text[:120]}"


# ── Auth / session contract ────────────────────────────────────────────────────
@pytest.mark.api
def test_me_reflects_logged_in_identity(make_client):
    r = make_client("superadmin").get("/api/auth/me")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("username") == "admin", f"/me username: {body.get('username')}"
    assert body.get("is_superadmin") is True
    assert isinstance(body.get("permissions"), dict)


@pytest.mark.api
def test_garbage_token_cookie_is_401(client):
    """A forged / corrupt auth cookie must be rejected, not honoured or crashed."""
    client.cookies.set(COOKIE_NAME, "not.a.valid.jwt")
    r = client.get("/api/auth/me")
    assert r.status_code == 401, f"garbage token -> {r.status_code} (expected 401)"


@pytest.mark.api
def test_logout_invalidates_session(make_client):
    c = make_client("superadmin")
    assert c.get("/api/auth/me").status_code == 200
    assert c.post("/api/auth/logout").status_code == 200
    r = c.get("/api/auth/me")
    assert r.status_code == 401, f"session still live after logout -> {r.status_code}"


@pytest.mark.api
@pytest.mark.parametrize("payload,expected", [
    ({"username": "admin", "password": "wrong-password"}, 401),   # bad password
    ({"username": "ghost", "password": "whatever12"},    401),    # unknown user
    ({"username": "admin"},                              422),    # missing field
    ({},                                                 422),    # empty body
])
def test_login_failure_contract(payload, expected, client):
    r = client.post("/api/auth/login", json=payload)
    assert r.status_code == expected, f"login {payload} -> {r.status_code} (expected {expected})"
