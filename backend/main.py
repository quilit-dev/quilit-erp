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
from routers import purchases, settings, documents, suppliers, audit, users, roles, search
from routers import reports, crm, planning, notifications
from routers import approval_policies, approval_requests, hr, hr_contracts, recruitment, hr_activities, tax_rates, pos, cash, manufacturing
from routers import assets, recurring, announcements, attachments, accounting, warehouses, platform, imports
from routers import products
from routers import support as support_router
from routers import categories as categories_router, promotions

# Structured logging (JSON when LOG_FORMAT=json) + per-request correlation ids.
# Configured before the app so startup logs are formatted too.
from logging_setup import configure_logging, RequestContextMiddleware
configure_logging()

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


# ── Security response headers ────────────────────────────────────────────────
# Hardening headers on every response: block MIME-sniffing, framing
# (clickjacking), and constrain resource loading (defense-in-depth XSS). Pure
# ASGI (not BaseHTTPMiddleware) so it never interferes with streaming/file
# responses. The SPA is served same-origin with NO inline scripts (Vite emits
# external module scripts), so `script-src 'self'` is safe; React inline styles
# need `style-src 'unsafe-inline'`.
class SecurityHeadersMiddleware:
    def __init__(self, app, hsts: bool):
        self.app = app
        self._headers = [
            (b"x-content-type-options", b"nosniff"),
            (b"x-frame-options", b"DENY"),
            (b"referrer-policy", b"strict-origin-when-cross-origin"),
            (b"content-security-policy",
             b"default-src 'self'; base-uri 'self'; frame-ancestors 'none'; "
             b"object-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; "
             b"style-src 'self' 'unsafe-inline'; script-src 'self'; "
             b"connect-src 'self'; form-action 'self'"),
        ]
        # HSTS only over HTTPS deployments (COOKIE_SECURE=true). Browsers ignore
        # it over plain HTTP anyway, but sending it only when secure avoids
        # surprising LAN-only self-hosted installs served on http://.
        if hsts:
            self._headers.append(
                (b"strict-transport-security", b"max-age=31536000; includeSubDomains"))

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def _send(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                present = {k.lower() for k, _ in headers}
                for k, v in self._headers:
                    if k not in present:
                        headers.append((k, v))
            await send(message)

        await self.app(scope, receive, _send)


from auth_utils import COOKIE_SECURE
app.add_middleware(SecurityHeadersMiddleware, hsts=COOKIE_SECURE)

# Added last → outermost: it assigns the request id before any other middleware
# or handler runs, so every log line for the request is correlated.
app.add_middleware(RequestContextMiddleware)

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
app.include_router(imports.router,            prefix="/api/imports",            tags=["imports"])
app.include_router(support_router.router, prefix="/api/support",  tags=["support"])
app.include_router(products.router,           prefix="/api/products",           tags=["products"])
app.include_router(categories_router.router,  prefix="/api/categories",         tags=["categories"])
app.include_router(promotions.router,         prefix="/api/promotions",         tags=["promotions"])

@app.get("/api/health")
def health():
    """Liveness probe for containers / load balancers (no DB hit)."""
    return {"status": "ok"}

# ── Serve the built SPA (single-service hosts: Render, Fly, a bare VM…) ───────
# In the Docker Compose stack, Caddy serves the SPA and reverse-proxies /api here.
# On a single-service host the app must serve BOTH, so when a built frontend is
# present next to the app we serve it + a client-side-routing fallback. Declared
# AFTER every /api router, so the API always wins; with no build present it falls
# back to a JSON banner (API-only / test runs for non-SPA paths).
from fastapi.responses import FileResponse, Response

STATIC_DIR = os.environ.get("STATIC_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
_HAS_SPA = os.path.isfile(os.path.join(STATIC_DIR, "index.html"))

if _HAS_SPA:
    _NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate",
                 "Pragma": "no-cache", "Expires": "0"}
    _STATIC_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".css",
                    ".js", ".woff", ".woff2", ".ttf", ".map", ".webp", ".json", ".txt")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str = ""):
        # Unknown /api/* paths return 404 JSON, never the SPA shell.
        if full_path.startswith("api/"):
            return Response('{"detail":"Not found"}', status_code=404,
                            media_type="application/json")
        if full_path:
            # Resolve strictly within STATIC_DIR — block path traversal.
            p = os.path.normpath(os.path.join(STATIC_DIR, full_path))
            if (p == STATIC_DIR or p.startswith(STATIC_DIR + os.sep)) and os.path.isfile(p):
                hdrs = {"Cache-Control": "public, max-age=31536000, immutable"} \
                       if "/assets/" in full_path else {}
                return FileResponse(p, headers=hdrs)
            if any(full_path.endswith(e) for e in _STATIC_EXTS):
                return Response(status_code=404)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=_NO_CACHE)
else:
    @app.get("/")
    def root():
        return {"message": "ERP System API v2.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0",
                port=int(os.environ.get("PORT", 8000)), reload=True)
