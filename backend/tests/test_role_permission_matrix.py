"""
Role / permission matrix.

For every (role, module) pair this asserts the API enforcement agrees with the
`role_permissions` table that database.py seeds. Mismatches surface as:
  * incorrect 403  — role HAS the grant but is refused
  * privilege leak — role LACKS the grant but is served

The grant table is read from the DB at runtime, so it stays the single source
of truth even if the seed matrix changes.
"""
import itertools
import pytest
from helpers.catalog import MODULE_VIEW_ENDPOINTS, ADMIN_VIEW_ENDPOINTS
from helpers.seeding import RBAC_ROLES


def _can_view(db, role_name, module):
    role = db.execute("SELECT id FROM roles WHERE name=?", (role_name,)).fetchone()
    if not role:
        return False
    perm = db.execute(
        "SELECT can_view FROM role_permissions WHERE role_id=? AND module=?",
        (role["id"], module),
    ).fetchone()
    return bool(perm and perm["can_view"])


@pytest.mark.rbac
@pytest.mark.parametrize(
    "role,module",
    list(itertools.product(RBAC_ROLES, sorted(MODULE_VIEW_ENDPOINTS))),
)
def test_module_view_enforcement(role, module, db, make_client):
    """A role reaches a module's list endpoint IFF role_permissions grants view."""
    granted = _can_view(db, role, module)
    endpoint = MODULE_VIEW_ENDPOINTS[module]
    r = make_client(role).get(endpoint)

    assert r.status_code < 500, f"{role} -> {endpoint} crashed ({r.status_code})"
    if granted:
        assert r.status_code != 403, (
            f"INCORRECT 403: {role} has '{module}.view' but {endpoint} returned 403")
    else:
        assert r.status_code == 403, (
            f"PRIVILEGE LEAK: {role} lacks '{module}.view' but {endpoint} "
            f"returned {r.status_code} (expected 403)")


@pytest.mark.rbac
@pytest.mark.parametrize("role", RBAC_ROLES)
@pytest.mark.parametrize("path", sorted(ADMIN_VIEW_ENDPOINTS.values()))
def test_admin_endpoints_reject_non_superadmin(role, path, make_client):
    """User/role administration must be superadmin-only."""
    r = make_client(role).get(path)
    assert r.status_code < 500, f"{role} -> {path} crashed ({r.status_code})"
    assert r.status_code == 403, (
        f"PRIVILEGE LEAK: non-superadmin {role} reached admin endpoint {path} "
        f"-> {r.status_code} (expected 403)")


@pytest.mark.rbac
def test_no_role_user_is_forbidden_everywhere(make_client):
    """A user with no role assigned must be refused every business module."""
    c = make_client("__norole__")
    leaks = []
    for module, path in MODULE_VIEW_ENDPOINTS.items():
        r = c.get(path)
        if r.status_code != 403:
            leaks.append(f"  {path} -> {r.status_code} (expected 403)")
    assert not leaks, "no-role user was NOT uniformly forbidden:\n" + "\n".join(leaks)


@pytest.mark.rbac
def test_superadmin_reaches_every_module(make_client):
    c = make_client("superadmin")
    blocked = []
    for path in list(MODULE_VIEW_ENDPOINTS.values()) + list(ADMIN_VIEW_ENDPOINTS.values()):
        r = c.get(path)
        if r.status_code >= 400:
            blocked.append(f"  {path} -> {r.status_code}")
    assert not blocked, "superadmin was unexpectedly blocked:\n" + "\n".join(blocked)


@pytest.mark.rbac
@pytest.mark.parametrize("role", RBAC_ROLES)
def test_create_requires_create_permission(role, db, make_client):
    """
    Probe a write: only roles WITH clients.create may POST a client; everyone
    else must get 403 (never 500, never a silent 200).
    """
    rolerow = db.execute("SELECT id FROM roles WHERE name=?", (role,)).fetchone()
    perm = db.execute(
        "SELECT can_create FROM role_permissions WHERE role_id=? AND module='clients'",
        (rolerow["id"],),
    ).fetchone()
    can_create = bool(perm and perm["can_create"])

    r = make_client(role).post("/api/clients/", json={"name": f"Probe {role}"})
    assert r.status_code < 500, f"{role} POST /api/clients/ crashed ({r.status_code})"
    if can_create:
        assert r.status_code in (200, 201), (
            f"INCORRECT 403: {role} has clients.create but POST -> {r.status_code}")
    else:
        assert r.status_code == 403, (
            f"PRIVILEGE LEAK: {role} lacks clients.create but POST -> {r.status_code}")
