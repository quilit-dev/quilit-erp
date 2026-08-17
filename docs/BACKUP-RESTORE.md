# Database backup and restore

The production database is PostgreSQL on Railway. `backup_manager.py` does not
apply to it — that module is for the SQLite desktop build and is only started by
`launcher.py`, whereas production runs gunicorn. Off-site backups are handled by
`backend/pg_backup.py`.

**The Railway volume is not a backup.** It is durable storage: it persists
damage exactly as faithfully as it persists data. It protects against the
container being replaced, and against nothing else.

## What this protects against

- A bad migration. `database.py` calls `init_db()` at import, so migrations run
  on **every process start**, unattended, across **every tenant schema**.
- A mistaken `DROP SCHEMA` — `tenancy.py:290`, reachable from the Control Center.
- An `UPDATE` without a `WHERE`.
- Loss of the Railway account itself. The dumps live at a different vendor
  (Cloudflare R2) specifically so a billing or account problem cannot take both.

Every customer shares one database, so any database-level incident affects all
tenants at once. There is no "only one customer" scenario.

## Retention

Seven daily, four weekly — 11 objects, roughly 220 MB at the current size.

A single overwritten copy was considered and rejected. Damage to accounting
records is normally noticed days later, and an overwriting scheme spends those
days replacing the last good copy with progressively damaged ones. The copy you
reach for is the one most likely to contain the problem, because the problem is
what sent you looking.

Sunday's dump is *promoted* to a weekly rather than dumped twice: same bytes,
and the weekly then ages out on its own schedule.

## Three ordering rules

1. **Verify before upload.** A truncated dump that uploads cleanly is worse than
   a failed job, because it looks like success.
2. **Prune after upload.** The delete is always last, so a failed run costs
   today's copy and never yesterday's.
3. **Dated keys, never a fixed name.** Nothing is overwritten in place, so a
   partial write cannot destroy a good copy.

## Setup

### 1. A separate R2 bucket and token

Do **not** reuse the app's `S3_*` attachment credentials. If backups live in the
same bucket under the same key, one leaked key exposes the live data *and* every
copy of it — the exact correlation a backup exists to break.

- Create a bucket, e.g. `quilit-backups`.
- Create an R2 API token scoped to **that bucket only**, with write access.

### 2. Service variables

    DATABASE_URL                 (reference the erp-db service's internal URL)
    BACKUP_S3_BUCKET             quilit-backups
    BACKUP_S3_ENDPOINT_URL       https://<account>.r2.cloudflarestorage.com
    BACKUP_S3_ACCESS_KEY_ID      <backup-only token id>
    BACKUP_S3_SECRET_ACCESS_KEY  <backup-only token secret>
    BACKUP_S3_REGION             auto
    BACKUP_ENCRYPTION_KEY        optional, see below

The database has **no public endpoint**, so the backup must run inside Railway's
private network. It cannot run from GitHub Actions or a laptop.

### 3. A cron service

Add a service from this repo, then set three things on it:

  * `RAILWAY_DOCKERFILE_TARGET=backup` — **required**. With no target Docker
    builds the last stage, which is `app`, and the cron service would run the
    API instead of the backup.
  * Config-as-code path `railway.backup.json` — **required**. The default
    `railway.json` sets `healthcheckPath: /api/health`, and this service runs no
    web server, so the healthcheck would fail every run. That file also sets
    `restartPolicyType: NEVER`, because a process that is *supposed* to exit
    must not be restarted for exiting.
  * A cron schedule, e.g. `15 2 * * *` (Railway schedules in UTC).

Give it no public domain — it serves nothing.

The image is built on `postgres:18-alpine` so `pg_dump` matches the server's
major version. Debian's client is 15 and would fail against an 18 server.

### 4. Encryption (recommended)

Unset, dumps are stored unencrypted and every run prints a warning. A dump is
every customer's complete books in one file; R2 encrypts at rest, but that does
not help if the storage token leaks.

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

**Keep this key somewhere that is not the server.** Losing it means the backups
cannot be read. That is the real trade-off — an unreadable backup and no backup
are the same thing.

## Checking it

    python pg_backup.py --list             # what is stored
    python pg_backup.py --verify-latest    # download the newest and check it reads back

`--verify-latest` matters because verifying before upload only proves the file
was good when written; this proves what is actually *in* the bucket still
restores.

## Restoring

Both procedures below were run end-to-end against PostgreSQL 18 on a real dump
of this schema (879 objects) and verified by comparing row counts and sums
against the source.

### Everything

```bash
createdb -h <host> -U postgres erp_restored
pg_restore -h <host> -U postgres -d erp_restored --no-owner --no-privileges backup.pgdump
```

### One tenant, leaving the others untouched

This is the common case: one customer's data is damaged and the rest are fine.

**The schema must be created first.** `pg_restore -n` selects objects *in* a
schema but will not create the schema in an empty database — without this step
it fails with "errors ignored on restore" and leaves nothing behind, which looks
like a successful run.

```bash
psql -h <host> -U postgres -d erp_restored -c 'CREATE SCHEMA tenant_hajosign'
pg_restore -h <host> -U postgres -d erp_restored --no-owner --no-privileges \
  -n tenant_hajosign backup.pgdump
```

Verified: restores that tenant's rows exactly, and creates no other tenant
schema.

### If the dump is encrypted

```python
from cryptography.fernet import Fernet
open("backup.pgdump", "wb").write(
    Fernet(KEY.encode()).decrypt(open("backup.pgdump.enc", "rb").read()))
```

## Restore drill

Do this quarterly, and after any change to the backup job. A backup nobody has
restored is a hypothesis.

1. `python pg_backup.py --verify-latest`
2. Restore the newest dump into a scratch database.
3. Compare per-tenant row counts and invoice totals against production.

Step 3 is the one that counts. The drill that produced this document passed the
full restore and **failed** the single-tenant restore on the first attempt —
that is where the `CREATE SCHEMA` step above came from.
