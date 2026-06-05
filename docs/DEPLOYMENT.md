# Cloud Deployment (Docker + Hetzner)

Phase 5 of the SaaS migration (see [SAAS_ARCHITECTURE.md](SAAS_ARCHITECTURE.md) §10).
The whole stack runs from `docker-compose.yml`: **Caddy** (TLS + SPA) → **app**
(FastAPI/gunicorn) + **worker** (RQ) → **Postgres** + **Redis**, with a nightly
**backup** sidecar.

```
            ┌── Caddy (web) ──┐  auto-TLS, serves SPA, proxies /api
 Internet ─▶│  :80 / :443     │────────────┐
            └─────────────────┘            ▼
                                   ┌── app (gunicorn main:app) ──┐
                                   │  /api/*                      │
                                   └───────┬──────────────┬──────┘
                                           ▼              ▼
                                      Postgres         Redis ◀── worker (RQ)
                                     (pgdata vol)    (cache + jobs)
                                           ▲
                                      backup sidecar → nightly pg_dump
```

## Prerequisites

- A Hetzner Cloud VM (CPX21+ is plenty to start), Ubuntu 22.04/24.04.
- A domain with an **A record** → the VM's IP (and a wildcard `*.erp.example.com`
  if you run schema-per-tenant on subdomains).
- Docker Engine + the compose plugin on the VM.

## First deploy

```bash
# on the VM
git clone <your-repo> erp && cd erp
cp .env.production.example .env
nano .env          # set SECRET_KEY, POSTGRES_PASSWORD, DOMAIN, flags (see below)

docker compose up -d --build
docker compose logs -f app        # watch the bootstrap + gunicorn start
```

Caddy obtains a Let's Encrypt certificate for `DOMAIN` automatically. Open
`https://<DOMAIN>` — the SPA loads and talks to `/api`.

### Required `.env` values
| Key | Notes |
|---|---|
| `SECRET_KEY` | `python -c "import secrets; print(secrets.token_hex(32))"` |
| `POSTGRES_PASSWORD` | strong; compose builds `DATABASE_URL` from it |
| `DOMAIN` | real hostname for TLS, or `:80` for an HTTP-only test |
| `ALLOWED_ORIGINS` | `https://<DOMAIN>` |
| `COOKIE_SECURE` | `true` in production (HTTPS) |

### Optional capabilities (all default to off → unchanged single-tenant behavior)
| Flag | Off (default) | On |
|---|---|---|
| `TENANCY` | `single` | `schema` (multi-tenant) |
| `STORAGE` | `db` | `s3` (+ `S3_*` for AWS/R2/MinIO) |
| `CACHE` | `none` | `redis` (compose sets `REDIS_URL`) |
| `JOBS` | `inline` | `rq` (the `worker` service processes them) |

## Single-tenant vs multi-tenant

- **Single (`TENANCY=single`)** — one company. The bootstrap runs `init_db` and
  the install is ready; log in as the `admin` printed in `docker compose logs app`.
- **Schema-per-tenant (`TENANCY=schema`)** — many companies, one Postgres schema
  each. The bootstrap only creates the `public` catalog. Then:
  ```bash
  # create the first platform operator (one-time)
  docker compose exec app python -c "import tenancy; print(tenancy.create_platform_admin('operator'))"
  # → log in at POST /api/platform/login, then provision tenants:
  #   POST /api/platform/tenants {"slug":"acme","name":"Acme"}  → returns first admin creds
  ```
  Point `acme.erp.example.com` (wildcard DNS) at the VM; the tenant is resolved
  from the subdomain (or an `X-Tenant` header / the signed session).

## Backups & restore

The `backup` service runs `ops/backup.sh` nightly: a compressed `pg_dump` of the
whole database (every tenant schema) into the `backups` volume, 14-day retention.
Offsite copy to S3/R2 is enabled by setting `BACKUP_S3_BUCKET` (and adding an `aws`
CLI to the image).

```bash
# run a backup now
docker compose exec backup sh /ops/backup.sh
# restore a dump (DESTRUCTIVE — stop app/worker first)
docker compose stop app worker
docker compose run --rm backup sh /ops/restore.sh /backups/erp-<TS>.dump
docker compose start app worker
```

## Updating

```bash
git pull
docker compose up -d --build      # rebuilds images; bootstrap re-runs migrations idempotently
```

## Security hardening checklist (host)

- [ ] **Firewall:** `ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`
      (do **not** expose Postgres/Redis — they stay on the internal compose network).
- [ ] **SSH:** key-only auth (`PasswordAuthentication no`), non-root login.
- [ ] **fail2ban** for sshd.
- [ ] **Secrets:** real values only in `.env` (git-ignored); rotate `SECRET_KEY`/DB
      password if ever exposed.
- [ ] **Unattended security upgrades** (`unattended-upgrades`).
- [ ] **Container user:** the app runs as a non-root `appuser` (already baked in).
- [ ] **HTTPS/HSTS:** provided by Caddy (`Strict-Transport-Security` header set).
- [ ] **Backups:** verify a restore into a scratch DB monthly.

## Monitoring & logging

- **Health:** `GET /api/health` (app), Postgres/Redis have compose healthchecks.
- **Logs:** structured to stdout — `docker compose logs -f app worker`; ship to a
  collector (Grafana Loki / Vector) for retention.
- **Metrics (optional):** add `postgres_exporter` / `redis_exporter` + Prometheus
  and a node exporter; alert on disk (the `pgdata`/`backups` volumes) and on the
  health endpoints.

## Notes / next steps

- The app opens a Postgres connection per request (Phase 1 deferred pooling). At
  higher load add **PgBouncer** (or `psycopg_pool`) between app and Postgres.
- Caddy can scale to multiple `app` replicas (`reverse_proxy app:8000` load-balances
  across compose replicas) once you add `deploy.replicas`.
