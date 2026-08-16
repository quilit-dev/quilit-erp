"""The card a chat app renders when a customer is sent a share link.

WhatsApp fetches the URL and builds a preview from the Open Graph tags in the
HTML — it runs no JavaScript, so nothing the React app renders can reach it.
That preview then appears in chat lists and on locked phones, in front of
whoever happens to be holding the handset.

So there are two properties here, and the second is the important one:

  1. The tags are in the HTML the SERVER returns, or there is no card at all.
  2. The card names the document and stops. No amount, no balance, no client
     details — those stay behind the token, which the customer has to open.
"""
import pytest

import main
from main import build_share_head, inject_share_head
from routers.communications import share_preview


PREVIEW = {"label": "Invoice", "number": "INV-2026-0029", "company": "HAJO SIGN"}


# ── what the card says ───────────────────────────────────────────────────────

def test_names_the_document_and_who_issued_it():
    head = build_share_head(PREVIEW, "https://hajosign.quilit.dev", True)

    assert 'content="Invoice INV-2026-0029 — HAJO SIGN"' in head
    assert "Tap to view your invoice." in head


def test_the_shell_title_is_replaced_not_joined():
    # Two <title> tags and a crawler taking the first one captions a customer's
    # invoice "ERP System".
    shell = "<html><head><title>ERP System</title></head><body></body></html>"
    out = inject_share_head(shell, build_share_head(PREVIEW, "https://x.dev", False))

    assert out.count("<title>") == 1
    assert "ERP System" not in out


# ── what the card must never say ─────────────────────────────────────────────

def test_the_preview_carries_no_money(as_role):
    """The structural guarantee: the amount is not in the data, so it cannot be
    in the card however the tags are later rewritten."""
    client = as_role("superadmin")
    c = client.post("/api/clients/", json={"name": "Acme Ltd"}).json()
    inv = client.post("/api/invoices/", json={
        "client_id": c["id"], "amount": 4321,
        "items": [{"name": "Signage", "quantity": 1, "unit_price": 4321}],
    }).json()
    share = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv["id"], "channel": "whatsapp",
        "to": "9613111222",
    })
    assert share.status_code == 200, share.text
    token = share.json()["url"].rstrip("/").split("/")[-1]

    import database
    with database.session() as db:
        preview = share_preview(db, token)

    assert preview is not None
    # An allow-list of three keys, asserted exactly. A future SELECT that starts
    # returning the row's amount fails here rather than on somebody's phone.
    assert set(preview) == {"label", "number", "company"}
    assert preview["number"] == inv["invoice_number"]

    head = build_share_head(preview, "https://hajosign.quilit.dev", True)
    assert "4321" not in head
    assert "Acme Ltd" not in head


def test_a_logoless_tenant_does_not_borrow_the_vendor_mark():
    # Falling back to Quilit's icon would put OUR branding in the customer's
    # chat, over their supplier's invoice.
    assert "og:image" not in build_share_head(PREVIEW, "https://x.dev", False)
    assert "og:image" in build_share_head(PREVIEW, "https://x.dev", True)


def test_the_image_is_absolute():
    # A crawler fetching the tags has no base URL to resolve "/api/..." against.
    head = build_share_head(PREVIEW, "https://hajosign.quilit.dev", True)
    assert 'content="https://hajosign.quilit.dev/api/settings/logo"' in head


# ── a bad token reveals nothing ──────────────────────────────────────────────

@pytest.mark.parametrize("token", ["", "short", "z" * 40])
def test_unknown_tokens_get_a_blank_card(token, as_role):
    as_role("superadmin")                       # ensure the schema exists
    import database
    with database.session() as db:
        assert share_preview(db, token) is None

    head = build_share_head(None, "https://x.dev", False)
    assert "Shared document" in head
    assert "og:image" not in head               # nothing, not even a logo, leaks


def test_a_revoked_link_previews_like_one_that_never_existed(as_role):
    client = as_role("superadmin")
    c = client.post("/api/clients/", json={"name": "Acme Ltd"}).json()
    inv = client.post("/api/invoices/", json={
        "client_id": c["id"], "amount": 100,
        "items": [{"name": "Sign", "quantity": 1, "unit_price": 100}],
    }).json()
    sent = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv["id"], "channel": "whatsapp",
        "to": "9613111222",
    }).json()
    token = sent["url"].rstrip("/").split("/")[-1]

    import database
    with database.session() as db:
        assert share_preview(db, token) is not None

    with database.session() as db:
        share_id = db.execute("SELECT id FROM document_shares "
                              "ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert client.post(
        f"/api/communications/shares/{share_id}/revoke").status_code == 200

    with database.session() as db:
        assert share_preview(db, token) is None


def test_previewing_does_not_count_as_the_customer_opening_it(as_role):
    # The crawler is not the customer. Letting it tick the counter reports the
    # invoice as read before anybody has looked at it.
    client = as_role("superadmin")
    c = client.post("/api/clients/", json={"name": "Acme Ltd"}).json()
    inv = client.post("/api/invoices/", json={
        "client_id": c["id"], "amount": 100,
        "items": [{"name": "Sign", "quantity": 1, "unit_price": 100}],
    }).json()
    sent = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv["id"], "channel": "whatsapp",
        "to": "9613111222",
    }).json()
    token = sent["url"].rstrip("/").split("/")[-1]

    import database
    with database.session() as db:
        before = db.execute("SELECT view_count FROM document_shares "
                            "ORDER BY id DESC LIMIT 1").fetchone()[0]
        share_preview(db, token)
        after = db.execute("SELECT view_count FROM document_shares "
                           "ORDER BY id DESC LIMIT 1").fetchone()[0]

    assert after == before


# ── end to end: what a crawler actually receives ─────────────────────────────

@pytest.mark.skipif(not main._HAS_SPA,
                    reason="no built frontend — static/ is generated, so CI has "
                           "no SPA and the share route does not exist there")
def test_the_served_html_carries_the_tags(as_role):
    """Property one, against the real route: a crawler runs no JavaScript, so
    if these are not in the response body there is no card at all."""
    client = as_role("superadmin")
    c = client.post("/api/clients/", json={"name": "Acme Ltd"}).json()
    inv = client.post("/api/invoices/", json={
        "client_id": c["id"], "amount": 4321,
        "items": [{"name": "Sign", "quantity": 1, "unit_price": 4321}],
    }).json()
    url = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv["id"], "channel": "whatsapp",
        "to": "9613111222",
    }).json()["url"]

    # Fetched WITHOUT a session, the way the crawler fetches it.
    path = "/d/" + url.split("/d/", 1)[1]
    body = client.get(path).text

    assert 'property="og:title"' in body
    assert inv["invoice_number"] in body
    assert "4321" not in body                   # still no money on the card
    assert '<div id="root">' in body            # and it is still the real app
