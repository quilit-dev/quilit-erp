"""
pg_backup.py — off-site PostgreSQL backups to S3-compatible storage (Cloudflare R2).

Why this exists
---------------
`backup_manager.py` backs up SQLite for the desktop build. Production is
PostgreSQL behind gunicorn, where that module never even initialises, so the
deployed database had no backup of any kind. The Railway volume is durable
storage, not a backup: it persists damage as faithfully as data.

What it protects against
------------------------
The things a volume cannot: a bad migration (they run automatically at every
process start, across every tenant schema), a mistaken DROP SCHEMA, an UPDATE
without a WHERE, and loss of the Railway account itself. The dumps live at a
different vendor for that last reason.

Retention
---------
Seven daily copies and four weekly ones — 11 objects, roughly 220 MB at this
database's size. A single overwritten copy was considered and rejected: damage
to financial records is usually noticed days later, by which point an
overwriting scheme has replaced the last good copy with several bad ones. The
copy you reach for is the one most likely to contain the problem, because the
problem is what sent you looking.

Ordering rules that make this a backup rather than a hope
---------------------------------------------------------
  1. VERIFY the dump before uploading it. A truncated dump that uploads cleanly
     is worse than a failed job, because it looks like success.
  2. PRUNE only after the upload succeeds. The delete is always last, so a
     failed run costs you today's copy, never yesterday's.
  3. Dated keys, never a fixed name. Nothing is overwritten in place, so a
     partial write cannot destroy an existing good copy.

Format
------
`pg_dump --format=custom`, which is compressed and lets `pg_restore -n` restore
ONE tenant schema without touching the others — the operation this system is
most likely to need, since every customer shares one database.

Configuration (all BACKUP_-prefixed, deliberately separate from the app's own
S3 credentials — attachments and backups must not share a bucket or a token, or
one leaked key exposes both the live data and every copy of it):

    DATABASE_URL                 the database to dump
    BACKUP_S3_BUCKET             e.g. quilit-backups
    BACKUP_S3_ENDPOINT_URL       e.g. https://<account>.r2.cloudflarestorage.com
    BACKUP_S3_ACCESS_KEY_ID
    BACKUP_S3_SECRET_ACCESS_KEY
    BACKUP_S3_REGION             "auto" for R2
    BACKUP_ENCRYPTION_KEY        optional; Fernet key. Unset = dumps stored
                                 unencrypted, and the run says so.

Usage:
    python pg_backup.py              run a backup
    python pg_backup.py --list       show what is stored
    python pg_backup.py --verify-latest   download the newest and check it
"""
import datetime
import logging
import os
import subprocess
import sys
import tempfile

logger = logging.getLogger("erp.pg_backup")

DAILY_PREFIX = "daily/"
WEEKLY_PREFIX = "weekly/"
DAILY_KEEP = 7
WEEKLY_KEEP = 4

# A custom-format dump always begins with this magic. The cheapest possible
# check that we uploaded a dump and not an error message.
_PGDMP_MAGIC = b"PGDMP"

# Below this, something is wrong no matter what the file claims to be: an empty
# database still carries a schema.
_MIN_PLAUSIBLE_BYTES = 1024


class BackupError(RuntimeError):
    """Anything that means "there is no good backup from this run"."""


# ── configuration ────────────────────────────────────────────────────────────

def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise BackupError(
            f"{name} is not set. Backups need their own bucket and token, "
            f"separate from the app's S3_* attachment credentials.")
    return v


def config() -> dict:
    return {
        "database_url": _require("DATABASE_URL"),
        "bucket":       _require("BACKUP_S3_BUCKET"),
        "endpoint":     os.environ.get("BACKUP_S3_ENDPOINT_URL") or None,
        "access_key":   _require("BACKUP_S3_ACCESS_KEY_ID"),
        "secret_key":   _require("BACKUP_S3_SECRET_ACCESS_KEY"),
        "region":       os.environ.get("BACKUP_S3_REGION") or "auto",
        "enc_key":      os.environ.get("BACKUP_ENCRYPTION_KEY") or None,
    }


def _client(cfg: dict):
    import boto3
    kwargs = {
        "aws_access_key_id": cfg["access_key"],
        "aws_secret_access_key": cfg["secret_key"],
        "region_name": cfg["region"],
    }
    if cfg["endpoint"]:
        kwargs["endpoint_url"] = cfg["endpoint"]
    return boto3.client("s3", **kwargs)


