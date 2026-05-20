"""
Static catalog of the system surface, used to drive parametrised tests.

The smoke suite discovers routes dynamically from `app.routes`; this file only
holds the maps that need human knowledge (which list endpoint represents a
module, which modules are admin-gated, etc.).
"""

# Business modules: guarded by require_perm(module, action).
# value = a representative GET "view" (list) endpoint for that module.
MODULE_VIEW_ENDPOINTS = {
    "clients":    "/api/clients/",
    "projects":   "/api/projects/",
    "quotations": "/api/quotations/",
    "invoices":   "/api/invoices/",
    "pos":        "/api/pos/sales",
    "inventory":  "/api/inventory/",
    "manufacturing": "/api/manufacturing/boms",
    "purchases":  "/api/purchases/",
    "suppliers":  "/api/suppliers/",
    "crm":        "/api/crm/leads",
    "planning":   "/api/planning/projects",
    "hr":         "/api/hr/employees",
    "reports":    "/api/reports/financial",
    "finance":    "/api/finance/summary",
    "expenses":   "/api/finance/expenses",
    "cash":       "/api/cash/drawers",
    "dashboard":  "/api/dashboard/",
}

# Admin modules: guarded by require_admin (superadmin only).
# NOTE: 'audit' is deliberately excluded — database.py seeds the Auditor role
# with audit.view, implying audit endpoints are require_perm-gated, not
# require_admin. That discrepancy is probed in the RBAC matrix tests instead.
ADMIN_VIEW_ENDPOINTS = {
    "users": "/api/users/",
    "roles": "/api/roles/",
}

ACTIONS = ["view", "create", "edit", "delete", "approve"]

# Endpoints that are intentionally public (no auth) — excluded from auth checks.
PUBLIC_PATHS = {
    "/",
    "/api/settings/setup-status",
}
