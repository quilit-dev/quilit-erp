"""
Outbound email (SMTP) — Feature #1.

Sending is OFF by default (the `email_enabled` setting), so nothing changes for
existing installs until an admin turns it on. Uses the stdlib ``smtplib`` — no new
runtime dependency, nothing added to the desktop bundle.

Config resolves in this order:
  1. Environment — ``SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_USE_TLS/
     SMTP_FROM/SMTP_FROM_NAME``. Preferred for cloud: one relay, no secrets in
     the DB.
  2. Else the per-tenant ``settings`` table (``smtp_*`` keys) — for self-hosted
     installs that configure SMTP from the UI.

Every send goes through ``jobs.enqueue('email.send', …)``, so it's asynchronous
under ``JOBS=rq`` (a worker delivers it) and inline/synchronous otherwise — the
request never blocks on the SMTP round-trip in production.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage

import jobs


def _bool(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def resolve_config(db=None):
    """Return an SMTP config dict, or None if not configured."""
    host = os.environ.get("SMTP_HOST")
    if host:
        return {
            "host":      host,
            "port":      int(os.environ.get("SMTP_PORT", "587") or 587),
            "user":      os.environ.get("SMTP_USER", ""),
            "password":  os.environ.get("SMTP_PASSWORD", ""),
            "use_tls":   _bool(os.environ.get("SMTP_USE_TLS", "1")),
            "from_addr": os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER", ""),
            "from_name": os.environ.get("SMTP_FROM_NAME", ""),
        }
    if db is not None:
        from utils import get_setting
        host = get_setting(db, "smtp_host")
        if host:
            return {
                "host":      host,
                "port":      int(get_setting(db, "smtp_port", "587") or 587),
                "user":      get_setting(db, "smtp_user", "") or "",
                "password":  get_setting(db, "smtp_password", "") or "",
                "use_tls":   _bool(get_setting(db, "smtp_use_tls", "1")),
                "from_addr": (get_setting(db, "smtp_from", "")
                              or get_setting(db, "company_email", "") or ""),
                "from_name": get_setting(db, "company_name", "") or "",
            }
    return None


def is_enabled(db=None) -> bool:
    """True only if email is switched on AND a usable SMTP config resolves."""
    enabled = False
    if db is not None:
        from utils import get_setting
        enabled = _bool(get_setting(db, "email_enabled", "0"))
    env = os.environ.get("EMAIL_ENABLED")
    if env is not None:
        enabled = _bool(env)          # env override wins (cloud)
    return enabled and resolve_config(db) is not None


def _send_now(cfg, to, subject, html_body, reply_to=None):
    msg = EmailMessage()
    msg["From"] = (f'{cfg["from_name"]} <{cfg["from_addr"]}>'
                   if cfg.get("from_name") else cfg["from_addr"])
    msg["To"] = to if isinstance(to, str) else ", ".join(to)
    msg["Subject"] = subject
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content("This email requires an HTML-capable mail client.")
    msg.add_alternative(html_body, subtype="html")

    if cfg["use_tls"]:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=30) as s:
            s.starttls(context=ssl.create_default_context())
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=30) as s:
            if cfg["user"]:
                s.login(cfg["user"], cfg["password"])
            s.send_message(msg)
    return True


@jobs.job("email.send")
def _email_job(to, subject, html_body, reply_to=None):
    """Runs in the worker (or inline). Re-resolves config in the job's tenant
    context and delivers. Never raises into the caller's request."""
    import database
    try:
        with database.session() as db:
            cfg = resolve_config(db)
        if not cfg:
            return {"sent": False, "reason": "not configured"}
        _send_now(cfg, to, subject, html_body, reply_to)
        return {"sent": True}
    except Exception as e:
        # Email failures must never break the originating business action.
        return {"sent": False, "reason": str(e)}


def send(db, to, subject, html_body, reply_to=None):
    """Queue an email. Returns the job id (JOBS=rq) or the inline result, or
    False if email is disabled/unconfigured. Safe to call from any request."""
    if not is_enabled(db):
        return False
    return jobs.enqueue("email.send", to, subject, html_body, reply_to)
