"""SQL that only works on SQLite must not reach a Postgres deployment.

Every test in this suite runs on SQLite; the cloud runs on PostgreSQL. So a
SQLite-only construct passes the entire suite and fails only in production, on a
customer's screen. That has now happened twice:

  * `SELECT DISTINCT name ... ORDER BY sort_order` — swallowed by a bare except,
    so the inventory import wizard silently offered none of a tenant's own
    attribute columns.
  * `date('now','start of month')` — a 500 on the dashboard. dialect.py
    deliberately refuses to translate 'start of month' and leaves the SQLite
    text in place, which Postgres rejects with "function date(unknown, unknown)
    does not exist".

`dialect.UNTRANSLATED` lists constructs the translator will not handle, and its
docstring says they are "flagged ... so a grep finds them". This is that grep,
run automatically.

The list is not trusted blindly, because it goes stale: `strftime(` is still in
it although the translator learned to rewrite `%Y-%m` and `%Y` afterwards, and
several working call sites use it. So each construct is first put THROUGH the
translator; only the ones that come out unchanged are treated as unsupported and
scanned for. That keeps the guard correct as the translator improves, with no
list to maintain by hand.
"""
import pytest as _pytest

# Part of the Critical Regression Suite: run with `-m critical`.
pytestmark = _pytest.mark.critical

import pathlib
import re

import pytest

import dialect


BACKEND = pathlib.Path(__file__).resolve().parents[1]

# The translator itself and the compatibility shim legitimately contain these
# strings; so does the migration code, which only ever runs against SQLite.
EXEMPT = {"dialect.py", "db_compat.py", "database.py"}

_PG = dialect.get_dialect("postgres")


def _survives_translation(construct: str) -> bool:
    """True when the Postgres translator leaves `construct` in place.

    A construct it rewrites is safe to use; one it passes through unchanged
    reaches PostgreSQL verbatim and fails there.
    """
    probe = f"SELECT 1 FROM t WHERE x = {construct}'%Y-%m', y)" \
        if construct.endswith("(") else f"SELECT 1 FROM t WHERE x = date('now',{construct}month')"
    # translate() returns (sql, params, flag) — a 2-way unpack raises, and an
    # over-broad `except` then reports every construct as unsupported, which is
    # how the first version of this test flagged working strftime call sites.
    out = _PG.translate(probe, ())[0]
    return construct.lower() in out.lower()


UNSUPPORTED = [c for c in dialect.UNTRANSLATED if _survives_translation(c)]


def _sql_literals():
    """(file, line, text) for every string literal that looks like SQL.

    Anchored on a leading SQL keyword so prose and docstrings stay out — an
    earlier version of this scan matched English sentences containing the word
    "select".
    """
    pattern = re.compile(r'"""(.*?)"""|"([^"\n]*)"|\'([^\'\n]*)\'', re.S)
    verb = re.compile(r'\s*(SELECT|INSERT|UPDATE|DELETE|WITH|AND|OR|WHERE|'
                      r'ORDER BY|GROUP BY|FROM|SET|VALUES|\()', re.I)
    for path in BACKEND.rglob("*.py"):
        if "tests" in path.parts or path.name in EXEMPT:
            continue
        src = path.read_text(encoding="utf-8", errors="ignore")
        for m in pattern.finditer(src):
            text = next(g for g in m.groups() if g is not None)
            if verb.match(text):
                yield (path.relative_to(BACKEND).as_posix(),
                       src[:m.start()].count("\n") + 1, text)


def test_the_scanner_actually_sees_sql():
    """A scanner matching nothing would make every check below vacuous."""
    assert len(list(_sql_literals())) > 200


def test_something_is_actually_unsupported():
    """If the translator ever handled everything, the guard below would pass
    for the wrong reason. 'start of ' is the one with no translation and no
    hand-port, and it is what took the dashboard down."""
    assert "'start of " in UNSUPPORTED


@pytest.mark.parametrize("construct", UNSUPPORTED)
def test_no_unsupported_construct_reaches_a_query(construct):
    offenders = [
        f"{f}:{line} — {sql.strip()[:80]}"
        for f, line, sql in _sql_literals()
        if construct.lower() in sql.lower()
    ]

    assert not offenders, (
        f"{construct!r} passes through dialect.py untranslated, so PostgreSQL "
        f"receives it verbatim and rejects it. Compute the value in Python and "
        f"bind it as a parameter instead.\n  " + "\n  ".join(offenders))


def test_the_dashboard_regression_would_be_caught():
    """The exact line that took the dashboard down, proven detectable."""
    sql = "SELECT COUNT(*) FROM t WHERE date(x) >= date('now','start of month')"

    assert any(c.lower() in sql.lower() for c in UNSUPPORTED)
