"""
Phase 0 DB-abstraction seam — unit tests for db_compat + dialect.

Two things are proven here:
  1. CompatConn over real SQLite is transparent: the exact sqlite3 surface the
     routers use (db.execute(...).fetchone(), dict(row), row[0], row["c"],
     cur.lastrowid, executemany, commit) behaves identically through the wrapper.
  2. PostgresDialect rewrites the mechanical idioms to the expected SQL strings
     (pure string translation — no Postgres instance required).

See docs/SAAS_ARCHITECTURE.md §4.
"""
import sqlite3
import pytest

from db_compat import CompatConn, CompatRow
from dialect import SqliteDialect, PostgresDialect


# These are pure/in-memory unit tests — they need neither the FastAPI app nor the
# shared test database. Override conftest's autouse `fresh_db` (which rebuilds the
# on-disk _test_erp.db before every test) with a no-op so this module stays fast
# and can't race a concurrent full-suite run on that shared file.
@pytest.fixture(autouse=True)
def fresh_db():
    yield


# ── 1. CompatConn over SQLite is transparent ─────────────────────────────────

@pytest.fixture
def cc():
    raw = sqlite3.connect(":memory:")
    raw.row_factory = sqlite3.Row
    conn = CompatConn(raw, SqliteDialect())
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, qty REAL)")
    conn.commit()
    yield conn
    conn.close()


def test_insert_returns_lastrowid(cc):
    cur = cc.execute("INSERT INTO t (name, qty) VALUES (?, ?)", ("widget", 3))
    assert cur.lastrowid == 1
    cur2 = cc.execute("INSERT INTO t (name, qty) VALUES (?, ?)", ("gadget", 5))
    assert cur2.lastrowid == 2


def test_row_supports_name_positional_and_dict(cc):
    cc.execute("INSERT INTO t (name, qty) VALUES (?, ?)", ("widget", 3))
    cc.commit()
    row = cc.execute("SELECT id, name, qty FROM t WHERE name=?", ("widget",)).fetchone()
    assert row["name"] == "widget"      # by name
    assert row[1] == "widget"           # by position
    assert row["qty"] == 3
    d = dict(row)                        # dict() conversion
    assert d == {"id": 1, "name": "widget", "qty": 3}
    assert set(row.keys()) == {"id", "name", "qty"}


def test_fetchall_and_iteration(cc):
    cc.executemany("INSERT INTO t (name, qty) VALUES (?, ?)",
                   [("a", 1), ("b", 2), ("c", 3)])
    cc.commit()
    rows = cc.execute("SELECT name FROM t ORDER BY id").fetchall()
    assert [r["name"] for r in rows] == ["a", "b", "c"]
    # cursor iteration
    names = [r["name"] for r in cc.execute("SELECT name FROM t ORDER BY id")]
    assert names == ["a", "b", "c"]


def test_rowcount_and_rollback(cc):
    cc.executemany("INSERT INTO t (name, qty) VALUES (?, ?)", [("a", 1), ("b", 2)])
    cc.commit()
    cur = cc.execute("UPDATE t SET qty = qty + 1")
    assert cur.rowcount == 2
    cc.rollback()
    total = cc.execute("SELECT SUM(qty) AS s FROM t").fetchone()["s"]
    assert total == 3   # rollback undid the +1 on both rows


def test_fetchone_none_when_empty(cc):
    assert cc.execute("SELECT * FROM t WHERE id=?", (999,)).fetchone() is None


# ── 2. CompatRow direct behaviors ────────────────────────────────────────────

def test_compatrow_behaviors():
    r = CompatRow({"id": 7, "name": "x", "qty": 2})
    assert r["name"] == "x"
    assert r[0] == 7
    assert r[2] == 2
    assert "name" in r
    assert r.get("missing", "def") == "def"
    assert list(r.keys()) == ["id", "name", "qty"]
    assert dict(r) == {"id": 7, "name": "x", "qty": 2}
    assert list(r) == [7, "x", 2]   # iterates values, like sqlite3.Row
    assert len(r) == 3


# ── 3. PostgresDialect string translation (pure) ─────────────────────────────

@pytest.fixture
def pg():
    return PostgresDialect()


def test_placeholder_translation(pg):
    sql, _, _ = pg.translate("SELECT * FROM t WHERE a=? AND b=?", (1, 2))
    assert sql == "SELECT * FROM t WHERE a=%s AND b=%s"


def test_literal_percent_is_escaped(pg):
    sql, _, _ = pg.translate("SELECT * FROM t WHERE x LIKE 'a%b'", ())
    assert "%%" in sql and "a%%b" in sql


