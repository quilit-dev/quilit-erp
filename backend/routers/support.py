"""
Tenant-side support endpoint — the "Report a problem" action inside the ERP.

Deliberately available to ANY authenticated user, not just admins: the person
who hits the bug is usually a cashier or a clerk, and routing them through an
administrator is how reports stop being filed.

Tenancy and identity come from the session, never the request body, so a user
cannot file a report against another customer.
"""
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import support
from database import get_db
from permissions import require_auth

router = APIRouter()


class ProblemReport(BaseModel):
    title:       Optional[str] = None
    message:     Optional[str] = None      # error message, if any
    stack:       Optional[str] = None      # stack trace, if any
    page_url:    Optional[str] = None
    user_agent:  Optional[str] = None
    app_version: Optional[str] = None
    severity:    Optional[str] = "medium"
    description: Optional[str] = None      # what the user was trying to do


@router.post("/report")
def report_problem(data: ProblemReport,
                   user=Depends(require_auth),
                   db: sqlite3.Connection = Depends(get_db)):
    """File a problem report. Lands in the vendor's Control Center inbox."""
    slug = name = None
    try:
        from tenant_context import current_schema
        schema = current_schema()
        if schema:
            import tenancy
            raw = tenancy._connect()
            try:
                with raw.cursor() as cur:
                    cur.execute("SELECT slug, name FROM public.tenants "
                                "WHERE schema_name = %s", (schema,))
                    row = cur.fetchone()
                    if row:
                        slug, name = row["slug"], row["name"]
            finally:
                raw.close()
    except Exception:
        # Single-tenant installs have no catalog; the report is still filed,
        # just without a customer attached.
        pass

    return support.file_report(
        data.dict(),
        tenant_slug=slug, tenant_name=name,
        user_id=user.get("id"), username=user.get("username"),
    )
