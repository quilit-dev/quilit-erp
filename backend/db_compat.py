"""
DBAPI compatibility wrappers for the database-abstraction seam.

Phase 0 of the SaaS migration (see docs/SAAS_ARCHITECTURE.md §4–§6).

The ERP's routers use a small, specific slice of the ``sqlite3`` API directly on
the connection injected by ``database.get_db``:

    row = db.execute("SELECT … WHERE id=?", (x,)).fetchone()
    rows = db.execute("SELECT …").fetchall()
    cur  = db.execute("INSERT INTO t(…) VALUES (?,?)", (...,)); cur.lastrowid
    db.executemany("INSERT …", seq)
    db.commit() / db.rollback()
    dict(row); row["col"]; row[0]

``CompatConn`` / ``CompatCursor`` reproduce exactly that surface on top of *any*
DBAPI driver, delegating SQL rewriting and row adaptation to a *Dialect*:

  * SQLite mode — the dialect is identity, so this is a thin, transparent
    forwarder and native ``sqlite3.Row`` objects flow straight through. The full
    test-suite runs through it to prove the seam adds no behavioral change.

  * Postgres mode (wired in Phase 1) — the dialect rewrites placeholders, adds
    ``RETURNING id`` for ``lastrowid`` emulation, and wraps psycopg dict-rows in
    ``CompatRow`` so positional access keeps working.

This module imports no database engine; it is given a live connection + dialect.
"""


class CompatRow:
    """A row that supports BOTH ``row["name"]`` and ``row[0]`` as well as
    ``dict(row)`` / ``row.keys()`` / iteration — matching the ``sqlite3.Row``
    behaviors the app relies on. Only used for drivers (psycopg) whose native rows
    don't already do all of this; in SQLite mode the native row is used directly.
    """
    __slots__ = ("_d", "_cols")

    def __init__(self, d):
        # `d` is a mapping (e.g. psycopg dict_row). Preserve column order.
        self._d = d
        self._cols = list(d.keys())

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._d[self._cols[key]]
        if isinstance(key, slice):
            return [self._d[c] for c in self._cols[key]]
        return self._d[key]

    def keys(self):
        return list(self._cols)

    def get(self, key, default=None):
        return self._d.get(key, default)

    def __contains__(self, key):
        return key in self._d

    def __iter__(self):
        # sqlite3.Row iterates over VALUES (positional), and dict(row) uses keys();
        # mirror that so `for v in row` and `dict(row)` both behave like sqlite3.
        return iter(self._d[c] for c in self._cols)

    def __len__(self):
        return len(self._cols)

    def __repr__(self):
        return f"CompatRow({self._d!r})"


class CompatCursor:
    """Wraps a DBAPI cursor; rewrites SQL via the dialect, adapts rows, and
    emulates ``lastrowid`` for backends that report it through ``RETURNING``."""

    def __init__(self, raw_cursor, dialect):
        self._cur = raw_cursor
        self._dialect = dialect
        self._lastrowid = None   # set when the dialect captured a RETURNING id

    # -- execution --------------------------------------------------------------
    def execute(self, sql, params=()):
        sql2, params2, capture = self._dialect.translate(sql, params)
        self._cur.execute(sql2, params2)
        if capture:
            # The dialect appended `RETURNING id`; read it so `.lastrowid` works,
            # then keep it out of the caller's fetch* stream.
            row = self._cur.fetchone()
            self._lastrowid = (row[0] if not hasattr(row, "keys") else row["id"]) if row else None
        return self

    def executemany(self, sql, seq_of_params):
        sql2 = self._dialect.translate_many(sql)
        self._cur.executemany(sql2, list(seq_of_params))
        return self

    # -- fetching ---------------------------------------------------------------
    def fetchone(self):
        return self._dialect.wrap_row(self._cur.fetchone())

    def fetchall(self):
        return [self._dialect.wrap_row(r) for r in self._cur.fetchall()]

    def fetchmany(self, size=None):
        rows = self._cur.fetchmany(size) if size is not None else self._cur.fetchmany()
        return [self._dialect.wrap_row(r) for r in rows]

    def __iter__(self):
        for r in self._cur:
            yield self._dialect.wrap_row(r)

    # -- attributes the app reads ----------------------------------------------
    @property
    def lastrowid(self):
        if self._lastrowid is not None:
            return self._lastrowid
        # SQLite (and any driver that populates it natively).
        return getattr(self._cur, "lastrowid", None)

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def description(self):
        return self._cur.description

    def close(self):
        self._cur.close()

    def __getattr__(self, name):
        # Forward anything else (e.g. arraysize) to the underlying cursor.
        return getattr(self._cur, name)


class CompatConn:
    """Wraps a DBAPI connection, mirroring the ``sqlite3.Connection`` conveniences
    the routers use: connection-level ``execute``/``executemany`` (which implicitly
    create a cursor), ``cursor()``, ``commit``/``rollback``/``close`` and use as a
    context manager."""

    def __init__(self, raw_conn, dialect):
        self._conn = raw_conn
        self._dialect = dialect

    # sqlite3 allows `conn.execute(...)` as a shortcut returning a fresh cursor.
    def execute(self, sql, params=()):
        cur = CompatCursor(self._conn.cursor(), self._dialect)
        return cur.execute(sql, params)

    def executemany(self, sql, seq_of_params):
        cur = CompatCursor(self._conn.cursor(), self._dialect)
        return cur.executemany(sql, seq_of_params)

    def cursor(self):
        return CompatCursor(self._conn.cursor(), self._dialect)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    # `with db:` — sqlite3 commits on clean exit, rolls back on exception. Mirror
    # that, but yield the CompatConn so chained calls stay wrapped.
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self._conn.commit()
        else:
            self._conn.rollback()
        return False

    def __getattr__(self, name):
        # Forward rarely-used connection attributes (row_factory, total_changes,
        # in_transaction, …) to the underlying driver connection.
        return getattr(self._conn, name)