# ── the dump ─────────────────────────────────────────────────────────────────

def _major(version_text: str) -> int:
    """Major version out of 'pg_dump (PostgreSQL) 18.4' or '180004'."""
    import re
    m = re.search(r"(\d+)", version_text.strip())
    if not m:
        raise BackupError(f"could not read a version from {version_text!r}")
    n = int(m.group(1))
    return n // 10000 if n > 1000 else n


def check_versions(database_url: str) -> tuple:
    """(pg_dump major, server major). Refuses if pg_dump is older.

    pg_dump cannot read a newer server, and the failure message it gives is
    obscure. Checking up front turns it into one sentence.
    """
    try:
        out = subprocess.run(["pg_dump", "--version"], capture_output=True,
                             text=True, check=True).stdout
    except FileNotFoundError:
        raise BackupError(
            "pg_dump not found. Install the postgresql-client package matching "
            "the server's major version.")
    dump_major = _major(out)

    import psycopg
    with psycopg.connect(database_url, connect_timeout=15) as conn:
        server_major = _major(str(conn.execute("SHOW server_version").fetchone()[0]))

    if dump_major < server_major:
        raise BackupError(
            f"pg_dump is version {dump_major} but the server is {server_major}. "
            f"pg_dump must be the same major version or newer.")
    return dump_major, server_major


