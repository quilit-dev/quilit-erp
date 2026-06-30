"""Backend-generated notifications re-render in the viewer's language.

The row stores English title/body + a msg_key + JSON params; the list endpoint
localizes when ?lang=ar is sent, and falls back to the stored English otherwise.
"""
import json

from notif_messages import localize
from utils import _now


def _insert(db, *, title, body, msg_key, params):
    db.execute(
        """INSERT INTO notifications
               (user_id, type, title, body, link, is_read, created_at, msg_key, params)
           VALUES (NULL, ?, ?, ?, '/x', 0, ?, ?, ?)""",
        ("invoice_paid", title, body, _now(), msg_key,
         json.dumps(params, ensure_ascii=False)),
    )
    db.commit()


# ── Unit: the pure renderer ──────────────────────────────────────────────────
def test_localize_renders_arabic_from_key_and_params():
    row = {"title": "Invoice INV-1 fully paid",
           "body": "Acme — $100.00 received via Cash",
           "msg_key": "invoice_paid",
           "params": json.dumps({"number": "INV-1", "client": "Acme",
                                 "amount": 100.0, "method": "Cash"})}
    title, body = localize(row, "ar")
    assert "INV-1" in title and "Acme" in body
    assert "$100.00" in body                    # format spec preserved
    assert any("؀" <= ch <= "ۿ" for ch in title)   # contains Arabic


def test_localize_falls_back_to_stored_english():
    row = {"title": "Stored EN", "body": "Body EN", "msg_key": "invoice_paid",
           "params": json.dumps({})}            # missing params → fall back
    assert localize(row, "ar") == ("Stored EN", "Body EN")
    # Unknown language and unknown key both keep the stored text.
    assert localize(row, "fr") == ("Stored EN", "Body EN")
    assert localize({"title": "T", "body": "B", "msg_key": "nope", "params": "{}"},
                    "ar") == ("T", "B")
    # No lang → English unchanged.
    assert localize(row, None) == ("Stored EN", "Body EN")


# ── Endpoint: ?lang threads through to the response ───────────────────────────
def test_list_endpoint_localizes_when_lang_ar(make_client, db):
    _insert(db, title="Invoice INV-9 fully paid",
            body="Acme — $250.00 received via Bank",
            msg_key="invoice_paid",
            params={"number": "INV-9", "client": "Acme", "amount": 250.0, "method": "Bank"})

    c = make_client("superadmin")

    en = c.get("/api/notifications/").json()["notifications"]
    assert any(n["title"] == "Invoice INV-9 fully paid" for n in en)

    ar = c.get("/api/notifications/?lang=ar").json()["notifications"]
    row = next(n for n in ar if n.get("msg_key") == "invoice_paid")
    assert "INV-9" in row["title"]
    assert any("؀" <= ch <= "ۿ" for ch in row["title"])
    assert "$250.00" in row["body"]
