"""
Send invoices and quotations to clients, and record what was sent.

Two audiences, two auth models, deliberately in one file so the shape of the
public payload sits next to the code that issues the token for it:

  * `/api/communications/*` — staff, behind require_perm.
  * `/api/communications/public/{token}` — the CLIENT, unauthenticated. This is
    the only route in the app that returns business data without a session, so
    it is written to be boring: one document, read-only, no listing, no
    neighbouring records, and a 404 for anything it cannot prove.
"""
import sqlite3
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

import communications as comms
import line_items
from database import get_db
from permissions import require_perm
from utils import _now

router = APIRouter()


class SendRequest(BaseModel):
    entity_type: str                      # 'invoice' | 'quotation'
    entity_id: int
    channel: str                          # 'email' | 'whatsapp'
    to: Optional[str] = None              # email address / phone (E.164 digits)
    note: Optional[str] = None            # optional line from the sender


# ── document loading ─────────────────────────────────────────────────────────

_DOC = {
    "invoice": {
        "table": "invoices", "number": "invoice_number", "label": "Invoice",
        "items": "invoice_items", "fk": "invoice_id", "module": "invoices",
    },
    "quotation": {
        "table": "quotations", "number": "quote_number", "label": "Quotation",
        "items": "quotation_items", "fk": "quotation_id", "module": "quotations",
    },
}


def _cfg(entity_type: str) -> dict:
    cfg = _DOC.get(entity_type)
    if not cfg:
        raise HTTPException(400, "Unsupported document type.")
    return cfg


def _load_document(db, entity_type: str, entity_id: int) -> dict:
    """Read one document plus its client and lines.

    Table and column names come from the _DOC registry, never from the request,
    so the interpolation below cannot be steered by a caller.
    """
    cfg = _cfg(entity_type)
    row = db.execute(
        f"""SELECT d.*, d.{cfg['number']} AS doc_number,
                   c.name AS client_name, c.email AS client_email,
                   c.phone AS client_phone
            FROM {cfg['table']} d
            LEFT JOIN clients c ON d.client_id = c.id
            WHERE d.id = ?""", (entity_id,)).fetchone()
    if not row:
        raise HTTPException(404, f"{cfg['label']} not found.")
    doc = dict(row)
    try:
        items = db.execute(
            f"SELECT name, quantity, unit_price, discount, discount_pct, tax_rate, "
            f"inventory_id "
            f"FROM {cfg['items']} "
            f"WHERE {cfg['fk']} = ? ORDER BY id", (entity_id,)).fetchall()
        # inventory_id is selected only to resolve the barcode; it is dropped
        # from the payload below, since an internal row id tells an outsider
        # nothing useful and is not theirs to have.
        doc["items"] = line_items.attach_barcodes(db, [dict(i) for i in items])
    except sqlite3.Error:
        doc["items"] = []
    return doc


def _company(db) -> dict:
    """Company identity for the document header. This is the one place the
    tenant's own name is still shown to an outsider — it is their invoice, not
    Quilit's."""
    # The keys the printed template reads, so the client's copy looks like the
    # supplier's. Bank details are included deliberately: the customer cannot pay
    # an invoice without them, and they are on the paper version already.
    WANTED = ("company_name", "company_tagline", "company_address", "company_city",
              "company_country", "company_phone", "company_email", "company_website",
              "company_tax_number", "company_reg_number",
              "bank_name", "bank_account", "bank_iban", "bank_swift",
              "default_currency", "currency", "footer_text", "payment_terms_days",
              "tax_enabled", "default_tax_rate", "show_tax_col", "show_discount_col",
              "show_barcode_col", "show_total_words")
    # `preprinted_stationery` is deliberately NOT in that list, and adding it
    # would be a bug. It means "this company prints onto paper that already has
    # its letterhead", which is true of the supplier and false of whoever opens
    # the link — they are looking at a screen. Carrying it here would strip the
    # design from the customer's copy of a document the supplier sent on
    # letterhead.
    out = {"name": "", "address": "", "phone": "", "email": "", "currency": "USD"}
    try:
        rows = db.execute(
            "SELECT key, value FROM settings WHERE key IN "
            "(" + ",".join("?" * len(WANTED)) + ")", WANTED).fetchall()
        m = {r["key"]: r["value"] for r in rows}
        out.update(m)
        out.update({
            "name": m.get("company_name") or "",
            "address": m.get("company_address") or "",
            "phone": m.get("company_phone") or "",
            "email": m.get("company_email") or "",
            "currency": m.get("default_currency") or m.get("currency") or "USD",
        })
    except sqlite3.Error:
        pass
    # Which letterhead to print on. Resolved from the tenant rather than read
    # from the settings table — same source the supplier's own export uses, so
    # the copy a customer opens is the copy that was sent. Without this the
    # customer would get the generic design for a document the supplier printed
    # on its own letterhead.
    import vendor_config
    out["document_template"] = vendor_config.document_template()
    return out


