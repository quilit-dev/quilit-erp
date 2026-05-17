"""
Smoke coverage — "nothing 500s".

Discovers every GET route from `app.routes` (so new endpoints are covered
automatically) and asserts none returns a 5xx, authenticated or not. This is
the broadest net for unhandled exceptions / null-reference crashes.

Parameterised routes ( /api/.../{id} ) are exercised by test_edge_cases.py.
"""
import pytest
from helpers.catalog import PUBLIC_PATHS


def discover_get_routes(app):
    paths = []
    for r in app.routes:
        methods = getattr(r, "methods", None) or set()
        path = getattr(r, "path", "")
        if "GET" in methods and path.startswith("/api") and "{" not in path:
            paths.append(path)
    return sorted(set(paths))


@pytest.mark.smoke
def test_superadmin_get_endpoints_never_5xx(app, make_client):
    c = make_client("superadmin")
    bad = []
    for path in discover_get_routes(app):
        r = c.get(path)
        if r.status_code >= 500:
            bad.append(f"  {path} -> {r.status_code}  {r.text[:160]}")
    assert not bad, "GET endpoints returned 5xx for superadmin:\n" + "\n".join(bad)


@pytest.mark.smoke
def test_anonymous_get_endpoints_never_5xx(app, client):
    bad = []
    for path in discover_get_routes(app):
        r = client.get(path)
        if r.status_code >= 500:
            bad.append(f"  {path} -> {r.status_code}  {r.text[:160]}")
    assert not bad, "GET endpoints returned 5xx without auth:\n" + "\n".join(bad)


@pytest.mark.smoke
def test_protected_endpoints_reject_anonymous(app, client):
    """Every /api GET except the known-public set must answer 401 when anonymous."""
    leaks = []
    for path in discover_get_routes(app):
        if path in PUBLIC_PATHS:
            continue
        r = client.get(path)
        if r.status_code == 200:
            leaks.append(f"  {path} served data with no authentication")
    assert not leaks, "Authentication bypass — endpoints reachable anonymously:\n" + "\n".join(leaks)
