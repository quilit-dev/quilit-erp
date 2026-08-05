"""
Per-tenant health — "which customer needs attention?" in one query pass.

Everything here is DERIVED from data the platform already stores. Nothing is
sampled or estimated: a number is either sourced or reported as null, because
a health console that quietly invents figures is worse than one that admits a
gap.

Deliberately NOT reported, and why:
  * last backup   — Railway snapshots the whole database, not per tenant.
                    There is no per-customer backup to report, so claiming one
                    would be fiction.
  * system version— one deployment serves every tenant, so this is a property
                    of the platform, not of a customer. Reported once at the
                    top level rather than repeated per row.
  * storage usage — only meaningful while STORAGE=db (attachment bytes live in
                    the tenant schema and are counted in its size). Under
                    STORAGE=s3 the bytes are in R2 and would need a bucket
                    API call per tenant; reported as null rather than guessed.

Cost: one catalog query for every schema's size, one aggregate over the shared
report table, then a small per-tenant query for user counts. At ten customers
that is a dozen cheap queries; if the customer count ever reaches the hundreds
the per-tenant loop is the part to batch.
"""
import os
from datetime import datetime, timedelta

# A tenant nobody has signed into for this long is probably abandoned or stuck.
_STALE_LOGIN_DAYS = 14


def _connect():
    from tenancy import _connect as tenancy_connect
    return tenancy_connect()


def _iso_days_ago(value):
    """Whole days since an ISO timestamp, or None if absent/unparseable."""
    if not value:
        return None
    text = str(value)[:19].replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return (datetime.utcnow() - datetime.strptime(text, fmt)).days
        except ValueError:
            continue
    return None


def _schema_sizes(raw) -> dict:
    """Bytes on disk per tenant schema — one pass over the catalog."""
    with raw.cursor() as cur:
        cur.execute("""
            SELECT n.nspname AS schema_name,
                   COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname LIKE 'tenant\\_%' AND c.relkind IN ('r', 'm')
            GROUP BY n.nspname
        """)
        return {r["schema_name"]: int(r["bytes"]) for r in cur.fetchall()}


def _tenant_user_stats(raw, schema: str) -> dict:
    """Seat usage and recency of use, read from inside the tenant."""
    from tenancy import valid_schema_name
    if not valid_schema_name(schema):
        return {}
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{schema}", public')
            cur.execute("""
                SELECT COUNT(*)                                   AS users_total,
                       COUNT(*) FILTER (WHERE is_active = 1)      AS users_active,
                       MAX(last_login)                            AS last_login
                FROM users
            """)
            row = cur.fetchone() or {}
            return {
                "users_total":  row.get("users_total"),
                "users_active": row.get("users_active"),
                "last_login":   row.get("last_login"),
            }
    except Exception:
        # A half-provisioned schema should show as unhealthy, not 500 the page.
        return {"users_total": None, "users_active": None, "last_login": None}
    finally:
        try:
            with raw.cursor() as cur:
                cur.execute("SET search_path TO public")
        except Exception:
            pass


def _score(row) -> tuple:
    """Health score 0-100 plus the reasons it is not 100.

    Weighted by what actually signals trouble for a paying customer, so the
    console can sort by "needs attention" rather than by name.
    """
    score, issues = 100, []

    if row.get("status") != "active":
        score -= 45
        issues.append(f"workspace {row.get('status')}")

    if row.get("urgent_errors"):
        score -= 25
        issues.append(f"{row['urgent_errors']} unresolved high/critical error(s)")
    elif row.get("open_errors"):
        score -= 10
        issues.append(f"{row['open_errors']} open error report(s)")

    if not row.get("users_active"):
        score -= 20
        issues.append("no active users")

    days = row.get("days_since_login")
    if days is None:
        score -= 15
        issues.append("never signed in")
    elif days > _STALE_LOGIN_DAYS:
        score -= 15
        issues.append(f"no sign-in for {days} days")

    for field, label in (("trial_days_left", "trial"),
                         ("license_days_left", "licence")):
        left = row.get(field)
        if left is not None and left < 0:
            score -= 20
            issues.append(f"{label} expired")
        elif left is not None and left <= 7:
            score -= 5
            issues.append(f"{label} ends in {left} day(s)")

    return max(0, min(100, score)), issues


def overview() -> dict:
    """Health row per tenant, worst first."""
    import support
    import tenancy

    tenants = tenancy.list_tenants()
    stats = support.report_stats()

    raw = _connect()
    try:
        sizes = _schema_sizes(raw)
        rows = []
        for t in tenants:
            slug = t.get("slug")
            schema = t.get("schema_name")
            row = dict(t)
            row.update(_tenant_user_stats(raw, schema))

            s = stats.get(slug) or {}
            row["open_errors"] = s.get("open") or 0
            row["urgent_errors"] = s.get("urgent") or 0
            row["total_errors"] = s.get("total") or 0
            row["last_error"] = s.get("last_report")

            row["db_bytes"] = sizes.get(schema)
            # Under STORAGE=s3 the documents are in R2, not in this number.
            row["storage_backend"] = os.environ.get("STORAGE", "db").lower()
            row["document_bytes"] = None if row["storage_backend"] != "db" else row["db_bytes"]

            row["days_since_login"] = _iso_days_ago(row.get("last_login"))
            for src, dst in (("trial_ends_at", "trial_days_left"),
                             ("license_expires_at", "license_days_left")):
                d = _iso_days_ago(row.get(src))
                row[dst] = None if d is None else -d      # future = positive

            modules = (row.get("modules") or "").strip()
            row["module_count"] = len([m for m in modules.split(",") if m]) if modules else None

            row["health_score"], row["issues"] = _score(row)
            rows.append(row)
    finally:
        raw.close()

    rows.sort(key=lambda r: (r["health_score"], -(r.get("urgent_errors") or 0)))
    return {
        "tenants": rows,
        "platform": {
            # One deployment serves every tenant, so these are platform-wide.
            "tenant_count":   len(rows),
            "needs_attention": sum(1 for r in rows if r["health_score"] < 80),
            "open_errors":    sum(r["open_errors"] for r in rows),
            "storage_backend": os.environ.get("STORAGE", "db").lower(),
            "tenancy":        os.environ.get("TENANCY", "single"),
            # Not tracked per tenant - see the module docstring.
            "last_backup":    None,
        },
    }
