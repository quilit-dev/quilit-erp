"""
Platform-operator API (Phase 2 lifecycle) — the SaaS vendor's control surface.

This is a SEPARATE auth tier from tenant users (docs/SAAS_ARCHITECTURE.md §15):
operators live in ``public.platform_admins``, log in on their own cookie
(``platform_session``, scope=``platform``), and manage the tenant catalog. A
tenant session can never reach these endpoints and vice-versa.

Endpoints (all under /api/platform):
    POST /login                       operator login
    POST /logout
    GET  /me
    GET  /tenants                     list all tenants
    POST /tenants                     provision a new tenant (returns first creds)
    GET  /tenants/{slug}
    POST /tenants/{slug}/suspend      block all access to a tenant (402)
    POST /tenants/{slug}/activate     re-enable a suspended tenant
"""
from typing import Optional

import jwt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel

import capabilities
import tenancy
from auth_utils import (
    SECRET_KEY, ALGORITHM, COOKIE_SECURE, TOKEN_EXPIRE_HOURS,
    PLATFORM_COOKIE_NAME, create_platform_token,
)
from tenant_context import IS_SCHEMA_TENANCY

router = APIRouter()


def _require_cloud():
    """The operator console only exists on the multi-tenant (cloud) deployment.
    On desktop / single-tenant installs every platform endpoint is a 404 so the
    surface is simply absent rather than half-working against SQLite."""
    if not IS_SCHEMA_TENANCY:
        raise HTTPException(status_code=404, detail="Not available on this deployment.")


# ── auth dependency ──────────────────────────────────────────────────────────

