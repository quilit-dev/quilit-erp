"""
Phase 3 — attachment object storage (STORAGE=s3).

Runs in the normal suite (SQLite). The default STORAGE=db path is covered by
test_attachments.py; here we flip storage.STORAGE to 's3' and mock S3 in-process
with moto, then drive the real attachments API end-to-end:

    upload → bytes land in object storage, DB row keeps only metadata + key;
    download → bytes are fetched back from object storage;
    delete   → object and row both removed.

No real S3/R2 credentials or network are used.
"""
import pytest

import storage

boto3 = pytest.importorskip("boto3")
moto = pytest.importorskip("moto")
from moto import mock_aws   # noqa: E402

BUCKET = "erp-test-bucket"


@pytest.fixture
def s3_mode(monkeypatch):
    monkeypatch.setenv("S3_BUCKET", BUCKET)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setattr(storage, "STORAGE", "s3")
    storage.reset()
    yield
    storage.reset()


def test_db_is_the_default_backend():
    assert storage.is_s3() is False


def test_make_key_is_tenant_scoped():
    # In single-tenant mode the schema prefix is 'public'.
    key = storage.make_key("clients", 7, "report.pdf")
    assert key.startswith("public/clients/7/")
    assert key.endswith(".pdf")


def test_s3_upload_download_delete_via_api(make_client, db, s3_mode):
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)

        c = make_client("Admin")
        cid = c.post("/api/clients/", json={"name": "Attach Co"}).json()["id"]

        # Upload — routed to object storage.
        r = c.post(f"/api/attachments/clients/{cid}",
                   files={"file": ("note.txt", b"hello object storage", "text/plain")})
        assert r.status_code == 200, r.text
        att_id = r.json()["id"]

        # The DB row holds metadata + key, NOT the bytes.
        row = db.execute(
            "SELECT storage_backend, storage_key, data, size_bytes "
            "FROM attachments WHERE id=?", (att_id,)).fetchone()
        assert row["storage_backend"] == "s3"
        assert row["storage_key"] and row["storage_key"].startswith("public/clients/")
        assert bytes(row["data"] or b"") == b""
        assert row["size_bytes"] == len(b"hello object storage")

        # Download — bytes come back from object storage unchanged.
        r = c.get(f"/api/attachments/file/{att_id}?download=true")
        assert r.status_code == 200
        assert r.content == b"hello object storage"

        # Delete — object + row both gone.
        assert c.delete(f"/api/attachments/file/{att_id}").status_code == 200
        assert db.execute("SELECT 1 FROM attachments WHERE id=?", (att_id,)).fetchone() is None


def test_backfill_migrates_db_rows_to_s3(make_client, db, s3_mode):
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)

        # Seed a legacy DB-stored attachment directly (storage_backend='db').
        c = make_client("Admin")
        cid = c.post("/api/clients/", json={"name": "Legacy Co"}).json()["id"]
        db.execute(
            "INSERT INTO attachments (entity_type, entity_id, filename, content_type, "
            "size_bytes, data, storage_backend, created_at) "
            "VALUES ('clients', ?, 'old.txt', 'text/plain', 5, ?, 'db', '2026-01-01 00:00:00')",
            (cid, b"olddd"))
        db.commit()

        # Superadmin runs the backfill.
        admin = make_client("superadmin")
        r = admin.post("/api/attachments/migrate-to-s3")
        assert r.status_code == 200, r.text
        assert r.json()["migrated"] >= 1

        row = db.execute("SELECT storage_backend, storage_key FROM attachments "
                         "WHERE entity_id=? AND filename='old.txt'", (cid,)).fetchone()
        assert row["storage_backend"] == "s3"
        # And it downloads correctly from object storage now.
        att = db.execute("SELECT id FROM attachments WHERE storage_key=?",
                         (row["storage_key"],)).fetchone()
        r = c.get(f"/api/attachments/file/{att['id']}?download=true")
        assert r.status_code == 200 and r.content == b"olddd"
