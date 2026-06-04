"""
Per-request tenant context (Phase 2 — schema-per-tenant multi-tenancy).

Kept as a tiny, dependency-free module so BOTH ``database.get_db`` (which applies
the search_path) and ``tenancy`` (the middleware that resolves the tenant) can
import it without an import cycle.

Tenancy modes (env ``TENANCY``):
  * ``single`` (default) — one schema (``public``); behaves exactly like the
    pre-Phase-2 app. The 840-test suite runs in this mode.
  * ``schema``           — schema-per-tenant. A pure-ASGI middleware resolves the
    request's tenant and stores its schema here; ``get_db`` issues
    ``SET search_path`` so every existing query runs against that schema.

The current schema is held in a ContextVar set by the middleware. A *pure* ASGI
middleware sets it in the same task that runs the endpoint, so the value
propagates into FastAPI's threadpool-run sync dependencies (this would NOT hold
for a Starlette BaseHTTPMiddleware, which runs the endpoint in a separate task).
"""
import os
import re
from contextvars import ContextVar

TENANCY = os.environ.get("TENANCY", "single").lower()
IS_SCHEMA_TENANCY = TENANCY in ("schema", "multi", "tenant")
DEFAULT_SCHEMA = "public"

# A valid Postgres identifier we are willing to interpolate into SET search_path.
# Lower-case letter first, then letters/digits/underscores — no quoting tricks.
_SCHEMA_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")

_current_schema: "ContextVar[str | None]" = ContextVar("current_schema", default=None)


def valid_schema_name(name) -> bool:
    return isinstance(name, str) and bool(_SCHEMA_RE.match(name))


def set_current_schema(schema):
    """Set the active request's schema; returns a token for reset()."""
    return _current_schema.set(schema)


def reset_current_schema(token):
    _current_schema.reset(token)


def current_schema() -> str:
    """The schema for the active request, or ``public`` when none is set."""
    return _current_schema.get() or DEFAULT_SCHEMA
