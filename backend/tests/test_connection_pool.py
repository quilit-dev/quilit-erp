"""
The PostgreSQL connection pool, and the isolation it must not break.

Every request used to open its own connection. That was slow — ~33 ms of
handshake against ~0.05 ms for a simple query — and it let in-flight requests
outnumber the server's `max_connections`, which fails every request at once
rather than merely slowing them down.

Pooling REUSES connections, and that is the whole danger. A connection carries
server-side state: its `search_path`, and any prepared statements. In
schema-per-tenant mode a connection last used by one customer must not serve the
next request still pointing at the previous customer's schema.

Postgres-only: the SQLite path opens a file and has no pool.
"""
import os
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("DB_BACKEND", "sqlite").lower() not in ("postgres", "postgresql", "pg"),
    reason="the connection pool only exists on the postgres backend",
)

from fastapi.testclient import TestClient   # noqa: E402

TEST_PW = "Pool1234!"


@pytest.fixture(autouse=True)
def fresh_db():
    """These manage their own schemas; opt out of conftest's rebuild."""
    yield


def _set_admin_password(schema, password):
    import psycopg
    from auth_utils import hash_password
    from database import _pg_dsn
    raw = psycopg.connect(_pg_dsn())
    try:
        with raw.cursor() as cur:
            cur.execute(f'SET search_path TO "{schema}", public')
            cur.execute("UPDATE users SET password_hash=%s, must_change_password=0 "
                        "WHERE username='admin'", (hash_password(password),))
        raw.commit()
    finally:
        raw.close()


@pytest.fixture(scope="module")
def two_tenants(app):
    import tenancy
    if not tenancy.IS_SCHEMA_TENANCY:
        pytest.skip("schema tenancy required")
    for slug in ("poolone", "pooltwo"):
        t = tenancy.provision_tenant(slug, name=slug)
        _set_admin_password(t["schema_name"], TEST_PW)
    return ("poolone", "pooltwo")


def _login(app, slug):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "admin", "password": TEST_PW},
               headers={"X-Tenant": slug})
    assert r.status_code == 200, f"login to {slug}: {r.text[:200]}"
    return c


@pytest.fixture
def single_connection_pool():
    """Force max_size=1 so every request provably reuses the SAME connection.

    With a roomy pool a leak can hide behind a request happening to get a fresh
    connection. One connection makes reuse certain.
    """
    import database
    database.close_pg_pool()
    old = os.environ.get("DB_POOL_MAX")
    os.environ["DB_POOL_MAX"] = "1"
    try:
        yield
    finally:
        database.close_pg_pool()
        if old is None:
            os.environ.pop("DB_POOL_MAX", None)
        else:
            os.environ["DB_POOL_MAX"] = old


def test_a_reused_connection_never_serves_the_wrong_tenant(
        app, two_tenants, single_connection_pool):
    """The reason search_path is set on every checkout rather than at connect.

    Both tenants are served by one physical connection, alternating, well past
    the point where any per-connection caching would kick in.
    """
    a, b = _login(app, "poolone"), _login(app, "pooltwo")
    a.post("/api/clients/", json={"name": "POOLONE-CLIENT"})
    b.post("/api/clients/", json={"name": "POOLTWO-CLIENT"})

    for i in range(15):
        one = {c["name"] for c in a.get("/api/clients/").json()}
        two = {c["name"] for c in b.get("/api/clients/").json()}
        assert one == {"POOLONE-CLIENT"}, f"iteration {i}: poolone saw {one}"
        assert two == {"POOLTWO-CLIENT"}, f"iteration {i}: pooltwo saw {two}"


def test_no_server_side_prepared_statements_accumulate(app, two_tenants,
                                                       single_connection_pool):
    """psycopg auto-prepares a repeated query, and a prepared plan resolves
    table names ONCE against the search_path in force at prepare time. On a
    pooled connection that later serves another tenant, that plan would still
    read the first tenant's tables — a leak no SET search_path could correct.
    So preparation is disabled; this is the guard on that staying true.
    """
    import database
    c = _login(app, "poolone")
    for _ in range(20):                      # well past psycopg's threshold of 5
        c.get("/api/clients/")

    with database._pg_pool().connection() as raw:
        with raw.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM pg_prepared_statements")
            assert cur.fetchone()["n"] == 0, "prepared statements are pinning a schema"


def test_search_path_is_set_on_every_checkout(app, two_tenants,
                                              single_connection_pool):
    import database
    _login(app, "pooltwo").get("/api/clients/")
    with database._pg_pool().connection() as raw:
        with raw.cursor() as cur:
            cur.execute("SHOW search_path")
            assert "tenant_" in cur.fetchone()["search_path"]


def test_uncommitted_work_is_discarded(app, two_tenants, single_connection_pool):
    """The pool's own context manager COMMITS on a clean exit. get_db rolls back
    first, deliberately — otherwise work a router chose not to commit would be
    persisted anyway, silently turning half-finished operations into real rows.
    """
    import database
    c = _login(app, "poolone")
    before = len(c.get("/api/clients/").json())

    with database.session() as db:
        db.execute("INSERT INTO clients (name, created_at) VALUES (?, datetime('now'))",
                   ("NEVER-COMMITTED",))
        # no commit

    names = {x["name"] for x in c.get("/api/clients/").json()}
    assert "NEVER-COMMITTED" not in names, "uncommitted work was persisted by the pool"
    assert len(names) == before


def test_the_pool_is_bounded(app):
    """max_size is per worker process; WEB_CONCURRENCY x DB_POOL_MAX must stay
    under the server's max_connections, so an unbounded pool would defeat the
    point of pooling at all."""
    import database
    pool = database._pg_pool()
    assert pool.max_size >= 1
    assert pool.max_size <= 50, "a pool this large can exhaust max_connections"
