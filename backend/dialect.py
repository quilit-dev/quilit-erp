"""
SQL dialect translation for the DB-compatibility seam.

Phase 0 of the SaaS migration (see docs/SAAS_ARCHITECTURE.md §4–§6).

The ERP's routers speak SQLite SQL directly — raw ``db.execute("… ?", params)``
with ``cur.lastrowid``. To let a PostgreSQL backend serve the SAME queries
unchanged, a *Dialect* rewrites each statement on its way to the driver:

  * ``SqliteDialect``   — IDENTITY. Used in desktop / self-hosted / test mode so
                          behavior is byte-for-byte today's. Nothing is rewritten,
                          nothing is wrapped; native ``sqlite3.Row`` flows through.

  * ``PostgresDialect`` — translates the MECHANICAL differences only:
                            - ``?``           → ``%s``   (psycopg paramstyle)
                            - literal ``%``   → ``%%``   (psycopg escaping)
                            - ``datetime('now' [, '±N unit'…])`` → ``to_char(now() …)``
                            - ``date('now' …)``                  → ``to_char(now(), 'YYYY-MM-DD')``
                            - ``INSERT OR IGNORE``               → ``INSERT … ON CONFLICT DO NOTHING``
                            - auto-append ``RETURNING id`` to plain INSERTs so the
                              compat cursor can emulate ``lastrowid``.

A small set of NON-mechanical idioms is deliberately LEFT for per-site
hand-porting in Phase 1 — they are listed in :data:`UNTRANSLATED` so a grep finds
every call site. Timestamp columns stay TEXT/ISO-8601 on Postgres (ADR-6), so the
``datetime('now')`` rewrite preserves the exact stored string format.

This module has NO dependency on the database engine and is pure/​unit-testable.
"""
import re

# Idioms intentionally NOT auto-translated. Each needs a Postgres equivalent
# authored at the call site (or in the squashed baseline) during Phase 1. Kept as
# a named list so `grep` over the codebase can locate every occurrence to port.
UNTRANSLATED = (
    "json_extract(", "json_each(", "strftime(", "julianday(", "typeof(",
    "INSERT OR REPLACE", "'start of ",
)


# ── low-level string rewriters (pure) ────────────────────────────────────────

def qmark_to_format(sql: str) -> str:
    """Convert SQLite ``?`` placeholders to psycopg ``%s``, and escape every
    literal ``%`` to ``%%`` (psycopg's *format* paramstyle scans the whole query
    for ``%``). ``?`` inside single-quoted string literals is left alone; doubled
    ``''`` escapes within a string are handled so the quote state stays correct.
    """
    out = []
    in_str = False
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "%":
            # Escape ALL literal percent signs, inside or outside strings — the
            # driver un-escapes them. (We emit %s for placeholders separately.)
            out.append("%%")
            i += 1
            continue
        if ch == "'":
            out.append(ch)
            if in_str:
                # A doubled '' is an escaped quote, not a string terminator.
                if i + 1 < n and sql[i + 1] == "'":
                    out.append("'")
                    i += 2
                    continue
                in_str = False
            else:
                in_str = True
            i += 1
            continue
        if ch == "?" and not in_str:
            out.append("%s")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# datetime('now')  /  datetime('now', '-90 days')  /  date('now', '+1 month')
_DT_CALL = re.compile(r"\b(datetime|date)\(\s*'now'\s*((?:,\s*'[^']*'\s*)*)\)", re.IGNORECASE)
_MOD = re.compile(r"'\s*([+-]?\d+)\s+(second|seconds|minute|minutes|hour|hours|"
                  r"day|days|month|months|year|years)\s*'", re.IGNORECASE)


def _translate_datetime(sql: str) -> str:
    """Rewrite SQLite ``datetime('now', …)`` / ``date('now', …)`` to Postgres
    ``to_char(now() ± interval …, fmt)`` so the produced TEXT timestamp matches
    SQLite's ``'YYYY-MM-DD HH:MM:SS'`` / ``'YYYY-MM-DD'`` exactly.

    Only the common ``'±N unit'`` modifiers are handled. Modifiers SQLite supports
    that we don't (e.g. ``'start of month'``, ``'weekday 0'``, ``'localtime'``) are
    left untouched on purpose — those call sites are flagged via UNTRANSLATED and
    hand-ported in Phase 1.
    """
    def repl(m):
        fn = m.group(1).lower()
        mods = m.group(2) or ""
        # Build the `now() ± interval 'N unit'` chain from each '±N unit' modifier.
        expr = "now()"
        for mm in _MOD.finditer(mods):
            n = int(mm.group(1))
            unit = mm.group(2).lower().rstrip("s")
            op = "-" if n < 0 else "+"
            expr = f"({expr} {op} interval '{abs(n)} {unit}')"
        if "start of " in mods.lower():
            # Don't silently mistranslate; leave the original for Phase 1.
            return m.group(0)
        fmt = "YYYY-MM-DD" if fn == "date" else 'YYYY-MM-DD HH24:MI:SS'
        return f"to_char({expr}, '{fmt}')"

    return _DT_CALL.sub(repl, sql)


