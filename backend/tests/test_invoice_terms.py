"""Custom invoice terms & conditions.

Free text the owner types once in Settings and that then prints at the foot of
every invoice — the PDF and the customer's share link alike, because both render
the same shared template.
"""
import uuid

import pytest


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


TERMS = "Payment due within 30 days.\nGoods remain our property until paid."


def test_the_setting_round_trips(client):
    r = client.put("/api/settings/", json={"invoice_terms": TERMS})
    assert r.status_code == 200, r.text

    assert client.get("/api/settings/").json()["invoice_terms"] == TERMS


def test_it_survives_the_line_breaks(client):
    """Terms are a short list; the breaks are part of what was written."""
    client.put("/api/settings/", json={"invoice_terms": TERMS})

    assert "\n" in client.get("/api/settings/").json()["invoice_terms"]


def test_the_customer_copy_carries_them(client):
    """The share link renders the same template as the printed invoice, so a
    field missing from its payload shows up as a blank region on the customer's
    document rather than an error."""
    client.put("/api/settings/", json={"invoice_terms": TERMS})
    cid = client.post("/api/clients/", json={"name": "Terms Co"}).json()["id"]
    created = client.post("/api/invoices/", json={
        "client_id": cid, "amount": 0,
        "items": [{"name": "Widget", "quantity": 1, "unit_price": 100}]}).json()
    inv = created.get("invoice_id") or created.get("id")

    send = client.post("/api/communications/send", json={
        "entity_type": "invoice", "entity_id": inv,
        "channel": "whatsapp", "to": "96171234567"})
    assert send.status_code == 200, send.text
    token = send.json()["url"].rsplit("/", 1)[-1]

    body = client.get(f"/api/communications/public/{token}").json()

    assert body["company"]["invoice_terms"] == TERMS


def test_an_unknown_setting_is_still_refused(client):
    """The model forbids extra fields on purpose — adding one key must not have
    opened the door to any key."""
    r = client.put("/api/settings/", json={"enabled_modules": "everything"})

    assert r.status_code == 422
