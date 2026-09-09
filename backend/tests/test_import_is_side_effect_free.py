"""Importing the application must not build a database.

`database.py` used to call `init_db()` at module scope. Every router imports
`get_db` from it and `main.py` imports every router, so `import main` ran the
whole schema pass as an import side effect --- once per gunicorn worker,
concurrently, racing on the same ALTER TABLE locks, before the socket bound.

At three tenants that was merely slow. At twenty it is roughly 11,800
sequential statements across three workers, against a 300-second health-check
timeout, on every deploy.

Schema work now happens once in the release phase. This file is what stops the
side effect creeping back --- and it would creep back easily, because putting
`init_db()` at import time makes the test suite and the local launcher work
without thinking about it.

Run in a subprocess deliberately: `database` is already imported by the time
any test runs, so an in-process check would prove nothing.
"""
import os
import subprocess
import sys
import tempfile
import textwrap

import pytest

pytestmark = pytest.mark.critical

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(snippet: str, db_path: str):
    env = dict(os.environ)
    env["DB_PATH"] = db_path
    env["DB_BACKEND"] = "sqlite"
    env.pop("TENANCY", None)          # single-tenant: the SQLite path
    return subprocess.run([sys.executable, "-c", textwrap.dedent(snippet)],
                          cwd=_BACKEND, env=env, capture_output=True,
                          text=True, timeout=180)


def _fresh_path():
    path = os.path.join(tempfile.mkdtemp(), "import_probe.db")
    assert not os.path.exists(path)
    return path


def test_importing_database_creates_nothing():
    path = _fresh_path()
    r = _run("import database; print('imported')", path)
    assert r.returncode == 0, r.stderr[-800:]
    assert "imported" in r.stdout

    assert not os.path.exists(path) or os.path.getsize(path) == 0, (
        "importing `database` built a database. That is the import-time "
        "init_db() coming back: in the cloud it makes every gunicorn worker "
        "migrate concurrently at import, racing on ALTER TABLE locks before "
        "the health check can answer.")


def test_importing_the_whole_app_creates_nothing():
    """The one that actually matters --- main imports all 47 routers."""
    path = _fresh_path()
    r = _run("import main; print('app built:', bool(main.app))", path)
    assert r.returncode == 0, r.stderr[-1500:]
    assert "app built: True" in r.stdout

    if os.path.exists(path):
        import sqlite3
        conn = sqlite3.connect(path)
        try:
            tables = [row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        finally:
            conn.close()
        assert not tables, (
            "importing `main` created %d table(s): %s. Schema work belongs in "
            "the release phase (bootstrap.py), not in an import."
            % (len(tables), ", ".join(sorted(tables)[:6])))


def test_init_db_still_works_when_called_on_purpose():
    """The negative above is only safe because the positive still holds.

    seed.py, launcher.py, the baseline generator and the test harness all call
    this explicitly and always did.
    """
    path = _fresh_path()
    r = _run("""
        import database
        database.init_db()
        print('tables:', len(database.__dict__) > 0)
        import sqlite3
        conn = sqlite3.connect(database.DB_PATH)
        n = conn.execute("SELECT COUNT(*) FROM sqlite_master "
                         "WHERE type='table'").fetchone()[0]
        print('created', n)
    """, path)
    assert r.returncode == 0, r.stderr[-800:]
    created = int(r.stdout.split("created")[1].strip())
    assert created > 50, "init_db() built only %d tables" % created


def test_the_lifespan_hook_does_not_migrate():
    """Warmup is fine; migration in a lifespan is the same race, relocated.

    Every worker runs its own lifespan, so migrating there would put N workers
    back on the same locks.
    """
    with open(os.path.join(_BACKEND, "main.py"), encoding="utf-8") as fh:
        src = fh.read()
    start = src.index("async def lifespan(")
    body = src[start:src.index("\napp = FastAPI(", start)]
    for forbidden in ("init_db(", "_init_db_postgres(",
                      "upgrade_all_tenant_schemas("):
        assert forbidden not in body, (
            "main.py's lifespan calls %s. Every gunicorn worker runs its own "
            "lifespan, so this is the import-time race with a new name --- "
            "schema work belongs in bootstrap.py." % forbidden)