def _money(amount, currency: str) -> str:
    try:
        return f"{currency} {float(amount or 0):,.2f}"
    except (TypeError, ValueError):
        return f"{currency} 0.00"


# ── share links ──────────────────────────────────────────────────────────────

def _url_slug(text: str) -> str:
    """A short, safe, human-readable path segment from a document number."""
    out = "".join(c if (c.isalnum() or c in "-_") else "-" for c in str(text or "").lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")[:40]


def _share_url(request: Request, token: str, doc_number: str = None) -> str:
    """Build the client-facing URL on the SAME host the request arrived on.

    That is what makes per-tenant tokens safe: the link is on the customer's own
    domain, so tenant resolution happens from the host and a token cannot be
    replayed against another workspace.

    The document number goes in the path ahead of the token. A bare random
    string reads exactly like a phishing link, and a client who does not open
    the message has not been sent anything — so the URL has to say what it is.
    The segment is cosmetic: the token alone is checked, and /d/<token> without
    it still resolves, which keeps every link already sent working.

    No new disclosure: anyone holding the link can read the whole document, so
    putting its number in the path reveals nothing the page would not.
    """
    base = str(request.base_url).rstrip("/")
    slug = _url_slug(doc_number)
    return f"{base}/d/{slug}/{token}" if slug else f"{base}/d/{token}"


def _issue_share(db, entity_type: str, entity_id: int, user_id) -> tuple:
    """Create a fresh capability token. Returns (share_id, plaintext token).

    A new token per send, rather than one reusable link per document: sending
    again after a correction should not silently reuse a link the client may
    have forwarded, and revoking one send must not break another.
    """
    token = comms.new_token()
    expires = (datetime.utcnow() + timedelta(days=comms.SHARE_TTL_DAYS)
               ).strftime("%Y-%m-%d %H:%M:%S") if comms.SHARE_TTL_DAYS > 0 else None
    cur = db.execute(
        "INSERT INTO document_shares (entity_type, entity_id, token_hash, "
        "expires_at, created_by, created_at) VALUES (?,?,?,?,?,?)",
        (entity_type, entity_id, comms.hash_token(token), expires, user_id, _now()))
    db.commit()
    return cur.lastrowid, token


def _log(db, *, channel, entity_type, entity_id, recipient, subject,
         status, error=None, share_id=None, user_id=None) -> int:
    cur = db.execute(
        "INSERT INTO communications_log (channel, entity_type, entity_id, "
        "recipient, subject, status, error, share_id, sent_by, sent_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (channel, entity_type, entity_id, recipient, subject, status, error,
         share_id, user_id, _now()))
    db.commit()
    return cur.lastrowid


# ── staff endpoints ──────────────────────────────────────────────────────────

@router.get("/status")
def status(user=Depends(require_perm("communications", "view"))):
    """Whether email can actually be sent, so the UI can disable the option and
    say why instead of failing at the moment of sending."""
    return {"email": comms.email_status(), "whatsapp": {"enabled": True,
            "mode": "deep_link"}}


@router.post("/send")
def send(data: SendRequest, request: Request,
         user=Depends(require_perm("communications", "create")),
         db: sqlite3.Connection = Depends(get_db)):
    """Issue a link for one document and either email it or return a wa.me URL.

    WhatsApp does not send from the server in phase 1: the response carries a
    deep link the browser opens, so the message leaves the user's own WhatsApp
    account. The log records that as 'opened', not 'sent' — the server never
    observes delivery and must not claim it did.
    """
    cfg = _cfg(data.entity_type)
    if data.channel not in ("email", "whatsapp"):
        raise HTTPException(400, "Channel must be 'email' or 'whatsapp'.")

    doc = _load_document(db, data.entity_type, data.entity_id)
    company = _company(db)
    total = _money(doc.get("amount"), company["currency"])
    user_id = int(user["sub"])

    share_id, token = _issue_share(db, data.entity_type, data.entity_id, user_id)
    url = _share_url(request, token, doc.get("doc_number"))

    common = dict(company=company["name"] or "Your supplier",
                  doc_label=cfg["label"], doc_number=doc.get("doc_number") or "",
                  client_name=doc.get("client_name") or "Customer",
                  total=total, url=url, note=(data.note or "").strip() or None)

    if data.channel == "whatsapp":
        phone = "".join(ch for ch in (data.to or doc.get("client_phone") or "")
                        if ch.isdigit())
        if not phone:
            raise HTTPException(400, "No phone number for this client.")
        text = comms.whatsapp_text(**common)
        _log(db, channel="whatsapp", entity_type=data.entity_type,
             entity_id=data.entity_id, recipient=phone,
             subject=f"{cfg['label']} {common['doc_number']}",
             status="opened", share_id=share_id, user_id=user_id)
        from urllib.parse import quote
        return {"channel": "whatsapp", "url": url,
                "whatsapp_url": f"https://wa.me/{phone}?text={quote(text)}"}

    to = (data.to or doc.get("client_email") or "").strip()
    if not to:
        raise HTTPException(400, "No email address for this client.")
    subject = f"{cfg['label']} {common['doc_number']} from {common['company']}"
    try:
        comms.send_email(to=to, subject=subject,
                         html=comms.document_email_html(**common),
                         reply_to=company["email"] or None,
                         from_name=company["name"] or None)
    except RuntimeError as e:
        # Logged as failed, then surfaced. A send that vanishes without a trace
        # is the failure mode this log exists to prevent.
        _log(db, channel="email", entity_type=data.entity_type,
             entity_id=data.entity_id, recipient=to, subject=subject,
             status="failed", error=str(e)[:500], share_id=share_id,
             user_id=user_id)
        raise HTTPException(502, str(e))

    _log(db, channel="email", entity_type=data.entity_type,
         entity_id=data.entity_id, recipient=to, subject=subject,
         status="sent", share_id=share_id, user_id=user_id)
    return {"channel": "email", "to": to, "url": url}