# ── sqlite_master → information_schema (runtime table existence / listing) ────
# A few routers introspect the schema with `SELECT … FROM sqlite_master WHERE
# type='table' [AND name=?]`. Replace the table reference with a derived table
# that exposes the same `name`/`type` columns, backed by information_schema, so
# the surrounding WHERE/SELECT (incl. row["name"]) keep working unchanged.
_SQLITE_MASTER = re.compile(r"\bsqlite_master\b", re.IGNORECASE)
_SQLITE_MASTER_SUBQ = (
    "(SELECT table_name AS name, 'table' AS type "
    "FROM information_schema.tables "
    "WHERE table_schema = current_schema() AND table_type = 'BASE TABLE') sqlite_master"
)


def _translate_sqlite_master(sql: str) -> str:
    return _SQLITE_MASTER.sub(_SQLITE_MASTER_SUBQ, sql)


# ── strftime('%Y-%m' | '%Y', arg) → substr() / to_char(now()) ────────────────
# Timestamps are TEXT ISO-8601 (ADR-6), so the year-month / year prefix is just a
# substring: strftime('%Y-%m', col) == substr(col,1,7), strftime('%Y', col) ==
# substr(col,1,4). The literal 'now' becomes to_char(now(), …). MUST run before
# qmark_to_format(), which would otherwise escape the % in the format string.
_STRFTIME = re.compile(r"strftime\(\s*'(%Y-%m|%Y)'\s*,\s*([^)]+?)\s*\)", re.IGNORECASE)


def _translate_strftime(sql: str) -> str:
    def repl(m):
        fmt, arg = m.group(1), m.group(2).strip()
        if arg.lower() == "'now'":
            return f"to_char(now(), '{'YYYY-MM' if fmt == '%Y-%m' else 'YYYY'}')"
        width = 7 if fmt == "%Y-%m" else 4
        return f"substr({arg}, 1, {width})"

    return _STRFTIME.sub(repl, sql)


# Runtime ``CREATE TABLE IF NOT EXISTS … INTEGER PRIMARY KEY AUTOINCREMENT``
# (a couple of routers defensively (re)declare a table). Postgres parses the DDL
# even when IF NOT EXISTS skips creation, so the identity spelling must be valid.
_AUTOINC = re.compile(r"\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b", re.IGNORECASE)


def _translate_autoincrement(sql: str) -> str:
    return _AUTOINC.sub("INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY", sql)


# PRAGMA has no Postgres equivalent. Setter pragmas (foreign_keys, journal_mode…)
# become harmless no-ops; integrity_check returns a single 'ok' row so the health
# endpoint keeps working exactly like a healthy SQLite database.
# Postgres cannot DROP a table other objects reference without CASCADE, whereas
# SQLite drops freely (especially with foreign_keys OFF). The app never drops
# tables at runtime (only migrations do, and those don't run on Postgres), so
# appending CASCADE is safe and is the intended behavior on Postgres.
_DROP_TABLE = re.compile(r"\bDROP\s+TABLE\b", re.IGNORECASE)
_HAS_CASCADE = re.compile(r"\bCASCADE\b", re.IGNORECASE)


def _translate_drop_table(sql: str) -> str:
    if _DROP_TABLE.search(sql) and not _HAS_CASCADE.search(sql):
        return sql.rstrip().rstrip(";").rstrip() + " CASCADE"
    return sql


_PRAGMA = re.compile(r"^\s*PRAGMA\s+(\w+)", re.IGNORECASE)


def _translate_pragma(sql: str) -> str:
    m = _PRAGMA.match(sql)
    if not m:
        return sql
    if m.group(1).lower() == "integrity_check":
        return "SELECT 'ok' AS integrity_check"
    return "SELECT 1"


# SQLite `x IS NOT <value>` acts like a NULL-safe `!=` for any operand; Postgres
# only allows IS [NOT] NULL/TRUE/FALSE/DISTINCT FROM. Map the value form to the
# NULL-safe `IS DISTINCT FROM` (leaving IS NOT NULL/TRUE/FALSE/DISTINCT untouched).
_IS_NOT_VALUE = re.compile(
    r"\bIS\s+NOT\s+(?!NULL\b|TRUE\b|FALSE\b|UNKNOWN\b|DISTINCT\b)", re.IGNORECASE)


def _translate_is_not(sql: str) -> str:
    return _IS_NOT_VALUE.sub("IS DISTINCT FROM ", sql)


