"""
Feature #1 — outbound email (mailer.py) + the test-email endpoint.

SMTP is mocked (no real server). Covers: OFF by default, gating, inline send,
the admin test-email endpoint, and that the SMTP password is masked on read and
never wiped by a blank submit.
"""
import smtplib

import pytest

import mailer


class _FakeSMTP:
    """Minimal stand-in for smtplib.SMTP used as a context manager."""
    sent = []

    def __init__(self, host, port, timeout=None):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self, context=None):
        pass

    def login(self, user, password):
        self.user = user

    def send_message(self, msg):
        _FakeSMTP.sent.append(
            {"to": msg["To"], "subject": msg["Subject"], "from": msg["From"]})


@pytest.fixture
def fake_smtp(monkeypatch):
    _FakeSMTP.sent = []
    monkeypatch.setattr(smtplib, "SMTP", _FakeSMTP)
    return _FakeSMTP


def _set_email(db, **overrides):
    cfg = {"email_enabled": "1", "smtp_host": "localhost", "smtp_port": "25",
           "smtp_user": "", "smtp_password": "", "smtp_use_tls": "0",
           "smtp_from": "erp@test.local"}
    cfg.update(overrides)
    for k, v in cfg.items():
        db.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                   "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    db.commit()


def test_email_off_by_default(db):
    assert mailer.is_enabled(db) is False


def test_send_when_enabled(db, fake_smtp):
    _set_email(db)
    assert mailer.is_enabled(db) is True
    res = mailer.send(db, "client@example.com", "Hello", "<p>Body</p>")
    assert res                                   # inline → {"sent": True}
    assert len(fake_smtp.sent) == 1
    assert fake_smtp.sent[0]["to"] == "client@example.com"
    assert fake_smtp.sent[0]["subject"] == "Hello"


def test_send_is_noop_when_disabled(db, fake_smtp):
    assert mailer.send(db, "x@y.com", "s", "<p>b</p>") is False
    assert fake_smtp.sent == []


def test_email_test_endpoint(make_client, db, fake_smtp):
    c = make_client("superadmin")
    assert c.post("/api/settings/email-test", json={"to": "a@b.com"}).status_code == 400
    _set_email(db)
    r = c.post("/api/settings/email-test", json={"to": "a@b.com"})
    assert r.status_code == 200, r.text
    assert any(s["to"] == "a@b.com" for s in fake_smtp.sent)


def test_email_test_surfaces_smtp_error(make_client, db, monkeypatch):
    """A failing SMTP send must return a 400 with the real reason — not a false
    'sent' (the bug: the test used to queue the send, which swallows errors)."""
    _set_email(db)

    class _BoomSMTP(_FakeSMTP):
        def send_message(self, msg):
            raise smtplib.SMTPAuthenticationError(535, b"Bad credentials")

    monkeypatch.setattr(smtplib, "SMTP", _BoomSMTP)
    r = make_client("superadmin").post("/api/settings/email-test", json={"to": "a@b.com"})
    assert r.status_code == 400, r.text
    body = r.text.lower()
    assert "failed" in body and ("535" in r.text or "credential" in body)


def test_password_masked_on_read(make_client, db):
    _set_email(db, smtp_password="secret123")
    s = make_client("superadmin").get("/api/settings/").json()
    assert s["smtp_password"] == ""          # never leaked
    assert s["smtp_password_set"] is True


def test_blank_password_does_not_wipe(make_client, db):
    _set_email(db, smtp_password="keepme")
    c = make_client("superadmin")
    r = c.put("/api/settings/", json={"smtp_password": ""})
    assert r.status_code == 200, r.text
    row = db.execute("SELECT value FROM settings WHERE key='smtp_password'").fetchone()
    assert row["value"] == "keepme"


# ── document email rendering + endpoints ─────────────────────────────────────

def test_render_invoice_and_quotation_html(db):
    import email_templates
    inv = {"invoice_number": "INV-2026-0001", "amount": 150.0, "subtotal": 150.0,
           "tax_total": 0, "total_paid": 50.0, "remaining": 100.0,
           "client_name": "Acme", "created_at": "2026-06-05 10:00:00"}
    items = [{"name": "Widget <x>", "quantity": 2, "unit_price": 75.0, "total": 150.0}]
    subj, html = email_templates.render_invoice(db, inv, items)
    assert "INV-2026-0001" in subj
    assert "Widget &lt;x&gt;" in html        # HTML-escaped
    assert "Amount due" in html

    q = {"quote_number": "QTN-2026-0001", "total": 200.0, "tax_total": 0,
         "client_name": "Acme"}
    subj, html = email_templates.render_quotation(db, q, items)
    assert "QTN-2026-0001" in subj and "Total" in html


def test_send_invoice_email_gating(make_client, db, fake_smtp):
    c = make_client("superadmin")
    # email off → 400 even before the invoice is looked up
    assert c.post("/api/invoices/99999/send-email", json={}).status_code == 400
    _set_email(db)
    # enabled but invoice missing → 404
    assert c.post("/api/invoices/99999/send-email", json={}).status_code == 404


def test_send_invoice_email_happy_path(make_client, db, fake_smtp):
    from utils import _now
    _set_email(db)
    db.execute("INSERT INTO clients (name, email, created_at) VALUES (?,?,?)",
               ("Acme", "acme@example.com", _now()))
    cid = db.execute("SELECT id FROM clients WHERE name='Acme'").fetchone()["id"]
    db.execute("INSERT INTO invoices (invoice_number, client_id, amount, subtotal, "
               "tax_total, created_at) VALUES (?,?,?,?,?,?)",
               ("INV-T-1", cid, 150, 150, 0, _now()))
    iid = db.execute("SELECT id FROM invoices WHERE invoice_number='INV-T-1'").fetchone()["id"]
    db.execute("INSERT INTO invoice_items (invoice_id, name, quantity, unit_price) "
               "VALUES (?,?,?,?)", (iid, "Widget", 2, 75))
    db.commit()

    c = make_client("superadmin")
    r = c.post(f"/api/invoices/{iid}/send-email", json={})
    assert r.status_code == 200, r.text
    assert any(s["to"] == "acme@example.com" for s in fake_smtp.sent)
    assert any("INV-T-1" in s["subject"] for s in fake_smtp.sent)
