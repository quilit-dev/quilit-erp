"""An apostrophe in a comment must not swallow the placeholders after it.

`qmark_to_format` turns SQLite's `?` into psycopg's `%s`, skipping anything
inside a single-quoted string literal. It did not know what a comment was --- so
the apostrophe in "today's takings", written in prose inside a `--` comment,
opened a string literal that never closed. Every `?` below it stayed a `?`,
psycopg counted zero placeholders against the two parameters it was handed, and
refused the query.

That is a whole-statement failure on Postgres from valid SQL, and it is
invisible locally: SQLite binds `?` natively and never calls this function, so
2,898 tests pass and the customer gets a 500.

It reached a live tenant exactly that way. The dashboard's POS card had carried
that comment for months with no placeholders after it; the first `?` added below
it took the front page down for everyone on Postgres.

The tests below are written as the shapes that can recur, not as one regression:
an apostrophe in prose, a contraction, a possessive, a block comment, and a
comment that is the last thing in the statement.
"""
import pytest

from dialect import qmark_to_format as q

pytestmark = pytest.mark.critical


# ── the exact shape that broke production ────────────────────────────────────
def test_an_apostrophe_in_a_line_comment_does_not_eat_the_placeholders():
    sql = ("SELECT COUNT(*) FROM pos_sales\n"
           "  -- today's takings, the same money twice\n"
           "  WHERE created_at >= ? AND created_at < ?")
    out = q(sql)
    assert out.count("%s") == 2, out
    assert "?" not in out


def test_the_comment_itself_survives():
    """Skipped, not stripped: these comments explain decisions, and a query in
    a slow-query log is worth reading."""
    sql = "SELECT 1\n  -- today's takings\n  WHERE a = ?"
    out = q(sql)
    assert "today's takings" in out


@pytest.mark.parametrize("comment", [
    "-- today's takings",
    "-- don't count a return as a sale",
    "-- the till's own running total",
    "-- it's one apostrophe that does it",
    "-- three ' in ' one ' comment",
])
def test_odd_numbers_of_apostrophes_in_prose(comment):
    out = q("SELECT 1 FROM t\n  %s\n  WHERE a = ? AND b = ?" % comment)
    assert out.count("%s") == 2, "%r swallowed the placeholders" % comment


def test_a_block_comment_too():
    sql = "SELECT 1 FROM t\n  /* the till's total, not the day's */\n  WHERE a = ?"
    assert q(sql).count("%s") == 1


def test_a_comment_that_never_ends():
    """A `--` on the last line has no newline after it. Running off the end of
    the string must not raise."""
    assert q("SELECT 1 WHERE a = ?\n  -- what's left").count("%s") == 1


def test_an_unclosed_block_comment_does_not_raise():
    assert q("SELECT 1 WHERE a = ?\n  /* what's left").count("%s") == 1


# ── the behaviour that must NOT have been broken to fix the above ────────────
def test_a_question_mark_inside_a_real_string_is_still_left_alone():
    out = q("SELECT * FROM t WHERE note = 'why? because' AND id = ?")
    assert out.count("%s") == 1
    assert "'why? because'" in out


def test_a_doubled_quote_inside_a_string_still_works():
    out = q("SELECT * FROM t WHERE name = 'it''s fine' AND id = ?")
    assert out.count("%s") == 1
    assert "'it''s fine'" in out


def test_a_double_dash_inside_a_string_is_not_a_comment():
    """`'a--b'` is data. Treating it as a comment would drop the rest of the
    statement's placeholders in the other direction."""
    out = q("SELECT * FROM t WHERE code = 'a--b' AND id = ? AND x = ?")
    assert out.count("%s") == 2, out


def test_percent_signs_are_still_escaped_everywhere():
    """psycopg scans the whole query for `%`, comments included --- an
    unescaped one there is as fatal as anywhere else."""
    out = q("SELECT 1\n  -- 50% of the time\n  WHERE name LIKE '%x%' AND id = ?")
    assert "50%% of the time" in out
    assert "'%%x%%'" in out
    assert out.count("%s") == 1


def test_a_negative_number_is_not_a_comment():
    out = q("SELECT a - -1 FROM t WHERE id = ?")
    assert out.count("%s") == 1


def test_a_division_is_not_a_block_comment():
    out = q("SELECT a / b FROM t WHERE id = ? AND c = ?")
    assert out.count("%s") == 2
