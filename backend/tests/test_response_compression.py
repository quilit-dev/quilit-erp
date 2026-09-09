"""API responses are compressed on the way out.

Railway runs gunicorn directly. Caddy's `encode gzip zstd` exists only in the
compose stack, so on the hosted product every JSON payload -- report tables,
list endpoints, the dashboard -- went over the wire uncompressed. That is the
cheapest latency win available and it needed one line.

The threshold is doing a second job worth keeping. Small bodies gain nothing
from gzip, and leaving them alone also keeps the few responses that carry a
secret (a freshly issued device token, a share link) out of the compressor.
BREACH needs a secret and attacker-influenced text compressed together; this
app has no CSRF token in any body and authenticates by HttpOnly cookie, so the
exposure was already slight, and the threshold closes the remainder.
"""
import json
import uuid

import pytest

pytestmark = pytest.mark.critical

GZIP = {"Accept-Encoding": "gzip"}


def test_a_large_json_response_is_compressed(make_client):
    c = make_client("superadmin")
    # Enough rows that the list comfortably clears the 1000-byte threshold.
    for _ in range(40):
        r = c.post("/api/clients/", json={"name": "Compressible Co %s"
                                          % uuid.uuid4().hex[:8]})
        assert r.status_code in (200, 201), r.text

    r = c.get("/api/clients/", headers=GZIP)
    assert r.status_code == 200
    body = r.content
    assert len(json.dumps(r.json())) > 1000, "setup: the payload must be big"
    assert r.headers.get("content-encoding") == "gzip", (
        "a large JSON response went out uncompressed. On Railway nothing else "
        "compresses it -- Caddy is only in the compose stack.")
    assert len(body) < len(json.dumps(r.json())), "compressed but not smaller"


def test_a_small_response_is_left_alone(make_client):
    """Below the threshold gzip costs more than it saves --- and this is what
    keeps token-bearing replies out of the compressor."""
    c = make_client()
    r = c.get("/api/health", headers=GZIP)
    assert r.status_code == 200
    assert r.headers.get("content-encoding") is None


def test_a_freshly_issued_device_token_is_not_compressed(make_client):
    """The one response that carries a write-capable secret."""
    c = make_client("superadmin")
    r = c.post("/api/hr/timeclock/devices", json={"name": "Front door"},
               headers=GZIP)
    assert r.status_code in (200, 201), r.text
    assert r.json().get("token"), "setup: this is the reply that carries it"
    assert r.headers.get("content-encoding") is None, (
        "the token reply was compressed. It is well under the threshold, so "
        "if this fires the threshold has been lowered -- reconsider before "
        "compressing bodies that contain a secret.")


def test_compression_does_not_cost_the_security_headers(make_client):
    """GZip is added INSIDE SecurityHeadersMiddleware, so a compressed
    response must still carry them."""
    c = make_client("superadmin")
    for _ in range(40):
        c.post("/api/clients/", json={"name": "Hdr Co %s" % uuid.uuid4().hex[:8]})

    r = c.get("/api/clients/", headers=GZIP)
    assert r.headers.get("content-encoding") == "gzip", "setup: it compressed"
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers.get("x-frame-options") == "DENY"


def test_a_client_that_does_not_ask_for_gzip_gets_plain_json(make_client):
    c = make_client("superadmin")
    for _ in range(40):
        c.post("/api/clients/", json={"name": "Plain Co %s" % uuid.uuid4().hex[:8]})

    r = c.get("/api/clients/", headers={"Accept-Encoding": "identity"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") is None
    assert r.json(), "and it is still readable"
