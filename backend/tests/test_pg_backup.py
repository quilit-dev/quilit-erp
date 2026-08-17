"""Backups, and the rules that make them backups rather than hope.

The behaviours worth testing here are the ORDERING ones, because those are what
separate a working backup from one that silently destroys itself:

  * verify before upload — a truncated dump must never reach the bucket
  * prune after upload   — a failed run costs today's copy, never yesterday's
  * dated keys           — nothing overwrites an existing good copy in place

Retention is 7 daily + 4 weekly. A single overwritten copy was rejected because
damage to accounting records surfaces days later, by which point the one slot
holds the damage.
"""
import datetime

import pytest

import pg_backup
from pg_backup import BackupError


# ── a stand-in bucket ────────────────────────────────────────────────────────

class FakeS3:
    """Records what happened, in order — which is the thing under test."""

    def __init__(self, fail_put_on=None):
        self.objects = {}
        self.log = []
        self.fail_put_on = fail_put_on

    def put_object(self, Bucket, Key, Body, ContentType=None):
        if self.fail_put_on and self.fail_put_on in Key:
            self.log.append(("put-FAILED", Key))
            raise IOError("network died mid-upload")
        self.objects[Key] = Body
        self.log.append(("put", Key))

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)
        self.log.append(("delete", Key))

    def get_object(self, Bucket, Key):
        class B:
            def __init__(self, b): self._b = b
            def read(self): return self._b
        return {"Body": B(self.objects[Key])}

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        return {"Contents": [{"Key": k} for k in keys], "IsTruncated": False}


CFG = {
    "database_url": "postgresql://x/y", "bucket": "quilit-backups",
    "endpoint": "https://acct.r2.cloudflarestorage.com",
    "access_key": "k", "secret_key": "s", "region": "auto", "enc_key": None,
}


@pytest.fixture
def fake(monkeypatch):
    s3 = FakeS3()
    monkeypatch.setattr(pg_backup, "_client", lambda cfg: s3)
    monkeypatch.setattr(pg_backup, "check_versions", lambda url: (18, 18))

    def fake_dump(url, dest):
        with open(dest, "wb") as fh:
            fh.write(b"PGDMP" + b"x" * 4000)
        return 4005
    monkeypatch.setattr(pg_backup, "create_dump", fake_dump)
    monkeypatch.setattr(pg_backup, "verify_dump", lambda p: 42)
    return s3


# ── retention ────────────────────────────────────────────────────────────────

def test_keeps_seven_daily(fake):
    for day in range(1, 13):                       # twelve consecutive days
        pg_backup.run(datetime.datetime(2026, 6, day, 3, tzinfo=datetime.timezone.utc), CFG)

    dailies = [k for k in fake.objects if k.startswith("daily/")]
    assert len(dailies) == 7
    assert min(dailies).endswith("2026-06-06.pgdump"), "oldest kept should be day 6"
    assert max(dailies).endswith("2026-06-12.pgdump")


def test_keeps_four_weekly(fake):
    # Ten Sundays. Weeklies are promoted from that day's dump, not dumped twice.
    d = datetime.datetime(2026, 6, 7, 3, tzinfo=datetime.timezone.utc)   # a Sunday
    assert d.isoweekday() == 7
    for i in range(10):
        pg_backup.run(d + datetime.timedelta(weeks=i), CFG)

    assert len([k for k in fake.objects if k.startswith("weekly/")]) == 4


def test_a_weekday_writes_no_weekly(fake):
    monday = datetime.datetime(2026, 6, 8, 3, tzinfo=datetime.timezone.utc)
    assert monday.isoweekday() == 1
    pg_backup.run(monday, CFG)

    assert not [k for k in fake.objects if k.startswith("weekly/")]


def test_a_year_of_runs_settles_at_eleven_objects(fake):
    start = datetime.datetime(2026, 1, 1, 3, tzinfo=datetime.timezone.utc)
    for i in range(365):
        pg_backup.run(start + datetime.timedelta(days=i), CFG)

    # The whole point of retention: unbounded runs, bounded storage.
    assert len(fake.objects) == 11


# ── the ordering rules ───────────────────────────────────────────────────────

def test_nothing_is_deleted_before_the_upload_lands(fake):
    for day in range(1, 10):
        pg_backup.run(datetime.datetime(2026, 6, day, 3, tzinfo=datetime.timezone.utc), CFG)

    # Every delete must be preceded by the put from the same run. Reading the
    # log in order: the first delete cannot come before the first put.
    first_put = next(i for i, (op, _) in enumerate(fake.log) if op == "put")
    first_del = next(i for i, (op, _) in enumerate(fake.log) if op == "delete")
    assert first_put < first_del


