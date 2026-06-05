# Cloud SaaS Migration — Architecture & Design

**Status:** Draft for review · **Owner:** Ali Koteich · **Date:** 2026-06-04
**Decision locked:** Tenant isolation = **schema-per-tenant** on PostgreSQL.
**Scope:** Convert the self-hosted single-company ERP into a multi-tenant cloud SaaS
**without** changing business logic, accounting/costing/payroll calculations,
RBAC, approvals, audit, reports, API contracts, or UI behavior.

> Every phase below is gated behind a feature flag so the existing single-tenant /
> desktop build (`.exe` / `.dmg` / `.AppImage`) keeps working from the same codebase.

## Implementation status

| Phase | State | Evidence |
|---|---|---|
| **0 — DB-abstraction seam** | ✅ **Done** | `db_compat.py`, `dialect.py`; `get_db` routes through `CompatConn`; SQLite is the transparent default. 16 unit tests + full suite green (823 passed). |
| **1 — PostgreSQL backend** | ✅ **Done** | Squashed `migrations/pg_baseline.sql` (91 tables, 172 FKs, 231 indexes, seed data) generated + validated on PG 16; `get_db`/`init_db` Postgres paths wired. **The FULL suite passes on BOTH backends — 840 passed / 1 skipped on SQLite AND on PostgreSQL 16.** `conftest` runs the same suite on either backend via `DB_BACKEND=postgres`, using TEMPLATE-database cloning for fast per-test isolation (~1.4s/test). CI (`.github/workflows/tests.yml`) runs both backends on every push so parity can't regress. |
| **2 — Multi-tenancy (schema-per-tenant)** | ✅ **Done** | `tenant_context.py` + `tenancy.py`: `public.tenants` catalog, `provision_tenant()`, and a pure-ASGI `TenantMiddleware` (signed JWT `schema` claim → `X-Tenant` → subdomain) feeding a ContextVar; `get_db` pins `search_path`. Login binds the JWT to the resolved tenant. **Lifecycle**: a separate platform-operator auth tier (`public.platform_admins`, own cookie/scope) and a `/api/platform` API (`routers/platform.py`) to login + provision (returns first-login creds) + suspend/activate; suspended tenants are blocked with 402 by the middleware. `test_multitenancy.py` (isolation) + `test_platform.py` (lifecycle) — 7 tests, run by a dedicated CI job. Inert in single-tenant mode (`TENANCY=single`, default); single-tenant suite unchanged (840 passed). **Deferred:** self-service signup UI. |
| **3 — Attachments → object storage** | ✅ **Done** | `storage.py`: a `db`/`s3` abstraction (lazy `boto3`; S3 / Cloudflare R2 / MinIO), tenant-scoped keys `<schema>/<entity>/<id>/<uuid>`. Migrations 124–125 add `storage_backend` + `storage_key` to **all three** BLOB tables (`attachments`, `hr_employee_files`, `recruitment_applicant_files`) — additive, no rebuild. Each module's API routes uploads to object storage when `STORAGE=s3`, streams downloads back (RBAC re-checked — no public presigned URLs), cleans up objects on delete (incl. single-slot CV/contract replacement); the attachments router adds a superadmin `POST /api/attachments/migrate-to-s3` backfill. `test_storage.py` proves the s3 round-trip + backfill (attachments **and** HR files) via mocked S3 (moto) on **both** backends; `test_attachments.py` / recruitment / contracts tests remain the `db`-default regression gate. Default `STORAGE=db` = unchanged behavior. |
| **4 — Redis (cache + jobs)** | ✅ **Done** | `cache.py` (`CACHE=none\|redis`, tenant-scoped keys, TTL, lazy `redis`) + `jobs.py` (`JOBS=inline\|rq`, tenant-aware job registry, lazy `rq`) + `worker.py` (RQ worker entrypoint). Defaults `none`/`inline` are pure passthroughs → behavior identical, desktop bundle stays lean (redis/rq imported lazily). Wired: a cached `utils.get_setting()` (used by invoice/quotation numbering, invalidated on settings write) and the attachment backfill (`POST /api/attachments/migrate-to-s3`) enqueues a background job when `JOBS=rq`, else runs inline. `test_cache.py` + `test_jobs.py` prove the redis/rq paths in-process via `fakeredis`. Other fan-outs (notifications, recurring expenses, depreciation, report exports) adopt this incrementally. |
| **5 — Docker + Hetzner deploy** | ✅ **Done** | Multi-target `Dockerfile` (`app` = gunicorn/uvicorn API; `web` = Caddy serving the built SPA + `/api` reverse-proxy + auto-TLS/HSTS). `docker-compose.yml` wires Caddy + app + RQ worker + Postgres + Redis + a nightly `pg_dump` backup sidecar (`ops/backup.sh`/`restore.sh`). `bootstrap.py` runs migrations on start (single-tenant) or ensures the `public` catalog (schema mode); non-root container user; `/api/health` liveness. `.env.production.example` + `docs/DEPLOYMENT.md` (Hetzner steps + security hardening checklist). **Verified**: the `app` image builds and boots against Postgres — bootstrap creates 91 tables + admin, `/api/health` 200, `/api/clients/` 401; `docker compose config` validates all services. App-logic untouched (only a new `/api/health` route). |
| 6 | ⬜ Planned | — |

