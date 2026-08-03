"""
Per-customer vendor configuration.

This file is the SINGLE source of truth for which modules a particular
customer's build ships with. It is intentionally NOT part of the database
and NOT writable from a running ERP. The whole point of this file is that
a customer with filesystem access to their install cannot grant themselves
access to modules they did not pay for — even by deleting `erp.db` and
relaunching to provision a fresh superadmin.

How the vendor uses this file
-----------------------------
1. Edit `ENABLED_MODULES` below to the comma-separated list of module keys
   the customer purchased (e.g. "sales,clients,quotations,invoices,inventory").
2. Run `build.ps1` to produce a customer-specific Windows installer.
3. Ship the installer.

Module changes after delivery require a fresh build — there is no "click
to enable" path. This is by design.

Convention
----------
An empty string means "every module visible" — used for the dev install
and demos. Customer builds always set a real list.

Module keys must match the values used by `Sidebar.jsx` and the backend
RBAC `MODULES` list in `database.py`. The canonical set is:

    dashboard, crm, clients, quotations, invoices, pos, projects,
    planning, suppliers, purchases, inventory, warehouses, manufacturing,
    expenses, assets, finance, accounting, cash, reports, hr, recruitment,
    hr_activities, announcements

`dashboard` is always implicitly enabled regardless of this list.

Cloud (multi-instance) hosting
------------------------------
For a hosted deployment you can host the SAME codebase as several instances
that differ only by an `ENABLED_MODULES` environment variable (plus their own
`DATABASE_URL`). The env var, when present, overrides the constant below — so
you don't need a per-customer branch or rebuild to change a module set.
"""
import os

# The env var wins when set (cloud multi-instance); otherwise the build-time
# constant applies (desktop / per-customer installer). Empty == all modules.
ENABLED_MODULES = (os.environ.get("ENABLED_MODULES")
                   if os.environ.get("ENABLED_MODULES") is not None
                   else "").strip()


# ── Server-side module gating (paywall enforcement) ───────────────────────────
# The sidebar hides modules the customer didn't buy, but that's cosmetic on its
# own. `module_allowed` lets the permission layer reject requests to a disabled
# module's API too — defence in depth so a disabled module can't be reached by
# guessing the URL, and so even the superadmin can't use what wasn't purchased.

# Route-guard permission keys that have NO sidebar entry of their own and so
# never appear in a vendor's ENABLED_MODULES list — they belong to a parent
# purchasable module and are allowed whenever that parent is enabled.
_MODULE_PARENT = {
    "hr_contracts": "hr",
}

# System / admin permission keys that are never part of the module paywall.
# They are gated separately (require_admin / require_superadmin) and must keep
# working regardless of which business modules a customer purchased.
_ALWAYS_ON = {"dashboard", "users", "roles"}


def enabled_modules_set():
    """The whitelist of enabled module keys, or None when unrestricted
    (empty constant / env — dev, demo, or a full build)."""
    # Multi-tenant: the licence belongs to the TENANT, not the process. One
    # deployment serves every customer, so a process-wide env var cannot
    # express "Acme bought POS, Globex bought Manufacturing". When a tenant is
    # in scope its stored set wins; the env/constant remains the fallback for
    # single-tenant and desktop installs.
    try:
        from tenant_context import IS_SCHEMA_TENANCY, current_schema
        if IS_SCHEMA_TENANCY:
            schema = current_schema()
            if schema:
                import tenancy
                per_tenant = tenancy.tenant_modules(schema)
                if per_tenant is not None:
                    return per_tenant
    except Exception:
        # Never let a licence lookup take the app down — fall through to the
        # build-time configuration.
        pass

    raw = ENABLED_MODULES
    if not raw:
        return None
    selected = {m.strip() for m in raw.split(",") if m.strip()}
    # Expand to the dependency closure so a plan naming only the headline
    # modules still yields a working system: selling `pos` implicitly licenses
    # invoices, inventory, cash and clients. Without this the customer sees
    # links into modules they hold no licence for and gets 403s — a broken
    # product rather than an unbought one.
    import capabilities
    return capabilities.resolve(selected)


def module_allowed(module: str) -> bool:
    """Is `module` part of this build/instance's purchased set? True for every
    module when unrestricted. System keys are always allowed; a childless
    sub-feature key rides along with its parent module."""
    allowed = enabled_modules_set()
    if allowed is None:
        return True
    if module in _ALWAYS_ON or module in allowed:
        return True
    parent = _MODULE_PARENT.get(module)
    return parent is not None and parent in allowed
