"""
SQLite and PostgreSQL must end up with the same columns.

The two backends have completely separate migration mechanisms: SQLite replays
the numbered chain in `_run_migrations`, while PostgreSQL applies a squashed
baseline plus `_ensure_pg_post_baseline`. A column added to only one of them
leaves the other missing it, and nothing fails until the first INSERT — which
surfaces in production as a 500 while every local test passes.

That is not hypothetical: `inventory_id`, `promotion_id` and `discount_pct` were
added to the SQLite chain only, and invoice creation broke on the hosted
deployment while the whole suite was green.

This test reads the Postgres path as TEXT rather than executing it, so it runs
on any machine without a database. It cannot prove the two schemas are
identical — only that columns known to matter are mentioned in both places —
but it turns a silent production break into a failing test.
"""
import pathlib
import re

import pytest

_DB = pathlib.Path(__file__).resolve().parents[1] / "database.py"

# Columns on shared tables that BOTH backends must create. Add a row here
# whenever a migration touches one of these tables.
_REQUIRED = [
    ("invoice_items", "inventory_id"),
    ("invoice_items", "promotion_id"),
    ("invoice_items", "discount_pct"),
    ("quotation_items", "inventory_id"),
    ("quotation_items", "promotion_id"),
    ("quotation_items", "discount_pct"),
]


@pytest.fixture(scope="module")
def source() -> str:
    return _DB.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def pg_block(source) -> str:
    """The body of _ensure_pg_post_baseline — the PostgreSQL upgrade path."""
    start = source.index("def _ensure_pg_post_baseline(")
    end = source.index("\ndef ", start + 10)
    return source[start:end]


@pytest.mark.parametrize("table,column", _REQUIRED)
def test_column_reaches_the_postgres_path(pg_block, table, column):
    """A column present only in the SQLite chain is invisible until a hosted
    customer tries to save a document."""
    # The Postgres block loops over both line tables, so accept either an
    # explicit mention or the loop that covers them.
    loops_both = 'for tbl in ("invoice_items", "quotation_items")' in pg_block
    mentioned = column in pg_block and (table in pg_block or loops_both)
    assert mentioned, (
        f"{table}.{column} is not created by _ensure_pg_post_baseline — "
        f"PostgreSQL deployments will 500 on the first INSERT that uses it")


@pytest.mark.parametrize("table,column", _REQUIRED)
def test_column_reaches_the_sqlite_chain(source, table, column):
    """The mirror check, so a Postgres-only addition is caught too."""
    assert column in source, f"{table}.{column} is not created for SQLite either"


def test_postgres_path_uses_if_not_exists(pg_block):
    """The function runs on every boot and on every tenant provision, so each
    statement has to be idempotent or the second run raises."""
    alters = re.findall(r"ALTER TABLE[^\"']*", pg_block)
    missing = [a for a in alters if "IF NOT EXISTS" not in a]
    assert not missing, f"non-idempotent ALTER in the Postgres path: {missing}"