@router.get("/log")
def log(entity_type: str, entity_id: int,
        user=Depends(require_perm("communications", "view")),
        db: sqlite3.Connection = Depends(get_db)):
    """Everything ever sent for one document — the answer to 'did they get it?'."""
    _cfg(entity_type)
    rows = db.execute(
        """SELECT l.*, u.username AS sent_by_name,
                  s.view_count, s.last_seen_at, s.revoked_at, s.expires_at
           FROM communications_log l
           LEFT JOIN users u ON l.sent_by = u.id
           LEFT JOIN document_shares s ON l.share_id = s.id
           WHERE l.entity_type = ? AND l.entity_id = ?
           ORDER BY l.sent_at DESC, l.id DESC""",
        (entity_type, entity_id)).fetchall()
    return [dict(r) for r in rows]


@router.get("/history")
def history(channel: str = None, status: str = None, q: str = None,
            limit: int = 100, offset: int = 0,
            user=Depends(require_perm("communications", "view")),
            db: sqlite3.Connection = Depends(get_db)):
    """Everything sent, across every document — the Communications page.

    The per-document log answers "did this invoice go out?". This answers the
    questions you cannot ask from inside one record: what failed today, what has
    never been opened, who has been sending.

    Document numbers are resolved with two LEFT JOINs rather than a per-row
    lookup, so the list stays one query regardless of length.
    """
    where, params = [], []
    if channel in ("email", "whatsapp"):
        where.append("l.channel = ?"); params.append(channel)
    if status in ("sent", "opened", "failed"):
        where.append("l.status = ?"); params.append(status)
    if q:
        where.append("(l.recipient LIKE ? OR l.subject LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    limit = max(1, min(int(limit or 100), 500))
    rows = db.execute(
        f"""SELECT l.*, u.username AS sent_by_name,
                   s.view_count, s.last_seen_at, s.revoked_at, s.expires_at,
                   i.invoice_number, qt.quote_number
            FROM communications_log l
            LEFT JOIN users u ON l.sent_by = u.id
            LEFT JOIN document_shares s ON l.share_id = s.id
            LEFT JOIN invoices   i  ON l.entity_type = 'invoice'   AND l.entity_id = i.id
            LEFT JOIN quotations qt ON l.entity_type = 'quotation' AND l.entity_id = qt.id
            {clause}
            ORDER BY l.sent_at DESC, l.id DESC
            LIMIT ? OFFSET ?""",
        (*params, limit, max(0, int(offset or 0)))).fetchall()

    total = db.execute(
        f"SELECT COUNT(*) AS n FROM communications_log l{clause}",
        tuple(params)).fetchone()["n"]

    out = []
    for r in rows:
        d = dict(r)
        d["document"] = d.pop("invoice_number", None) or d.pop("quote_number", None)
        d.pop("invoice_number", None); d.pop("quote_number", None)
        out.append(d)

    # Headline counters, computed server-side so the page is correct even when
    # the list itself is paginated.
    counts = {}
    for row in db.execute(
            "SELECT status, COUNT(*) AS n FROM communications_log GROUP BY status"
    ).fetchall():
        counts[row["status"]] = row["n"]
    # "Sent but never opened" is the number that actually prompts a follow-up.
    unopened = db.execute(
        "SELECT COUNT(*) AS n FROM communications_log l "
        "LEFT JOIN document_shares s ON l.share_id = s.id "
        "WHERE l.status IN ('sent','opened') AND COALESCE(s.view_count, 0) = 0"
    ).fetchone()["n"]

    return {"items": out, "total": total, "limit": limit,
            "offset": max(0, int(offset or 0)),
            "counts": counts, "unopened": unopened,
            "email": comms.email_status()}


@router.post("/shares/{share_id}/revoke")
def revoke(share_id: int,
           user=Depends(require_perm("communications", "edit")),
           db: sqlite3.Connection = Depends(get_db)):
    """Kill a link that was sent to the wrong person. Irreversible by design —
    issue a new one rather than un-revoking."""
    row = db.execute("SELECT id FROM document_shares WHERE id=?",
                     (share_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Link not found.")
    db.execute("UPDATE document_shares SET revoked_at=? WHERE id=? "
               "AND revoked_at IS NULL", (_now(), share_id))
    db.commit()
    return {"revoked": True}


# ── the client-facing endpoint (no auth) ─────────────────────────────────────

@router.get("/public/{token}")
def public_document(token: str, db: sqlite3.Connection = Depends(get_db)):
    """Return exactly one document to whoever holds a valid token.

    Every rejection is a flat 404 with the same body: distinguishing "expired"
    from "revoked" from "never existed" would confirm to a prober that a token
    was once real. The lookup is by HASH, so the stored value is not a usable
    credential.
    """
    NOT_FOUND = HTTPException(404, "This link is no longer available.")
    if not token or len(token) < 20:
        raise NOT_FOUND

    share = db.execute(
        "SELECT * FROM document_shares WHERE token_hash = ?",
        (comms.hash_token(token),)).fetchone()
    if not share:
        raise NOT_FOUND
    share = dict(share)
    if share.get("revoked_at"):
        raise NOT_FOUND
    if share.get("expires_at") and share["expires_at"] < _now():
        raise NOT_FOUND

    cfg = _cfg(share["entity_type"])
    doc = _load_document(db, share["entity_type"], share["entity_id"])
    company = _company(db)

    # Record the open. Best-effort: a failed counter update must not stop the
    # client seeing their invoice.
    try:
        db.execute("UPDATE document_shares SET view_count = view_count + 1, "
                   "last_seen_at = ? WHERE id = ?", (_now(), share["id"]))
        db.commit()
    except sqlite3.Error:
        pass

    payments = []
    if share["entity_type"] == "invoice":
        try:
            rows = db.execute(
                "SELECT paid_at, method, note, amount FROM invoice_payments "
                "WHERE invoice_id = ? ORDER BY id", (share["entity_id"],)).fetchall()
            payments = [dict(r) for r in rows]
        except sqlite3.Error:
            payments = []

    # An explicit allow-list, not `dict(doc)`. A SELECT * that later gains an
    # internal column (a margin, a cost, a private note) must not start leaking
    # it to the public — so the payload is enumerated by hand.
    #
    # It carries everything PRINTED on the customer's own document, because the
    # share link now renders the same layout they would receive as a PDF: line
    # discounts and tax, the totals, the payment history, and the bank details
    # they need in order to pay. Nothing here is internal — a cost, a margin or
    # another customer's data would be, and none of it is included.
    return {
        "type": share["entity_type"],
        "label": cfg["label"],
        "number": doc.get("doc_number"),
        "issued_at": (doc.get("created_at") or "")[:10],
        "created_at": doc.get("created_at"),
        "due_date": doc.get("due_date"),
        "valid_until": doc.get("valid_until"),
        "currency": company["currency"],
        "amount": doc.get("amount") or doc.get("total") or 0,
        "subtotal": doc.get("subtotal"),
        "tax_total": doc.get("tax_total"),
        "total_paid": doc.get("total_paid"),
        "remaining": doc.get("remaining"),
        "payment_status": doc.get("payment_status"),
        "notes": doc.get("notes"),
        # Name only, deliberately. The document is addressed to whoever opens
        # the link, and they already know their own phone and email — but the
        # link is a bearer URL that travels through WhatsApp and gets forwarded,
        # so carrying contact details here would turn a leaked link into a
        # contact-data leak. The "Bill To" block shows one line less than the
        # supplier's copy; that is the intended trade.
        "client": {"name": doc.get("client_name")},
        "company": company,
        "payments": payments,
        # `barcode` is here and `inventory_id` is not, deliberately. The barcode
        # is printed on the customer's own copy when the company prints it; the
        # row id behind it is internal and tells an outsider nothing they need.
        "items": [{"name": i.get("name"),
                   "quantity": i.get("quantity"),
                   "unit_price": i.get("unit_price"),
                   "discount": i.get("discount"),
                   "discount_pct": i.get("discount_pct"),
                   "tax_rate": i.get("tax_rate"),
                   "barcode": i.get("barcode")} for i in doc["items"]],
    }
