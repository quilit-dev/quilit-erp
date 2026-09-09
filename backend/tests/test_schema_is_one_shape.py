"""The two Postgres paths must build the same schema --- executed, not grepped.

`test_migration_parity.py` reads `database.py` as TEXT and asserts that column
names appear in both migration paths. It is honest about its own weakness: a
substring match passes if the name occurs in a comment, and it cannot notice a
type that differs, an index that is missing, or a column nobody thought to add
to its hand-maintained list.

This runs both paths against a real database and compares the result:

    pg_baseline.sql            (what a NEW schema is built from)
    pg_baseline.sql + _ensure_pg_post_baseline
                               (what an EXISTING schema gets on every boot)

They have to be identical, and this asserts it rather than reasoning about it.

Two things depend on that being true. Day to day: a tenant provisioned today
must be the same shape as one provisioned last year, or a query works for one
customer and 500s for another. And for the Alembic cutover: if the baseline is
a true snapshot of head, the three live tenants can simply be STAMPED. If it is
not, the difference is a migration that has to be applied first --- because
Alembic tracks version numbers, not column presence, so stamping a schema that
is missing something turns a self-healing bug into a permanent one.
"""
import os
import sys

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="compares two Postgres schemas; there is nothing to compare on SQLite",
)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "migrations"))


@pytest.fixture(autouse=True)
def fresh_db():
    yield                       # this file manages its own schemas


def test_the_baseline_alone_equals_baseline_plus_post_baseline():
    """The gate for the whole Alembic cutover."""
    import schema_diff
    conn = schema_diff._connect()
    try:
        diffs = schema_diff.build_and_compare(conn)
    finally:
        conn.close()

    assert not diffs, (
        "pg_baseline.sql and _ensure_pg_post_baseline build DIFFERENT schemas, "
        "so a freshly provisioned tenant is not the same shape as an existing "
        "one --- and the Alembic baseline is not a true snapshot of head. Each "
        "difference below is either a missing regeneration of pg_baseline.sql "
        "or a real migration:\n\n  " + "\n  ".join(diffs))


def test_a_freshly_provisioned_tenant_matches_the_baseline():
    """Provisioning must not quietly produce a different shape."""
    import psycopg
    import schema_diff
    import tenancy
    from database import _pg_dsn, _apply_pg_baseline
    from tenant_context import IS_SCHEMA_TENANCY

    if not IS_SCHEMA_TENANCY:
        pytest.skip("schema tenancy only")

    slug = "shapecheck"
    t = tenancy.provision_tenant(slug, name="Shape Check")

    conn = schema_diff._connect()
    try:
        with conn.cursor() as cur:
            cur.execute('DROP SCHEMA IF EXISTS ref_head CASCADE')
            cur.execute('CREATE SCHEMA ref_head')
        raw = psycopg.connect(_pg_dsn())
        try:
            with raw.cursor() as cur:
                cur.execute('SET search_path TO ref_head')
            _apply_pg_baseline(raw)
            raw.commit()
        finally:
            raw.close()

        diffs = schema_diff.compare(conn, "ref_head", t["schema_name"])
        with conn.cursor() as cur:
            cur.execute('DROP SCHEMA IF EXISTS ref_head CASCADE')
    finally:
        conn.close()

    assert not diffs, (
        "a tenant provisioned right now differs from the baseline it was built "
        "from:\n\n  " + "\n  ".join(diffs))


def test_public_is_a_superset_not_a_different_shape():
    """`public` carries the shared catalogs on top of a full business schema.

    Extra is fine --- missing is not. `get_db` falls back to `public` when a
    schema cannot be resolved, and Postgres resolves unqualified names against
    the first schema in the search_path that exists, so anything absent from
    `public` is a 500 waiting for whichever request lands there.
    """
    import psycopg
    import schema_diff
    from database import _pg_dsn, _apply_pg_baseline

    conn = schema_diff._connect()
    try:
        with conn.cursor() as cur:
            cur.execute('DROP SCHEMA IF EXISTS ref_head CASCADE')
            cur.execute('CREATE SCHEMA ref_head')
        raw = psycopg.connect(_pg_dsn())
        try:
            with raw.cursor() as cur:
                cur.execute('SET search_path TO ref_head')
            _apply_pg_baseline(raw)
            raw.commit()
        finally:
            raw.close()

        diffs = schema_diff.compare(conn, "ref_head", "public")
        with conn.cursor() as cur:
            cur.execute('DROP SCHEMA IF EXISTS ref_head CASCADE')
    finally:
        conn.close()

    # "missing from public" is the direction that hurts.
    missing = [d for d in diffs if "missing from public" in d]
    assert not missing, (
        "`public` is missing part of the schema. get_db falls back to it, so "
        "this is a 500 waiting to happen:\n\n  " + "\n  ".join(missing))
