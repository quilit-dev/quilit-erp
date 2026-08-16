"""
Client communications — share links, email, WhatsApp, and the sent-log.

The share link is the only unauthenticated route in the app that returns
business data, so most of what is pinned here is about what it refuses and what
it does not disclose.
"""
import pytest

import communications as comms


@pytest.fixture
def client(as_role):
    """Authenticated as superadmin — the sender is always a staff user."""
    return as_role("superadmin")


@pytest.fixture
def invoice(client):
    """A client with contact details plus one invoice to send."""
    c = client.post("/api/clients/", json={
        "name": "Acme Ltd", "email": "ap@acme.test", "phone": "+961 71 234567"}).json()
    inv = client.post("/api/invoices/", json={
        "client_id": c["id"], "amount": 1500, "due_date": "2026-09-01",
        "items": [{"name": "Consulting", "quantity": 10, "unit_price": 150}],
    }).json()
    return inv


def _send_whatsapp(client, inv, **kw):
    body = {"entity_type": "invoice", "entity_id": inv["id"], "channel": "whatsapp"}
    body.update(kw)
    return client.post("/api/communications/send", json=body)


def _token_of(resp) -> str:
    return resp.json()["url"].rsplit("/", 1)[-1]


# ── tokens ───────────────────────────────────────────────────────────────────

def test_only_the_token_hash_is_stored(client, invoice, db):
    """A database dump must not yield working links. Same reasoning as password
    hashes: the stored value is a verifier, not a credential."""
    token = _token_of(_send_whatsapp(client, invoice))
    rows = db.execute("SELECT token_hash FROM document_shares").fetchall()
    stored = [r[0] for r in rows]
    assert token not in stored
    assert comms.hash_token(token) in stored


def test_each_send_mints_a_new_token(client, invoice):
    """Re-sending after a correction must not reuse a link the client may have
    forwarded, and revoking one send must not break another."""
    a = _token_of(_send_whatsapp(client, invoice))
    b = _token_of(_send_whatsapp(client, invoice))
    assert a != b


# ── the public endpoint ──────────────────────────────────────────────────────

def test_valid_token_returns_the_document(client, invoice):
    token = _token_of(_send_whatsapp(client, invoice))
    r = client.get(f"/api/communications/public/{token}")
    assert r.status_code == 200
    d = r.json()
    assert d["number"] == invoice["invoice_number"]
    assert d["amount"] == 1500
    assert len(d["items"]) == 1


def test_public_payload_withholds_client_contact_details(client, invoice):
    """The recipient already knows their own address; exposing it here would
    turn a leaked link into a contact-data leak. The endpoint enumerates its
    payload by hand precisely so a later SELECT * cannot widen it."""
    token = _token_of(_send_whatsapp(client, invoice))
    d = client.get(f"/api/communications/public/{token}").json()
    assert set(d["client"].keys()) == {"name"}
    blob = str(d)
    assert "ap@acme.test" not in blob
    assert "71234567" not in blob.replace(" ", "")


def test_the_line_barcode_travels_but_the_row_id_does_not(client, db):
    """A barcode is printed on the customer's own copy, so it belongs here.

    The inventory row id used to resolve it does NOT: it is an internal handle,
    and the allow-list exists to stop exactly that kind of field riding along
    with something legitimate.
    """
    item = client.post("/api/inventory/", json={
        "name": "Flex Roll 320cm", "barcode": "1000387",
        "unit_cost": 50, "sale_price": 120}).json()
    cust = client.post("/api/clients/", json={
        "name": "Acme Ltd", "phone": "+961 71 234567"}).json()
    inv = client.post("/api/invoices/", json={
        "client_id": cust["id"], "amount": 120,
        "items": [{"name": "Flex Roll 320cm", "quantity": 1, "unit_price": 120,
                   "inventory_id": item["id"]}],
    }).json()

    token = _token_of(_send_whatsapp(client, inv))
    line = client.get(f"/api/communications/public/{token}").json()["items"][0]

    assert line["barcode"] == "1000387"
    assert "inventory_id" not in line


def test_a_hand_typed_line_carries_no_barcode(client, invoice):
    """Not another product's. A line with no stock link must resolve to null —
    a wrong code on a document is worse than none, because it scans."""
    token = _token_of(_send_whatsapp(client, invoice))
    line = client.get(f"/api/communications/public/{token}").json()["items"][0]

    assert line["barcode"] is None


@pytest.mark.parametrize("bad", [
    "short",
    "x" * 43,
    "../../etc/passwd",
    "' OR 1=1 --",
])
def test_bad_tokens_are_refused(client, invoice, bad):
    assert client.get(f"/api/communications/public/{bad}").status_code == 404


def test_a_one_character_change_invalidates_a_token(client, invoice):
    token = _token_of(_send_whatsapp(client, invoice))
    flipped = token[:-1] + ("A" if token[-1] != "A" else "B")
    assert client.get(f"/api/communications/public/{flipped}").status_code == 404