def create_dump(database_url: str, dest: str) -> int:
    """Write a custom-format dump. Returns its size in bytes."""
    cmd = [
        "pg_dump",
        "--format=custom",
        "--compress=9",
        "--no-owner",          # restoring into a differently-named role must work
        "--no-privileges",     # ditto for grants
        "--file", dest,
        database_url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise BackupError(f"pg_dump failed: {(proc.stderr or '').strip()[:500]}")
    if not os.path.exists(dest):
        raise BackupError("pg_dump reported success but wrote no file")
    return os.path.getsize(dest)


def verify_dump(path: str) -> int:
    """Prove the file is a restorable dump. Returns the object count.

    Runs BEFORE the upload, because the failure this guards against is a
    truncated or empty dump replacing a good one — a job that "succeeds" every
    night and leaves you with nothing is the classic way backups turn out to be
    fiction.
    """
    size = os.path.getsize(path)
    if size < _MIN_PLAUSIBLE_BYTES:
        raise BackupError(f"dump is only {size} bytes — too small to be real")

    with open(path, "rb") as fh:
        if fh.read(len(_PGDMP_MAGIC)) != _PGDMP_MAGIC:
            raise BackupError("file is not a PostgreSQL custom-format dump")

    # pg_restore --list parses the whole archive's table of contents, so a
    # truncated file fails here rather than during a restore at 3am.
    proc = subprocess.run(["pg_restore", "--list", path],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise BackupError(
            f"dump does not read back: {(proc.stderr or '').strip()[:300]}")

    entries = [ln for ln in proc.stdout.splitlines()
               if ln.strip() and not ln.startswith(";")]
    if not entries:
        raise BackupError("dump contains no objects")
    return len(entries)


def encrypt_file(path: str, key: str) -> str:
    """Encrypt in place, returning the new path. Fernet: authenticated, so a
    corrupted download fails to decrypt rather than restoring garbage."""
    from cryptography.fernet import Fernet
    with open(path, "rb") as fh:
        token = Fernet(key.encode()).encrypt(fh.read())
    enc = path + ".enc"
    with open(enc, "wb") as fh:
        fh.write(token)
    return enc


def decrypt_bytes(blob: bytes, key: str) -> bytes:
    from cryptography.fernet import Fernet
    return Fernet(key.encode()).decrypt(blob)


# ── storage ──────────────────────────────────────────────────────────────────

def upload(client, bucket: str, key: str, path: str) -> None:
    with open(path, "rb") as fh:
        client.put_object(Bucket=bucket, Key=key, Body=fh.read(),
                          ContentType="application/octet-stream")


def list_keys(client, bucket: str, prefix: str) -> list:
    """Keys under prefix, oldest first. Names are dated, so lexical order is
    chronological — that is why the key format is fixed."""
    keys, token = [], None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = client.list_objects_v2(**kw)
        keys += [o["Key"] for o in resp.get("Contents", [])]
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return sorted(keys)


def prune(client, bucket: str, prefix: str, keep: int) -> list:
    """Delete all but the newest `keep`. Returns what was removed.

    Called ONLY after a verified upload has landed. A run that fails earlier
    deletes nothing, so a broken backup job degrades into "no new copy" rather
    than "no copies".
    """
    keys = list_keys(client, bucket, prefix)
    doomed = keys[:-keep] if keep > 0 and len(keys) > keep else []
    for k in doomed:
        client.delete_object(Bucket=bucket, Key=k)
    return doomed


# ── orchestration ────────────────────────────────────────────────────────────

def run(now: datetime.datetime = None, cfg: dict = None) -> dict:
    """Take one backup. Returns a summary; raises BackupError on failure."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    cfg = cfg or config()
    client = _client(cfg)

    dump_major, server_major = check_versions(cfg["database_url"])
    summary = {
        "started_at": now.isoformat(timespec="seconds"),
        "pg_dump_version": dump_major, "server_version": server_major,
        "encrypted": bool(cfg["enc_key"]), "uploaded": [], "pruned": [],
    }

    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "dump.pgdump")
        summary["bytes"] = create_dump(cfg["database_url"], raw)
        summary["objects"] = verify_dump(raw)          # BEFORE the upload

        body, suffix = raw, ".pgdump"
        if cfg["enc_key"]:
            body, suffix = encrypt_file(raw, cfg["enc_key"]), ".pgdump.enc"
            summary["bytes_stored"] = os.path.getsize(body)

        daily_key = f"{DAILY_PREFIX}{now:%Y-%m-%d}{suffix}"
        upload(client, cfg["bucket"], daily_key, body)
        summary["uploaded"].append(daily_key)

        # One of the seven dailies is promoted to a weekly rather than dumped
        # twice — same bytes, and the weekly then ages out on its own schedule.
        if now.isoweekday() == 7:                      # Sunday
            iso_year, iso_week, _ = now.isocalendar()
            weekly_key = f"{WEEKLY_PREFIX}{iso_year}-W{iso_week:02d}{suffix}"
            upload(client, cfg["bucket"], weekly_key, body)
            summary["uploaded"].append(weekly_key)

    # Deletes last, always.
    summary["pruned"] += prune(client, cfg["bucket"], DAILY_PREFIX, DAILY_KEEP)
    summary["pruned"] += prune(client, cfg["bucket"], WEEKLY_PREFIX, WEEKLY_KEEP)
    return summary


def verify_latest(cfg: dict = None) -> dict:
    """Download the newest daily and check it reads back.

    Verifying locally before upload proves the file was good when written; this
    proves what is actually IN the bucket is still restorable.
    """
    cfg = cfg or config()
    client = _client(cfg)
    keys = list_keys(client, cfg["bucket"], DAILY_PREFIX)
    if not keys:
        raise BackupError("no daily backups found")
    key = keys[-1]

    blob = client.get_object(Bucket=cfg["bucket"], Key=key)["Body"].read()
    if key.endswith(".enc"):
        if not cfg["enc_key"]:
            raise BackupError(f"{key} is encrypted but BACKUP_ENCRYPTION_KEY is unset")
        blob = decrypt_bytes(blob, cfg["enc_key"])

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "check.pgdump")
        with open(path, "wb") as fh:
            fh.write(blob)
        objects = verify_dump(path)
    return {"key": key, "bytes": len(blob), "objects": objects}


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    argv = argv if argv is not None else sys.argv[1:]
    try:
        if "--list" in argv:
            cfg = config()
            client = _client(cfg)
            for prefix in (DAILY_PREFIX, WEEKLY_PREFIX):
                for k in list_keys(client, cfg["bucket"], prefix):
                    print(" ", k)
            return 0
        if "--verify-latest" in argv:
            print(verify_latest())
            return 0

        result = run()
        print(f"backed up {result['bytes']:,} bytes / {result['objects']} objects")
        for k in result["uploaded"]:
            print("  stored ", k)
        for k in result["pruned"]:
            print("  expired", k)
        if not result["encrypted"]:
            print("  WARNING: stored unencrypted — set BACKUP_ENCRYPTION_KEY to "
                  "protect the dump if the storage token ever leaks")
        return 0
    except BackupError as e:
        logger.error("BACKUP FAILED: %s", e)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
