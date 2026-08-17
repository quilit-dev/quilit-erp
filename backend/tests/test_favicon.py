"""The browser tab's icon.

`/api/settings/favicon` exists separately from `/api/settings/logo` because the
two have opposite obligations. `/logo` MUST 404 when there is none — callers use
that to decide whether to draw one at all. A favicon must ALWAYS return an
image: a `<link rel="icon">` pointing at a 404 leaves the tab on the browser's
default globe, which is the bug this replaced.

The first implementation probed `/logo` from JavaScript and rewrote the tag.
That failed in a real browser — Chrome reads the icon while parsing the head and
does not reliably repaint afterwards, so the DOM changed and the tab did not.
Answering on the server means the tag is static and needs no script.
"""
import struct
import zlib

import pytest


def _png(w=8, h=8, rgb=(240, 113, 0)) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


@pytest.fixture
def client(as_role):
    return as_role("superadmin")


def test_it_answers_with_an_image_when_no_logo_is_uploaded(client):
    # The whole point: this must not 404 the way /logo does.
    logo = client.get("/api/settings/logo")
    assert logo.status_code == 404, "fixture already has a logo — test is void"

    r = client.get("/api/settings/favicon")

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/")
    assert len(r.content) > 0


def test_it_is_the_tenants_logo_once_they_upload_one(client):
    data = _png()
    up = client.post("/api/settings/logo",
                     files={"file": ("logo.png", data, "image/png")})
    assert up.status_code == 200, up.text

    r = client.get("/api/settings/favicon")

    assert r.status_code == 200
    assert r.content == data, "the tab must show the tenant's own logo"


def test_it_needs_no_session(client):
    # The tab has an icon on the login screen and on the page a customer opens
    # from a share link, neither of which has a session.
    client.post("/api/settings/logo",
                files={"file": ("logo.png", _png(), "image/png")})
    from fastapi.testclient import TestClient
    import main

    with TestClient(main.app) as anon:
        assert anon.get("/api/settings/favicon").status_code == 200


def test_a_new_logo_is_not_served_from_cache(client):
    # Browsers cache favicons hard. Without revalidation a tenant who uploads a
    # new logo keeps seeing the old tab icon indefinitely.
    r = client.get("/api/settings/favicon")
    cache = r.headers.get("cache-control", "")

    assert "no-cache" in cache or "no-store" in cache
    # ...and never in a shared cache, which would hand one tenant's icon to
    # another on a different host.
    assert "public" not in cache
