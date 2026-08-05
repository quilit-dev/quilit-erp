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

def validate_config() -> dict:
    """Check object storage at BOOT rather than at a customer's first upload.

    Without this the first symptom of a missing or mistyped credential is a
    500 when someone attaches a contract — the worst possible moment and the
    hardest to attribute. Called from bootstrap.py.

    Two different failure classes, handled differently on purpose:

      * CONFIG errors (boto3 absent, no bucket, no credentials) raise. They are
        deterministic, they will not fix themselves, and serving an ERP whose
        document storage cannot work is worse than refusing to start.

      * REACHABILITY errors (bucket unreachable, DNS, transient 5xx) only warn.
        A network blip at boot must not stop the whole ERP from starting when
        every other module is fine.

    Returns a summary dict; raises RuntimeError on a config error.
    """
    if not is_s3():
        return {"backend": STORAGE, "checked": False,
                "detail": "documents are stored in the database"}

    try:
        import boto3  # noqa: F401
    except ImportError:
        raise RuntimeError(
            "STORAGE=s3 but boto3 is not installed.\n"
            "Install the cloud requirements: pip install -r requirements-cloud.txt\n"
            "Or set STORAGE=db to keep documents in the database."
        )

    missing = []
    if not os.environ.get("S3_BUCKET"):
        missing.append("S3_BUCKET")
    if not (os.environ.get("S3_ACCESS_KEY_ID") or os.environ.get("AWS_ACCESS_KEY_ID")):
        missing.append("S3_ACCESS_KEY_ID")
    if not (os.environ.get("S3_SECRET_ACCESS_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY")):
        missing.append("S3_SECRET_ACCESS_KEY")
    if missing:
        raise RuntimeError(
            f"STORAGE=s3 but {', '.join(missing)} not set.\n"
            "Document uploads would fail at the first attachment.\n"
            "Set the missing variable(s), or set STORAGE=db to keep documents "
            "in the database."
        )

    bucket = os.environ.get("S3_BUCKET")
    result = {"backend": "s3", "bucket": bucket, "checked": True,
              "endpoint": os.environ.get("S3_ENDPOINT_URL") or "aws"}
    try:
        _s3().head_bucket(Bucket=bucket)
        result["reachable"] = True
    except Exception as e:
        # Warn, do not raise - see the docstring.
        result["reachable"] = False
        result["warning"] = f"{type(e).__name__}: {e}"
    return result
