"""
App-wide exception handlers.

Turn known bad-input failures into clean 4xx responses instead of leaking an
unhandled exception as a 500. These are a safety net: most endpoints validate
explicitly, but heavy/erratic use (a non-existent foreign key, an absurd
numeric amount) must never crash the request. The original error is logged so
genuine bugs are still visible to operators.

Caught here:
  * sqlite3.IntegrityError   — FK / UNIQUE / NOT NULL violations -> 400
  * decimal.InvalidOperation — non-finite or out-of-range money amounts -> 400

NOT caught (left as 500 on purpose, because they indicate a real defect rather
than bad input): sqlite3.OperationalError, programming errors, etc.
"""
import logging
import sqlite3
from decimal import InvalidOperation

from fastapi import Request
from fastapi.responses import JSONResponse

log = logging.getLogger("erp.errors")


def register_error_handlers(app) -> None:
    @app.exception_handler(sqlite3.IntegrityError)
    async def _on_integrity_error(request: Request, exc: sqlite3.IntegrityError):
        log.warning("IntegrityError on %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=400,
            content={"detail": "This action references a record that does not exist, "
                               "or would duplicate or violate an existing one."},
        )

    @app.exception_handler(InvalidOperation)
    async def _on_decimal_error(request: Request, exc: InvalidOperation):
        log.warning("Decimal error on %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=400,
            content={"detail": "A numeric value was invalid or out of range."},
        )