def require_platform_admin(
    platform_session: Optional[str] = Cookie(None, alias=PLATFORM_COOKIE_NAME),
) -> dict:
    _require_cloud()
    if not platform_session:
        raise HTTPException(status_code=401, detail="Not authenticated (platform).")
    try:
        payload = jwt.decode(platform_session, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token.")
    if payload.get("scope") != "platform":
        raise HTTPException(status_code=403, detail="Not a platform session.")
    admin = tenancy.get_platform_admin(int(payload["sub"]))
    if not admin or not admin.get("is_active"):
        raise HTTPException(status_code=401, detail="Platform account disabled.")
    return admin


# ── models ───────────────────────────────────────────────────────────────────

class PlatformLogin(BaseModel):
    username: str
    password: str


class TenantCreate(BaseModel):
    slug: str
    name: Optional[str] = None
    plan: str = "standard"


class DomainAdd(BaseModel):
    domain: str


class ModuleSelection(BaseModel):
    modules: list[str] = []


# ── auth endpoints ───────────────────────────────────────────────────────────

@router.get("/status")
def platform_status():
    """Unauthenticated capability probe — lets the SPA decide whether to render
    the operator console or a 'cloud only' notice without trial-and-error."""
    return {"enabled": IS_SCHEMA_TENANCY}


@router.post("/login")
def platform_login(data: PlatformLogin, response: Response):
    _require_cloud()
    admin = tenancy.verify_platform_admin(data.username, data.password)
    if not admin:
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    token = create_platform_token(admin["id"], admin["username"])
    response.set_cookie(
        key=PLATFORM_COOKIE_NAME, value=token, httponly=True, secure=COOKIE_SECURE,
        samesite="strict", max_age=TOKEN_EXPIRE_HOURS * 3600, path="/",
    )
    return {"username": admin["username"], "full_name": admin.get("full_name")}


@router.post("/logout")
def platform_logout(response: Response, admin=Depends(require_platform_admin)):
    response.delete_cookie(key=PLATFORM_COOKIE_NAME, path="/")
    return {"message": "Logged out."}


@router.get("/me")
def platform_me(admin=Depends(require_platform_admin)):
    return {"username": admin["username"], "full_name": admin.get("full_name")}


# ── tenant lifecycle ─────────────────────────────────────────────────────────

@router.get("/modules")
def module_catalog(admin=Depends(require_platform_admin)):
    """The licensable module list plus its dependency graph.

    The console renders straight from this: `always_on` modules are shown
    permanently on, and `requires` lets the UI resolve a selection locally so
    ticking Point of Sale immediately locks Invoices, Inventory, Cash and
    Clients — without a round trip per click."""
    return {"modules": capabilities.catalog(),
            "always_on": sorted(capabilities.ALWAYS_ON)}


@router.post("/modules/resolve")
def resolve_modules(data: ModuleSelection, admin=Depends(require_platform_admin)):
    """Expand a proposed selection to what the customer would actually get.

    Returns the resolved set plus, for each module the selection forces on,
    which chosen modules require it — so the UI can explain a locked checkbox
    ("required by Point of Sale") instead of just disabling it."""
    selected = set(data.modules or [])
    return {
        "selected": sorted(selected),
        "resolved": sorted(capabilities.resolve(selected)),
        "locked_by": {k: v for k, v in capabilities.lock_reasons(selected).items()},
    }


@router.get("/tenants")
def list_all_tenants(admin=Depends(require_platform_admin)):
    return tenancy.list_tenants()


@router.post("/tenants")
def create_tenant(data: TenantCreate, admin=Depends(require_platform_admin)):
    if not tenancy.valid_slug(data.slug):
        raise HTTPException(status_code=400,
                            detail="Invalid slug — use lower-case letters, digits, underscore.")
    try:
        return tenancy.provision_tenant(data.slug, data.name, data.plan)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/tenants/{slug}")
def get_tenant(slug: str, admin=Depends(require_platform_admin)):
    for t in tenancy.list_tenants():
        if t["slug"] == slug:
            return t
    raise HTTPException(status_code=404, detail="Tenant not found.")


@router.post("/tenants/{slug}/suspend")
def suspend_tenant(slug: str, admin=Depends(require_platform_admin)):
    tenancy.set_tenant_status(slug, "suspended")
    return {"slug": slug, "status": "suspended"}


@router.post("/tenants/{slug}/activate")
def activate_tenant(slug: str, admin=Depends(require_platform_admin)):
    tenancy.set_tenant_status(slug, "active")
    return {"slug": slug, "status": "active"}


# ── custom domains ───────────────────────────────────────────────────────────

@router.get("/tenants/{slug}/domains")
def list_domains(slug: str, admin=Depends(require_platform_admin)):
    return tenancy.list_tenant_domains(slug)


@router.post("/tenants/{slug}/domains")
def add_domain(slug: str, data: DomainAdd, admin=Depends(require_platform_admin)):
    """Attach a custom domain (pending verification). Returns the DNS TXT record
    the client must publish to prove ownership before the domain goes live."""
    try:
        return tenancy.add_tenant_domain(slug, data.domain)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/domains/{domain}/verify")
def verify_domain(domain: str, admin=Depends(require_platform_admin)):
    """Re-check the DNS TXT record and flip the domain to verified if it matches."""
    try:
        return tenancy.verify_tenant_domain(domain)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/domains/{domain}")
def delete_domain(domain: str, admin=Depends(require_platform_admin)):
    tenancy.remove_tenant_domain(domain)
    return {"domain": domain, "removed": True}


@router.get("/tls-check")
def tls_check(domain: str = "", host: str = ""):
    """On-demand TLS gate for the reverse proxy (e.g. Caddy `on_demand_tls.ask`).
    UNAUTHENTICATED by design — the proxy calls it server-side before issuing a
    certificate. Returns 200 only for a known, VERIFIED tenant domain so random
    hosts pointed at us can't trigger certificate issuance. Caddy passes the SNI
    host as `?domain=`; we also accept `?host=` for other proxies."""
    _require_cloud()
    candidate = (domain or host or "").strip().lower().rstrip(".")
    if not candidate or not tenancy.is_verified_domain(candidate):
        raise HTTPException(status_code=404, detail="Unknown domain.")
    return {"domain": candidate, "ok": True}