**Dialect translations implemented** (`dialect.py`, SQLite→Postgres, all verified by the dual-backend suite): `?`→`%s` + `%` escaping; auto `RETURNING id` for `lastrowid`; `datetime('now',…)`/`date('now')`; `date(col)`/`datetime(col)`→`substr` (balanced-paren); `strftime('%Y-%m'|'%Y',…)`; `sqlite_master`→`information_schema`; `INSERT OR IGNORE`/`INSERT OR REPLACE`→`ON CONFLICT`; `IS NOT <val>`→`IS DISTINCT FROM`; `? IS NULL`→`CAST(? AS TEXT) IS NULL`; `AUTOINCREMENT`→`IDENTITY`; `char()`→`chr()`; `PRAGMA`→no-op/`'ok'`; `DROP TABLE`→`… CASCADE`.

**Result-identical app-SQL portability fixes** (verified on both engines — no calculation change): inlined `HAVING`-clause aliases (`accounting.py` trial balance, `finance.py` ×2, `reports.py`); `SUM(<boolean>)` → `SUM(CASE WHEN … THEN 1 ELSE 0 END)` (`hr.py`); added joined columns to `GROUP BY` (`manufacturing.py`, `clients.py`); replaced `datetime('now', <param>)` with a Python-computed UTC cutoff (`utils.py`, `audit.py`, `users.py`). Cross-cutting: `error_handlers.py` now catches psycopg's `IntegrityError` hierarchy too, so FK/UNIQUE/NOT-NULL violations return 400 (not 500) on Postgres — matching SQLite.

**Phase 2 is complete** — schema-per-tenant isolation *and* the operator lifecycle surface work end-to-end (see `tenancy.py`, `routers/platform.py`, `test_multitenancy.py`, `test_platform.py`). Isolation is structural: each tenant is a Postgres schema with its own users/roles/permissions/audit (ADR-3); a query in one schema cannot name another's tables, and a session token is cryptographically bound to its tenant. The SaaS operator provisions/suspends tenants through a separate platform-auth tier. **Bootstrap:** create the first operator with `python -c "import tenancy; print(tenancy.create_platform_admin('operator'))"`.

**Phase 3 is complete** — all three file stores (generic attachments, HR employee files, recruitment applicant files) can live in S3/R2 instead of DB BLOBs (`STORAGE=s3`), with a backfill for existing attachments; default `STORAGE=db` keeps current behavior.

**Phase 4 is complete** — Redis-backed caching (`CACHE=redis`) and background jobs (`JOBS=rq`) are available behind flags that default to off, so nothing changes for desktop/single-tenant installs. The infrastructure (`cache.py`, `jobs.py`, `worker.py`) is tenant-aware and wired into representative paths (settings caching; the attachment backfill as a job); remaining fan-outs migrate onto it incrementally. **Run a worker:** `JOBS=rq REDIS_URL=… python backend/worker.py`.

