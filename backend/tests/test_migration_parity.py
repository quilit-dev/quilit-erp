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
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import pathlib
import re

import pytest

_DB = pathlib.Path(__file__).resolve().parents[1] / "database.py"

# Columns on shared tables that BOTH backends must create. Add a row here
# whenever a migration touches one of these tables.
_REQUIRED = [
    # A purchase can be reversed, the way an invoice can.
    ("purchases", "voided_at"),
    ("purchases", "void_reason"),
    # A purchase is a document with lines. The header carries the money the
    # supplier and insights aggregates read; the lines carry everything
    # per-item. `landed_unit_cost` and `additional_cost_share` are the frozen
    # receipt facts a reversal has to un-blend with.
    ("purchases", "subtotal"),
    ("purchases", "tax_total"),
    ("purchase_items", "discount"),
    ("purchase_items", "discount_pct"),
    ("purchase_items", "tax_amount"),
    ("purchase_items", "line_total"),
    ("purchase_items", "additional_cost_share"),
    ("purchase_items", "landed_unit_cost"),
    ("purchase_items", "stock_updated"),
    # A corrected till sale points at the one it replaced, so the pair can be
    # told apart from a customer who came back and bought twice.
    ("pos_sales", "amended_from"),
    ("invoice_items", "inventory_id"),
    ("invoice_items", "promotion_id"),
    ("invoice_items", "discount_pct"),
    ("quotation_items", "inventory_id"),
    ("quotation_items", "promotion_id"),
    ("quotation_items", "discount_pct"),
    # Where an invoice came from, so a POS or service document stays traceable
    # once every invoice draws from one number series.
    ("invoices", "source_type"),
    ("invoices", "source_reference"),
    ("invoices", "service_job_id"),
    # Whether a recurring cost is spread across the period it covers.
    ("recurring_expenses", "spread_across_period"),
    # Which payment an allocation row belongs to, so a receipt can be written
    # for the payment the customer actually made.
    ("invoice_payments", "customer_payment_id"),
    ("customer_payments", "plan_id"),
    # The currency a sales document was agreed in, beside its base figures.
    ("invoices", "currency"),
    ("invoices", "exchange_rate"),
    ("invoices", "txn_amount"),
    ("invoice_items", "txn_unit_price"),
    ("quotations", "currency"),
    ("quotations", "txn_total"),
    ("quotation_items", "txn_unit_price"),
    ("service_jobs", "currency"),
    ("service_jobs", "txn_total"),
]


# Tables introduced after the squashed baseline. A table added to the SQLite
# chain alone fails the same way a column does — on the first query, in
# production only.
_REQUIRED_TABLES = [
    "company_logo",
    # A purchase is a document with lines, like an invoice.
    "purchase_items",
    # A payment plan against one invoice.
    "invoice_installments",
    # Stock held for a named customer.
    "stock_reservations",
    # A payment plan against the customer's account.
    "client_payment_plans",
    "client_plan_installments",
    # One payment, however many invoices it settled.
    "customer_payments",
    # Currency differences an accountant can work with.
    "fx_revaluation_runs",
    "fx_reconciliations",
]


# Chart accounts and role mappings added after the baseline. An account that
# reaches SQLite alone means postings on the hosted deployment land somewhere
# else — silently, and only for the currency nobody tested.
_REQUIRED_LITERALS = [
    "1020",        # Cash — EUR
    "cash_eur",    # the role that points at it
]


@pytest.mark.parametrize("literal", _REQUIRED_LITERALS)
def test_literal_reaches_both_backends(source, pg_block, literal):
    chain = source[:source.index("def _ensure_pg_post_baseline(")]
    assert literal in chain, f"{literal} missing from the SQLite chain"
    assert literal in pg_block, f"{literal} missing from the PostgreSQL path"


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


@pytest.mark.parametrize("table", _REQUIRED_TABLES)
def test_table_reaches_both_backends(source, pg_block, table):
    """A new table is the same trap as a new column: the SQLite chain creates
    it, PostgreSQL never replays that chain, and the miss only shows up as a
    500 for a hosted customer."""
    assert f"CREATE TABLE IF NOT EXISTS {table}" in pg_block, (
        f"{table} is not created by _ensure_pg_post_baseline — PostgreSQL "
        f"deployments will 500 on the first query against it")
    assert f"CREATE TABLE IF NOT EXISTS {table}" in source, (
        f"{table} is not created for SQLite either")


def test_postgres_path_uses_if_not_exists(pg_block):
    """The function runs on every boot and on every tenant provision, so each
    statement has to be idempotent or the second run raises."""
    alters = re.findall(r"ALTER TABLE[^\"']*", pg_block)
    # `DROP COLUMN IF EXISTS` is idempotent too, and does not contain the
    # literal "IF NOT EXISTS" the ADD form uses.
    missing = [a for a in alters
               if "IF NOT EXISTS" not in a and "IF EXISTS" not in a]
    assert not missing, f"non-idempotent ALTER in the Postgres path: {missing}"


# ── Ordering inside the PostgreSQL path ──────────────────────────────────────
# `_ensure_pg_post_baseline` is one long linear block, and statements that
# WRITE to a table had drifted above the line that CREATES it. On a database
# that already had the table nothing failed, so the only place it showed was a
# genuinely fresh Postgres — which is exactly what a new deployment is.
#
# These read the block as text. They cannot prove the SQL is valid, but they
# catch the two mistakes that actually happened.

_WRITE = re.compile(r"(?:INSERT INTO|UPDATE)\s+([a-z_]+)", re.I)
_CREATE = re.compile(r"CREATE TABLE IF NOT EXISTS\s+([a-z_]+)", re.I)


def test_nothing_writes_to_a_table_before_it_is_created(pg_block):
    created = {}
    for m in _CREATE.finditer(pg_block):
        created.setdefault(m.group(1).lower(), m.start())

    too_early = []
    for m in _WRITE.finditer(pg_block):
        table = m.group(1).lower()
        if table in created and m.start() < created[table]:
            too_early.append((table, m.start(), created[table]))

    assert too_early == [], (
        "these are written to before the CREATE that makes them: "
        + ", ".join(t for t, _, _ in too_early))


def test_no_boolean_literals_where_the_column_is_an_integer(pg_block):
    """`is_system` and `is_active` are INTEGER in this schema, mirroring
    SQLite. Passing `true` raises DatatypeMismatch and the app never starts."""
    offenders = [
        line.strip() for line in pg_block.splitlines()
        if "chart_of_accounts" in line or "'debit'" in line or "'credit'" in line
        if ",true," in line.replace(" ", "") or ",false," in line.replace(" ", "")
    ]
    assert offenders == [], offenders
