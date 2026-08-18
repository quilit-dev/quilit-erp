"""Every module must be known to every registry that gates it.

A module name is repeated in several places, and each omission fails in its own
quiet way:

  * missing from `permissions.MODULES` — the RBAC catalog rejects the grant
  * missing from the seed list / ROLE_PERMS — nobody has the permission until an
    admin grants it by hand
  * missing from `RoleManagement.jsx` CORE_MODULES — the permission exists but
    there is no checkbox to grant it, so the matrix is silently incomplete
  * missing from `capabilities` — licensing cannot resolve its dependencies

None of these raise. The module simply does not work for anyone, and the reason
is somewhere other than where the symptom shows up. Writing this test surfaced
exactly that: `communications` had been in the backend catalog and absent from
the roles matrix, so its permissions could not be granted through the UI.
"""
import re
import pathlib

import capabilities
import permissions


FRONTEND = (pathlib.Path(__file__).resolve().parents[2]
            / "frontend_src" / "src" / "pages" / "RoleManagement.jsx")


def _jsx_module_list(name):
    """The string literals inside a `const <name> = [ ... ];` array."""
    src = FRONTEND.read_text(encoding="utf-8")
    m = re.search(rf"const {name}\s*=\s*\[(.*?)\];", src, re.S)
    assert m, f"{name} not found in RoleManagement.jsx — was it renamed?"
    return {x for x in re.findall(r"'([a-z_]+)'", m.group(1))}


def test_the_roles_matrix_offers_every_backend_module():
    """A permission nobody can tick is a permission nobody has."""
    missing = sorted(set(permissions.MODULES) - _jsx_module_list("CORE_MODULES"))

    assert not missing, (
        "these modules exist in permissions.MODULES but have no checkbox in "
        f"RoleManagement.jsx, so an admin cannot grant them: {missing}")


def test_the_roles_matrix_offers_every_admin_module():
    missing = sorted(set(permissions.ADMIN_MODULES) - _jsx_module_list("ADMIN_MODULES"))
    assert not missing, missing


def test_the_matrix_invents_no_modules_of_its_own():
    """The reverse direction: a checkbox for a module the backend does not know
    writes a permission row that check_perm will never read."""
    known = set(permissions.ALL_MODULES)
    extra = sorted((_jsx_module_list("CORE_MODULES")
                    | _jsx_module_list("ADMIN_MODULES")) - known)

    assert not extra, f"RoleManagement.jsx offers unknown modules: {extra}"


def test_every_licensable_module_is_a_real_module():
    """capabilities keys and dependency targets must all be real module names,
    or licence resolution silently pulls in nothing."""
    known = set(permissions.ALL_MODULES)
    names = set(capabilities._REQUIRES) | {
        dep for deps in capabilities._REQUIRES.values() for dep in deps}
    names |= set(capabilities.ALWAYS_ON)

    assert not sorted(names - known), sorted(names - known)


def test_service_is_registered_everywhere():
    """The module this test file was written for."""
    assert "service" in permissions.MODULES
    assert "service" in _jsx_module_list("CORE_MODULES")
    # Its dependencies are load-bearing: a job needs a client to bill, stock to
    # draw parts from, and an invoice to charge for the work.
    assert capabilities._REQUIRES["service"] == {"clients", "invoices", "inventory"}
    resolved = capabilities.resolve({"service"})
    for dep in ("clients", "invoices", "inventory"):
        assert dep in resolved, f"licensing service must pull in {dep}"


def test_the_seed_grants_cover_service(as_role):
    """A module with no seeded grant is invisible until an admin goes looking
    for it, which is not a discoverable way to ship a feature."""
    import database
    with database.session() as db:
        rows = db.execute(
            "SELECT r.name FROM role_permissions rp "
            "JOIN roles r ON r.id = rp.role_id "
            "WHERE rp.module='service' AND rp.can_view=1").fetchall()
    granted = {r["name"] for r in rows}

    assert "Business Owner" in granted
    assert "Operations Manager" in granted, "the role that runs service work"