**Phase 5 is complete** — the whole stack runs from `docker-compose.yml` (Caddy + app + worker + Postgres + Redis + backup), TLS/HSTS via Caddy, nightly `pg_dump` backups, non-root containers, and a hardening checklist. See **[DEPLOYMENT.md](DEPLOYMENT.md)**. The app image was built and smoke-tested against Postgres (bootstrap → 91 tables + admin, health 200). No app-logic change beyond a `/api/health` liveness route. **Next: Phase 6 — opportunistic layering** (§11), much of which is already in place via the `get_db` seam, `tenancy`/middleware, and the cache/jobs/storage wrappers.

---

## 0. Reading guide

- §1 — what the codebase is today (measured, not assumed)
- §2 — the architecture decisions (ADR table)
- §3 — target architecture & request lifecycle
- §4 — the single seam everything hangs off (`get_db`)
- §5–§11 — Phase 0→6, each with **Why / Risk / Files / Migrate / Rollback / Keep-green**
- §12–§18 — data migration, testing, backward-compat, tenant lifecycle, security, risk register, sequencing

---

## 1. Current-state assessment (measured)

| Area | Reality | Source of truth |
|---|---|---|
| Data access | **No ORM / repository.** Routers run raw SQL on a `sqlite3.Connection` injected via `Depends(get_db)`. | 58 files `import sqlite3` |
| SQL dialect coupling | **352** SQLite-only idioms across 57 files (`datetime('now')`, `INSERT OR IGNORE`, `PRAGMA`, `pragma_table_info`, `executescript`, `AUTOINCREMENT`…) | grep inventory |
| Insert IDs | **97** `cursor.lastrowid` reads across 35 files (Postgres needs `RETURNING`) | grep inventory |
| Migrations | Custom **3,055-line** runner, **123+** migrations, using the SQLite `CREATE-new / INSERT-SELECT / DROP / RENAME` rebuild pattern | `backend/database.py` |
| Multi-tenancy | **None.** Every query is global. "company/tenant" hits are `settings` rows + CRM fields, not a boundary. | `backend/database.py`, `routers/settings.py` |
| Attachments | Stored as **DB BLOBs** (`attachments.data`); HR/recruitment files too | `backend/routers/attachments.py` |
| Tests | Rebuild a real SQLite **file per test** (`fresh_db` autouse), assert via a direct `sqlite3` connection, drive via `TestClient` | `backend/tests/conftest.py` |
| **The seam** | Every router gets its connection from **one** function: `database.get_db`. | `backend/database.py:15` |

### Why the seam changes everything

```python
# backend/database.py (today)
def get_db():
    conn = _configure(sqlite3.connect(DB_PATH, check_same_thread=False))
    try:
        yield conn
    finally:
        conn.close()
```

Because **every** router does `db = Depends(get_db)` and never opens its own
connection, we can change *what* `get_db` yields — engine, tenant routing, pooling —
**without touching a single router**. This is the architectural lever the whole plan
rests on. It is why schema-per-tenant is cheap here and shared-table tenancy would be
expensive (the latter needs `WHERE tenant_id=?` in all 350+ queries).

---

## 2. Decisions (ADR summary)

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| ADR-1 | **PostgreSQL** as the cloud backend; SQLite stays first-class for desktop/tests | Concurrency, network access, managed backups, schemas | MySQL (weaker schema-per-tenant ergonomics) |
| ADR-2 | **Schema-per-tenant** isolation, routed at `get_db` via `SET LOCAL search_path` | Leakage structurally impossible; ~zero business-query changes; trivial per-tenant backup/export | Shared-table `tenant_id` (touches every query; one miss = leak); DB-per-tenant (heavier ops at scale) |
| ADR-3 | **Users/roles/permissions/audit stay INSIDE each tenant schema** | Exactly how each self-hosted install works today → RBAC/audit unchanged | Global users in `public` (would rewire auth + permissions) |
| ADR-4 | A **compatibility cursor** emulates the `sqlite3` API (`?` placeholders, `.lastrowid`, `Row` access) over psycopg | Keeps the 97 `lastrowid` sites + raw SQL unchanged | Rewrite every query to psycopg style |
| ADR-5 | Postgres gets a **squashed baseline schema** (final shape of all 123 migrations); SQLite keeps its existing chain | Replaying `PRAGMA`/`executescript`/table-rebuilds on PG is infeasible | Translate 123 migrations 1:1 (huge, fragile) |
| ADR-6 | Timestamp columns remain **TEXT ISO-8601** on Postgres too | Byte-for-byte parity → reports & date math behave identically | `timestamptz` (changes tz semantics, risks report drift) |
| ADR-7 | Object storage = **Cloudflare R2** (S3 API); attachments keyed `tenant_<id>/...` | Cheap egress, S3-compatible | Hetzner Object Storage (fine alt; same S3 client) |
| ADR-8 | **Redis** for cache + jobs (RQ/Arq); synchronous fallback retained | Background fan-out, scalability, without changing sync behavior now | Celery (heavier), in-proc threads only (no durability) |
| ADR-9 | **Docker Compose on Hetzner**, Caddy auto-TLS, per-tenant `pg_dump` backups to R2 | Simple, reproducible, cheap | Kubernetes (over-kill at this stage) |
| ADR-10 | Every phase is **flag-gated**; single-tenant self-hosted mode is the default | One codebase serves desktop + SaaS; safe incremental rollout | Fork the repo into two products |

