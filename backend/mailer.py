"""
Outbound email — Feature #1.

Sending is OFF by default (the `email_enabled` setting), so nothing changes for
existing installs until an admin turns it on. Stdlib only (``smtplib`` +
``urllib``) — no new runtime dependency, nothing added to the desktop bundle.

Two transports, chosen automatically:
  * **Resend** (HTTPS API) when a Resend API key is configured — the cloud path.
    Most PaaS (Render included) block outbound SMTP ports (25/465/587), so a
    plain SMTP relay can't connect from the cloud at all. Resend delivers over
    HTTPS/443, which is never blocked.
  * **SMTP** otherwise — unchanged, for desktop / self-hosted installs.

Config resolves in this order:
  1. Environment — ``RESEND_API_KEY`` (+ optional ``RESEND_FROM``) selects
     Resend; else ``SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_USE_TLS/
     SMTP_FROM/SMTP_FROM_NAME``. Preferred for cloud: no secrets in the DB.
  2. Else the per-tenant ``settings`` table (``resend_api_key`` or ``smtp_*``
     keys) — for installs configured from the UI.

Every send goes through ``jobs.enqueue('email.send', …)``, so it's asynchronous
under ``JOBS=rq`` (a worker delivers it) and inline/synchronous otherwise — the
request never blocks on the delivery round-trip in production.
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


def resolve_resend(db=None):
    """Resend HTTPS-API config, or None if no API key is set. Env wins (cloud:
    no secret in the DB), then the per-tenant ``resend_api_key`` setting. The
    ``from`` address falls back to ``smtp_from`` / ``company_email`` and finally
    Resend's shared ``onboarding@resend.dev`` (which delivers only to your own
    Resend account email until you verify a sending domain — fine for a test)."""
    key = os.environ.get("RESEND_API_KEY")
    from_addr = os.environ.get("RESEND_FROM") or os.environ.get("SMTP_FROM")
    from_name = os.environ.get("SMTP_FROM_NAME", "")
    if not key and db is not None:
        from utils import get_setting
        key = get_setting(db, "resend_api_key", "") or ""
        from_addr = (from_addr or get_setting(db, "smtp_from", "")
                     or get_setting(db, "company_email", "") or "")
        from_name = from_name or get_setting(db, "company_name", "") or ""
    if not key:
        return None
    return {
        "api_key":   key,
        "from_addr": from_addr or "onboarding@resend.dev",
        "from_name": from_name,
    }


def is_enabled(db=None) -> bool:
    """True only if email is switched on AND a usable transport resolves
    (Resend HTTPS API or SMTP)."""
    enabled = False
    if db is not None:
        from utils import get_setting
        enabled = _bool(get_setting(db, "email_enabled", "0"))
    env = os.environ.get("EMAIL_ENABLED")
    if env is not None:
        enabled = _bool(env)          # env override wins (cloud)
    configured = resolve_resend(db) is not None or resolve_config(db) is not None
    return enabled and configured


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


def _send_via_resend(cfg, to, subject, html_body, reply_to=None):
    """Deliver one message through the Resend HTTPS API. Stdlib ``urllib`` only
    (no new dependency). Raises ``RuntimeError`` on a non-2xx with the API's own
    message, mirroring ``_send_now``'s raise-on-failure contract so callers
    surface the real reason."""
    import json
    import urllib.error
    import urllib.request
    payload = {
        "from": (f'{cfg["from_name"]} <{cfg["from_addr"]}>'
                 if cfg.get("from_name") else cfg["from_addr"]),
        "to": [to] if isinstance(to, str) else list(to),
        "subject": subject,
        "html": html_body,
    }
    if reply_to:
        payload["reply_to"] = reply_to
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f'Bearer {cfg["api_key"]}',
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"Resend API {e.code}: {detail}") from None
    return True


def _deliver(db, to, subject, html_body, reply_to=None):
    """Send synchronously over the active transport: Resend (HTTPS) when an API
    key is configured — the cloud-safe path — otherwise SMTP. Returns
    ``{sent, reason?}``; raises only on a transport-level error (the caller
    wraps it). Resend takes precedence when both are configured."""
    rcfg = resolve_resend(db)
    if rcfg:
        _send_via_resend(rcfg, to, subject, html_body, reply_to)
        return {"sent": True}
    cfg = resolve_config(db)
    if not cfg:
        return {"sent": False, "reason": "not configured"}
    _send_now(cfg, to, subject, html_body, reply_to)
    return {"sent": True}


@jobs.job("email.send")
def _email_job(to, subject, html_body, reply_to=None):
    """Runs in the worker (or inline). Re-resolves config in the job's tenant
    context and delivers via Resend or SMTP. Never raises into the caller."""
    import database
    try:
        with database.session() as db:
            return _deliver(db, to, subject, html_body, reply_to)
    except Exception as e:
        # Email failures must never break the originating business action.
        return {"sent": False, "reason": str(e)}


def send(db, to, subject, html_body, reply_to=None):
    """Queue an email. Returns the job id (JOBS=rq) or the inline result, or
    False if email is disabled/unconfigured. Safe to call from any request."""
    if not is_enabled(db):
        return False
    return jobs.enqueue("email.send", to, subject, html_body, reply_to)


def send_test(db, to):
    """Send a test message SYNCHRONOUSLY over the active transport (Resend or
    SMTP) and return {sent, reason}. Unlike send(), this bypasses the queue and
    surfaces the real error so the Settings "Send test email" button is an
    authoritative diagnostic (a queued send swallows failures by design so it
    can't break a business action)."""
    try:
        return _deliver(db, to, "ERP — test email",
                        "<p>This is a test message from your ERP. "
                        "If you received it, outbound email is working.</p>")
    except Exception as e:   # noqa: BLE001 — report the exact failure to the admin
        return {"sent": False, "reason": f"{type(e).__name__}: {e}"}