def test_revoked_link_stops_working(client, invoice):
    r = _send_whatsapp(client, invoice)
    token = _token_of(r)
    assert client.get(f"/api/communications/public/{token}").status_code == 200

    share_id = client.get(
        "/api/communications/log?entity_type=invoice&entity_id=%d" % invoice["id"]
    ).json()[0]["share_id"]
    assert client.post(f"/api/communications/shares/{share_id}/revoke").status_code == 200
    assert client.get(f"/api/communications/public/{token}").status_code == 404


def test_expired_link_stops_working(client, invoice, db):
    token = _token_of(_send_whatsapp(client, invoice))
    db.execute("UPDATE document_shares SET expires_at = ?",
                    ("2000-01-01 00:00:00",))
    db.commit()
    assert client.get(f"/api/communications/public/{token}").status_code == 404


def test_every_rejection_looks_identical(client, invoice, db):
    """Distinguishing expired from revoked from never-existed would confirm to a
    prober that a token was once real."""
    live = _token_of(_send_whatsapp(client, invoice))
    db.execute("UPDATE document_shares SET revoked_at = ?", ("2026-01-01 00:00:00",))
    db.commit()

    bodies = {
        client.get(f"/api/communications/public/{live}").text,
        client.get("/api/communications/public/%s" % ("z" * 43)).text,
    }
    assert len(bodies) == 1


def test_opening_the_link_is_counted(client, invoice):
    """The closest thing to a read receipt, and the only delivery signal that is
    actually observable."""
    token = _token_of(_send_whatsapp(client, invoice))
    for _ in range(3):
        client.get(f"/api/communications/public/{token}")
    row = client.get(
        "/api/communications/log?entity_type=invoice&entity_id=%d" % invoice["id"]
    ).json()[0]
    assert row["view_count"] == 3


# ── channels ─────────────────────────────────────────────────────────────────

def test_whatsapp_returns_a_deep_link_with_a_normalised_number(client, invoice):
    r = _send_whatsapp(client, invoice)
    assert r.status_code == 200
    url = r.json()["whatsapp_url"]
    # "+961 71 234567" -> digits only, which is what wa.me requires.
    assert url.startswith("https://wa.me/96171234567?text=")


def test_whatsapp_is_logged_as_opened_not_sent(client, invoice):
    """The server hands the browser a deep link; the message leaves the user's
    own WhatsApp. Recording 'sent' would claim a delivery nothing here saw."""
    _send_whatsapp(client, invoice)
    row = client.get(
        "/api/communications/log?entity_type=invoice&entity_id=%d" % invoice["id"]
    ).json()[0]
    assert row["channel"] == "whatsapp"
    assert row["status"] == "opened"


def test_whatsapp_without_a_number_is_refused(client):
    c = client.post("/api/clients/", json={"name": "No Phone Co"}).json()
    inv = client.post("/api/invoices/", json={"client_id": c["id"], "amount": 10}).json()
    r = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv["id"], "channel": "whatsapp"})
    assert r.status_code == 400


def test_unconfigured_email_fails_loudly_and_is_logged(client, invoice, monkeypatch):
    """A send that vanishes without a trace is indistinguishable from never
    having tried — which is the thing the log exists to prevent."""
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("MAIL_FROM", raising=False)
    r = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": invoice["id"], "channel": "email"})
    assert r.status_code == 502

    row = client.get(
        "/api/communications/log?entity_type=invoice&entity_id=%d" % invoice["id"]
    ).json()[0]
    assert row["channel"] == "email"
    assert row["status"] == "failed"
    assert row["error"]


def test_email_sends_through_the_provider(client, invoice, monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "test-key")
    monkeypatch.setenv("MAIL_FROM", "noreply@quilit.test")
    captured = {}

    def fake_send(**kw):
        captured.update(kw)

    monkeypatch.setattr(
        "routers.communications.comms.send_email",
        lambda **kw: fake_send(**kw))

    r = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": invoice["id"], "channel": "email",
        "note": "Thanks for your order."})
    assert r.status_code == 200, r.text
    assert captured["to"] == "ap@acme.test"
    assert invoice["invoice_number"] in captured["subject"]
    # The body must carry the LINK, since there is no PDF to attach.
    assert "/d/" in captured["html"]
    assert "Thanks for your order." in captured["html"]

    row = client.get(
        "/api/communications/log?entity_type=invoice&entity_id=%d" % invoice["id"]
    ).json()[0]
    assert row["status"] == "sent"


def test_api_key_never_reaches_the_client(client, invoice, monkeypatch):
    """A provider failure must not echo credentials into an HTTP response."""
    monkeypatch.setenv("RESEND_API_KEY", "super-secret-key")
    monkeypatch.setenv("MAIL_FROM", "noreply@quilit.test")

    def boom(**kw):
        raise RuntimeError("Email provider rejected the message (401). unauthorized")

    monkeypatch.setattr("routers.communications.comms.send_email", boom)
    r = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": invoice["id"], "channel": "email"})
    assert r.status_code == 502
    assert "super-secret-key" not in r.text