---

## 3. Target architecture

```
                       ┌────────────────────────────────────────────┐
   acme.erp.app  ─────▶│  Caddy (auto-TLS, HTTP→HTTPS, HSTS)         │
   beta.erp.app  ─────▶│  reverse proxy + per-host routing          │
                       └───────────────┬────────────────────────────┘
                                       │
                       ┌───────────────▼────────────────┐   ┌──────────────┐
                       │  FastAPI app (uvicorn/gunicorn) │   │  RQ worker   │
                       │  ┌──────────────────────────┐   │   │ (jobs:       │
                       │  │ TenantMiddleware          │   │   │  notifs,     │
                       │  │  JWT → tenant schema      │   │   │  recurring,  │
                       │  └─────────┬────────────────┘   │   │  deprec.,    │
                       │  routers (UNCHANGED)            │   │  backfill)   │
                       │  └─── get_db ── SET LOCAL ───┐  │   └──────┬───────┘
                       └──────────────────────────────┼──┘          │
                                                      │             │
                   ┌──────────────────────────────────▼─────────────▼───┐
                   │  PostgreSQL                                         │
                   │   public.tenants (catalog)  public.platform_admins │
                   │   tenant_acme.*   tenant_beta.*   tenant_… .*       │
                   │   (each schema = one company's full ERP, incl.     │
                   │    users/roles/permissions/audit_log)              │
                   └────────────────────────────────────────────────────┘
                   ┌─────────────┐   ┌──────────────────────────────────┐
                   │  Redis      │   │  Cloudflare R2 (attachments)      │
                   │ cache+queue │   │  key = tenant_<id>/<entity>/<f>   │
                   └─────────────┘   └──────────────────────────────────┘
```

### Request lifecycle (cloud mode)

1. Browser hits `acme.erp.app`; Caddy terminates TLS, forwards to the app.
2. `TenantMiddleware` reads the auth JWT cookie → extracts `schema` claim → validates
   against `public.tenants` (status must be `active`) → sets `request.state.tenant`.
3. A router runs; its `Depends(get_db)` opens a pooled connection, begins a
   transaction, and issues `SET LOCAL search_path = tenant_acme, public`.
4. All existing raw SQL now resolves against `tenant_acme.*` — **unchanged**.
5. On response, the transaction commits/rolls back; `SET LOCAL` auto-resets, the
   connection returns to the pool clean (no path leakage to the next request).

### Login (how tenant is resolved)

- **Subdomain** (`acme.erp.app`) is the primary signal; the host → `public.tenants.slug`.
- Fallback: a **company code** field on the login form (for apex-domain / shared host).
- On success, the JWT carries `{ sub, schema, ... }`; nothing else in auth changes.
- Self-hosted/desktop mode: a single implicit tenant (`public` or one fixed schema) →
  login is byte-for-byte today's behavior.

---

## 4. The `get_db` seam — central design

Phases 0–2 all land in `database.py` behind one switch. Target shape:

