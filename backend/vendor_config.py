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
    planning, suppliers, purchases, inventory, manufacturing, expenses,
    assets, finance, cash, reports, hr, announcements

`dashboard` is always implicitly enabled regardless of this list.
"""

ENABLED_MODULES = ""