def _replace_func_call(sql: str, fname: str, repl) -> str:
    """Replace every ``fname(<args>)`` call with ``repl(args_text)``, matching the
    argument with BALANCED parentheses (so ``date(COALESCE(a, b))`` works). A word
    boundary before *fname* is required, so ``update(`` / ``to_char(`` are skipped.
    """
    low, fl, n = sql.lower(), fname.lower(), len(sql)
    out, i = [], 0
    while i < n:
        idx = low.find(fl + "(", i)
        if idx == -1:
            out.append(sql[i:])
            break
        prev = sql[idx - 1] if idx > 0 else ""
        if prev.isalnum() or prev == "_":          # part of a longer identifier
            out.append(sql[i:idx + len(fl) + 1])
            i = idx + len(fl) + 1
            continue
        out.append(sql[i:idx])
        depth, k = 0, idx + len(fl)
        while k < n:
            if sql[k] == "(":
                depth += 1
            elif sql[k] == ")":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        out.append(repl(sql[idx + len(fl) + 1:k]))
        i = k + 1
    return "".join(out)


def _has_top_level_comma(s: str) -> bool:
    """True if `s` has a comma outside any parens/quotes — i.e. it's a multi-arg
    call like ``'now', ?`` rather than a single column/expression argument."""
    depth, in_str, i = 0, False, 0
    while i < len(s):
        ch = s[i]
        if ch == "'":
            if in_str and i + 1 < len(s) and s[i + 1] == "'":
                i += 2
                continue
            in_str = not in_str
        elif not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                return True
        i += 1
    return False


# date(col) / datetime(col) on a TEXT timestamp → the date / datetime substring.
# The 'now' forms are handled by _translate_datetime above (or the app computes
# the cutoff in Python); this catches only the single column/expression forms
# (Postgres would otherwise read `date(x)` as a cast to the date type). A 'now'
# literal or a multi-arg form (datetime('now', ?)) is left untouched so it is
# never mis-rewritten into substr(...). MUST run AFTER _translate_datetime.
def _translate_date_funcs(sql: str) -> str:
    def _mk(fname, width):
        def repl(a):
            if a.strip().lower().startswith("'now'") or _has_top_level_comma(a):
                return f"{fname}({a})"
            return f"substr({a}, 1, {width})"
        return repl
    sql = _replace_func_call(sql, "datetime", _mk("datetime", 19))
    sql = _replace_func_call(sql, "date", _mk("date", 10))
    return sql


# SQLite char(N) (codepoint → character) is chr(N) in Postgres, where `char` is a
# type name. \bchar\( deliberately does not match varchar(/to_char(.
_CHAR_FN = re.compile(r"\bchar\(", re.IGNORECASE)


def _translate_char(sql: str) -> str:
    return _CHAR_FN.sub("chr(", sql)


# INSERT OR REPLACE INTO t (c1, c2, …) → an upsert keyed on the first column
# (the key/PK of the tables this is used on, e.g. settings(key, value)).
_INSERT_OR_REPLACE = re.compile(
    r"INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)", re.IGNORECASE)


def _translate_insert_or_replace(sql: str) -> str:
    m = _INSERT_OR_REPLACE.search(sql)
    if not m:
        return sql
    table, collist = m.group(1), m.group(2)
    cols = [c.strip() for c in collist.split(",")]
    conflict = cols[0]
    updates = (", ".join(f"{c}=excluded.{c}" for c in cols[1:])
               or f"{conflict}=excluded.{conflict}")
    s = _INSERT_OR_REPLACE.sub(f"INSERT INTO {table} ({collist})", sql, count=1)
    s = s.rstrip().rstrip(";").rstrip()
    return s + f" ON CONFLICT ({conflict}) DO UPDATE SET {updates}"


# A bare bound parameter in `? IS [NOT] NULL` has no inferable type in Postgres
# ("could not determine data type of parameter"). Casting to text is a no-op for
# the null test (NULL stays NULL) and gives the planner a concrete type; SQLite
# supports CAST(... AS TEXT) too. Runs before qmark_to_format (operates on `?`).
_PARAM_IS_NULL = re.compile(r"\?\s+IS\s+(NOT\s+)?NULL", re.IGNORECASE)


def _translate_param_is_null(sql: str) -> str:
    return _PARAM_IS_NULL.sub(
        lambda m: f"CAST(? AS TEXT) IS {m.group(1) or ''}NULL", sql)


_INSERT_OR_IGNORE = re.compile(r"\bINSERT\s+OR\s+IGNORE\b", re.IGNORECASE)