```python
# Pseudocode — final form after Phases 0–2
BACKEND = os.environ.get("DB_BACKEND", "sqlite")   # 'sqlite' | 'postgres'

def get_db(request: Request = None):
    if BACKEND == "sqlite":
        conn = _configure(sqlite3.connect(DB_PATH, check_same_thread=False))
        try:    yield CompatConn(conn, dialect="sqlite")
        finally: conn.close()
    else:
        schema = _resolve_schema(request)            # from request.state.tenant
        conn = _PG_POOL.getconn()
        try:
            with conn.transaction():
                conn.execute("SET LOCAL search_path = %s, public", (schema,))
                yield CompatConn(conn, dialect="postgres")
        finally:
            _PG_POOL.putconn(conn)
```

`CompatConn` / `CompatCursor` emulate the slice of the `sqlite3` API the routers use:

| sqlite3 idiom used in routers | Compat shim behavior on Postgres |
|---|---|
| `db.execute("… ?", params)` | rewrite `?`→`%s`, run on psycopg |
| `cur.lastrowid` | auto-append `RETURNING id` to param-less-of-RETURNING INSERTs; cache the returned id |
| `row["col"]` / `row[0]` | psycopg `dict_row` + tuple access shim |
| `INSERT OR IGNORE …` | rewrite → `INSERT … ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE …` | rewrite → `INSERT … ON CONFLICT … DO UPDATE` (table-aware) |
| `datetime('now')`, `datetime('now','-90 days')` | rewrite → `to_char(now() [- interval '90 days'], 'YYYY-MM-DD"T"HH24:MI:SS')` (TEXT parity) |
| `db.commit()` / `db.rollback()` | proxy to psycopg transaction |

**Hand-ported (not mechanical) — enumerated at implementation time, small set:**
`json_extract` / `json_each`, `strftime`, `julianday`, `typeof()`. These appear mostly
in `reports.py` (17 sqlite refs), `dashboard.py` (10), `finance.py` (17). Each gets a
PG-equivalent behind a tiny `dialect.py` helper; the SQLite path is untouched.

---

## 5. Phase 0 — DB abstraction seam (prerequisite)

**Why.** Create the compat layer + dialect switch so Postgres can be introduced later
with zero router edits, while SQLite stays the default and every test stays green.

**Risk.** 🟠 Medium — central file, but additive; SQLite path is a pass-through.

**Files.** `backend/database.py` (wrap `get_db`), new `backend/db_compat.py`
(`CompatConn`/`CompatCursor`), new `backend/dialect.py` (idiom translation). No router changes.

**Migrate.**
1. Add `CompatConn` wrapping `sqlite3.Connection`; in `sqlite` mode it forwards 1:1.
2. Point `get_db` at `CompatConn`. Run full test-suite → must be 100% green (proves the
   wrapper is transparent).
3. Land `dialect.py` with the translation table (unit-tested in isolation).

**Rollback.** Set `DB_BACKEND=sqlite` (default) — wrapper is inert; or revert the 3 files.
No data touched.

**Keep-green.** SQLite remains the test/desktop default; wrapper is provably transparent.

---

## 6. Phase 1 — PostgreSQL as an alternative backend

**Why.** Multi-node concurrency, network DB, managed backups — SQLite can't.

**Risk.** 🔴 High (dialect surface). Mitigated by (a) the compat shim, (b) a squashed
baseline, (c) running the **same** test-suite against Postgres in CI.

**Files.** `backend/database.py` (PG pool + `postgres` branch), new
`backend/migrations/pg_baseline.sql` (squashed schema), `backend/requirements.txt`
(`psycopg[binary,pool]`), `backend/tests/conftest.py` (parametrize backend).

**Migrate.**
1. Author `pg_baseline.sql` = the final shape of all 123 SQLite migrations, in PG dialect
   (`SERIAL`/`GENERATED` PKs, `TEXT` timestamps per ADR-6, indexes preserved). Generate a
   first draft by introspecting a fully-migrated SQLite DB, then hand-tune types.
2. Record the baseline as migration `000_pg_baseline` in `schema_migrations`; **new**
   migrations from here are authored for both engines (or PG-only with a SQLite mirror).
3. Add `psycopg_pool.ConnectionPool`; implement the `postgres` branch of `get_db`.
4. CI: add a `postgres:16` service; run the suite with `DB_BACKEND=postgres`. Fix dialect
   gaps surfaced by failing tests (the suite becomes the conformance harness).

