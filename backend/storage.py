"""
Object-storage abstraction for file attachments (Phase 3 —
docs/SAAS_ARCHITECTURE.md §8).

``STORAGE`` selects where uploaded bytes live:
  * ``db``  (default) — in the row's BLOB column. Unchanged behavior, no external
                        dependency; this is what desktop / self-hosted installs use
                        and what the existing test-suite exercises.
  * ``s3``            — an S3-compatible object (AWS S3, Cloudflare R2, MinIO). The
                        DB row keeps the metadata + a ``storage_key``; its BLOB is
                        left empty.

Keys are tenant-scoped — ``<schema>/<entity_type>/<entity_id>/<uuid><ext>`` — so a
single bucket safely holds every tenant's files and per-tenant export/delete is
just a key-prefix operation.

Config (env, only read when STORAGE=s3):
  ``S3_BUCKET`` (required), ``S3_ENDPOINT_URL`` (set for R2/MinIO; omit for AWS),
  ``S3_REGION``, ``S3_ACCESS_KEY_ID``/``AWS_ACCESS_KEY_ID``,
  ``S3_SECRET_ACCESS_KEY``/``AWS_SECRET_ACCESS_KEY``.

boto3 is imported lazily, so it is never required for the default ``db`` backend
(and stays out of the lean desktop bundle).
"""
import os
import uuid

STORAGE = os.environ.get("STORAGE", "db").lower()


def is_s3() -> bool:
    return STORAGE in ("s3", "r2", "object")


def _ext_from(filename: str) -> str:
    _, ext = os.path.splitext(filename or "")
    # keep it short and free of anything weird (the uuid carries uniqueness).
    return ext[:10] if ext.isascii() else ""


def make_key(entity_type: str, entity_id: int, filename: str) -> str:
    """Tenant-scoped object key. Uses the active request's schema as the prefix."""
    from tenant_context import current_schema
    return f"{current_schema()}/{entity_type}/{entity_id}/{uuid.uuid4().hex}{_ext_from(filename)}"


# ── S3 client (lazy, cached) ─────────────────────────────────────────────────
_client = None


def reset():
    """Drop the cached client. Used by tests so a mocked backend takes effect."""
    global _client
    _client = None


def _s3():
    global _client
    if _client is None:
        import boto3
        kwargs = {}
        endpoint = os.environ.get("S3_ENDPOINT_URL")
        if endpoint:
            kwargs["endpoint_url"] = endpoint
        region = os.environ.get("S3_REGION") or os.environ.get("AWS_REGION")
        if region:
            kwargs["region_name"] = region
        ak = os.environ.get("S3_ACCESS_KEY_ID") or os.environ.get("AWS_ACCESS_KEY_ID")
        sk = os.environ.get("S3_SECRET_ACCESS_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY")
        if ak and sk:
            kwargs["aws_access_key_id"] = ak
            kwargs["aws_secret_access_key"] = sk
        _client = boto3.client("s3", **kwargs)
    return _client


def _bucket() -> str:
    b = os.environ.get("S3_BUCKET")
    if not b:
        raise RuntimeError("S3_BUCKET is not configured but STORAGE=s3.")
    return b


def put_object(key: str, data: bytes, content_type: str) -> None:
    _s3().put_object(Bucket=_bucket(), Key=key, Body=data,
                     ContentType=content_type or "application/octet-stream")


def get_object(key: str) -> bytes:
    resp = _s3().get_object(Bucket=_bucket(), Key=key)
    return resp["Body"].read()


def delete_object(key: str) -> None:
    # Best-effort: removing the DB row is the source of truth; a dangling object
    # is harmless and swept by a lifecycle rule / the per-tenant purge.
    try:
        _s3().delete_object(Bucket=_bucket(), Key=key)
    except Exception:
        pass
