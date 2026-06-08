"""
Feature #1 — the scheduler's first periodic task: overdue-invoice reminders.

Tests the task directly (the scheduler loop is a thin wrapper). SMTP is mocked.
"""
import smtplib
import uuid
from datetime import datetime, timedelta

import pytest

import scheduled_tasks
from utils import _now


class _FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout=None):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self, context=None):
        pass

    def login(self, u, p):
        pass

    def send_message(self, msg):
        _FakeSMTP.sent.append({"to": msg["To"], "subject": msg["Subject"]})


@pytest.fixture
def fake_smtp(monkeypatch):
    _FakeSMTP.sent = []
    monkeypatch.setattr(smtplib, "SMTP", _FakeSMTP)
    return _FakeSMTP


def _enable_email(db):
    for k, v in {"email_enabled": "1", "smtp_host": "localhost", "smtp_port": "25",
                 "smtp_use_tls": "0", "smtp_from": "erp@test.local"}.items():
        db.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                   "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    db.commit()


def _mk_invoice(db, due_date, amount=100, paid=0, email="c@x.com"):
    db.execute("INSERT INTO clients (name, email, created_at) VALUES (?,?,?)",
               ("Client", email, _now()))
    cid = db.execute("SELECT id FROM clients ORDER BY id DESC LIMIT 1").fetchone()["id"]
    num = "INV-" + uuid.uuid4().hex[:8]
    db.execute("INSERT INTO invoices (invoice_number, client_id, amount, subtotal, "
               "tax_total, due_date, created_at) VALUES (?,?,?,?,?,?,?)",
               (num, cid, amount, amount, 0, due_date, _now()))
    iid = db.execute("SELECT id FROM invoices ORDER BY id DESC LIMIT 1").fetchone()["id"]
    if paid:
        db.execute("INSERT INTO invoice_payments (invoice_id, amount, method, paid_at) "
                   "VALUES (?,?,?,?)", (iid, paid, "Cash", _now()))
    db.commit()
    return iid


def _days_ago(n):
    return (datetime.utcnow() - timedelta(days=n)).strftime("%Y-%m-%d")


def _days_ahead(n):
    return (datetime.utcnow() + timedelta(days=n)).strftime("%Y-%m-%d")


def test_overdue_reminder_sent_then_deduped(db, fake_smtp):
    _enable_email(db)
    _mk_invoice(db, due_date=_days_ago(5), amount=100, paid=0, email="late@x.com")
    assert scheduled_tasks.send_overdue_invoice_reminders(db) == 1
    assert any(s["to"] == "late@x.com" for s in fake_smtp.sent)
    # Idempotent: a second sweep within the window sends nothing more.
    _FakeSMTP.sent.clear()
    assert scheduled_tasks.send_overdue_invoice_reminders(db) == 0
    assert fake_smtp.sent == []


def test_paid_and_not_yet_due_are_skipped(db, fake_smtp):
    _enable_email(db)
    _mk_invoice(db, due_date=_days_ahead(10), amount=100, paid=0,  email="future@x.com")
    _mk_invoice(db, due_date=_days_ago(5),    amount=100, paid=100, email="paid@x.com")
    assert scheduled_tasks.send_overdue_invoice_reminders(db) == 0
    assert fake_smtp.sent == []


def test_noop_when_email_disabled(db, fake_smtp):
    _mk_invoice(db, due_date=_days_ago(5), email="x@x.com")   # email NOT enabled
    assert scheduled_tasks.send_overdue_invoice_reminders(db) == 0
    assert fake_smtp.sent == []