def test_qmark_inside_string_literal_is_left_alone(pg):
    sql, _, _ = pg.translate("SELECT '? literal' , c FROM t WHERE c=?", (1,))
    assert sql == "SELECT '? literal' , c FROM t WHERE c=%s"


def test_datetime_now(pg):
    sql, _, _ = pg.translate("SELECT datetime('now')", ())
    assert sql == "SELECT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')"


def test_datetime_now_with_modifier(pg):
    sql, _, _ = pg.translate("DELETE FROM x WHERE t < datetime('now', '-90 days')", ())
    assert sql == ("DELETE FROM x WHERE t < "
                   "to_char((now() - interval '90 day'), 'YYYY-MM-DD HH24:MI:SS')")


def test_date_now(pg):
    sql, _, _ = pg.translate("SELECT date('now')", ())
    assert sql == "SELECT to_char(now(), 'YYYY-MM-DD')"


def test_insert_or_ignore(pg):
    sql, _, capture = pg.translate(
        "INSERT OR IGNORE INTO m (name, applied_at) VALUES (?, ?)", ("x", "y"))
    assert sql.startswith("INSERT INTO m")
    assert "ON CONFLICT DO NOTHING" in sql
    # No RETURNING is appended after ON CONFLICT DO NOTHING.
    assert "RETURNING" not in sql


def test_plain_insert_gets_returning_and_capture(pg):
    sql, _, capture = pg.translate("INSERT INTO t (a) VALUES (?)", (1,))
    assert sql.endswith("RETURNING id")
    assert capture is True


def test_select_has_no_capture(pg):
    sql, _, capture = pg.translate("SELECT * FROM t", ())
    assert capture is False
    assert "RETURNING" not in sql


def test_datetime_now_with_param_modifier_not_substr(pg):
    # datetime('now', ?) is now-minus-a-parameterized-modifier, NOT a column
    # conversion — the date(col)/datetime(col)->substr rule must leave it alone
    # (the app computes such cutoffs in Python; the guard prevents mis-rewriting).
    sql, _, capture = pg.translate(
        "SELECT id FROM n WHERE created_at >= datetime('now', ?)", ("-5 hours",))
    assert "substr" not in sql.lower()
    assert capture is False


def test_datetime_col_still_becomes_substr(pg):
    sql, _, _ = pg.translate("SELECT datetime(created_at) FROM t", ())
    assert sql == "SELECT substr(created_at, 1, 19) FROM t"


def test_nested_comma_arg_still_becomes_substr(pg):
    # The comma is inside COALESCE(...) (depth 1), so it's a single-arg call.
    sql, _, _ = pg.translate("SELECT date(COALESCE(end_date, start_date)) FROM t", ())
    assert sql == "SELECT substr(COALESCE(end_date, start_date), 1, 10) FROM t"


def test_sqlite_dialect_is_identity():
    sd = SqliteDialect()
    sql, params, capture = sd.translate("INSERT INTO t (a) VALUES (?)", (1,))
    assert sql == "INSERT INTO t (a) VALUES (?)"
    assert capture is False


# ── 4. Phase-1 runtime-idiom translations (Postgres) ─────────────────────────

def test_strftime_year_month_on_column(pg):
    sql, _, _ = pg.translate("SELECT strftime('%Y-%m', paid_at) FROM t", ())
    assert sql == "SELECT substr(paid_at, 1, 7) FROM t"


def test_strftime_year_now(pg):
    sql, _, _ = pg.translate("SELECT strftime('%Y','now')", ())
    assert sql == "SELECT to_char(now(), 'YYYY')"


def test_date_func_on_column(pg):
    sql, _, _ = pg.translate("WHERE date(created_at) = '2026-01-01'", ())
    assert sql == "WHERE substr(created_at, 1, 10) = '2026-01-01'"


def test_date_func_with_nested_parens(pg):
    # The argument itself contains a function call with parentheses.
    sql, _, _ = pg.translate("SELECT date(COALESCE(end_date, start_date)) FROM t", ())
    assert sql == "SELECT substr(COALESCE(end_date, start_date), 1, 10) FROM t"


