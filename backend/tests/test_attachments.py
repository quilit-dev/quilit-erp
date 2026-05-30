"""
Generic attachments — upload / list / download / delete across entities, with
RBAC tied to the host module and a content-type allowlist.
"""
import pytest

PDF_BYTES = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"


def _make_client_row(c, name="Acme Co"):
    r = c.post("/api/clients/", json={"name": name, "type": "Company"})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _upload(c, entity_type, entity_id, filename, content, ctype):
    return c.post(f"/api/attachments/{entity_type}/{entity_id}",
                  files={"file": (filename, content, ctype)})


def test_upload_list_download_delete_roundtrip(make_client, db):
    c = make_client("superadmin")
    cid = _make_client_row(c)

    up = _upload(c, "clients", cid, "contract.pdf", PDF_BYTES, "application/pdf")
    assert up.status_code in (200, 201), up.text
    att_id = up.json()["id"]
    assert up.json()["content_type"] == "application/pdf"

    lst = c.get(f"/api/attachments/clients/{cid}")
    assert lst.status_code == 200
    assert len(lst.json()) == 1
    assert lst.json()[0]["filename"] == "contract.pdf"
    assert lst.json()[0]["uploaded_by_name"]            # captured
    assert "data" not in lst.json()[0]                  # metadata only — no BLOB

    dl = c.get(f"/api/attachments/file/{att_id}")
    assert dl.status_code == 200
    assert dl.content == PDF_BYTES
    assert dl.headers["content-disposition"].startswith("inline")
    assert dl.headers["x-content-type-options"] == "nosniff"

    dele = c.delete(f"/api/attachments/file/{att_id}")
    assert dele.status_code == 200
    assert c.get(f"/api/attachments/clients/{cid}").json() == []


def test_office_file_resolves_by_extension_when_ctype_generic(make_client):
    c = make_client("superadmin")
    cid = _make_client_row(c)
    # Browsers often send octet-stream for .xlsx — we resolve from the name.
    up = _upload(c, "clients", cid, "budget.xlsx", b"PK\x03\x04zip", "application/octet-stream")
    assert up.status_code in (200, 201), up.text
    assert up.json()["content_type"] == \
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def test_non_inline_type_forced_to_attachment(make_client):
    c = make_client("superadmin")
    cid = _make_client_row(c)
    up = _upload(c, "clients", cid, "data.csv", b"a,b,c\n1,2,3", "text/csv")
    assert up.status_code in (200, 201), up.text
    dl = c.get(f"/api/attachments/file/{up.json()['id']}")
    assert dl.headers["content-disposition"].startswith("attachment")


def test_pdf_inline_can_be_forced_to_download(make_client):
    c = make_client("superadmin")
    cid = _make_client_row(c)
    up = _upload(c, "clients", cid, "c.pdf", PDF_BYTES, "application/pdf")
    dl = c.get(f"/api/attachments/file/{up.json()['id']}?download=true")
    assert dl.headers["content-disposition"].startswith("attachment")


def test_disallowed_type_rejected(make_client):
    c = make_client("superadmin")
    cid = _make_client_row(c)
    up = _upload(c, "clients", cid, "evil.html", b"<script>alert(1)</script>", "text/html")
    assert up.status_code == 400
    assert "Unsupported file type" in up.text


def test_empty_file_rejected(make_client):
    c = make_client("superadmin")
    cid = _make_client_row(c)
    up = _upload(c, "clients", cid, "empty.pdf", b"", "application/pdf")
    assert up.status_code == 400


def test_unknown_entity_type_404(make_client):
    c = make_client("superadmin")
    up = _upload(c, "users", 1, "x.pdf", PDF_BYTES, "application/pdf")
    assert up.status_code == 404
    assert "not supported" in up.text


def test_missing_host_record_404(make_client):
    c = make_client("superadmin")
    up = _upload(c, "clients", 999999, "x.pdf", PDF_BYTES, "application/pdf")
    assert up.status_code == 404


def test_rbac_view_can_list_but_not_upload(make_client):
    """The Viewer role has read-only access: it can list attachments but an
    upload (requires the module's `edit`) is rejected with 403."""
    admin = make_client("superadmin")
    cid = _make_client_row(admin)
    admin.post(f"/api/attachments/clients/{cid}",
               files={"file": ("c.pdf", PDF_BYTES, "application/pdf")})

    viewer = make_client("Viewer")
    assert viewer.get(f"/api/attachments/clients/{cid}").status_code == 200
    up = viewer.post(f"/api/attachments/clients/{cid}",
                     files={"file": ("v.pdf", PDF_BYTES, "application/pdf")})
    assert up.status_code == 403


def test_attaches_to_supplier_too(make_client):
    """The same generic endpoint serves any registered entity (suppliers here)."""
    c = make_client("superadmin")
    s = c.post("/api/suppliers/", json={"name": "Bolt Supply Co"})
    assert s.status_code in (200, 201), s.text
    up = _upload(c, "suppliers", s.json()["id"], "terms.pdf", PDF_BYTES, "application/pdf")
    assert up.status_code in (200, 201), up.text
    assert len(c.get(f"/api/attachments/suppliers/{s.json()['id']}").json()) == 1