def _translate_insert_or_ignore(sql: str) -> str:
    """``INSERT OR IGNORE INTO t …`` → ``INSERT INTO t … ON CONFLICT DO NOTHING``.

    The ``ON CONFLICT DO NOTHING`` is appended (before any ``RETURNING``) only when
    the original used ``OR IGNORE``. ``INSERT OR REPLACE`` is NOT handled here — it
    needs an explicit conflict target — and is left for per-site porting.
    """
    if not _INSERT_OR_IGNORE.search(sql):
        return sql
    s = _INSERT_OR_IGNORE.sub("INSERT", sql)
    # Append ON CONFLICT DO NOTHING at the end of the statement (strip a trailing
    # semicolon first, restore after).
    stripped = s.rstrip()
    semi = stripped.endswith(";")
    if semi:
        stripped = stripped[:-1].rstrip()
    stripped += " ON CONFLICT DO NOTHING"
    return stripped + (";" if semi else "")


_INSERT_HEAD = re.compile(r"^\s*INSERT\s+INTO\b", re.IGNORECASE)
_HAS_RETURNING = re.compile(r"\bRETURNING\b", re.IGNORECASE)
_HAS_ON_CONFLICT = re.compile(r"\bON\s+CONFLICT\b", re.IGNORECASE)


def _maybe_add_returning(sql: str):
    """For a plain ``INSERT`` lacking a ``RETURNING`` clause, append
    ``RETURNING id`` so the compat cursor can expose ``lastrowid``. Returns
    ``(sql, capture)`` where *capture* tells the cursor to read the returned id.

    Skipped when the statement already has an ``ON CONFLICT`` clause: those come
    from ``INSERT OR IGNORE`` (idempotent inserts whose ``lastrowid`` is never
    read), and ``ON CONFLICT DO NOTHING`` returns no row on conflict anyway.

    Assumption: insertable business tables use an ``id`` primary key (true across
    this schema). The handful of tables without one (e.g. ``settings``) never have
    their ``lastrowid`` read; if a future call does, Phase 1 adds a per-site
    ``RETURNING`` or a no-capture hint.
    """
    if (not _INSERT_HEAD.search(sql)
            or _HAS_RETURNING.search(sql)
            or _HAS_ON_CONFLICT.search(sql)):
        return sql, False
    stripped = sql.rstrip()
    semi = stripped.endswith(";")
    if semi:
        stripped = stripped[:-1].rstrip()
    return stripped + " RETURNING id" + (";" if semi else ""), True


# ── dialect classes ──────────────────────────────────────────────────────────

class Dialect:
    name = "base"

    def translate(self, sql, params):
        """Return ``(sql, params, capture_returning_id)`` for a single statement."""
        raise NotImplementedError

    def translate_many(self, sql):
        """SQL-only translation for ``executemany`` (no RETURNING capture)."""
        raise NotImplementedError

    def wrap_row(self, row):
        """Adapt a driver row to the sqlite3.Row-like interface the app expects."""
        raise NotImplementedError


class SqliteDialect(Dialect):
    """Identity dialect — the desktop / self-hosted / test default. Guarantees
    byte-for-byte current behavior: no SQL rewriting, native rows pass through."""
    name = "sqlite"

    def translate(self, sql, params):
        return sql, params, False

    def translate_many(self, sql):
        return sql

    def wrap_row(self, row):
        return row  # already a sqlite3.Row: supports dict(), row[int], row["name"]


class PostgresDialect(Dialect):
    """Translate the mechanical SQLite→Postgres differences. See module docstring."""
    name = "postgres"

    def translate(self, sql, params):
        s = _translate_pragma(sql)
        s = _translate_drop_table(s)
        s = _translate_autoincrement(s)
        s = _translate_datetime(s)
        s = _translate_date_funcs(s)
        s = _translate_strftime(s)
        s = _translate_char(s)
        s = _translate_sqlite_master(s)
        s = _translate_is_not(s)
        s = _translate_insert_or_replace(s)
        s = _translate_insert_or_ignore(s)
        s = _translate_param_is_null(s)
        s, capture = _maybe_add_returning(s)
        s = qmark_to_format(s)
        return s, params, capture

    def translate_many(self, sql):
        s = _translate_autoincrement(sql)
        s = _translate_datetime(s)
        s = _translate_date_funcs(s)
        s = _translate_strftime(s)
        s = _translate_char(s)
        s = _translate_sqlite_master(s)
        s = _translate_is_not(s)
        s = _translate_insert_or_replace(s)
        s = _translate_insert_or_ignore(s)
        s = qmark_to_format(s)
        return s

    def wrap_row(self, row):
        if row is None:
            return None
        # psycopg is configured with dict_row → `row` is a plain dict. Wrap it so
        # positional access (row[0]) keeps working alongside row["name"]/dict(row).
        from db_compat import CompatRow
        return CompatRow(row)


def get_dialect(name: str) -> Dialect:
    name = (name or "sqlite").lower()
    if name in ("sqlite", "sqlite3"):
        return SqliteDialect()
    if name in ("postgres", "postgresql", "pg"):
        return PostgresDialect()
    raise ValueError(f"Unknown SQL dialect: {name!r}")
