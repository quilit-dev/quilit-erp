from dotenv import load_dotenv
from pathlib import Path
load_dotenv(Path(__file__).parent / ".env")

import os, sys
if not os.environ.get("SECRET_KEY"):
    sys.exit(
        "\n  FATAL: SECRET_KEY environment variable is not set.\n"
        "  Generate one with:  python -c \"import secrets; print(secrets.token_hex(32))\"\n"
        "  Add it to backend/.env as:  SECRET_KEY=<generated-value>\n"
    )

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os

from routers import clients, projects, quotations, inventory, invoices, finance, dashboard, auth
from routers import purchases, settings, archives, documents, suppliers, audit, users, roles, search
from routers import reports, crm, planning, notifications
from routers import approval_policies, approval_requests, hr, hr_contracts, recruitment, hr_activities, tax_rates, pos, cash, manufacturing
from routers import assets, recurring, announcements, attachments, accounting, warehouses, platform

app = FastAPI(title="ERP System", version="2.0.0")

# Turn known bad-input failures (bad FKs, absurd amounts) into clean 4xx
# instead of 500s — see error_handlers.py.
from error_handlers import register_error_handlers
register_error_handlers(app)

# Allow origins from env var (comma-separated) or fall back to localhost for dev
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Schema-per-tenant routing (Phase 2). Self-disables unless TENANCY=schema, so
# single-tenant / desktop installs are completely unaffected.
from tenancy import TenantMiddleware
app.add_middleware(TenantMiddleware)

app.include_router(auth.router,        prefix="/api/auth",        tags=["auth"])
app.include_router(dashboard.router,   prefix="/api/dashboard",   tags=["dashboard"])
app.include_router(clients.router,     prefix="/api/clients",     tags=["clients"])
app.include_router(projects.router,    prefix="/api/projects",    tags=["projects"])
app.include_router(quotations.router,  prefix="/api/quotations",  tags=["quotations"])
app.include_router(inventory.router,   prefix="/api/inventory",   tags=["inventory"])
app.include_router(invoices.router,    prefix="/api/invoices",    tags=["invoices"])
app.include_router(finance.router,     prefix="/api/finance",     tags=["finance"])
app.include_router(purchases.router,     prefix="/api/purchases",     tags=["purchases"])
app.include_router(settings.router,      prefix="/api/settings",      tags=["settings"])
app.include_router(archives.router,      prefix="/api/archives",      tags=["archives"])
app.include_router(documents.router,     prefix="/api/documents",     tags=["documents"])
app.include_router(suppliers.router,     prefix="/api/suppliers",     tags=["suppliers"])
app.include_router(audit.router,         prefix="/api/audit",         tags=["audit"])
app.include_router(users.router,         prefix="/api/users",          tags=["users"])
app.include_router(roles.router,         prefix="/api/roles",          tags=["roles"])
app.include_router(search.router,        prefix="/api/search",         tags=["search"])
app.include_router(reports.router,       prefix="/api/reports",        tags=["reports"])
app.include_router(crm.router,           prefix="/api/crm",            tags=["crm"])
app.include_router(planning.router,      prefix="/api/planning",       tags=["planning"])
app.include_router(notifications.router,     prefix="/api/notifications",      tags=["notifications"])
app.include_router(approval_policies.router, prefix="/api/approval-policies",  tags=["approvals"])
app.include_router(approval_requests.router, prefix="/api/approval-requests",  tags=["approvals"])
app.include_router(hr.router,                prefix="/api/hr",                 tags=["hr"])
app.include_router(hr_contracts.router,      prefix="/api/hr/contracts",       tags=["hr"])
app.include_router(recruitment.router,       prefix="/api/recruitment",        tags=["recruitment"])
app.include_router(hr_activities.router,     prefix="/api/hr-activities",      tags=["hr"])
app.include_router(tax_rates.router,         prefix="/api/tax-rates",          tags=["tax"])
app.include_router(pos.router,               prefix="/api/pos",                tags=["pos"])
app.include_router(cash.router,              prefix="/api/cash",               tags=["cash"])
app.include_router(manufacturing.router,     prefix="/api/manufacturing",      tags=["manufacturing"])
app.include_router(assets.router,            prefix="/api/assets",             tags=["assets"])
app.include_router(recurring.router,         prefix="/api/recurring-expenses", tags=["expenses"])
app.include_router(announcements.router,      prefix="/api/announcements",      tags=["announcements"])
app.include_router(attachments.router,        prefix="/api/attachments",        tags=["attachments"])
app.include_router(accounting.router,         prefix="/api/accounting",         tags=["accounting"])
app.include_router(warehouses.router,         prefix="/api/warehouses",         tags=["warehouses"])
app.include_router(platform.router,           prefix="/api/platform",           tags=["platform"])

@app.get("/")
def root():
    return {"message": "ERP System API v2.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
