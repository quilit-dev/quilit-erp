"""
Pytest bootstrap for the ERP backend test-suite.

The environment is configured BEFORE the backend is imported, because:
  * main.py hard-exits if SECRET_KEY is missing
  * database.py reads DB_PATH once, at import time
  * the auth cookie is `secure` by default and would not survive TestClient http

Isolation model
---------------
Every test runs against a freshly rebuilt SQLite database (`fresh_db`, autouse).
That makes tests fully order-independent and lets login-rate-limit / session
tests run without bleeding state into their neighbours.
"""
import os
import sys
import sqlite3
import pathlib

# ── 1. Environment — must be set before importing the backend ────────────────
_TESTS_DIR   = pathlib.Path(__file__).resolve().parent
_BACKEND_DIR = _TESTS_DIR.parent
_TEST_DB     = _TESTS_DIR / "_test_erp.db"

os.environ.setdefault("SECRET_KEY", "test-only-secret-key-not-for-production-0123456789abcd")
os.environ["DB_PATH"]       = str(_TEST_DB)
os.environ["COOKIE_SECURE"] = "false"
os.environ.setdefault("TOKEN_EXPIRE_HOURS", "24")
os.environ.setdefault("ALLOWED_ORIGINS", "http://testserver")

# `backend/` for `import main/database/...`, `tests/` for `import helpers.*`
sys.path.insert(0, str(_BACKEND_DIR))
sys.path.insert(0, str(_TESTS_DIR))

import pytest                                              # noqa: E402
import database                                            # noqa: E402
from helpers.seeding import seed_test_users, ROLE_USERS, TEST_PASSWORD  # noqa: E402


# ── 2. Database lifecycle ────────────────────────────────────────────────────
def _wipe_db_files():
    for suffix in ("", "-wal", "-shm", "-journal"):
        f = pathlib.Path(str(_TEST_DB) + suffix)
        if f.exists():
            try:
                f.unlink()
            except OSError:
                pass


def _rebuild_db():
    """Drop the test DB and recreate schema + seed roles + canonical test users."""
    _wipe_db_files()
    database.init_db()                       # schema, migrations, 14 roles, 'admin'
    conn = sqlite3.connect(str(_TEST_DB))
    conn.row_factory = sqlite3.Row
    try:
        seed_test_users(conn)
        conn.commit()
    finally:
        conn.close()


# ── 3. Fixtures ──────────────────────────────────────────────────────────────
@pytest.fixture(scope="session")
def app():
    """The FastAPI app. Imported once; the DB is rebuilt per-test by `fresh_db`."""
    _rebuild_db()
    import main
    return main.app


@pytest.fixture(autouse=True)
def fresh_db(app):
    """Rebuild the database before every test for full isolation."""
    _rebuild_db()
    yield


@pytest.fixture
def db():
    """A direct read/write connection to the test DB for arrange/assert steps."""
    conn = sqlite3.connect(str(_TEST_DB))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    conn.close()


@pytest.fixture
def client(app):
    """An un-authenticated TestClient."""
    from fastapi.testclient import TestClient
    with TestClient(app) as c:
        yield c


@pytest.fixture
def make_client(app):
    """
    Factory for TestClients, optionally pre-authenticated as a role.

        c = make_client("Manager")          # logged in as the Manager user
        anon = make_client()                # anonymous

    Multiple independent clients can be created (needed for concurrency tests).
    """
    from fastapi.testclient import TestClient
    created = []

    def _make(role_name=None):
        c = TestClient(app)
        created.append(c)
        if role_name is not None:
            username = ROLE_USERS[role_name]
            r = c.post("/api/auth/login",
                       json={"username": username, "password": TEST_PASSWORD})
            assert r.status_code == 200, f"login as {role_name!r} failed: {r.text}"
        return c

    yield _make
    for c in created:
        c.close()


@pytest.fixture
def as_role(make_client):
    """Convenience: return a TestClient already logged in as `role_name`."""
    return lambda role_name: make_client(role_name)