def test_sqlite_master_becomes_information_schema(pg):
    sql, _, _ = pg.translate(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", ("users",))
    assert "information_schema.tables" in sql
    assert "sqlite_master" not in sql.replace(") sqlite_master", "")  # only the alias
    assert sql.endswith("AND name=%s")


def test_is_not_value_becomes_is_distinct_from(pg):
    sql, _, _ = pg.translate("WHERE source_type IS NOT 'closing'", ())
    assert sql == "WHERE source_type IS DISTINCT FROM 'closing'"


def test_is_not_null_is_left_alone(pg):
    sql, _, _ = pg.translate("WHERE voided_at IS NOT NULL", ())
    assert sql == "WHERE voided_at IS NOT NULL"


def test_char_becomes_chr_but_not_to_char(pg):
    sql, _, _ = pg.translate("SELECT to_char(now(),'YYYY') , char(10)", ())
    assert "chr(10)" in sql
    assert "to_char(" in sql            # to_char must be untouched


def test_autoincrement_becomes_identity(pg):
    sql, _, _ = pg.translate(
        "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)", ())
    assert "GENERATED BY DEFAULT AS IDENTITY" in sql
    assert "AUTOINCREMENT" not in sql


def test_pragma_setter_is_noop(pg):
    sql, _, _ = pg.translate("PRAGMA foreign_keys=OFF", ())
    assert sql == "SELECT 1"


def test_pragma_integrity_check_returns_ok(pg):
    sql, _, _ = pg.translate("PRAGMA integrity_check", ())
    assert sql == "SELECT 'ok' AS integrity_check"


def test_drop_table_gets_cascade(pg):
    sql, _, _ = pg.translate("DROP TABLE IF EXISTS users", ())
    assert sql == "DROP TABLE IF EXISTS users CASCADE"


def test_insert_or_replace_becomes_upsert(pg):
    sql, _, _ = pg.translate(
        "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", ("k", "v"))
    assert sql.startswith("INSERT INTO settings (key,value)")
    assert "ON CONFLICT (key) DO UPDATE SET value=excluded.value" in sql


def test_param_is_null_gets_cast(pg):
    sql, _, _ = pg.translate("WHERE ? IS NULL", (None,))
    assert sql == "WHERE CAST(%s AS TEXT) IS NULL"

# ── LIKE means different things on the two engines ───────────────────────

# SQLite's LIKE ignores ASCII case; Postgres's does not. Every search box in the
# app compiles to `col LIKE ?` — 119 of them across 21 routers — so a product
# called "Ink Tube" was found by "Ink Tube" and not by "ink tube", in production
# only, because every test here runs on SQLite where LIKE already behaved the
# way everyone assumed.
#
# The translation is the guard, not an endpoint test: an endpoint test on SQLite
# passes whether or not this exists.

def test_like_becomes_ilike(pg):
    sql, _, _ = pg.translate("SELECT * FROM t WHERE name LIKE ?", ("%ink%",))
    assert sql == "SELECT * FROM t WHERE name ILIKE %s"


def test_not_like_becomes_not_ilike(pg):
    # The same statement about the same comparison, so it moves with it.
    sql, _, _ = pg.translate("SELECT 1 WHERE a NOT LIKE ?", ("x",))
    assert sql == "SELECT 1 WHERE a NOT ILIKE %s"


def test_lowercase_like_is_translated_too(pg):
    sql, _, _ = pg.translate("select 1 where a like ?", ("x",))
    assert "ILIKE" in sql and " like " not in sql


def test_the_word_like_inside_a_string_is_data(pg):
    # A note that says "I like this" is text a person wrote, not an operator.
    sql, _, _ = pg.translate(
        "SELECT 'I like this' FROM t WHERE note LIKE ?", ("x",))

    assert "'I like this'" in sql
    assert "note ILIKE" in sql


def test_an_escaped_quote_does_not_confuse_the_scanner(pg):
    # `''` is one literal quote inside a string. Mis-reading it flips the
    # scanner's idea of where the string ends, and every LIKE after it is
    # treated as data.
    sql, _, _ = pg.translate(
        "SELECT 'it''s like that' FROM t WHERE a LIKE ? AND b LIKE ?", ("x", "y"))

    assert "'it''s like that'" in sql
    assert sql.count("ILIKE") == 2


def test_a_column_called_like_something_is_untouched(pg):
    # \b anchors the operator, so `dislike` and `liked` are not operators.
    sql, _, _ = pg.translate("SELECT liked, dislike FROM t", ())

    assert sql == "SELECT liked, dislike FROM t"


def test_sqlite_leaves_like_alone():
    # SQLite has no ILIKE, and does not need one.
    sql, _, _ = SqliteDialect().translate("WHERE a LIKE ?", ("x",))

    assert sql == "WHERE a LIKE ?"


def test_executescript_gets_it_too(pg):
    # Same rewrite on the DDL path, so the two cannot disagree.
    assert "ILIKE" in pg.translate_many("SELECT 1 WHERE a LIKE 'x'")
