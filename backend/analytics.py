"""
Per-business analytics — how is this customer actually using Quilit?

Sourced entirely from data the ERP already records. Timestamps are ISO TEXT
columns, so grouping is a substring rather than a date cast: substr(x,1,10)
is the day and substr(x,1,7) the month, which sorts correctly because ISO
dates sort lexicographically.

The most useful signal here is `module_usage`, read from audit_log.module:
it reports what the customer TOUCHES, not what they bought. A tenant licensed
for Manufacturing with zero manufacturing events is either mis-sold or stuck,
and both are worth a phone call.

Deliberately NOT reported, because nothing records them today:
  * API usage         - no request counter exists. Adding one means middleware
                        writing a per-tenant tally; worth doing, but it is
                        instrumentation, not a query.
  * Performance       - no timing is collected per tenant.
  * Storage growth    - only the CURRENT size is knowable. History needs
                        periodic snapshots, which nothing writes yet.
These return null rather than a plausible-looking zero: a chart that invents
a flat line is worse than one that says "not measured".
"""
from tenancy import schema_for_slug, valid_schema_name, valid_slug

_DAILY_DAYS   = 30
_MONTHLY_MONTHS = 12


def _connect():
    from tenancy import _connect as tenancy_connect
    return tenancy_connect()


def _rows(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]
    except Exception:
        # A tenant provisioned before a given table existed should degrade to
        # an empty series, not take the whole page down.
        return []


def for_tenant(slug: str) -> dict:
    if not valid_slug(slug):
        raise ValueError(f"Invalid tenant slug: {slug!r}")
    schema = schema_for_slug(slug)
    if not valid_schema_name(schema):
        raise ValueError(f"Unsafe schema name: {schema!r}")

    raw = _connect()
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{schema}", public')

            # Daily activity - every audited write, by day.
            daily = _rows(cur, """
                SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS events
                FROM audit_log
                WHERE created_at >= to_char(now() - interval '%s days', 'YYYY-MM-DD')
                GROUP BY day ORDER BY day
            """ % _DAILY_DAYS)

            # What they actually use, vs what they were licensed for.
            modules = _rows(cur, """
                SELECT module, COUNT(*) AS events, MAX(created_at) AS last_used
                FROM audit_log
                WHERE created_at >= to_char(now() - interval '90 days', 'YYYY-MM-DD')
                GROUP BY module ORDER BY events DESC
            """)

            # Cash actually collected, by month - the ERP's own revenue view.
            revenue = _rows(cur, """
                SELECT substr(paid_at, 1, 7) AS month,
                       ROUND(SUM(amount)::numeric, 2) AS collected,
                       COUNT(*) AS payments
                FROM invoice_payments
                WHERE paid_at IS NOT NULL
                GROUP BY month ORDER BY month DESC LIMIT %s
            """, (_MONTHLY_MONTHS,))

            # Seats over time.
            growth = _rows(cur, """
                SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS added
                FROM users WHERE created_at IS NOT NULL AND deleted_at IS NULL
                GROUP BY month ORDER BY month
            """)

            # Sign-ins, and how many distinct people that is.
            logins = _rows(cur, """
                SELECT substr(created_at, 1, 10) AS day,
                       COUNT(*) AS sessions,
                       COUNT(DISTINCT user_id) AS users
                FROM user_sessions
                WHERE created_at >= to_char(now() - interval '%s days', 'YYYY-MM-DD')
                GROUP BY day ORDER BY day
            """ % _DAILY_DAYS)

            totals = (_rows(cur, """
                SELECT (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL)      AS users_total,
                       (SELECT COUNT(*) FROM users WHERE is_active = 1
                                                     AND deleted_at IS NULL)      AS users_active,
                       (SELECT COUNT(*) FROM audit_log)                           AS events_total,
                       (SELECT COUNT(*) FROM invoices)                            AS invoices_total,
                       (SELECT COUNT(*) FROM clients)                             AS clients_total
            """) or [{}])[0]
    finally:
        raw.close()

    # Error frequency lives in the shared catalog, not the tenant schema.
    import support
    errors = (support.report_stats() or {}).get(slug) or {}

    return {
        "slug": slug,
        "daily_activity": daily,
        "module_usage": modules,
        "revenue_trend": list(reversed(revenue)),   # chronological for charting
        "user_growth": growth,
        "login_activity": logins,
        "totals": totals,
        "errors": {
            "total":  errors.get("total") or 0,
            "open":   errors.get("open") or 0,
            "urgent": errors.get("urgent") or 0,
            "last":   errors.get("last_report"),
        },
        # Honest nulls - see the module docstring.
        "not_measured": {
            "api_usage":      "no per-tenant request counter is recorded",
            "performance":    "no per-tenant timing is collected",
            "storage_growth": "only the current size is known; no history is snapshotted",
        },
    }
