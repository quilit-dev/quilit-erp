# Production Deployment — Cloudflare → Railway → Postgres + R2

The live-hosting runbook for this repo. One Docker service serves both the SPA
and the API, so there is no CORS surface and no second deploy to keep in sync.

```
                    Users
                      │
                      ▼
             Cloudflare (free)
          DNS · TLS · CDN · WAF
                      │
                      ▼
              Railway (Docker)
      ┌────────────────────────────┐
      │  React (Vite build)        │
      │  FastAPI (gunicorn)        │
      └────────────────────────────┘
                 │        │
                 ▼        ▼
     Railway PostgreSQL   Cloudflare R2
        (business data)   (PDF · Word · Excel)
```

Everything the image needs is already in the repo: the `app` stage of
[`Dockerfile`](../Dockerfile) binds `$PORT`, trusts the platform's
`X-Forwarded-*` headers, runs as a non-root user and health-checks
`/api/health`. `requirements-cloud.txt` carries `psycopg`, `boto3` and
`gunicorn`.

---

## 1. Cloudflare R2 (documents)

1. **R2 → Create bucket** — e.g. `quilit-erp-docs`. Keep it **private**; the API
   streams files after checking permissions.
2. **Manage R2 API Tokens → Create** with *Object Read & Write* on that bucket.
3. Note the **Access Key ID**, **Secret Access Key**, and your account's S3
   endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

R2 charges **no egress**, and the first 10 GB of storage are free — at ten
customers this line item is effectively zero.

---

## 2. Railway

1. **New Project → Deploy from GitHub repo** → `quilit-dev/quilit-erp`.
   Railway reads [`railway.json`](../railway.json) and builds the Dockerfile.
2. **Add → Database → PostgreSQL** in the same project.
3. **Service → Variables** — copy from
   [`.env.railway.example`](../.env.railway.example). The essentials:

   | Variable | Value |
   |---|---|
   | `DB_BACKEND` | `postgres` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — see warning below |
   | `RUN_BOOTSTRAP` | `1` |
   | `SECRET_KEY` | `python -c "import secrets; print(secrets.token_hex(32))"` |
   | `COOKIE_SECURE` | `true` |
   | `TENANCY` | `schema` (multi-customer) or `single` |
   | `STORAGE` | `s3` |
   | `S3_BUCKET` / `S3_ENDPOINT_URL` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from step 1 |
   | `ALLOWED_ORIGINS` | `https://app.quilit.dev` |
   | `WEB_CONCURRENCY` | `2` |

> **`DATABASE_URL` must be set on the *application* service.** The
> `${{Postgres.DATABASE_URL}}` reference resolves only when your Postgres
> service is named exactly `Postgres`; if it is named anything else the
> variable arrives empty. Either match the name or paste the literal
> connection string from the Postgres service's Variables tab, preferring the
> internal `*.railway.internal` host over the public proxy. The app fails fast
> with an explanatory error when this is missing.

> **`SECRET_KEY` must be set explicitly and never rotated casually.** Without
> it the app generates an ephemeral key, which silently invalidates every
> session on restart. Changing it logs everyone out.

4. **Settings → Networking → Custom Domain** → `app.quilit.dev`, and (for
   schema tenancy) the wildcard `*.quilit.dev`. Railway shows the CNAME target.

---

## 3. Cloudflare DNS

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `app` | *(Railway target)* | Proxied |
| CNAME | `*` | *(Railway target)* | Proxied |

Set SSL/TLS mode to **Full (strict)** — Railway serves a valid certificate, and
anything less leaves the Cloudflare→Railway hop unverified.

Cloudflare's Universal SSL covers **one** subdomain level, so `acme.quilit.dev`
is fine. A second level (`a.b.quilit.dev`) would need Advanced Certificate
Manager — avoid it in tenant slugs.

The reserved labels `www`, `app`, `api` and `admin` are **never** treated as
tenant slugs ([`tenancy.py`](../backend/tenancy.py) `_subdomain`), so
`app.quilit.dev` stays your main entry point.

---

## 4. First boot

`RUN_BOOTSTRAP=1` prepares the database on every deploy (idempotent):

- `TENANCY=single` → creates/upgrades the single schema.
- `TENANCY=schema` → creates the shared `public` catalogs only
  (`tenants`, `platform_admins`). Customer schemas are provisioned per tenant.

**Create the first platform operator** — this is the one manual step, since
nothing seeds it automatically. In the Railway service shell:

```bash
cd backend && python -c "import tenancy; print(tenancy.create_platform_admin('opsadmin'))"
```

It prints a generated password **once**. This identity is separate from tenant
users — its own table and its own cookie — so an operator session can never be
mistaken for a customer's.

### Onboarding a customer

Sign in at `https://app.quilit.dev/vendor-admin`, create the tenant, and hand
over the credentials it returns:

```bash
curl -X POST https://app.quilit.dev/api/platform/tenants \
  -H "Content-Type: application/json" \
  -d '{"slug":"acme","name":"Acme Ltd","plan":"trial"}'
```

`provision_tenant()` creates the schema, applies the full ledger baseline,
seeds roles and an admin, and returns the admin password **once**. The account
is flagged `must_change_password`, so the customer sets their own on first
login. They reach their workspace at `https://acme.quilit.dev`.

Ending a trial is **suspend**, not delete — suspended tenants get a clean
"workspace is suspended" response and their data is retained, so converting to
paid is just flipping the status back.

---

## 5. Post-deploy checks

```bash
curl -fsS https://app.quilit.dev/api/health          # 200
curl -sI https://app.quilit.dev | grep -i strict     # HSTS via Cloudflare
```

- [ ] Login works, and the session survives a page reload (proves the `Secure`
      cookie is being set and returned).
- [ ] Upload a PDF to any record, then confirm the object appears in the R2
      bucket — that verifies `STORAGE=s3` is actually in effect rather than
      silently falling back to database BLOBs.
- [ ] Railway logs show JSON lines (`LOG_FORMAT=json`).
- [ ] The login rate-limiter sees real client IPs, not one shared proxy
      address. `--forwarded-allow-ips='*'` is set in the Dockerfile; if IPs
      still collapse to one value, every user shares a single 5-attempt
      bucket and can lock each other out.

---

## 6. Ongoing

**Backups.** Railway snapshots Postgres, but *verify a restore* before you have
customers — an untested backup is not a backup. R2 holds the documents; enable
object versioning if you want protection against accidental deletion.

**Scaling.** At ten customers with fewer than ten users each, one instance at
`WEB_CONCURRENCY=2` is comfortable. Raise concurrency before adding replicas;
add `CACHE=redis` / `JOBS=rq` only when a measured bottleneck justifies the
extra moving parts.

**Region.** Deploy to the Railway region nearest your customers. Latency is the
single biggest factor in how fast the ERP *feels*, and it costs nothing to get
right at setup — versus roughly 200 ms of avoidable round-trip if the region is
on the wrong continent.
