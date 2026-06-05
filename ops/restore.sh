#!/bin/sh
# Restore a Postgres backup produced by ops/backup.sh (Phase 5).
#
#   ./ops/restore.sh /backups/erp-YYYYMMDDTHHMMSSZ.dump
#
# Run inside the `backup` service (has pg_dump/pg_restore + DATABASE_URL):
#   docker compose run --rm backup /ops/restore.sh /backups/erp-….dump
#
# DESTRUCTIVE: --clean drops existing objects before recreating them. Stop the
# app/worker first so nothing writes mid-restore.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
DUMP="${1:?usage: restore.sh <dumpfile>}"

[ -f "$DUMP" ] || { echo "restore: no such file: $DUMP" >&2; exit 1; }

echo "restore: restoring $DUMP → \$DATABASE_URL (this drops & recreates objects)…"
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DUMP"
echo "restore: done."