**Rollback.** Flip `DB_BACKEND=sqlite`. The SQLite file is untouched; the PG database is
additive. No data loss.

**Keep-green.** SQLite suite stays default and green; PG suite is a *new* CI lane that
must reach parity before any production cutover.

---

## 7. Phase 2 — Multi-tenancy (schema-per-tenant)

**Why.** Serve many companies from one deployment with hard isolation.

**Risk.** 🟢 Low (one seam) — the payoff of ADR-2/the `get_db` lever.

**Files.** `backend/database.py` (search_path routing + provisioning),
new `backend/tenancy.py` (catalog + middleware), `backend/main.py`/`launcher.py`
(register `TenantMiddleware`), `backend/routers/auth.py` (tenant resolution at login),
auth token builder (add `schema` claim). **Business routers: untouched.**

**Migrate.**
1. Create `public.tenants(id, slug, schema_name, status, plan, created_at)` and
   `public.platform_admins` (the SaaS operator — you).
2. `provision_tenant(slug)` → `CREATE SCHEMA tenant_<slug>` → run the **existing**
   migration runner with `search_path` set → seed roles + `admin` (reuse `seed.py`).
3. `TenantMiddleware`: JWT `schema` claim → validate `active` in `public.tenants` →
   `request.state.tenant`. Suspended/missing → 402/403.
4. `get_db` issues `SET LOCAL search_path` per request (transaction-scoped, pool-safe).
5. Login resolves tenant by subdomain → company-code fallback; issue JWT with `schema`.
6. Add **one** isolation test: two tenants, assert tenant A cannot read tenant B's rows.

**Rollback.** `TENANCY=single` pins `search_path` to one schema and skips the middleware
→ behaves exactly like today. Tenants catalog is inert.

**Keep-green.** Existing tests run in single-tenant mode unchanged; the isolation test is
additive.

> **Isolation guarantee.** With schema-per-tenant, a query in `tenant_acme` physically
> cannot name `tenant_beta`'s tables without an explicit cross-schema reference (which no
> business query contains). Optional defense-in-depth: Postgres **RLS** if any objects are
> ever moved to `public`. For pure schema isolation, the schema boundary *is* the wall.

---

## 8. Phase 3 — Attachments → object storage (R2/S3)

**Why.** DB BLOBs bloat backups and don't scale; offload to R2.

**Risk.** 🟢 Low — contained to the attachment read/write path; legacy BLOBs retained.

**Files.** `backend/routers/attachments.py`, HR/recruitment file endpoints, new
`backend/storage.py` (S3 client), migration adding `attachments.storage_key` +
`storage_backend` (BLOB `data` becomes nullable).

**Migrate.**
1. `storage.py` wraps `boto3`/`aioboto3` against R2; keys = `tenant_<id>/<entity>/<uuid>`.
2. Upload path (`STORAGE=s3`): stream bytes to R2, store `storage_key`; skip the BLOB.
3. Download path: if `storage_key` present → presigned URL (or proxy stream with the same
   `Content-Disposition`/`nosniff` headers already in `attachments.py`); else serve legacy BLOB.
4. Background **backfill job** copies existing BLOBs → R2, sets `storage_key`, then nulls
   `data` once verified.

**Rollback.** `STORAGE=db` → ignore R2, serve BLOBs (kept until backfill verified).

**Keep-green.** Default `STORAGE=db` preserves today's behavior; existing attachment tests
pass unchanged.

---

## 9. Phase 4 — Redis (cache + background jobs)

**Why.** Durable async fan-out and caching for scale, without changing current sync behavior.

**Risk.** 🟢 Low — opt-in; synchronous fallbacks retained.

**Files.** new `backend/cache.py`, `backend/jobs.py` (RQ/Arq), worker entrypoint,
`requirements.txt` (`redis`, `rq`). Call sites wrapped, not rewritten.

**Migrate.**
1. Cache read-mostly hot paths (settings, permissions, tax rates) behind `cache.get_or_set`;
   `CACHE=none` bypasses (identity function).
2. Move side-effecting fan-out to jobs **with inline fallback**: notification fan-out,
   recurring expenses, asset depreciation runs, report exports, attachment backfill.
   `JOBS=inline` runs them synchronously exactly as today.