# ── input validation ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("entity_type", ["invoices", "users", "clients; DROP TABLE users"])
def test_unknown_entity_type_is_refused(client, entity_type):
    """entity_type selects a TABLE NAME by interpolation, so it must only ever
    come from the registry — never from the request."""
    r = client.post("/api/communications/send", json={
        "entity_type": entity_type, "entity_id": 1, "channel": "whatsapp"})
    assert r.status_code == 400


def test_bad_channel_is_refused(client, invoice):
    r = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": invoice["id"], "channel": "carrier-pigeon"})
    assert r.status_code == 400


def test_sending_a_missing_document_is_404(client):
    r = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": 999999, "channel": "whatsapp"})
    assert r.status_code == 404


# ── authorization ────────────────────────────────────────────────────────────

def test_sending_requires_authentication(make_client, invoice):
    """The staff endpoints are not public — only the share link is."""
    anon = make_client()
    r = anon.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": invoice["id"], "channel": "whatsapp"})
    assert r.status_code in (401, 403)
    assert anon.get("/api/communications/status").status_code in (401, 403)


def test_a_role_without_the_module_cannot_send(as_role, invoice):
    """`communications` is its own permission surface, so a role can be allowed
    to see invoices without being allowed to mail them to customers. Inventory
    staff have no business emailing a client's bill."""
    c = as_role("Inventory")
    r = c.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": invoice["id"], "channel": "whatsapp"})
    assert r.status_code == 403, r.text


# ── link readability ────────────────────────────────────────────────────────
#
# A share link is read by a CLIENT deciding whether to click. A bare 43-char
# random string is the shape of a phishing URL, and an invoice nobody opens has
# not been delivered — so these pin the readability properties as behaviour, not
# cosmetics.

def test_share_url_names_the_document(make_client):
    """The document number goes in the path so the recipient can see what the
    link is before trusting it."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme", "phone": "+96171234567"}).json()
    inv = c.post("/api/invoices/", json={"client_id": cl["id"], "amount": 100}).json()
    r = c.post("/api/communications/send",
               json={"entity_type": "invoice", "entity_id": inv["id"],
                     "channel": "whatsapp"}).json()

    path = r["url"].split("testserver")[-1]
    parts = path.strip("/").split("/")
    assert parts[0] == "d"
    assert len(parts) == 3, f"expected /d/<slug>/<token>, got {path}"
    assert parts[1].startswith("inv-"), f"slug does not name the invoice: {parts[1]}"


def test_share_token_stays_short_enough_to_trust(make_client):
    """128 bits, 22 characters. Longer buys no security on an expiring,
    revocable, single-document link and costs trust in the URL."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme", "phone": "+96171234567"}).json()
    inv = c.post("/api/invoices/", json={"client_id": cl["id"], "amount": 100}).json()
    r = c.post("/api/communications/send",
               json={"entity_type": "invoice", "entity_id": inv["id"],
                     "channel": "whatsapp"}).json()
    token = r["url"].rstrip("/").split("/")[-1]
    assert 20 <= len(token) <= 24, f"token is {len(token)} chars: {token}"


def test_token_alone_still_opens_the_document(make_client):
    """The slug is cosmetic. Links already sent to clients are /d/<token> with
    no slug, and the API only ever receives the token — so an old link must
    resolve through exactly the same path. A dead invoice link is a support
    call, forever."""
    c = make_client("superadmin")
    cl = c.post("/api/clients/", json={"name": "Acme", "phone": "+96171234567"}).json()
    inv = c.post("/api/invoices/", json={"client_id": cl["id"], "amount": 100}).json()
    r = c.post("/api/communications/send",
               json={"entity_type": "invoice", "entity_id": inv["id"],
                     "channel": "whatsapp"}).json()
    token = r["url"].rstrip("/").split("/")[-1]

    anon = make_client()
    assert anon.get(f"/api/communications/public/{token}").status_code == 200


def test_url_slug_is_safe():
    """The slug is interpolated into a URL, so it must never carry a path
    separator or anything that could change where the link points."""
    from routers.communications import _url_slug
    assert _url_slug("INV-2026-0042") == "inv-2026-0042"
    assert "/" not in _url_slug("INV/2026/0042")
    assert "?" not in _url_slug("INV?2026")
    assert ".." not in _url_slug("../../etc/passwd")
    assert _url_slug(None) == ""
    assert _url_slug("") == ""
    assert len(_url_slug("X" * 200)) <= 40


def test_whatsapp_message_introduces_the_link():
    """The URL must not sit alone on a line. A recipient judges a link by the
    sentence next to it."""
    import communications as comms
    text = comms.whatsapp_text(
        company="Quilit Demo Co", doc_label="Invoice", doc_number="INV-1",
        client_name="Acme", total="USD 100.00",
        url="https://demo.quilit.dev/d/inv-1/abc")
    assert "INV-1" in text
    assert "Quilit Demo Co" in text
    assert "USD 100.00" in text
    lines = [l for l in text.splitlines() if l.strip()]
    idx = next(i for i, l in enumerate(lines) if l.startswith("https://"))
    assert idx > 0 and lines[idx - 1].strip(), "the link has no introducing line"
