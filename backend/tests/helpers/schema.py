"""Schema introspection that answers the same on SQLite and Postgres.

`PRAGMA table_info` is SQLite's; the Postgres dialect turns every PRAGMA into
`SELECT 1`, so a test that lists columns through it sees nothing there and
fails (or, worse, passes vacuously).
"""
import database


def table_columns(db, table):
    """The column names of `table`, in declaration order."""
    if database.DB_BACKEND in ("sqlite", "sqlite3"):
        return [r["name"] for r in db.execute(f"PRAGMA table_info({table})").fetchall()]
    return [r["column_name"] for r in db.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = ? "
        "ORDER BY ordinal_position", (table,)).fetchall()]
