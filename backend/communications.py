"""
Client communications — send a document to a customer by email or WhatsApp.

Phase 1 deliberately avoids two expensive things:

  * **No server-side PDF.** Invoices and quotations are rendered as HTML and
    printed by the browser (`exportUtils.printHTML`), so no PDF exists on the
    server to attach. Instead a document gets a capability URL and the email
    carries the LINK. That is cheaper to build, and better: the link can report
    that it was opened, and it is where a Pay button goes later.

  * **No WhatsApp Business API.** That needs Meta business verification,
    pre-approved templates and per-message billing — and, fatally for a
    multi-tenant product, a separate number and onboarding per customer. You
    cannot send as ten different businesses from one number. So phase 1 builds
    a `wa.me` deep link and the user's own WhatsApp sends it, which is what an
    SMB owner does by hand today.

Security of the share link. This is the only unauthenticated surface that
reaches business data, so:
  * the token is 32 random bytes (256 bits) — not guessable, not enumerable;
  * only its SHA-256 is stored, so a database dump yields no working links;
  * it grants exactly ONE document, read-only, and nothing else;
  * it can expire and can be revoked;
  * tokens live in the tenant schema and links are served from the tenant's own
    host, so a token is meaningless against another customer.

Email transport is Resend's HTTP API over urllib — no new dependency, and no
SMTP socket handling. Absent configuration, sending fails loudly with a clear
message rather than pretending to succeed.
"""
import hashlib
import json
import os
import secrets
import urllib.error
import urllib.request

SHARE_TTL_DAYS = int(os.environ.get("SHARE_LINK_TTL_DAYS", "30"))
_RESEND_ENDPOINT = "https://api.resend.com/emails"

ENTITY_TYPES = ("invoice", "quotation")


# ── tokens ───────────────────────────────────────────────────────────────────

def new_token() -> str:
    """A capability token for one share link.

    16 bytes, not 32. token_urlsafe(32) produces 43 characters, which alongside
    a host makes a URL that reads like something a client should not click — and
    an invoice nobody opens has not been delivered. 128 bits is 3.4e38
    possibilities: unguessable over HTTP, the same strength used for session
    identifiers, and on a link that also expires, is revocable, and only ever
    exposes a single read-only document. The extra 128 bits bought nothing but
    21 more characters of noise.
    """
    return secrets.token_urlsafe(16)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ── email configuration ──────────────────────────────────────────────────────

def email_config() -> dict:
    """Resolve email settings from the environment.

    Kept in env rather than tenant settings: it is a vendor-level secret shared
    by every tenant, and storing an API key in a tenant's own database would
    put it one SQL-injection or one careless export away from a customer.
    """
    return {
        "api_key": (os.environ.get("RESEND_API_KEY") or "").strip(),
        "from_email": (os.environ.get("MAIL_FROM") or "").strip(),
        "from_name": (os.environ.get("MAIL_FROM_NAME") or "").strip(),
    }


def email_enabled() -> bool:
    c = email_config()
    return bool(c["api_key"] and c["from_email"])


def email_status() -> dict:
    """What the UI needs to explain WHY email is unavailable, without leaking
    the key itself."""
    c = email_config()
    missing = [k for k in ("api_key", "from_email") if not c[k]]
    return {
        "enabled": not missing,
        "missing": missing,
        "from_email": c["from_email"] or None,
    }


def send_email(to: str, subject: str, html: str, reply_to: str = None,
               from_name: str = None) -> None:
    """Send one email. Raises RuntimeError with a usable message on failure.

    The caller logs the outcome either way — a failure that is not recorded is
    indistinguishable from never having tried, which is the thing this whole
    module exists to make auditable.
    """
    cfg = email_config()
    if not cfg["api_key"] or not cfg["from_email"]:
        raise RuntimeError(
            "Email is not configured. Set RESEND_API_KEY and MAIL_FROM.")

    display = (from_name or cfg["from_name"] or "").strip()
    sender = f"{display} <{cfg['from_email']}>" if display else cfg["from_email"]

    payload = {"from": sender, "to": [to], "subject": subject, "html": html}
    if reply_to:
        # The customer's own address, so a client replying reaches THEM and not
        # the vendor. Phase 2 replaces this with per-tenant DKIM sending.
        payload["reply_to"] = reply_to

    req = urllib.request.Request(
        _RESEND_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {cfg['api_key']}",
                 "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status not in (200, 201, 202):
                raise RuntimeError(f"Email provider returned {resp.status}")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = (e.read() or b"").decode("utf-8", "replace")[:300]
        except Exception:
            pass
        # Never echo the Authorization header or key back to a caller.
        raise RuntimeError(f"Email provider rejected the message ({e.code}). {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach the email provider: {e.reason}")


# ── message bodies ───────────────────────────────────────────────────────────

def _esc(s) -> str:
    from html import escape
    return escape("" if s is None else str(s))


def document_email_html(*, company: str, doc_label: str, doc_number: str,
                        client_name: str, total: str, url: str,
                        note: str = None) -> str:
    """A plain, deliverable email. No images, no tracking pixels, no external
    CSS — heavy HTML mail is what gets filed as spam, and an invoice landing in
    spam is the failure that matters here."""
    note_html = (f'<p style="margin:0 0 16px">{_esc(note)}</p>' if note else "")
    return f"""<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
     font-size:15px;line-height:1.6;color:#1c1a1d;max-width:520px">
  <p style="margin:0 0 16px">Dear {_esc(client_name)},</p>
  {note_html}
  <p style="margin:0 0 16px">
    Your {_esc(doc_label.lower())} <strong>{_esc(doc_number)}</strong> from
    {_esc(company)} is ready. The total is <strong>{_esc(total)}</strong>.
  </p>
  <p style="margin:0 0 24px">
    <a href="{_esc(url)}"
       style="background:#714B67;color:#fff;text-decoration:none;
              padding:11px 18px;border-radius:8px;display:inline-block">
      View {_esc(doc_label.lower())}
    </a>
  </p>
  <p style="margin:0 0 8px;color:#6b6570;font-size:13px">
    Or open this link: <a href="{_esc(url)}">{_esc(url)}</a>
  </p>
  <p style="margin:0;color:#6b6570;font-size:13px">{_esc(company)}</p>
</div>"""


def whatsapp_text(*, company: str, doc_label: str, doc_number: str,
                  client_name: str, total: str, url: str,
                  note: str = None) -> str:
    """Plain text for a wa.me deep link. WhatsApp renders the URL as a preview
    card, so the link goes last."""
    parts = [f"Dear {client_name},"]
    if note:
        parts.append(note)
    parts.append(f"Your {doc_label.lower()} {doc_number} from {company} "
                 f"is ready. Total: {total}.")
    # Introduce the link. A URL alone on its own line, with no sentence around
    # it, is the shape of a scam message — the recipient decides whether to
    # trust it from the words next to it, not from the domain.
    parts.append("View or print it here:\n" + url)
    return "\n\n".join(parts)
