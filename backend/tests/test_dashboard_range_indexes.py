"""Every date column the dashboard filters by, indexed on both backends.

Six unbounded tables --- sales, invoices, expenses, payments, stock movements
--- are read by the front page through a date range, and none of the six
columns carried an index. That costs nothing at three tenants with small
tables, which is exactly why it would have gone unnoticed until it was a
support ticket instead of a migration.

The reason this has its own test rather than trusting the migration: an index
is invisible. A missing column raises on the first INSERT; a missing index
raises nothing, ever. It just gets slower, on one backend, on the tenants with
the most data --- and `test_migration_parity.py` tracks columns, so nothing
else here would notice.

The three places a schema change has to land are asserted separately, because
they are three separate mechanisms and losing any one of them is a different
bug: the SQLite chain (local dev and the whole test suite), the
`_ensure_pg_post_baseline` mirror (what the LIVE tenants actually run), and
`pg_baseline.sql` (every tenant provisioned from here on).
"""
import os
import pathlib
import re

import pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = pytest.mark.critical

_DB_PY = pathlib.Path(__file__).resolve().parents[1] / "database.py"
_BASELINE = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "pg_baseline.sql"

_PG = (os.environ.get("DB_BACKEND", "sqlite").lower()
       in ("postgres", "postgresql", "pg"))

# name -> (table, column). The column matters: an index on the wrong one is
# still an index, and would satisfy a name-only check while helping nothing.
INDEXES = {
    "idx_pos_sales_created":        ("pos_sales", "created_at"),
    "idx_invoices_created":         ("invoices", "created_at"),
    "idx_invoices_due_date":        ("invoices", "due_date"),
    "idx_expenses_date":            ("expenses", "date"),
    "idx_invoice_payments_paid_at": ("invoice_payments", "paid_at"),
    "idx_stock_movements_created":  ("stock_movements", "created_at"),
}


@pytest.mark.skipif(_PG, reason="sqlite_master; the Postgres twin is below")
@pytest.mark.parametrize("name", sorted(INDEXES))
def test_sqlite_actually_creates_it(db, name):
    """Behavioural, not textual: this reads the schema the suite is running on."""
    table, column = INDEXES[name]
    row = db.execute(
        "SELECT tbl_name, sql FROM sqlite_master "
        " WHERE type = 'index' AND name = ?", (name,)).fetchone()
    assert row, "%s was never created; the dashboard scans %s" % (name, table)
    assert row["tbl_name"] == table
    assert column in (row["sql"] or ""), \
        "%s exists but not on %s.%s" % (name, table, column)


@pytest.mark.parametrize("name", sorted(INDEXES))
def test_the_postgres_mirror_has_it_too(name):
    """`_ensure_pg_post_baseline` is what the three live tenants run on deploy.

    Read as text --- this is the same technique `test_migration_parity.py`
    uses, and for the same reason: it must run on a machine with no Postgres.
    The Postgres-gated test below is the one that executes it.
    """
    src = _DB_PY.read_text(encoding="utf-8")
    start = src.index("def _ensure_pg_post_baseline")
    mirror = src[start:]
    table, column = INDEXES[name]
    pattern = r"CREATE INDEX IF NOT EXISTS %s ON %s\(%s\)" % (name, table, column)
    assert re.search(pattern, mirror), (
        "%s is in the SQLite chain but not in the Postgres mirror. Existing "
        "tenants would never get it, and only they have enough rows to care."
        % name)


@pytest.mark.parametrize("name", sorted(INDEXES))
def test_a_newly_provisioned_tenant_gets_it(name):
    """`pg_baseline.sql` is regenerated, not hand-edited --- so a missing entry
    here means the regeneration was skipped after the migration was written."""
    table, column = INDEXES[name]
    sql = _BASELINE.read_text(encoding="utf-8")
    assert re.search(r"CREATE INDEX %s ON %s\(%s\)" % (name, table, column), sql), \
        "%s missing from pg_baseline.sql --- re-run generate_pg_baseline.py" % name


def test_the_migration_is_recorded_as_applied_in_the_baseline():
    """A baseline that creates the index but does not record the migration
    would make every fresh tenant replay it. Harmless here, because the
    statements are IF NOT EXISTS --- but the ledger is the thing that keeps it
    harmless, and it is generated, so it can silently fall out of step."""
    assert "'182_dashboard_range_indexes'" in _BASELINE.read_text(encoding="utf-8")


# ── The ones that execute rather than read ───────────────────────────────────
@pytest.mark.skipif(not _PG, reason="needs DB_BACKEND=postgres")
@pytest.mark.parametrize("name", sorted(INDEXES))
def test_postgres_really_has_it(db, name):
    table, column = INDEXES[name]
    row = db.execute(
        "SELECT indexdef FROM pg_indexes "
        " WHERE indexname = ? AND tablename = ?", (name, table)).fetchone()
    assert row, "%s does not exist in this Postgres schema" % name
    assert column in row["indexdef"],         "%s exists but not on %s.%s" % (name, table, column)


@pytest.mark.skipif(not _PG, reason="needs DB_BACKEND=postgres")
def test_a_deploy_puts_back_one_that_is_missing():
    """This is the test that actually executes the Postgres mirror.

    The tests above read the schema the per-test template was built from,
    which is `pg_baseline.sql` --- the path a NEW tenant takes. The three live
    tenants take the other path: they already exist, so the only code that can
    ever give them this index is `_ensure_pg_post_baseline`, running on
    deploy. Dropping the index and running that function is the only way to
    tell the two paths apart, and the mirror losing a statement the SQLite
    chain has is the exact bug that cost the fixed-asset ledger.

    It talks to DATABASE_URL directly rather than through the `db` fixture,
    because the fixture hands out a per-test clone and the mirror runs against
    the real connection.
    """
    import psycopg

    import database

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        cur = conn.cursor()
        cur.execute("DROP INDEX IF EXISTS idx_pos_sales_created")
        conn.commit()
        cur.execute("SELECT 1 FROM pg_indexes WHERE indexname = %s",
                    ("idx_pos_sales_created",))
        assert cur.fetchone() is None, "setup: the index should be gone"

        database._ensure_pg_post_baseline(conn)

        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s",
                    ("idx_pos_sales_created",))
        row = cur.fetchone()
        assert row, (
            "a deploy did not restore the index, so the live tenants --- all "
            "of which were created before this migration existed --- will "
            "never get it, and nothing anywhere would report that.")
        assert "created_at" in row[0]
