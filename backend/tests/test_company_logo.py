"""
The company logo, which used to be one file on disk.

`static/logo.png` was a single path resolved from the running process, and that
was wrong twice over on the hosted deployment:

  * `static/` is baked into the image at build time with no volume behind it,
    so an uploaded logo was destroyed by the next deploy; and
  * one path served every tenant, so whoever uploaded last replaced every other
    customer's branding on their invoices, quotations and share links.

It now lives in the database, which makes it per-tenant for free — each customer
owns their schema — and survives redeploys.

The cross-tenant half runs ONLY on Postgres with TENANCY=schema (see
test_tenant_security.py); the rest runs everywhere.
"""
import io
import os
import pytest
from fastapi.testclient import TestClient

PNG  = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
GIF  = b"GIF8" + b"\x00" * 64


@pytest.fixture
def admin(make_client):
    """Logged in as superadmin — uploading the logo requires admin."""
    return make_client("superadmin")


def _upload(client, data, filename="logo.png"):
    return client.post(
        "/api/settings/logo",
        files={"file": (filename, io.BytesIO(data), "application/octet-stream")},
    )


# ── storage ─────────────────────────────────────────────────────────────────

def test_uploaded_logo_comes_back(admin):
    assert _upload(admin, PNG).status_code == 200

    r = admin.get("/api/settings/logo")
    assert r.status_code == 200
    assert r.content == PNG


def test_logo_is_not_written_to_the_filesystem(admin):
    """The bug this pins: a file under static/ is ephemeral on the hosted
    deployment and shared by every tenant. Uploading must not create one."""
    from routers.settings import _logo_path
    legacy = _logo_path()
    existed = os.path.exists(legacy)

    assert _upload(admin, PNG).status_code == 200

    if not existed:
        assert not os.path.exists(legacy), (
            "the logo was written to disk — it will be lost on the next deploy "
            "and shared with every other tenant")


def test_replacing_the_logo_keeps_exactly_one(admin, db):
    _upload(admin, PNG)
    _upload(admin, JPEG)

    r = admin.get("/api/settings/logo")
    assert r.content == JPEG

    row = db.execute(
        "SELECT COUNT(*) AS n FROM company_logo").fetchone()
    assert row["n"] == 1, "the single-row constraint should hold"


def test_content_type_follows_the_bytes(admin):
    """The file was always served as image/png whatever it really was."""
    _upload(admin, JPEG, filename="brand.jpg")
    assert admin.get("/api/settings/logo").headers["content-type"] \
        .startswith("image/jpeg")

    _upload(admin, GIF, filename="brand.gif")
    assert admin.get("/api/settings/logo").headers["content-type"] \
        .startswith("image/gif")


def test_logo_is_never_cached_across_workspaces(admin):
    """Two tenants answer the same URL with different bytes, so a shared cache
    reusing one response would show a customer someone else's branding."""
    _upload(admin, PNG)
    cc = admin.get("/api/settings/logo").headers.get("cache-control", "")
    assert "no-store" in cc.lower(), cc


# ── validation, unchanged behaviour ─────────────────────────────────────────

def test_non_image_is_refused(admin):
    assert _upload(admin, b"#!/bin/sh\nrm -rf /", "evil.png").status_code == 400


def test_oversized_upload_is_refused(admin):
    from routers.settings import MAX_LOGO_SIZE
    assert _upload(admin, PNG + b"\x00" * MAX_LOGO_SIZE).status_code == 413


def test_missing_logo_is_404_not_500(client):
    r = client.get("/api/settings/logo")
    assert r.status_code in (200, 404)      # 200 only if a legacy file exists


def test_reading_the_logo_needs_no_session(app, admin):
    """The login screen and the customer's share link both show it before
    anyone has a session."""
    _upload(admin, PNG)
    anon = TestClient(app)
    assert anon.get("/api/settings/logo").status_code == 200


def test_uploading_requires_admin(client):
    assert _upload(client, PNG).status_code in (401, 403)
