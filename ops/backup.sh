#!/bin/sh
# Nightly Postgres backup (Phase 5). Runs in the `backup` compose service (which
# uses the postgres:16 image, so pg_dump is present). Writes a compressed custom-
# format dump of the whole database — every tenant schema — to /backups, prunes
# old ones, and optionally ships the latest offsite to S3/R2.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/erp-$TS.dump"

echo "backup: dumping → $OUT"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$OUT"
echo "backup: wrote $(du -h "$OUT" | cut -f1)"

# Retention.
find "$BACKUP_DIR" -name 'erp-*.dump' -type f -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true

# Optional offsite copy (requires `aws` or `rclone` in the image; the default
# postgres image has neither, so this is a no-op unless you extend the image).
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    if command -v aws >/dev/null 2>&1; then
        aws s3 cp "$OUT" "s3://$BACKUP_S3_BUCKET/$(basename "$OUT")" \
            ${S3_ENDPOINT_URL:+--endpoint-url "$S3_ENDPOINT_URL"}
        echo "backup: uploaded to s3://$BACKUP_S3_BUCKET/"
    else
        echo "backup: BACKUP_S3_BUCKET set but no 'aws' CLI in image — skipping offsite copy." >&2
    fi
fi