3. Stand up one `rq` worker container; jobs are tenant-aware (carry `schema`).

**Rollback.** `CACHE=none`, `JOBS=inline` → fully synchronous, current behavior.

**Keep-green.** Both flags default to off; calculations and ordering unchanged.

---

## 10. Phase 5 — Docker + Hetzner + production ops

**Why.** Reproducible, secure, monitored deployment.

**Risk.** 🟠 Medium — infra, not app logic; staged behind a staging environment.

**Files (all new, no app logic):** `Dockerfile` (multi-stage: Vite build → python-slim
runtime, non-root user), `docker-compose.yml` (api, worker, postgres, redis, caddy,
backup), `Caddyfile`, `.env.production.example`, `ops/backup.sh`, `ops/restore.sh`,
`.github/workflows/deploy.yml`.

**Migrate.**
1. **Image:** multi-stage; runtime contains backend + built `static/`; runs `gunicorn -k uvicorn.workers.UvicornWorker`.
2. **Compose:** Postgres (Hetzner Volume for data), Redis, app, worker, Caddy (auto-TLS via
   Let's Encrypt, HSTS), backup sidecar.
3. **Backups:** nightly per-tenant `pg_dump --schema=tenant_x` + a full base backup; WAL
   archiving; ship to R2 (`ops/backup.sh`); test `ops/restore.sh` monthly.
4. **Logging:** structured JSON to stdout → shipped to Loki/Grafana (or Vector→file early).
5. **Monitoring:** `/api/health` (exists) + Postgres/Redis/node exporters → Prometheus +
   Uptime alerting.
6. **Security:** ufw firewall, fail2ban, secrets via env/secret store (never in image),
   container runs non-root, CORS already origin-restricted (`launcher.py`), HSTS, login
   rate-limiting already present (`login_attempts`), per-tenant request limits at Caddy.
7. **Env/secrets:** `SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, `R2_*`, `COOKIE_SECURE=true`,
   `ALLOWED_ORIGINS` per environment.

**Rollback.** `docker compose down` + restore last good image tag + DB from backup; DNS TTL
kept low during cutover.

**Keep-green.** CI builds the image and runs the suite inside it before any deploy.

---

## 11. Phase 6 — Layering (opportunistic, never a rewrite)

**Why.** Long-term maintainability — but introduced incrementally so nothing breaks.

**Risk.** 🟢 Low — additive seams; legacy call paths keep working.

| Layer | How it appears here | Effort posture |
|---|---|---|
| **Tenant middleware** | Delivered in Phase 2 | Done by then |
| **Repository/Data** | The `CompatConn` *is* the data layer; add per-module repo functions only when a module is next touched | Opportunistic |
| **Service** | Pure business modules already exist: `accounting.py`, `costing.py`, `lots.py`, `approval_engine.py` — keep as-is, extract more only as needed | Opportunistic |
| **API** | Routers unchanged | None |
| **Workers** | Delivered in Phase 4 | Done by then |

**Rule:** no module is rewritten "for layering." Layers are added at the moment a module is
already being modified for a feature, never as a big-bang refactor.

---

## 12. Data migration — SQLite → Postgres (per tenant)

1. For each company DB: run the SQLite chain to head, then a one-shot ETL copies tables in
   FK-safe order into a freshly provisioned `tenant_<slug>` schema (types per ADR-6).
2. Verify with row-count + checksum parity per table; reconcile `schema_migrations`.
3. Cutover: read-only window → final delta copy → flip `DB_BACKEND`/DNS → verify → done.
4. **Reverse path retained:** `pg_dump --schema` → SQLite converter regenerates a desktop
   `.db`, so a customer can always be handed a self-hostable copy (and to roll back).

---

## 13. Testing strategy

- **Same suite, two backends.** Parametrize `conftest.py`: `sqlite` (default, fast, local)
  and `postgres` (CI service container). Parity is the acceptance bar for Phase 1.
- **New, additive tests only:** cross-tenant isolation; storage backend (db vs s3);
  job inline-vs-redis equivalence. No existing test is modified.
- **Conformance:** the existing 300+ tests are the dialect/oracle for the compat shim.

---

## 14. Backward-compatibility guarantees

The **desktop product and the SaaS share one codebase**, separated only by flags:

| Flag | Desktop / self-hosted | Cloud SaaS |
|---|---|---|
| `DB_BACKEND` | `sqlite` | `postgres` |
| `TENANCY` | `single` | `schema` |
| `STORAGE` | `db` | `s3` |
| `CACHE` / `JOBS` | `none` / `inline` | `redis` / `rq` |

With all flags at their desktop defaults, behavior is **byte-for-byte today's** — so the
existing `.exe` / `.dmg` / `.AppImage` builds keep shipping unchanged throughout.

---

## 15. Tenant lifecycle

`signup → provision (CREATE SCHEMA + migrate + seed admin) → active → suspend (middleware
blocks, data retained) → export (pg_dump schema / convert to SQLite) → delete (drop schema
after retention)`. Ties into the existing per-module licensing (`test_module_provisioning`,
`setup_wizard`) — modules remain a per-tenant entitlement.

---

## 16. Security & isolation hardening

- **Structural isolation** via schema boundary (ADR-2); optional **RLS** as defense-in-depth.
- **Pool safety:** `SET LOCAL search_path` inside a per-request transaction — never a bare
  `SET` (which would leak the path to the next pooled checkout).
- **Auth unchanged:** JWT HS256 HttpOnly cookies, PBKDF2; add only a `schema` claim.
- Reuse existing controls: CORS origin allow-list, login rate-limiting (`login_attempts`),
  attachment content-type allow-list + `nosniff`, audit log (now per-schema).
- Transport: Caddy auto-TLS + HSTS; `COOKIE_SECURE=true` in cloud.

---

## 17. Risk register

| Phase | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 0 Seam | Wrapper alters behavior | Low | High | Suite must stay 100% green in sqlite mode |
| 1 Postgres | Dialect gaps in reports/finance | Med | High | Squashed baseline + dual-backend CI + shim |
| 1 Postgres | Timestamp semantics drift | Med | High | ADR-6: keep TEXT ISO-8601 |
| 2 Tenancy | search_path leak via pool | Low | Critical | `SET LOCAL` in transaction; isolation test |
| 3 Storage | Lost/duplicated files in backfill | Low | Med | Keep BLOBs until verified; idempotent keys |
| 4 Redis | Job/sync behavior divergence | Low | Med | Inline fallback is the oracle |
| 5 Ops | Bad deploy / data loss | Low | Critical | Staging, low DNS TTL, tested restores |
| 6 Layering | Scope creep into rewrites | Med | Med | Opportunistic-only rule |

---

## 18. Sequencing & rough effort

| Milestone | Phases | Indicative effort* |
|---|---|---|
| M1 — Seam + Postgres parity in CI | 0, 1 | ~2–4 weeks |
| M2 — Multi-tenant on staging | 2 | ~1–2 weeks |
| M3 — Storage + Redis | 3, 4 | ~1–2 weeks |
| M4 — Containerized prod on Hetzner | 5 | ~1–2 weeks |
| M5 — Layering as features land | 6 | ongoing |

\* *Indicative for one engineer; the dialect-parity work in M1 dominates and is the gate.*

---

## 19. Open questions

1. **Subdomain vs company-code** as the primary tenant signal (affects DNS + login UI).
2. **R2 vs Hetzner Object Storage** (same S3 client; pick on egress/cost).
3. **Per-tenant `pg_dump`** nightly vs cluster-level base-backup + WAL only (RPO target?).
4. **Plan/billing** integration point (Stripe?) — out of scope here, but the `tenants.plan`
   column anticipates it.

---

### Appendix A — flags (single source of truth)

```
DB_BACKEND = sqlite | postgres        # §5–6
TENANCY    = single  | schema         # §7
STORAGE    = db      | s3             # §8
CACHE      = none    | redis          # §9
JOBS       = inline  | rq             # §9
```

### Appendix B — files introduced (none modify business logic)

```
backend/db_compat.py            backend/storage.py        Dockerfile
backend/dialect.py              backend/cache.py          docker-compose.yml
backend/tenancy.py              backend/jobs.py           Caddyfile
backend/migrations/pg_baseline.sql                        ops/backup.sh, ops/restore.sh
```
