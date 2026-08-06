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

# Interactive API docs are a development tool. On a multi-tenant deployment they
# publish the complete API surface — every endpoint, every field name — to
# anyone who asks, unauthenticated. That does not grant access (the endpoints
# still require auth) but it hands an attacker a finished map, so the cloud
# deployment turns them off.
#
# The switch is on TENANCY rather than a new variable: schema mode IS the hosted
# multi-tenant product, and the self-hosted/desktop build keeps the docs it has
# always had. API_DOCS=on forces them back for debugging a cloud instance.
_DOCS = (os.environ.get("API_DOCS", "").strip().lower() in ("1", "on", "true")
         or os.environ.get("TENANCY", "single").strip().lower()
         not in ("schema", "multi", "tenant"))

app = FastAPI(title="ERP System", version="2.0.0",
              docs_url="/docs" if _DOCS else None,
              redoc_url="/redoc" if _DOCS else None,
              openapi_url="/openapi.json" if _DOCS else None)

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
from tenant_context import IS_SCHEMA_TENANCY
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


class MetricsMiddleware:
    """Per-tenant API usage and latency (see metrics.py).

    Pure ASGI so the response status can be read from the outgoing
    http.response.start message without buffering the body — wrapping this as
    a BaseHTTPMiddleware would materialise every response, which is exactly
    the cost telemetry must not add.

    The hot path is a timer plus a dict increment. The periodic flush runs
    AFTER the response has been sent, so a customer's request never waits on
    a metrics write. Every failure is swallowed: telemetry must never take the
    ERP down.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not IS_SCHEMA_TENANCY:
            await self.app(scope, receive, send)
            return

        import time as _time
        started = _time.perf_counter()
        status_holder = {"code": 0, "schema": None}

        async def _send(message):
            if message.get("type") == "http.response.start":
                status_holder["code"] = message.get("status", 0)
                # Capture the tenant HERE, not in the finally below. This
                # middleware is registered outside TenantMiddleware, whose own
                # finally resets the ContextVar first — so by the time our
                # finally runs, current_schema() is always None. At
                # response.start the inner middleware is still on the stack and
                # the context is live.
                try:
                    from tenant_context import current_schema
                    status_holder["schema"] = current_schema()
                except Exception:
                    pass
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            try:
                import metrics
                schema = status_holder.get("schema")
                if schema:
                    # tenant_<slug> -> slug
                    slug = schema[7:] if schema.startswith("tenant_") else schema
                    metrics.record(slug, status_holder["code"],
                                   (_time.perf_counter() - started) * 1000.0)
                # Response is already sent by here, so this costs the customer
                # nothing.
                if metrics.due_for_flush():
                    metrics.flush()
                    metrics.snapshot_storage_if_due()
            except Exception:
                pass


from auth_utils import COOKIE_SECURE
app.add_middleware(SecurityHeadersMiddleware, hsts=COOKIE_SECURE)

# Added last → outermost: it assigns the request id before any other middleware
# or handler runs, so every log line for the request is correlated.
app.add_middleware(MetricsMiddleware)
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