def test_a_failed_upload_deletes_nothing(monkeypatch):
    s3 = FakeS3()
    monkeypatch.setattr(pg_backup, "_client", lambda cfg: s3)
    monkeypatch.setattr(pg_backup, "check_versions", lambda url: (18, 18))
    monkeypatch.setattr(pg_backup, "verify_dump", lambda p: 42)

    def dump(url, dest):
        with open(dest, "wb") as fh:
            fh.write(b"PGDMP" + b"x" * 4000)
        return 4005
    monkeypatch.setattr(pg_backup, "create_dump", dump)

    for day in range(1, 10):                        # build up history
        pg_backup.run(datetime.datetime(2026, 6, day, 3, tzinfo=datetime.timezone.utc), CFG)
    before = set(s3.objects)

    s3.fail_put_on = "2026-06-10"
    with pytest.raises(IOError):
        pg_backup.run(datetime.datetime(2026, 6, 10, 3, tzinfo=datetime.timezone.utc), CFG)

    assert set(s3.objects) == before, "a failed run must not expire older copies"


def test_a_bad_dump_never_reaches_the_bucket(monkeypatch):
    s3 = FakeS3()
    monkeypatch.setattr(pg_backup, "_client", lambda cfg: s3)
    monkeypatch.setattr(pg_backup, "check_versions", lambda url: (18, 18))

    def truncated(url, dest):
        with open(dest, "wb") as fh:
            fh.write(b"")                          # pg_dump "succeeded", wrote nothing
        return 0
    monkeypatch.setattr(pg_backup, "create_dump", truncated)

    with pytest.raises(BackupError, match="too small"):
        pg_backup.run(datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc), CFG)

    assert not s3.objects, "an unverified dump must never be uploaded"


def test_keys_are_dated_so_nothing_is_overwritten_in_place(fake):
    pg_backup.run(datetime.datetime(2026, 6, 1, 3, tzinfo=datetime.timezone.utc), CFG)
    pg_backup.run(datetime.datetime(2026, 6, 2, 3, tzinfo=datetime.timezone.utc), CFG)

    assert "daily/2026-06-01.pgdump" in fake.objects
    assert "daily/2026-06-02.pgdump" in fake.objects


# ── verification ─────────────────────────────────────────────────────────────

def test_a_file_that_is_not_a_dump_is_rejected(tmp_path):
    p = tmp_path / "not.pgdump"
    p.write_bytes(b"<html>403 Forbidden</html>" + b"y" * 2000)

    with pytest.raises(BackupError, match="not a PostgreSQL"):
        pg_backup.verify_dump(str(p))


def test_an_empty_file_is_rejected(tmp_path):
    p = tmp_path / "empty.pgdump"
    p.write_bytes(b"")

    with pytest.raises(BackupError, match="too small"):
        pg_backup.verify_dump(str(p))


# ── configuration ────────────────────────────────────────────────────────────

def test_backups_refuse_to_share_the_attachment_credentials(monkeypatch):
    """The app's S3_* vars must not be silently borrowed: one leaked key would
    then expose both the live attachments and every backup."""
    for k in ("BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID",
              "BACKUP_S3_SECRET_ACCESS_KEY", "DATABASE_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("S3_BUCKET", "quilit-storage")
    monkeypatch.setenv("S3_ACCESS_KEY_ID", "attachments-key")

    with pytest.raises(BackupError, match="separate from the app"):
        pg_backup.config()


def test_encryption_round_trips(tmp_path):
    from cryptography.fernet import Fernet
    key = Fernet.generate_key().decode()
    p = tmp_path / "d.pgdump"
    p.write_bytes(b"PGDMP" + b"z" * 3000)

    enc = pg_backup.encrypt_file(str(p), key)
    assert open(enc, "rb").read() != p.read_bytes()
    assert pg_backup.decrypt_bytes(open(enc, "rb").read(), key) == p.read_bytes()


def test_a_wrong_key_fails_loudly_rather_than_restoring_rubbish(tmp_path):
    from cryptography.fernet import Fernet, InvalidToken
    p = tmp_path / "d.pgdump"
    p.write_bytes(b"PGDMP" + b"z" * 3000)
    enc = pg_backup.encrypt_file(str(p), Fernet.generate_key().decode())

    with pytest.raises(InvalidToken):
        pg_backup.decrypt_bytes(open(enc, "rb").read(), Fernet.generate_key().decode())


def test_an_older_pg_dump_is_refused(monkeypatch):
    # pg_dump 17 against a server 18 fails with an obscure message mid-run; this
    # turns it into one sentence, before anything is uploaded.
    monkeypatch.setattr(pg_backup.subprocess, "run",
                        lambda *a, **k: type("R", (), {
                            "returncode": 0, "stdout": "pg_dump (PostgreSQL) 17.2", "stderr": ""})())

    class FakeConn:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def execute(self, q): return type("C", (), {"fetchone": lambda s: ("18.4",)})()

    import psycopg
    monkeypatch.setattr(psycopg, "connect", lambda *a, **k: FakeConn())

    with pytest.raises(BackupError, match="must be the same major version or newer"):
        pg_backup.check_versions("postgresql://x/y")
