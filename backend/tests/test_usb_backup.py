"""
One-click USB / folder backup — POST /api/settings/backup-export.

Copies the live database to an external folder (USB drive, network share).
Admin-only; the database keeps working fully offline.
"""
import sqlite3
import pytest


@pytest.mark.rbac
@pytest.mark.parametrize("role", ["Viewer", "Sales", "Accountant", "Manager"])
def test_non_admin_cannot_export_backup(role, make_client):
    r = make_client(role).post("/api/settings/backup-export", json={"path": "/tmp/x"})
    assert r.status_code != 500
    assert r.status_code == 403


def test_backup_export_rejects_empty_path(make_client):
    r = make_client("superadmin").post("/api/settings/backup-export", json={"path": "   "})
    assert r.status_code < 500
    assert r.status_code == 400


def test_backup_export_writes_db_and_checksum(make_client, tmp_path):
    """A valid destination folder receives a timestamped .db plus its sidecar."""
    import backup_manager

    src = tmp_path / "live.db"
    con = sqlite3.connect(str(src))
    con.execute("CREATE TABLE demo (id INTEGER)")
    con.commit()
    con.close()
    backup_manager._db_path = str(src)

    dest = tmp_path / "usb_drive"
    r = make_client("superadmin").post(
        "/api/settings/backup-export", json={"path": str(dest)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True

    backups = list(dest.glob("erp_backup_*.db"))
    assert len(backups) == 1
    assert backups[0].with_suffix(".db.sha256").exists() \
        or list(dest.glob("erp_backup_*.sha256"))
