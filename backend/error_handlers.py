"""
App-wide exception handlers.

Turn known bad-input failures into clean 4xx responses instead of leaking an
unhandled exception as a 500. These are a safety net: most endpoints validate
explicitly, but heavy/erratic use (a non-existent foreign key, an absurd
numeric amount) must never crash the request. The original error is logged so
genuine bugs are still visible to operators.

Caught here:
  * IntegrityError            — FK / UNIQUE / NOT NULL violations -> 400
                               (sqlite3 AND psycopg, so both backends behave the same)
  * decimal.InvalidOperation — non-finite or out-of-range money amounts -> 400

NOT caught (left as 500 on purpose, because they indicate a real defect rather
than bad input): OperationalError, programming errors, etc.
"""
import logging
import sqlite3
from decimal import InvalidOperation

from fastapi import Request
from fastapi.responses import JSONResponse

log = logging.getLogger("erp.errors")

# Postgres (psycopg) raises its OWN IntegrityError hierarchy (ForeignKeyViolation,
# UniqueViolation, NotNullViolation, CheckViolation) — a different class tree from
# sqlite3's. Catch both so the same bad-input request returns a clean 400 on either
# backend. psycopg is optional (absent in the lean desktop build), so import it
# defensively.
_INTEGRITY_ERRORS = [sqlite3.IntegrityError]
try:
    import psycopg
    _INTEGRITY_ERRORS.append(psycopg.errors.IntegrityError)
except Exception:
    pass


def register_error_handlers(app) -> None:
    async def _on_integrity_error(request: Request, exc: Exception):
        log.warning("IntegrityError on %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=400,
            content={"detail": "This action references a record that does not exist, "
                               "or would duplicate or violate an existing one."},
        )

    for _exc_type in _INTEGRITY_ERRORS:
        app.add_exception_handler(_exc_type, _on_integrity_error)

    @app.exception_handler(InvalidOperation)
    async def _on_decimal_error(request: Request, exc: InvalidOperation):
        log.warning("Decimal error on %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=400,
            content={"detail": "A numeric value was invalid or out of range."},
        )
