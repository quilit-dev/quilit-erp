"""Compare two Postgres schemas and print exactly what differs.

Written for one job and kept for another.

The job it was written for: before Alembic can take over, we have to know that
`pg_baseline.sql` alone produces the same schema as `pg_baseline.sql` plus
`_ensure_pg_post_baseline`. If it does, the baseline is a true snapshot and the
cutover is a `stamp`. If it does not, the difference is a migration that has to
be written before anything is stamped --- because Alembic tracks version
numbers, not column presence, so stamping a schema that is missing something
converts a self-healing bug into a permanent one.

The job it is kept for: answering "is tenant X actually the shape head says it
is?" in thirty seconds. Today `_ensure_pg_post_baseline` is an idempotent
repair --- drop a column by hand and the next boot restores it. Under Alembic
that stops being true, and this is what replaces the reassurance.

Usage:
    python schema_diff.py SCHEMA_A SCHEMA_B          # compare two live schemas
    python schema_diff.py --build-and-compare        # the gating check

Exit code is 0 when the schemas match and 1 when they do not, so it can gate a
deploy or a test.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _connect():
    import psycopg
    from psycopg.rows import dict_row
    from database import _pg_dsn
    return psycopg.connect(_pg_dsn(), row_factory=dict_row, autocommit=True)


# ── reading a schema ─────────────────────────────────────────────────────────
def columns(conn, schema: str) -> dict:
    """{(table, column): 'type NULL/NOT NULL DEFAULT x'}.

    Types are compared as Postgres reports them, not as anybody wrote them, so
    `REAL` vs `DOUBLE PRECISION` shows up rather than hiding behind spelling.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT table_name, column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
             WHERE table_schema = %s
             ORDER BY table_name, column_name
        """, (schema,))
        out = {}
        for r in cur.fetchall():
            default = r["column_default"]
            # A sequence default names its own schema, so it always differs
            # between two schemas and would drown the real signal.
            if default and ("nextval(" in default or "::regclass" in default):
                default = "<sequence>"
            out[(r["table_name"], r["column_name"])] = "%s %s%s" % (
                r["data_type"],
                "NULL" if r["is_nullable"] == "YES" else "NOT NULL",
                " DEFAULT %s" % default if default else "")
        return out


def tables(conn, schema: str) -> set:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
             WHERE table_schema = %s AND table_type = 'BASE TABLE'
        """, (schema,))
        return {r["table_name"] for r in cur.fetchall()}


def indexes(conn, schema: str) -> dict:
    """{index_name: definition}, with the schema name normalised out."""
    with conn.cursor() as cur:
        cur.execute("SELECT indexname, indexdef FROM pg_indexes "
                    " WHERE schemaname = %s", (schema,))
        return {r["indexname"]: r["indexdef"].replace('"%s".' % schema, "")
                                             .replace("%s." % schema, "")
                for r in cur.fetchall()}


def constraints(conn, schema: str) -> set:
    """(table, type, name) for everything except foreign keys.

    FKs are excluded on purpose: the baseline emits them as deferred
    `ALTER TABLE ... ADD FOREIGN KEY` with server-generated names, so the names
    differ between schemas without the shape differing.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT table_name, constraint_type, constraint_name
              FROM information_schema.table_constraints
             WHERE table_schema = %s AND constraint_type <> 'FOREIGN KEY'
        """, (schema,))
        return {(r["table_name"], r["constraint_type"],
                 r["constraint_name"]) for r in cur.fetchall()}


# ── comparing ────────────────────────────────────────────────────────────────
def compare(conn, a: str, b: str) -> list:
    """Human-readable differences, a -> b. Empty means identical."""
    diffs = []

    ta, tb = tables(conn, a), tables(conn, b)
    for t in sorted(ta - tb):
        diffs.append("table missing from %s: %s" % (b, t))
    for t in sorted(tb - ta):
        diffs.append("table missing from %s: %s" % (a, t))

    ca, cb = columns(conn, a), columns(conn, b)
    shared_tables = ta & tb
    for key in sorted(set(ca) - set(cb)):
        if key[0] in shared_tables:
            diffs.append("column missing from %s: %s.%s" % (b, key[0], key[1]))
    for key in sorted(set(cb) - set(ca)):
        if key[0] in shared_tables:
            diffs.append("column missing from %s: %s.%s" % (a, key[0], key[1]))
    for key in sorted(set(ca) & set(cb)):
        if ca[key] != cb[key]:
            diffs.append("column differs %s.%s: %s=%r  %s=%r"
                         % (key[0], key[1], a, ca[key], b, cb[key]))

    ia, ib = indexes(conn, a), indexes(conn, b)
    for name in sorted(set(ia) - set(ib)):
        diffs.append("index missing from %s: %s" % (b, name))
    for name in sorted(set(ib) - set(ia)):
        diffs.append("index missing from %s: %s" % (a, name))

    ka, kb = constraints(conn, a), constraints(conn, b)
    for c in sorted(ka - kb):
        diffs.append("constraint missing from %s: %s %s on %s"
                     % (b, c[1], c[2], c[0]))
    for c in sorted(kb - ka):
        diffs.append("constraint missing from %s: %s %s on %s"
                     % (a, c[1], c[2], c[0]))
    return diffs


# ── the gating check ─────────────────────────────────────────────────────────
def build_and_compare(conn) -> list:
    """Is `pg_baseline.sql` alone the same as baseline + post-baseline?

    Everything about the Alembic cutover rests on this. If it is empty, the
    baseline is a true snapshot of head and live tenants can simply be stamped.
    If not, the difference is the first real migration and must be applied
    before anything is stamped.
    """
    from database import _apply_pg_baseline, _ensure_pg_post_baseline
    from tenant_context import valid_schema_name

    a, b = "diff_baseline_only", "diff_baseline_plus_post"
    assert valid_schema_name(a) and valid_schema_name(b)

    for schema in (a, b):
        with conn.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
            cur.execute(f'CREATE SCHEMA "{schema}"')

    import psycopg
    from database import _pg_dsn
    for schema, run_post in ((a, False), (b, True)):
        raw = psycopg.connect(_pg_dsn())
        try:
            with raw.cursor() as cur:
                cur.execute(f'SET search_path TO "{schema}"')
            _apply_pg_baseline(raw)
            if run_post:
                with raw.cursor() as cur:
                    cur.execute(f'SET search_path TO "{schema}"')
                _ensure_pg_post_baseline(raw)
            raw.commit()
        finally:
            raw.close()

    diffs = compare(conn, a, b)
    for schema in (a, b):
        with conn.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
    return diffs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("schema_a", nargs="?")
    ap.add_argument("schema_b", nargs="?")
    ap.add_argument("--build-and-compare", action="store_true",
                    help="build both schemas from scratch and compare them")
    args = ap.parse_args(argv)

    conn = _connect()
    try:
        if args.build_and_compare:
            print("building diff_baseline_only and diff_baseline_plus_post ...")
            diffs = build_and_compare(conn)
            label = "pg_baseline.sql  vs  pg_baseline.sql + _ensure_pg_post_baseline"
        else:
            if not (args.schema_a and args.schema_b):
                ap.error("give two schema names, or --build-and-compare")
            diffs = compare(conn, args.schema_a, args.schema_b)
            label = "%s  vs  %s" % (args.schema_a, args.schema_b)
    finally:
        conn.close()

    print("\n" + label)
    print("=" * len(label))
    if not diffs:
        print("identical -- nothing to migrate between them.")
        return 0
    print("%d difference(s):\n" % len(diffs))
    for d in diffs:
        print("  " + d)
    return 1


if __name__ == "__main__":
    sys.exit(main())
