"""
Cron trigger — run the periodic scheduler from an HTTP call.

For single-service hosts (e.g. Render free tier) that can't run the standalone
`scheduler.py` process, an external cron (cron-job.org, GitHub Actions, …) can
POST here on a schedule to drive the same periodic tasks (overdue-invoice
reminders, …). The Docker stack still uses the dedicated `scheduler` service and
does not need this.

Security: disabled unless CRON_TOKEN is set. The caller must present the same
token (header `X-Cron-Token` or `?token=`); compared in constant time. No user
session is involved — the tasks run as the system user, exactly like the
scheduler process.
"""
import hmac
import os

from fastapi import APIRouter, HTTPException, Header, Query

router = APIRouter()


@router.post("/run")
def run_cron(token: str = Query(None), x_cron_token: str = Header(None)):
    secret = (os.environ.get("CRON_TOKEN") or "").strip()
    if not secret:
        raise HTTPException(503, "Cron trigger disabled. Set CRON_TOKEN to enable it.")
    provided = (x_cron_token or token or "").strip()
    if not (provided and hmac.compare_digest(provided, secret)):
        raise HTTPException(401, "Invalid or missing cron token.")
    import scheduler
    ran = scheduler.run_once()
    return {"status": "ok", "ran": ran}
