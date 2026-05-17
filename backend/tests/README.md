# ERP Backend — Automated Test Suite

API-level regression and weakness-detection suite for the ERP backend
(FastAPI + SQLite, cookie-JWT auth, RBAC, multi-step approvals).

> Scope: this suite exercises the **HTTP API** — every endpoint, every role,
> every workflow transition. "Clicking every button" in the browser is a
> separate concern; see *UI coverage* below.

## Folder structure

```
backend/
  pytest.ini                     # config: testpaths, pythonpath, markers
  tests/
    conftest.py                  # env bootstrap + fixtures (THE linchpin)
    helpers/
      seeding.py                 # canonical per-role test users
      catalog.py                 # module -> endpoint maps, public paths
    test_smoke_endpoints.py      # every GET route -> never 5xx (smoke)
    test_auth_session.py         # login, logout, sessions, rate limiting
    test_role_permission_matrix.py  # role x module x action enforcement (rbac)
    test_workflow_approvals.py   # create->approve/reject/force/cancel (workflow)
    test_edge_cases.py           # invalid ids, dangling relations (edge)
    test_concurrency.py          # parallel approvals & payments (concurrency)
    test_state_transitions.py    # void / cancel / soft-delete terminals (state)
    README.md                    # this file
    RISK_ANALYSIS.md             # findings + architectural weaknesses
```

## Running

```bash
cd backend
python -m pytest                       # whole suite
python -m pytest -m rbac               # one category (see markers)
python -m pytest -m "not concurrency"  # skip the slow parallel tests
python -m pytest --tb=line             # concise one-line failures
```

Requirements: `pytest`, `httpx` (for `fastapi.testclient`). The backend's own
deps (`fastapi`, `pyjwt`, `python-dotenv`) must already be installed.

## Isolation model

`conftest.py` sets `DB_PATH`, `SECRET_KEY` and `COOKIE_SECURE=false` **before**
the backend is imported, then points the app at a throwaway SQLite file under
`tests/`. The autouse `fresh_db` fixture **rebuilds the database before every
test** (schema + 14 seeded roles + canonical users), so:

* tests are fully order-independent;
* login-rate-limit and session tests do not bleed state;
* a failing test never corrupts its neighbours.

Cost: ~0.6 s/test for the rebuild. Acceptable for a correctness-first suite;
if speed becomes an issue, switch `fresh_db` to a table-truncation strategy.

## Fixtures (conftest.py)

| Fixture        | Scope    | Purpose |
|----------------|----------|---------|
| `app`          | session  | the imported FastAPI app |
| `fresh_db`     | function | autouse — rebuilds the DB before each test |
| `db`           | function | direct `sqlite3` connection for arrange/assert |
| `client`       | function | un-authenticated `TestClient` |
| `make_client`  | function | factory: `make_client("Manager")` -> logged-in client; multiple independent clients for concurrency |
| `as_role`      | function | thin alias of `make_client` |

Canonical users (`helpers/seeding.py`): one active user per RBAC role, plus
`__norole__` (active, no role) and `__disabled__` (role, `is_active=0`).
All share password `Test1234!`.

## Test categories (pytest markers)

| Marker        | File                          | Detects |
|---------------|-------------------------------|---------|
| `smoke`       | test_smoke_endpoints          | 500s, auth bypass on any GET |
| `rbac`        | test_role_permission_matrix   | incorrect 403s, privilege leaks, module/permission mismatches |
| `workflow`    | test_workflow_approvals       | broken transitions, circular flows, wrong-approver actions |
| `edge`        | test_edge_cases               | 404-vs-500, dangling FKs, partial-permission writes |
| `concurrency` | test_concurrency              | double-resolution races, idempotency failures, lost writes |
| `state`       | test_state_transitions        | terminal-state violations (void/cancel/soft-delete) |

## Coverage strategy

1. **Breadth (smoke).** Routes are discovered from `app.routes`, so a newly
   added GET endpoint is covered automatically with no test edit.
2. **Depth (rbac).** The role matrix is *parametrised* over every
   `role x module` pair (≈240 cases) and reads expected grants from the live
   `role_permissions` table — the test cannot drift from the seed.
3. **Workflows.** Approval state-machine tests seed `approval_requests` directly
   so each transition is deterministic, independent of which business action
   triggers a policy.
4. **Negative space.** Edge/state tests assert the *deliberate* 4xx — a 5xx or a
   silent 200 is always a failure.
5. **Races.** Concurrency tests use real parallel `TestClient`s.

### Known coverage gaps (intentional next steps)

* **UI / "click every button"** — not in scope here; add a Playwright E2E
  project that drives the React app. This API suite is its backstop.
* **Purchases state machine** — needs a seeded purchase fixture (one test
  currently `SKIP`s for lack of data).
* **Write-path smoke** — POST/PUT/PATCH bodies are exercised via the rbac /
  edge / workflow tests, not blanket-fuzzed.
* **File uploads** — `restore-backup`, document upload endpoints uncovered.
* **HR / CRM / planning** deep workflows — only reached by smoke + rbac.

## Extending

* New endpoint → smoke covers it automatically; add a row to
  `catalog.MODULE_VIEW_ENDPOINTS` if it represents a module's "view".
* New role → add it to `seeding.ROLE_USERS`; the matrix expands automatically.
* New workflow → add a `@pytest.mark.workflow` test seeding the relevant rows.

## CI recommendation

Run `python -m pytest -m "not concurrency"` on every push (fast, deterministic)
and the full suite nightly. Treat any new failure as a release blocker until
triaged against `RISK_ANALYSIS.md`.
