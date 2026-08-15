# ERP System — Technical Documentation

> **Version:** 2.2 &nbsp;|&nbsp; **Last Updated:** 2026-07-01 &nbsp;|&nbsp; **Stack:** Python · FastAPI · React 18 · SQLite / PostgreSQL

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Installation & Setup](#3-installation--setup)
4. [Configuration Reference](#4-configuration-reference)
5. [Authentication & Security](#5-authentication--security)
6. [User Management & RBAC](#6-user-management--rbac)
7. [Modules](#7-modules)
   - 7.1  [Dashboard](#71-dashboard)
   - 7.2  [Clients](#72-clients)
   - 7.3  [Projects](#73-projects)
   - 7.4  [Quotations](#74-quotations)
   - 7.5  [Invoices](#75-invoices)
   - 7.6  [Inventory](#76-inventory)
   - 7.7  [Purchases](#77-purchases)
   - 7.8  [Suppliers](#78-suppliers)
   - 7.9  [Finance](#79-finance)
   - 7.10 [Expenses](#710-expenses)
   - 7.11 [CRM](#711-crm)
   - 7.12 [Planning](#712-planning)
   - 7.13 [HR (Human Resources)](#713-hr-human-resources)
     - 7.13.1 [HR Contracts](#7131-hr-contracts)
     - 7.13.2 [HR Activities](#7132-hr-activities)
     - 7.13.3 [Recruitment](#7133-recruitment)
   - 7.14 [Reports](#714-reports)
   - 7.15 [Archives](#715-archives)
   - 7.16 [Recycle Bin](#716-recycle-bin)
   - 7.17 [Audit Log](#717-audit-log)
   - 7.18 [Settings](#718-settings)
   - 7.19 [Approval Policies](#719-approval-policies)
   - 7.20 [Approval Requests](#720-approval-requests)
   - 7.21 [Tax Rates](#721-tax-rates)
   - 7.22 [POS — Point of Sale](#722-pos--point-of-sale)
   - 7.23 [Cash Management](#723-cash-management)
   - 7.24 [Manufacturing](#724-manufacturing)
   - 7.25 [Fixed Assets](#725-fixed-assets)
   - 7.26 [Recurring Expenses](#726-recurring-expenses)
   - 7.27 [Attachments (cross-cutting)](#727-attachments-cross-cutting)
   - 7.28 [Accounting (General Ledger)](#728-accounting-general-ledger)
   - 7.29 [Client Communications](#729-client-communications)
8. [Taxation & Multi-Currency](#8-taxation--multi-currency)
9. [API Reference](#9-api-reference)
10. [Database Schema](#10-database-schema)
11. [Frontend Architecture](#11-frontend-architecture)
12. [Backup & Recovery](#12-backup--recovery)
13. [Localization](#13-localization)
14. [Testing & QA](#14-testing--qa)
15. [Notifications](#15-notifications)
16. [Product Variants & Attributes](#16-product-variants--attributes)
17. [Category Registry](#17-category-registry)
18. [Multi-Branch & Multi-Warehouse](#18-multi-branch--multi-warehouse)
19. [Module Licensing](#19-module-licensing)
20. [Document Rendering](#20-document-rendering)
21. [Client Communications & Share Links](#21-client-communications--share-links)
22. [Subscription Lifecycle](#22-subscription-lifecycle)
23. [Scale & Performance](#23-scale--performance)

---

## 1. System Overview

This ERP (Enterprise Resource Planning) system is a full-stack business management platform designed for small-to-medium enterprises. It centralizes operations across sales, finance, inventory, project management, human resources, and customer relations into a single self-hosted application.

### Key Capabilities

| Area | Capabilities |
|------|-------------|
| **Sales** | Quotations → invoices → payments, partial / multi-currency payment tracking, aging reports, WhatsApp share |
| **POS** | Cash-drawer sessions, USD/LBP checkout, refunds that void invoices + restock, inventory autocomplete on custom lines |
| **Manufacturing** | Versioned BOMs with scrap %, multi-level sub-assemblies, resource-based overhead costing (per-hour resources × actual production hours), quality control with quarantine + defects + rework, scheduling/priority/partial completion, analytics & cost-variance reports, production-order lifecycle |
| **Inventory** | Raw / semi-finished / finished / consumable items, **product variants** (owner-defined attribute axes — e.g. Size / Color / Storage), per-item **USD or LBP** unit-cost & sale-price, weighted-average / FIFO / LIFO costing, batch/lot tracking with expiry + FEFO + full traceability, low-stock alerts, stock movements |
| **Variants & Attributes** | Owner-defined attribute fields (global + per-business-type presets seeded from the chosen vertical); a parent "product" fans out into variant SKUs across selected axes. See §16 |
| **Categories** | Owner-managed per-domain category registry (Inventory / Expense / Asset / Project) edited in Settings; expense categories map to a GL account. See §17 |
| **Promotions** | Time- or quantity-bound automatic discounts (per item / category / store) applied at POS |
| **Multi-branch** | Optional per-branch scoping of records and reporting; branch = warehouse. See §18 |
| **Procurement** | Suppliers, PO lifecycle (Ordered → Received → Paid) that auto-posts expense + adjusts landed cost |
| **Finance** | Revenue / expense tracking, accrual + cash views, period locking, smart insights, recurring expense templates |
| **Accounting** | Double-entry general ledger: Chart of Accounts, journal entries (auto-posted from invoices/expenses/payroll/depreciation/purchases + manual), Trial Balance, Income Statement, Balance Sheet |
| **Fixed Assets** | Capital register, straight-line depreciation auto-posted as expenses, disposal, capex approval workflow |
| **Cash** | Daily till reconciliation with auto-captured sales + expenses, USD/LBP variance reporting |
| **Taxation** | Admin-managed named tax rates (multiple standard / reduced / zero / exempt), per-line tax snapshot, VAT report with per-rate breakdown |
| **Multi-Currency** | Dual-currency (USD base + LBP secondary by default) with manual exchange-rate history |
| **Projects** | Project lifecycle, budget-vs-actual, milestone planning, Gantt-style planning board |
| **CRM** | Leads → deals → conversion to clients, contact directory, activity log |
| **HR** | Employee directory, departments, salary/role history, leave requests (auto-status flip while on leave), monthly payroll runs (with NSSF/tax breakdown, auto-posted to Finance), employee file attachments, formal contracts, recruitment pipeline, personal activity log with reminders |
| **Approvals** | Rule-based multi-step approval chains; expenses, invoices, purchases, projects, fixed-asset purchases |
| **Access Control** | RBAC across 20+ modules, **server-side module licensing** (a module a customer didn't buy is blocked at its API, not just hidden), JWT sessions with revocation, audit trail, recycle bin |
| **Localization** | Full English and Arabic (RTL), including backend-generated notification text (rendered per viewer's language). See §13 |
| **Resilience** | Automatic + manual backups, one-click backup to USB / network folder |
| **Attachments** | File attachments on any record — invoices, purchases, projects, expenses, fixed assets, suppliers, clients, quotations, inventory — stored as DB BLOBs |
| **Licensing / white-label** | Per-customer module set via `backend/vendor_config.py` (immutable at runtime) **or** an `ENABLED_MODULES` env var, so one codebase can run as several branded instances. See §19 |

### Technology Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.11+, FastAPI, Uvicorn (ASGI) |
| **Database** | SQLite (single-file, zero-config) |
| **Frontend** | React 18, Vite, React Router v6 |
| **Auth** | JWT (HS256) via HttpOnly cookies, PBKDF2-SHA256 passwords |
| **Packaging** | PyInstaller (Windows .exe), Inno Setup (installer) |

---

## 2. Architecture

```
erp-system/
├── backend/                    # Python/FastAPI backend
│   ├── main.py                 # FastAPI app, router registration, startup
│   ├── database.py             # SQLite schema, numbered migrations, connection management
│   ├── auth_utils.py           # Password hashing, JWT generation/verification
│   ├── permissions.py          # RBAC middleware and permission checks
│   ├── approval_engine.py      # Multi-step approval workflow logic
│   ├── backup_manager.py       # Automatic and manual backup logic
│   ├── utils.py                # Shared helpers (timestamps, tax calculations)
│   ├── routers/                # API endpoints (one file per module)
│   │   ├── auth.py             clients.py     projects.py
│   │   ├── quotations.py       invoices.py    inventory.py
│   │   ├── purchases.py        suppliers.py   finance.py
│   │   ├── pos.py              # Point-of-sale sessions + checkout + refunds
│   │   ├── cash.py             # Cash-drawer reconciliations
│   │   ├── manufacturing.py    # BOMs + production orders
│   │   ├── assets.py           # Fixed assets + depreciation
│   │   ├── recurring.py        # Recurring expense templates
│   │   ├── tax_rates.py        # Admin-managed named tax rates
│   │   ├── crm.py              planning.py    hr.py
│   │   ├── reports.py          dashboard.py   search.py
│   │   ├── notifications.py    approval_policies.py  approval_requests.py
│   │   ├── settings.py         documents.py   audit.py
│   │   ├── archives.py         announcements.py
│   │   └── users.py            roles.py
│   ├── tests/                  # Pytest QA suite (see §14) — 1074 passing
│   │   ├── conftest.py         # Fixtures: fresh DB per test, auth clients
│   │   ├── test_smoke_endpoints.py     test_auth_session.py
│   │   ├── test_role_permission_matrix.py
│   │   ├── test_tax_system.py          test_tax_engine.py
│   │   ├── test_vat_report.py
│   │   ├── test_pos.py                 test_cash.py
│   │   ├── test_manufacturing.py
│   │   ├── test_exchange_rate.py       test_lbp_payment.py
│   │   ├── test_usb_backup.py
│   │   └── …
│   ├── seed.py                 # Comprehensive sample-data seeder
│   ├── env.example             # Environment variable template
│   └── requirements.txt
│
├── frontend_src/               # React frontend source
│   ├── src/
│   │   ├── main.jsx            # App entry point (LocaleProvider wrapper)
│   │   ├── App.jsx             # Router, layout, language toggle
│   │   ├── index.css           # Global CSS (design tokens, component styles)
│   │   ├── pages/              # One component per page/module
│   │   ├── components/         # Shared UI components
│   │   │   ├── Sidebar.jsx     # Navigation sidebar
│   │   │   ├── shared.jsx      # Badge, Pagination, Modal, ExportButton, etc.
│   │   │   └── CommandPalette.jsx  # Global keyboard search (Ctrl+K)
│   │   ├── hooks/              # Custom React hooks
│   │   │   ├── useSettings.jsx    # Company settings context
│   │   │   ├── usePermissions.js  # RBAC permission checks
│   │   │   └── useLocale.jsx      # i18n translation context
│   │   ├── api/
│   │   │   └── client.js       # Axios instance + all API calls
│   │   └── locales/
│   │       ├── en.js           # English translations
│   │       └── ar.js           # Arabic translations
│   ├── package.json
│   └── vite.config.js
│
├── static/                     # Built frontend assets (served by backend)
├── backups/                    # Auto-managed daily/weekly DB backups
│   ├── daily/
│   └── weekly/
├── erp.db                      # SQLite database (auto-created on first run)
├── launcher.py                 # Entry point — run from the project root
├── build.ps1                   # Windows build script (frontend + PyInstaller)
├── ERP.spec                    # PyInstaller build spec
├── installer/                  # Inno Setup installer files
│   └── ERP-System.iss          # Windows installer script
├── README.md                   # Quick-start guide
└── DOCUMENTATION.md            # This file
```

### Request Flow

```
Browser → React (Vite dev server / static build)
       → HTTP request with HttpOnly cookie
       → FastAPI (uvicorn on port 8765)
       → permissions.py middleware (JWT + RBAC check)
       → router handler
       → SQLite (database.py)
       → JSON response
```

---

## 3. Installation & Setup

### Prerequisites

- Python 3.11 or later
- Node.js 18 or later

### Development Setup

```bash
# 1. Install backend dependencies
cd backend
pip install -r requirements.txt

# 2. Configure environment variables
cp env.example .env
# Edit backend/.env and set your SECRET_KEY:
# python -c "import secrets; print(secrets.token_hex(32))"

# 3. Start the backend from the PROJECT ROOT
#    (launcher.py auto-initializes the database on first run)
cd ..
python launcher.py

# 4. In a separate terminal, start the frontend dev server
cd frontend_src
npm install
npm run dev
```

- Backend: **http://localhost:8765**
- Frontend dev server: **http://localhost:5173** (proxies API calls to backend)

### First-Run Setup Wizard

On first launch, the app redirects to `/setup`. The setup wizard collects:

- Company name, address, country, phone, email, website
- Tax number and registration number
- Bank details (name, account number, IBAN, SWIFT)
- Default currency, tax rate, and payment terms
- Invoice and quotation number prefixes
- Admin account (username and password)

Once completed, `settings.setup_complete` is set to `"1"` and the wizard is permanently disabled.

### Production Build

```bash
# Build the frontend for production
cd frontend_src
npm run build
# Output written to frontend_src/dist/

# Run the backend from the project root — it serves the built frontend
cd ..
python launcher.py
```

### Windows Executable & Installer

The `build.ps1` script at the project root runs the complete Windows packaging pipeline in three stages. Run it from PowerShell in the repo root:

```powershell
.\build.ps1
```

| Stage | Tool | Output |
|-------|------|--------|
| 1. Build frontend | Vite (`npm run build`) | `static/` |
| 2. Bundle executable | PyInstaller (`ERP.spec`, onedir) | `dist/ERP System/ERP System.exe` |
| 3. Compile installer | Inno Setup 6 (`installer/ERP-System.iss`) | `installer/Output/*.exe` |

**One-time prerequisites:** Node.js, `pip install pyinstaller`, and [Inno Setup 6](https://jrsoftware.org/isdl.php).

To build only the standalone executable (skipping the installer), run `python -m PyInstaller ERP.spec` directly.

---

## 4. Configuration Reference

All runtime configuration is provided via **environment variables**. Create a `.env` file inside the `backend/` directory (copy from `backend/env.example`).

> ### The container filesystem is ephemeral
>
> The hosted deployment declares **no volume**, and the Dockerfile copies the
> built frontend into `/app/static` at BUILD time. Anything the app writes at
> runtime lives on the container's writable layer and **is destroyed by the next
> deploy**.
>
> So uploads belong in the database, not on disk. `attachments` already stored
> its bytes as a BLOB; the company logo was moved the same way
> (`company_logo` table) after it turned out to be written to
> `static/logo.png` — where every redeploy silently wiped a customer's branding,
> and where *one file served every tenant*, so whoever uploaded last replaced
> everyone else's logo on their invoices.
>
> It fails silently and on a delay: the upload works, reads back fine for days,
> and disappears at an unrelated deploy. Before adding any feature that writes a
> file, ask where it lives after a redeploy.

### Verifying a deploy

`GET /api/health` returns the commit the process is running:

```json
{"status": "ok", "commit": "2e6b2cac2014"}
```

Resolved once at import (this is a liveness probe hit every few seconds, and the
container's own `HEALTHCHECK` depends on it). The runtime image has no `.git`, so
a platform build variable is the real source — Railway injects
`RAILWAY_GIT_COMMIT_SHA` with no configuration; `GIT_COMMIT`, `SOURCE_VERSION`
and `COMMIT_SHA` cover other hosts, and the Dockerfile takes a `GIT_COMMIT`
build arg. Unresolvable reports `"unknown"` rather than failing.

This exists because a deploy was otherwise unverifiable from outside: after
pushing a security fix the only way to tell whether it was live was to trigger
the bug, which is not something you do against a customer's workspace.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | *(required)* | JWT signing key. Generate with: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `TOKEN_EXPIRE_HOURS` | `24` | JWT token lifetime in hours |
| `COOKIE_SECURE` | `true` | Set to `false` for local HTTP development (no HTTPS) |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Comma-separated CORS allowed origins |
| `DB_PATH` | `erp.db` | Path to the SQLite database file |
| `PORT` | `8765` | Backend HTTP port. Auto-increments if the port is already in use |
| `BIND_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict access to localhost only |
| `DB_BACKEND` | `sqlite` | `postgres` for a cloud deployment |
| `DATABASE_URL` | — | Postgres DSN; required when `DB_BACKEND=postgres`. Several aliases are accepted (Railway exposes a private-network variant) and an empty value fails fast rather than silently falling back to localhost |
| `TENANCY` | `single` | `schema` = one isolated PostgreSQL schema per customer (§2) |
| `ENABLED_MODULES` | *(empty)* | Fallback module whitelist. A per-tenant licence takes precedence — see §19 |
| `TENANT_BASE_DOMAIN` | *(empty)* | e.g. `quilit.dev`. An unknown subdomain under this domain returns a branded 404 instead of serving an ERP nobody can log into. Only matters with wildcard DNS; unset leaves the guard completely inert, so it cannot regress an existing deployment |
| `API_DOCS` | *(empty)* | `on` re-enables `/docs`, `/redoc` and `/openapi.json`, which are switched **off** automatically whenever `TENANCY` is a multi-tenant mode — they otherwise publish the entire API surface unauthenticated |
| `STORAGE` | `db` | `s3` stores attachments in S3/R2 instead of the database |
| `S3_BUCKET`, `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Required when `STORAGE=s3`. Omit the endpoint for AWS; set it for Cloudflare R2 or MinIO |
| `RESEND_API_KEY` | *(empty)* | Email delivery for §21. Unset means the email channel reports itself unavailable in the UI and explains why, rather than failing at the moment of sending |
| `MAIL_FROM` | *(empty)* | Sender address; must be a domain verified with the provider |
| `MAIL_FROM_NAME` | *(empty)* | Display name on outgoing mail |
| `SHARE_LINK_TTL_DAYS` | `30` | Lifetime of a client share link. `0` = never expires |
| `LOG_FORMAT` | `text` | `json` for structured logs with per-request correlation ids |
| `WEB_CONCURRENCY` | `3` | Gunicorn workers in the container. Note the module-licence cache is per-process — see §19 |

### System Settings (via UI)

Stored in the `settings` table and editable from **Settings → Company / Finance / Documents / Bank**:

| Setting Key | Description |
|------------|-------------|
| `company_name` | Appears in the sidebar and on generated documents |
| `company_tagline` | Subtitle shown beneath the company name |
| `company_address`, `company_city`, `company_country` | Address printed on documents |
| `company_phone`, `company_email`, `company_website` | Contact information |
| `company_tax_number`, `company_reg_number` | Legal identifiers |
| `bank_name`, `bank_account`, `bank_iban`, `bank_swift` | Bank details printed on invoices |
| `default_currency` | Base currency code (e.g., `USD`). All ledger amounts are stored in this currency |
| `secondary_currency` | Secondary currency code for dual-currency payments (default `LBP`) |
| `default_tax_rate` | *Legacy* single tax percentage — superseded by the Tax Rates table (§7.21); retained only for migration backfill |
| `tax_enabled` | `1` enables taxation system-wide (master on/off switch for the Tax Rates table) |
| `payment_terms_days` | Default number of days until invoice is due |
| `invoice_prefix` | Invoice number prefix (e.g., `INV-`) |
| `quotation_prefix` | Quotation number prefix (e.g., `QTN-`) |
| `inventory_costing_method` | Stock cost-flow assumption: `weighted_avg` (default) / `fifo` / `lifo` (see §7.6). Switching to FIFO/LIFO rebases cost layers from current stock |
| `footer_text` | Footer text printed on invoices and quotations |
| `show_discount_col` | `1` to display the discount column on documents |
| `show_tax_col` | `1` to display the tax column on documents |

`enabled_modules` is **not** a settings-table field — it lives in
`backend/vendor_config.py` as a build-time constant and is read-only from
the API. Editing the `settings` table directly has no effect; the API
always reports the value baked into the running build.

---

## 5. Authentication & Security

### Password Security

- **Algorithm:** PBKDF2-SHA256 with 260,000 iterations (OWASP recommended minimum as of 2023)
- **Salt:** 16 bytes, randomly generated per password
- **Storage format:** Base64(salt + derived_key) — passwords are never stored in plaintext

### Session Management

- Sessions use **JWT (HS256)** stored as `HttpOnly`, `Secure`, `SameSite=Strict` cookies
- Each JWT contains a **JTI** (JWT ID) that maps to a row in the `user_sessions` table
- **Server-side revocation:** logging out or an admin revoking a session invalidates the JTI immediately
- **One active session per user:** a new login revokes all previous sessions for that user
- **Inactivity timeout:** 30 minutes of no API activity automatically revokes the session
- **Session tracking:** the client IP address and User-Agent string are recorded per session

### Changing your own password

`POST /api/auth/change-password` has always accepted any authenticated user, but
nothing in the UI called it — the only password screen was the FORCED one-time
change at first login. So a member of staff who thought their password had been
seen had to ask an admin to reset it, which meant the admin choosing and knowing
their password.

The dialog lives in the sidebar account popover, not under Settings, because
Settings is a company-configuration screen most roles cannot open while this is
the one account action that belongs to everybody. Requiring the current password
is what makes it safe for every role: it grants nothing an account holder does
not already have.

**Changing a password revokes every session for that user, including the current
one**, and the response carries `relogin: true` so the client returns to the
sign-in screen rather than meeting a 401 on the next click.

Sparing the current session would be friendlier and useless: login already
revokes every prior session, so only one is ever live, and a stolen token *is*
that session rather than a second one beside it. "All but the current" would
match zero rows every time. The caller re-authenticates and gets a fresh JTI;
whoever held the old token does not.

### The first-run wizard is closed on hosted deployments

`POST /api/settings/complete-setup` is unauthenticated by design: on a
self-hosted first run somebody at the machine has to set the first password, and
a `setup_complete` flag closes it afterwards.

A provisioned tenant never runs that wizard — the platform generates the admin
password and hands it to the owner — so the flag stayed `"0"` and the endpoint
stayed open on the customer's subdomain **permanently**. Anyone who knew the
subdomain could set the admin password, log in as superadmin and read the
customer's books. Verified end to end before the fix.

The wizard is now refused outright whenever `IS_SCHEMA_TENANCY`, whatever any
schema's flag says, and provisioning writes `setup_complete=1`.
`GET /api/settings/setup-status` reports complete whenever the wizard is
unavailable, so it cannot be used to enumerate claimable workspaces. The
self-hosted first run is unchanged and still one-time.

### JWT Payload

```json
{
  "sub": 1,
  "username": "admin",
  "role": "Admin",
  "role_id": 1,
  "is_superadmin": true,
  "jti": "uuid-session-id",
  "exp": 1748000000
}
```

### Login Rate Limiting

- Maximum **5 failed login attempts** per IP address per **15-minute window**
- Exceeded limit returns `429 Too Many Requests`
- Attempts are tracked in the `login_attempts` table

### Force Password Change

If `users.must_change_password = 1`, the user is redirected to `/force-change-password` on login and **cannot navigate to any other page** until they set a new password. This is enforced at the React route level by a `RequirePasswordChange` guard component that wraps all authenticated routes — it cannot be bypassed by navigating directly to a URL. This flag is automatically set when an admin creates a new user or resets a user's password.

### Password Change Rate Limiting

The `/auth/change-password` endpoint applies the same IP-based rate limit as login (5 attempts per 15-minute window) to prevent brute-force attacks against an authenticated user's current password.

---

## 6. User Management & RBAC

### Built-in Roles

The system ships with **6 built-in (system) roles** that cannot be deleted:

| Role | Description |
|------|-------------|
| **Admin** | Full access to all modules including users, roles, and audit log |
| **Manager** | Clients, projects, quotations, invoices, suppliers (view / create / edit / approve) |
| **Accountant** | Invoices, finance, expenses (create / edit) |
| **Sales** | Clients, quotations, invoices (create / edit) |
| **Inventory** | Inventory, purchases, suppliers (create / edit) |
| **Viewer** | Read-only access across all modules |

Custom roles can be created from **Admin → Roles** with any combination of module/action permissions and a display color. A role cannot be deleted while it is assigned to active users or referenced by any pending approval steps.

### Modules & Actions

Each role can be granted permissions per module and per action.

**Available modules:**

| Module | Permission Key | Notes |
|--------|---------------|-------|
| Dashboard | `dashboard` | |
| Clients | `clients` | |
| Projects | `projects` | |
| Quotations | `quotations` | |
| Invoices | `invoices` | |
| Inventory | `inventory` | |
| Purchases | `purchases` | |
| Suppliers | `suppliers` | |
| **POS** | `pos` | Cash-drawer sessions + checkout |
| **Cash** | `cash` | Daily reconciliation |
| **Manufacturing** | `manufacturing` | BOMs + production orders |
| **Fixed Assets** | `assets` | Asset register + depreciation |
| Finance | `finance` | |
| Expenses | `expenses` | Includes recurring-expense templates |
| **Accounting** | `accounting` | Double-entry GL, chart of accounts, journal, financial statements |
| Reports | `reports` | |
| CRM | `crm` | |
| Planning | `planning` | |
| HR | `hr` | Employees, departments, leave, payroll, employee files |
| **HR Contracts** | `hr_contracts` | Formal employment contracts |
| **Recruitment** | `recruitment` | Positions, applicants, interviews, offers, onboarding |
| **HR Activities** | `hr_activities` | Personal HR activity log + reminders |
| Approvals | `approvals` | Workflow rules + decisions |
| Settings | `settings` | Admin-only |
| Users | `users` | Admin-only |
| Roles | `roles` | Admin-only |
| Audit Log | `audit` | Admin-only |

**Actions per module:** `view`, `create`, `edit`, `delete`, `approve`.

The Role Management UI lists modules in the same operational order as the
sidebar (Sales → Delivery → Procurement → Finance → People → Admin), so the
permission matrix is scannable.

### Superadmin

The `is_superadmin` flag bypasses all RBAC checks. The initial admin created during the setup wizard is a superadmin. Superadmin status can only be granted by another superadmin via the User Management UI.

### Sidebar Visibility

Navigation links are hidden by **two independent gates**:

1. **`vendor_config.ENABLED_MODULES`** — a vendor-level whitelist
   (comma-separated module keys). Its value comes from the `ENABLED_MODULES`
   **environment variable** when set (cloud / multi-instance hosting),
   otherwise from the build-time constant in `backend/vendor_config.py`
   (desktop / per-customer installer). Empty string means every module is
   visible (the dev + demo default). The value is immutable *from within the
   running app* — even a vendor superadmin cannot change it via the API; this
   closes the "delete `erp.db` + relaunch to get a fresh superadmin" attack.
2. **RBAC `view` permission** — the per-user check. The sidebar reflects
   the logged-in user's permissions in real time.

> **Server-side enforcement (not just the sidebar).** `vendor_config.module_allowed()`
> is checked inside `permissions.check_perm` **before** the superadmin bypass, so
> a module the customer didn't purchase returns **403** at its API — unreachable
> even by the owner or by guessing the URL. Sub-features that have their own
> sidebar entry (`warehouses`, `accounting`, `recruitment`, `hr_activities`) must
> be listed explicitly; a childless guard key (`hr_contracts`) rides along with
> its parent (`hr`). An empty whitelist is a complete no-op. Full details in §19.

---

## 7. Modules

### 7.1 Dashboard

**URL:** `/`

Displays a real-time business summary:

- **Revenue** — total paid invoices for the current month
- **Expenses** — total expenses for the current month
- **Net Profit** — revenue minus expenses
- **Outstanding** — total unpaid and partially-paid invoice balances
- **Active Projects** — count of in-progress projects
- **Overdue Invoices** — invoices past their due date
- Recent activity feed

---

### 7.2 Clients

**URL:** `/clients`

Manages the client database.

**Fields:** Name, company, phone, email, address, client type (Individual / Company), notes.

**Features:**
- Search by name, company, email, or phone
- Filter by client type
- View client detail with linked projects, quotations, invoices, and CRM contacts
- Archive clients (soft-delete with reason, reversible)
- Export to Excel

**Client Detail page** displays a tabbed view:
- **Overview** — contact info and summary statistics
- **Projects** — projects linked to this client
- **Quotations** — quotations issued to this client
- **Invoices** — invoices billed to this client
- **Contacts** — CRM contacts associated with this client

---

### 7.3 Projects

**URL:** `/projects`

Manages the full project lifecycle.

**Fields:** Name, client, location, status, start date, end date, estimated cost, actual cost, expected revenue, description.

**Statuses:** `Planning` → `In Progress` → `Completed` | `On Hold` | `Cancelled`

**Features:**
- Filter by status and client
- Track financial performance: estimated vs. actual cost, expected vs. billed revenue
- Link expenses directly to a project
- Deduct inventory items from stock and link the movement to a project
- Link invoices and quotations
- Archive projects

**Cost Tracking:** Actual cost is computed as the sum of all linked approved expenses and inventory deductions. The project detail page shows a full cost breakdown.

---

### 7.4 Quotations

**URL:** `/quotations`

Creates and tracks sales quotations.

**Fields:** Quote number (auto-generated), client, project, status, line items (name, quantity, unit price, total), notes.

**Statuses:** `Draft` → `Sent` → `Accepted` | `Rejected` | `Cancelled`

**Workflow:**
1. Create a quotation with line items
2. Send to the client (status → `Sent`)
3. Client accepts → **Convert to Invoice** (creates an invoice with the same line items)
4. Optionally **Convert to Project** (creates a linked project)

**Features:**
- PDF document generation
- Line items with subtotals, optional tax, and optional discount
- Cancel with a reason note

---

### 7.5 Invoices

**URL:** `/invoices`

Manages billing and payment collection.

**Fields:** Invoice number (auto-generated), client, project, linked quotation, amount, due date, line items, notes.

**Statuses:** `Unpaid` → `Partial` → `Paid` | `Void` | `Overdue` (calculated from due date)

**Features:**
- Record multiple payments against a single invoice (partial payment support)
- **Multi-currency payments** — a payment can be tendered in the base currency (USD) or the secondary currency (LBP). When `currency=LBP`, an `exchange_rate` is required; the system stores both the original amount tendered (`paid_amount`) and the converted base-currency value (`amount`) applied to the invoice balance. Invoice balances are always tracked in the base currency.
- Idempotent payment recording — each payment request requires a unique `idempotency_key` to prevent accidental duplicate charges
- Optimistic locking via a `version` field — prevents conflicting edits from concurrent sessions
- Invoice amount is locked once any payment is recorded (the amount cannot be edited after the first payment)
- Per-line tax — each line item carries a tax rate snapshot; the invoice stores rolled-up `subtotal` and `tax_total` (see §7.21 and §8)
- Void an invoice with a reason note (does not delete; marks as void and reverses its contribution to the linked project's `actual_cost`)
- Payment methods: Cash, Bank Transfer, Cheque, Card, Other
- Export to Excel
- Generate PDF

---

### 7.6 Inventory

**URL:** `/inventory`

Manages stock items and tracks all movements.

**Fields:** Name, category, quantity, minimum stock level, unit cost, supplier, unit of measure.

**Categories:** Product, Material, Equipment, Other.

**Barcodes.** Each item carries an optional, unique `barcode` (migration 046,
indexed). It is matched **exactly** in the inventory list search, exactly by the
POS register lookup, and by CSV import; global search matches it loosely.

A USB scanner is a keyboard: it types the code, then sends Enter. That matters in
two opposite ways:

- **POS wants the Enter.** `RegisterView` handles it, and a scan resolving to a
  single variant is added straight to the cart.
- **A form must swallow it.** Enter in a single-line input inside a `<form>`
  with a submit button submits that form, so scanning a barcode partway through
  *Add item* saved the item there and then — before cost, price, category or
  unit were filled. Nothing errored; the item was simply created half-empty.
  `swallowScannerEnter` (in `components/shared.jsx`) cancels that one key, and
  the barcode fields on the item form and product builder use it.

  It misfired only in the natural order — name first (satisfying `required`),
  then scan — so it hid from anyone who tested it the other way round.

The ERP does **not** generate or print barcode labels. It stores and reads codes
that already exist.

**Features:**
- Low-stock alerts (items below `min_stock` are highlighted in the UI)
- Manual stock adjustment with a reason note
- **Deduct to Project:** deduct a quantity and link the movement to a project (automatically records project actual cost)
- Full stock movement history per item

**Stock Movement Types:**

| Type | Trigger |
|------|---------|
| `purchase` | Stock received from a purchase order |
| `adjustment` | Manual stock correction |
| `deduction` | Stock used on a project |
| `return` | Returned stock |

#### Inventory Costing Method

A single, system-wide cost-flow assumption governs how the **cost of every
stock-OUT** (POS cost-of-goods-sold, project material consumption, manufacturing
material cost, and stock write-offs) is valued. It is chosen in
**Settings → Financial** via `inventory_costing_method`:

| Method | Value | Behaviour |
|--------|-------|-----------|
| **Weighted Average** *(default)* | `weighted_avg` | A moving average held on `inventory.unit_cost`, re-blended on every receipt/production. A stock-OUT is valued at the current average. This is the classic, original behaviour. |
| **FIFO** | `fifo` | First-In, First-Out. A stock-OUT draws down the **oldest** cost layers first. |
| **LIFO** | `lifo` | Last-In, First-Out. A stock-OUT draws down the **newest** cost layers first. |

**How it works.**
- Under FIFO/LIFO every stock-IN (purchase receipt, production output, positive
  adjustment, opening stock, return) appends a **cost layer** — a surviving lot
  recording its quantity and landed unit cost — to `inventory_cost_layers`.
- A stock-OUT consumes layers in the method's order; the COGS is the sum of the
  consumed layers' costs. If layers can't cover the quantity (e.g. legacy stock),
  the shortfall is valued at the moving average so COGS is never understated.
- After each movement, `inventory.unit_cost` is kept as the weighted average of
  the **remaining** layers, so the inventory list, reports and valuation always
  show a sensible per-unit cost.
- Under Weighted Average the layers table is unused and behaviour is identical to
  prior versions (zero overhead, no layers maintained).

**Switching method.** Selecting FIFO or LIFO **rebases** the cost layers: every
item's on-hand quantity becomes a single opening layer valued at its current
`unit_cost`. This keeps layers consistent with stock regardless of prior
activity (no attempt is made to reconstruct historical lots). Switching back to
Weighted Average simply resumes moving-average costing from the current
`unit_cost`. Frozen costs on already-completed sales, production orders, and
posted expenses are **never** retroactively changed.

#### Batch / Lot Tracking & Traceability

Items can be flagged **lot-tracked** (`inventory.lot_tracked`, with an optional
`shelf_life_days`). For a lot-tracked item:

- **Every stock-IN creates a lot** (`inventory_lots`) — purchase receipt,
  production output, opening stock, positive adjustment, POS return — with a lot
  number, manufacture date and an **expiry date** (auto-derived from
  `shelf_life_days` when not given).
- **Every stock-OUT draws lots First-Expired-First-Out (FEFO)** — sales, project
  use, production consumption, negative adjustments — recording each draw in
  `lot_consumption`. COGS comes from the **consumed lots' own cost** (specific
  identification), which supersedes the FIFO/LIFO/WA layers *for lot-tracked
  items only*; everything else keeps the global costing method. `unit_cost`
  stays the weighted average of the remaining lots.
- **Traceability.** `GET /inventory/lots/{id}` returns full genealogy:
  **forward** (every place the lot was used, and the output lot it became when
  consumed by production) and **backward** (the input lots consumed to make a
  produced lot — linked via `production_order_id` → `output_lot_id`).
- **Expiry.** `GET /inventory/lots?expiring=true` lists expired / soon-to-expire
  lots; each lot carries an `expiry_status` of `ok` / `expiring` / `expired`.

Items **without** `lot_tracked` never create lots and behave exactly as before.

---

### 7.7 Purchases

**URL:** `/purchases`

Manages purchase orders placed with suppliers.

**Fields:** PO number (auto-generated), supplier, inventory item, product name, quantity, unit cost, additional costs (shipping, duties, etc.), status, notes.

**Statuses:** `Draft` → `Ordered` → `Received` → `Paid`

**Features:**
- Link a PO to a supplier and an inventory item
- On status change to `Received`: automatically increments inventory stock and logs a stock movement
- On status change to `Paid`: automatically records a linked expense
- Optional tax rate per order — recorded as input VAT in the VAT report (§7.14, §8)
- Supplier PO history view
- Purchase statistics (total spent, pending orders, received value)

---

### 7.8 Suppliers

**URL:** `/suppliers`

Directory of vendors and suppliers.

**Fields:** Name, contact name, phone, email, payment terms (days), notes.

**Features:**
- Link to inventory items and purchase orders
- View supplier purchase history
- Archive suppliers

---

### 7.9 Finance

**URL:** `/finance`

Financial overview and accounting controls.

**Tabs:**
- **Summary** — current month revenue, expenses, net profit, outstanding invoices
- **Monthly** — month-by-month financial history chart and table
- **Date Range** — custom date range with monthly breakdown and detailed line items
- **Reconciliation** — side-by-side view of paid invoices vs. recorded expenses

**Period Locking & Year-End Closing** now live together under **Accounting → Closing** (see §7.28) — both monthly soft-close and annual hard-close, with one shared enforcement guard. A locked month or closed year blocks **every** dated-in-period financial change across the integrated modules: invoice payments, invoice edit/void, expenses, manual journal entries, POS sales/returns, **payroll mark-paid**, and **fixed-asset depreciation**.

---

### 7.10 Expenses

**URL:** `/expenses`

Tracks all business expenses.

**Fields:** Category, description, amount, date, linked project (optional), status.

**Categories (validated):** Labour, Materials, Equipment, Transport, Subcontractor, Permits, Purchase, Other.

**Statuses:** `Recorded` → `Pending Approval` → `Approved` | `Rejected`

Manually entered expenses go through the approval workflow if an approval policy is configured for the `expense` entity type. Auto-generated expenses (created from purchase orders or inventory deductions) bypass the approval workflow and are recorded directly with status `Recorded`.

**Features:**
- Optional project linkage (contributes to project `actual_cost` when approved)
- Optional tax rate — the entered amount is treated as tax-inclusive (gross), and VAT is *extracted* from it (§8.1); recorded as input VAT in the VAT report
- Filter by date range, category, project, and status
- Void an expense with a reason note (does not delete; voided expenses are excluded from period snapshots and financial totals)
- Period locking: expenses in a locked accounting period cannot be edited or voided
- Export to Excel

**Expense Approval Flow:**
1. A user creates an expense → status becomes `Pending Approval`
2. Approvers review it via the Approvals module
3. Approved → status `Approved`; linked project `actual_cost` is updated
4. Rejected → status `Rejected`; no cost impact

---

### 7.11 CRM

**URL:** `/crm`

Customer Relationship Management, organized into four sub-modules.

#### Leads

Track prospective customers.

**Fields:** Name, company, email, phone, source (Website, Referral, Cold Call, etc.), status, lead score (0–100), estimated value, expected close date, assigned user.

**Statuses:** New → Contacted → Qualified | Lost

**Convert to Client:** a qualified lead can be promoted to a full client record, preserving all linked contacts and activities.

#### Contacts

Individuals linked to clients or leads.

**Fields:** Name, job title, email, phone, primary contact flag, notes.

#### Activities

Log all customer interactions.

**Types:** Call, Email, Meeting, Task, Note.

**Fields:** Type, subject, description, linked client / lead / contact, due date, done flag, outcome.

Activities can be marked complete with an outcome note.

#### Deals

Sales pipeline management.

**Stages:** Qualification → Proposal → Negotiation → Won | Lost

**Fields:** Title, linked client / lead, linked quotation, value, probability (%), expected close date, assigned user, lost reason.

**CRM Dashboard** shows:
- Lead count by status
- Deal count and total value by stage
- Activities due today and overdue
- Weighted pipeline value (deal value × probability)

---

### 7.12 Planning

**URL:** `/planning`

Project task planning and scheduling, available in four views.

#### Gantt View
- Timeline visualization of tasks across a selected week or month
- Navigate between periods with Previous / Next buttons
- Toggle between **Week** (7 days) and **Month** (full month) views
- Drag task bars left/right to reschedule
- Drag the right edge to resize task duration
- Today's date highlighted with a vertical marker
- Tasks color-coded by project
- Progress percentage displayed inside bars

#### Board View (Kanban)
- Cards grouped by status column: **To Do | In Progress | Done**
- Each card shows task name, project, priority, assignee, and a progress bar

#### List View
- Full filterable table: search by name, filter by project, status, and priority
- Inline status and progress display
- Edit and archive actions

#### Calendar View
- Monthly calendar showing tasks by due date
- Designed to fit within a single screen without scrolling

**Planning Projects** group tasks. Each planning project has: name, description, client, color, start/end date, and status.

**Tasks:**

Fields: Name, project, assignee, status, priority (Low / Medium / High / Critical), start date, end date, progress (0–100%), milestone, depends-on task, color.

**Milestones:**

Named checkpoints with a due date. Tasks can be linked to milestones. Milestones appear on the Gantt timeline. Milestones must belong to an existing planning project (FK-validated on creation). Deleting a milestone performs a **soft-delete** (sets `archived_at`); the milestone can be recovered from Archives. Tasks previously linked to a soft-deleted milestone retain their `milestone_id`.

---

### 7.13 HR (Human Resources)

**URL:** `/hr` &nbsp;|&nbsp; **Permission key:** `hr`

A full HR workflow for a medium-size company: organizational structure, the
employee lifecycle, an immutable salary/role history, time-off, payroll, and
employee file attachments. Three tightly-coupled People-domain modules extend
it — **HR Contracts** (`hr_contracts`), **HR Activities** (`hr_activities`),
and **Recruitment** (`recruitment`, documented in §7.13.3) — each with its own
permission key so access can be granted independently of core HR.

> All business records are **soft-deleted** via `archived_at`. The salary /
> role history (`hr_employment_changes`) is **append-only** — an audit log that
> is never edited or deleted.

#### Departments

Organizational units that employees belong to.

**Fields:** Name, description.

**Features:**
- List departments with a live employee count per department
- Create / edit / archive / unarchive (archive is blocked while staff are still assigned)
- Department names are unique among non-archived rows

#### Employees

The core staff directory with full lifecycle tracking. Each employee is auto-assigned an `employee_code` (`EMP-0001`, …) on creation.

**Fields:** Full name, job title, department, employment type, status, hire date, end date, email, phone, salary, manager (self-referential FK), linked user account, address, notes.

**Employment Types:** Full-time, Part-time, Contract, Intern.

**Statuses:** Active, On Leave, Terminated.

**Features:**
- Search (name / title / code / email) and filter by department and status
- Link an employee record to a user account
- Hierarchical manager relationships (an employee cannot be their own manager; archiving a manager detaches their reports)
- The employee detail returns leave history, direct reports, salary/role timeline, attached files, and payroll history in one call
- Archive / unarchive employees (soft-delete)

**Auto leave-status reconciliation.** There is no background scheduler, so every HR read (list / detail / summary) lazily reconciles each Active/On-Leave employee against today's approved-leave window — flipping `Active → On Leave` when an approved leave covers today and back to `Active` once it ends. Terminated employees are never auto-changed.

#### Employment History (salary / role timeline)

An **immutable, append-only** audit trail of every salary, title, department, and manager change. Captured automatically:
- A `hire` row is seeded when an employee is created (or onboarded from Recruitment).
- On every employee edit, if any tracked field (salary / job title / department / manager) changed, one row is appended. The change is auto-classified — `raise`, `promotion`, `demotion`, `role_change`, `transfer`, or `adjustment` — unless the caller passes an explicit `change_type` and `change_reason`.
- A status transition to `Terminated` is logged as a `termination` event even when no other field moved.
- Activating a contract (see HR Contracts) appends an `adjustment` row so the timeline stays complete without a separate employee edit.

#### Leave Requests

Time-off tracking with a simple approval flow.

**Fields:** Employee, leave type, start date, end date, reason.

**Leave Types:** Annual, Sick, Unpaid, Maternity, Paternity, Bereavement, Other.

**Statuses:** Pending → Approved | Rejected.

**Features:**
- Managers or admins (the `approve` action) approve or reject; an approval whose window covers today immediately flips the employee to On Leave
- Inclusive day count is calculated and stored on submit (end-before-start is rejected)
- Only **Pending** requests can be edited or deleted; reviewed ones are retained for the record
- Full leave history per employee

#### Employee Files

PDF attachments stored as BLOBs directly in the database (no filesystem path, so no path-traversal surface).

- **Kinds:** `cv`, `contract`, `other`. CV and contract are single-slot — uploading a new one replaces the previous file of that kind; `other` files accumulate.
- **Limit:** 8 MB per file; only `application/pdf` is accepted.
- Files are streamed back inline (`Content-Disposition: inline`) for in-tab preview. When a recruitment applicant is converted to an employee, their uploaded documents are copied into the employee's files.

#### Payroll

Monthly payroll runs with a **Draft → Approved → Paid** lifecycle (plus `Cancelled`).

- **Create a run** for a period: one line is seeded per active (non-terminated) employee, pre-filled from their current salary.
- **Per-line breakdown** (`hr_payroll_lines`): base salary, bonuses, deductions, overtime (entered as a dollar amount, or computed from hours × hourly rate × multiplier). The engine derives gross, employee + employer NSSF, taxable base (NSSF is pre-tax), tax, and net. Net cannot go negative.
- **Settings-driven rates** (all default to 0, i.e. opt-in): `payroll_tax_pct`, `payroll_nssf_employee_pct`, `payroll_nssf_employer_pct`, `payroll_overtime_multiplier` (defaults to 1.5×).
- **Approve** locks the run for review; **Mark Paid** posts a *single* `Payroll` expense to Finance for the net total, links it back via `posted_expense_id`, and is **idempotent** (re-running returns the same expense). Lines cannot be edited once Paid.
- **Cancel** is allowed for Draft/Approved runs only. Paid runs cannot be cancelled — their posted expense is real money out; reverse it in Finance instead.

#### HR Summary

Dashboard-style KPIs: total headcount, active / on-leave / terminated counts, department count, headcount by department and by employment type, pending leave requests, **open payroll runs** (Draft + Approved), and **year-to-date paid payroll**.

---

#### 7.13.1 HR Contracts

**URL:** `/hr/contracts` &nbsp;|&nbsp; **Permission key:** `hr_contracts`

Formal, structured employment contracts — distinct from the contract PDF that can be attached to an employee record. Storage is structured (salary, type, dates, benefits, schedule, terms) so a branded, printable document can be rendered client-side through the same print pipeline used by quotations and invoices.

**Fields:** Employee, contract number (auto-generated `CTR-YYYY-NNNN` from the `contract_prefix` setting when blank), contract type, status, start / end / probation-end dates, job title, work schedule, weekly hours, salary, salary currency, benefits, terms.

**Contract Types:** Permanent, Fixed-term, Probation, Internship, Consultant.

**Lifecycle:** Draft → Active → Expired / Terminated.

- **Activating** a contract syncs the employee's current salary and job title to the contract values and appends a row to the salary timeline (`hr_employment_changes`) — no manual double-entry. A non-draft contract cannot be reassigned to a different employee.
- **Terminating** records a timestamp and reason; reverting a non-draft contract back to Draft is disallowed to protect history.
- A `print-data` endpoint returns the contract plus company-branding settings for client-side rendering.
- When a Recruitment offer is accepted and the applicant converted, a matching **Active** contract is auto-minted from the offer's clauses.

#### 7.13.2 HR Activities

**URL:** `/hr-activities` &nbsp;|&nbsp; **Permission key:** `hr_activities`

A unified, **personal** log of HR touchpoints with built-in reminders. Each activity has an `owner_id` and is visible only to its owner (superadmins see all) — you see your own queue, like any CRM/ATS activity log.

**Types:** Call, Meeting, Interview, Email, Note, Task. &nbsp; **Statuses:** Planned, Done, Cancelled.

**Fields:** Type, subject, description, scheduled date/time, duration, location, optional linked applicant or employee, reminder offset.

- **Reminders without a scheduler.** Creating/updating an activity inserts one notification row with `deliver_at = scheduled_at − reminder_minutes`; the notifications list surfaces it when its time passes. Allowed offsets: 0 (none), 5, 15, 30, 60, 120, 1440 minutes. Editing reschedules the pending reminder; already-delivered reminders are left as history.
- **List scopes:** `upcoming` (next 14 days, the landing view), `today`, `overdue`, `done`, `all`. A summary endpoint returns today / upcoming-14 / overdue / done-7d counters.
- **Distinct from recruitment interviews.** Recruitment interviews are applicant-centric (one applicant, scored, decision); HR Activities are owner-centric. The two coexist — scheduling a recruitment interview **auto-mirrors** one HR Activity into the interviewer's (or scheduler's) queue with a reminder, and keeps it in sync on edit/delete.

#### 7.13.3 Recruitment

**URL:** `/recruitment` &nbsp;|&nbsp; **Permission key:** `recruitment`

The applicant pipeline that feeds HR — positions, applicants, interviews, offer letters, and onboarding.

**Pipeline:** Applied → Screening → Interview → Technical Test → Accepted / Rejected / Withdrawn. Transitions are forward-only; the three terminal states (`Accepted`, `Rejected`, `Withdrawn`) flow only into archived history, and re-opening requires a new application. Each transition is recorded in an append-only status history.

- **Positions:** title, department, employment type, location, salary range, headcount, status (Open / On Hold / Filled / Cancelled), description, requirements.
- **Applicants:** name, position, contact, source, expected / offered salary, rating (1–5), assigned recruiter, notes. File attachments (CV / cover letter / portfolio / certificate / other) accept **PDF and Word (.doc/.docx)** up to 8 MB; the CV is single-slot.
- **Interviews:** type (Phone / Video / On-site / Technical / Final), schedule, duration, interviewer, status, score (1–10), decision. Each interview auto-mirrors an HR Activity (see §7.13.2).
- **Offer letters:** Lebanon-aware pre-employment contracts (Draft → Sent → Accepted / Declined / Expired) with NSSF, end-of-service, confidentiality, and non-compete toggles; probation capped at 3 months and the working week at 48 hours per the Lebanese Labor Code. *Template-generation only — not legal advice.*
- **Convert to employee:** an Accepted applicant is onboarded into HR via `POST /recruitment/applicants/{id}/convert` — creating the `hr_employees` row (seeding the salary timeline), copying their uploaded documents into employee files, marking a single-headcount position Filled, and optionally minting an Active contract from an accepted offer.

---

### 7.14 Reports

**URL:** `/reports`

Business intelligence and reporting.

#### Financial Summary
- Revenue, expenses, and net profit aggregated by period
- Monthly trend bar chart
- Expense breakdown by category (donut chart + horizontal bar chart)

#### VAT Report
- **Output VAT** (tax on issued invoices) vs. **input VAT** (tax on recorded expenses and purchases)
- Aggregated from the per-line `tax_amount` snapshots stored on each document (see §8.1)
- Monthly breakdown for the selected period
- Calculated net VAT liability (output − input)

#### Projects Report
- Project list with status, estimated vs. actual cost, expected vs. billed revenue
- Profit margin per project

#### Clients Report
- Revenue, outstanding balance, and project count per client
- Sorted by total revenue

#### Invoice Aging
- Outstanding invoices grouped by age: 0–30, 31–60, 61–90, 90+ days overdue
- Total at-risk amount per age bucket

#### Expense Report
- Expenses grouped by category with totals and percentages
- Date range filter

#### Sales Pipeline
- CRM deals by stage with value and weighted value (value × probability)
- Win/loss rate

All reports support **date range filtering** and **Excel export**.

---

### 7.15 Archives

**URL:** `/archives`

Soft-deleted items that have been archived with a reason. Items appear here after clicking **Archive** in any module.

- View all archived items across all modules (clients, projects, quotations, invoices, inventory, purchases, suppliers, expenses, CRM records, planning items)
- **Unarchive** restores the item to its original module
- Items remain fully intact in the database with an `archived_at` timestamp — no data is lost

---

### 7.16 Recycle Bin

**URL:** `/recycle-bin`

The Recycle Bin holds items that have been **soft-deleted** (as distinct from archived). Soft-deleted items have a `deleted_at` timestamp and are hidden from all normal module queries.

**Supported modules:** Clients, Projects, Quotations, Invoices, Inventory, Purchases, Expenses.

**Features:**
- List all soft-deleted items with delete date, module, and label
- Filter by module, search by name, and filter by date range
- **Restore** an individual item — clears `deleted_at` and returns it to its module
- **Permanently delete** an individual item — irreversible; removes the row from the database
- **Bulk restore** — restore multiple items at once
- **Bulk purge** — permanently delete multiple items at once
- **Auto-purge** — items soft-deleted more than 30 days ago are automatically and permanently removed

> **Warning:** Permanent deletion cannot be undone. Consider archiving records instead of deleting them for data retention.

---

### 7.17 Audit Log

**URL:** Admin → Audit Panel

Complete, tamper-evident activity log of all mutations performed in the system.

**Recorded fields:** User, action (create / edit / delete / login / etc.), module, record ID, record reference, detail text, timestamp.

**Features:**
- Filter by user, action type, module, and date range
- Cannot be edited or deleted by a normal admin (only purged by a superadmin)
- Every API mutation is automatically logged

---

### 7.18 Settings

**URL:** `/settings` (admin only)

System configuration panel.

**Sections:**
- **Company** — Name, tagline, address, contact info, tax/reg numbers, default currency, logo upload (PNG/JPG/GIF/WebP, max 2 MB)
- **Bank Details** — Bank name, account number, IBAN, SWIFT code (printed on invoice documents)
- **Financial** — Invoice / quotation / **contract** number prefixes, default payment terms, "enable tax" master switch
- **Payroll Defaults** — Income-tax %, NSSF employee %, NSSF employer %, overtime multiplier — read by the payroll engine (§7.13). All 0 = no tax / no NSSF
- **Inventory & Costing** — Business type (seeds variant-attribute presets, §16) and inventory costing method (weighted-avg / FIFO / LIFO); switching to a lot method rebases cost layers
- **Inventory Fields** — Owner-defined custom product attributes / variant axes (§16)
- **Categories** — Owner-managed per-domain category registry (§17)
- **Tax Rates** — The named tax-rate table (§7.21)
- **Exchange Rate** — Manual USD↔LBP rate entry + change history (§8.2)
- **Documents** — Footer text, show/hide discount and tax columns on documents
- **Backup & Integrity** — (self-hosted / SQLite only) manual backup download, backup history, backup-to-USB/folder export, restore from file, integrity check

**Storage model.** All scalar settings live in a single-row `settings`
key/value table with server-side defaults ([`routers/settings.py`](backend/routers/settings.py) `DEFAULTS`).
The write endpoint accepts a fixed field list (unknown keys → 422); the frontend
only sends keys in its `WRITABLE_SETTINGS` allow-list. `enabled_modules` is **not**
a settings-table field (see §6 / §19).

**Logo** is displayed in the sidebar and on generated documents (invoices, quotations).

> **Logo upload security:** Uploaded files are validated by inspecting their magic bytes (file header), not only the `Content-Type` header. Only valid PNG, JPEG, GIF, and WebP images are accepted (max 2 MB).

---

### 7.19 Approval Policies

**URL:** `/approval-policies` (admin only)

Defines the multi-step approval workflows that apply to specific business actions.

**Fields:** Entity type, step number, approver role, description.

**Supported entity types:**

| Entity | Trigger |
|--------|---------|
| `expense` | Manually created expenses |
| `invoice` | Invoice creation (if configured) |
| `purchase` | Purchase order creation (if configured) |

**How policies work:**
- Each policy defines one or more sequential **steps**
- Each step specifies an **approver role** (e.g., Manager, Accountant)
- When a triggering action occurs, an approval request is automatically created and routed to the first step's role
- After each step is approved, the request advances to the next step
- Only after all steps are approved is the underlying record considered fully approved

**Features:**
- Create multi-step approval chains (e.g., Step 1: Accountant → Step 2: Manager)
- Edit or delete policies (deletion is blocked if pending approvals reference the policy)
- Role deletion is blocked if any pending approval steps reference that role

---

### 7.20 Approval Requests

**URL:** `/approvals`

Tracks all in-flight and historical approval requests.

**Fields:** Entity type, entity ID, requester, current step number, status, created date.

**Statuses:** `pending` → `approved` | `rejected`

**Workflow:**
1. A triggering action (e.g., creating an expense) generates an approval request
2. Users with the matching approver role see pending requests in the Approvals page
3. The approver reviews the linked record and clicks **Approve** or **Reject**
4. On rejection, the request is closed and the underlying record is marked `Rejected`
5. On approval of the final step, the request is closed, the record is marked `Approved`, and side effects execute (e.g., `actual_cost` is updated on the linked project)

**Authorization:**
- Only the original requester, a user whose role matches the current approver role, or an admin can view a specific approval request

**Concurrency protection:**
- If two approvers act on the same request simultaneously, only the first action is accepted; the second receives a `409 Conflict` response

**Notifications:**
- Approvers receive in-app notifications when a new request reaches their step
- Requesters receive notifications when their request is approved or rejected

---

### 7.21 Tax Rates

**URL:** Settings → Finance (admin only)

A managed list of **named tax rates** used across quotations, invoices, purchases, and expenses. This replaces the legacy single `default_tax_rate` setting with a flexible, multi-rate model.

**Fields:** Name, rate (0–100 %), tax type, default flag, active flag.

**Tax types:**

| Type | Meaning |
|------|---------|
| `standard` | A normal taxable rate (e.g., VAT 11 %) |
| `zero` | Zero-rated — taxable in principle but charged at 0 % |
| `exempt` | Exempt from tax — no tax applies |

**Rules & behavior:**
- `tax_enabled` (Settings) is the **master on/off switch**; when off, no tax is applied regardless of the rate table.
- **Exactly one rate is the default.** The default is applied to new document lines unless another rate is explicitly chosen.
- The **first rate created is forced** to be both default and active.
- The default rate **cannot be deactivated or demoted** until another rate is promoted to default in its place.
- Deleting a rate is a **soft deactivation** (`is_active = 0`), not a hard delete — historical documents that reference the rate keep a valid pointer; the rate simply no longer appears in new-document forms.
- On upgrade, migration `044` **seeds** the table from the old `default_tax_rate` setting and adds `Zero-rated` and `Exempt` rows.

> **Note:** Tax rates are readable by every signed-in user (document forms need them) but only an **admin** can create, edit, or deactivate them.

---

### 7.22 POS — Point of Sale

**URL:** `/pos` &nbsp;|&nbsp; **Router:** `routers/pos.py` &nbsp;|&nbsp;
**Permission:** `pos`

A register UI for retail-style sales that integrates directly with
Inventory, Cash and Invoicing.

**Sessions.** A cashier opens a session (with an opening cash float), runs
sales against it, and closes it at the end of the shift. Only one session
per user can be open at a time. The session's drawer auto-captures
cash-tendered sales unless the cashier picks a specific drawer at
checkout.

**Pricing model.** POS prices are **tax-inclusive** (retail shelf
pricing). The line gross is the customer-facing price; line and order
discounts come off the gross; VAT is then *extracted* via
`resolve_inclusive_tax`. The resulting invoice is stored in the standard
`invoices` table in the **exclusive form** (`unit_price` = post-discount
net unit price) so every existing invoice / VAT / finance reader keeps
working without modification.

**Checkout flow.**
1. Verify open session, validate cart lines (qty > 0, discount ≤ line gross).
2. Distribute the order-level discount proportionally across lines.
3. Decrement inventory; reject if any item would go negative.
4. Create `invoices` + `invoice_items` + `invoice_payments` (atomic).
5. Create `pos_sales` + `pos_sale_items` (the cashier-facing record).
6. Auto-capture into the linked cash drawer.

**Returns.** `POST /api/pos/sales/{id}/return` voids the matching invoice,
re-credits inventory, and posts a reversing cash movement. The refunded
sale drops out of every revenue/VAT report automatically because the
underlying invoice has `voided_at` set.

**Custom lines.** Lines without an `inventory_id` are treated as
service/free-text items (no stock decrement). The UI offers
**autocomplete against the inventory** as the cashier types a line name —
selecting a match promotes the line into a proper inventory-backed line.

**Idempotency.** Every checkout requires an `idempotency_key`; a
duplicate POST with the same key returns the existing sale instead of
creating a duplicate.

---

### 7.23 Cash Management

**URL:** `/cash` &nbsp;|&nbsp; **Router:** `routers/cash.py` &nbsp;|&nbsp;
**Permission:** `cash`

Daily reconciliation of cash drawers. A drawer is a named cash point
(e.g., **Main Till**, **Workshop Petty Cash**). Exactly one drawer is the
**default** (`auto_capture=1`) — it receives cash sales and cash
expenses that aren't tagged to a specific drawer.

**Reconciliation lifecycle.** `open → closed`. Per business date per
drawer:

| Step | What happens |
|------|--------------|
| **Open** | Captures the opening balance (defaults to yesterday's counted close). |
| **Movements** | The day accumulates auto cash-in (cash payments), auto cash-out (cash expenses), and any manual cash-in / cash-out entries. |
| **Close** | The cashier enters the counted cash. The system computes USD and LBP variances separately and freezes the figures. A variance ≥ $5 (or ≥ 100,000 LBP) raises a `cash_variance` notification (deduped 24 h). |

USD and LBP are reconciled separately — never summed into a single
number, because exchange rates fluctuate mid-day.

---

### 7.24 Manufacturing

**URL:** `/manufacturing` &nbsp;|&nbsp;
**Router:** `routers/manufacturing.py` &nbsp;|&nbsp;
**Permission:** `manufacturing`

Bills of materials and production orders, integrated with Inventory.

**Product types.** Inventory items now carry a `product_type` column —
`raw_material` / `semi_finished` / `finished` / `consumable`. Only
finished / semi-finished items can be a BOM output.

**Versioned BOMs.** `bom_group_id` groups every version of a recipe; the
highest non-archived version is the **current** one used by new
production orders. Each BOM line carries an optional `scrap_pct`
allowance folded into the required quantity at order time. Sub-assemblies
(a BOM output used as a component of another BOM) are supported with a
depth limit of 8.

**Resources (lightweight overhead model for SMEs).** A **resource**
(`manufacturing_resources`) is a reusable per-hour cost rate — e.g. *Labor*,
*Electricity*, *Water*, *CNC Machine*, *Oven* (`name`, `cost_type = per_hour`,
`hourly_rate`). There are intentionally **no work centers, no capacity planning,
and no scheduling system** — just rates. A BOM assigns resources two ways
(`bom_resources`):

- **From the master list** — pick a resource; its name + rate are snapshotted.
- **Inline** — type a name + hourly rate directly on the BOM (the simplified option).

The BOM also carries a **`standard_hours`** (estimated production time per
batch). Its standard conversion cost = **Σ(resource hourly rates) ×
standard_hours**, scaled to the order quantity.

**Automatic production costing (actual hours).** Each order snapshots the BOM's
resources (`production_order_resources`). At completion the operator enters the
**actual production duration**; the overhead is computed and frozen per resource:

```
cost_per_resource = resource.hourly_rate × production_hours      (defaults to standard hours)
total_overhead    = Σ cost_per_resource
total_cost        = materials + total_overhead
```

Each resource's hours + cost are frozen on its order row. A BOM with **no
resources** falls back to the legacy flat `labor_cost + overhead_cost`, so the
simplest recipes still cost exactly as before. *(This replaced the earlier
work-center/routing model — flexible per machine/utility while staying simple
enough for small and medium businesses.)*

**Quality control & quarantine.** A BOM can be flagged **`qc_required`**. When
such an order completes, its finished batch goes into a **non-sellable
quarantine** bucket (`inventory.quarantine_quantity`) — not normal stock — and a
**Pending inspection** (`production_qc`) is opened holding the quantity and unit
cost. Resolving the inspection splits the batch into **passed** (released to
sellable stock, with a FIFO/LIFO cost layer + `qc_release` movement),
**rejected** (scrapped — quarantine cleared, `scrap_cost` recorded), and
optional **rework** (a subset of the rejects that spawns a new linked Draft
production order, `rework_of_order_id`, to remake them). Defects are logged by
reason/quantity (`production_qc_defects`). `passed + rejected` must equal the
batch. BOMs **without** `qc_required` complete straight to stock exactly as
before.

**Scheduling, priority & partial completion.** Orders carry a **priority**
(Low / Normal / High / Urgent), a **planned start** and a **due date**; the
orders list has a **Schedule** view that sorts by due date then priority and
flags overdue open orders. An order can be completed in **multiple partial
runs** (`POST /orders/{id}/complete-partial`): each run consumes its
proportional materials, takes a proportional share of the standard conversion
cost, raises that quantity to stock (through QC if required), and accumulates
onto `quantity_completed` — the order auto-closes once the planned quantity is
reached (or `complete` finishes the remainder). The classic single-shot
completion is unchanged.

**Analytics & variance** (`GET /manufacturing/analytics?start=&end=`). Over
completed orders in a range: output (orders, units), cost breakdown
(materials / overhead / scrap), **standard-vs-actual cost variance** (standard
from the BOM roll-up), **time efficiency** (standard vs actual production
hours), **on-time delivery %**, **QC pass rate**, and a **cost-by-resource**
breakdown (hours + cost per resource) plus per-product output. Surfaced on an
**Analytics** tab.

> **Roadmap — complete.** All phases delivered: resource-based overhead costing
> (per-hour resources × actual production hours); quality control with
> quarantine + rework; batch/lot tracking with expiry & traceability (§7.6);
> scheduling, priority & partial completion; and analytics / efficiency &
> cost-variance reports.

**Production-order lifecycle.**
`Draft → Confirmed → In Progress → Completed` (or `Cancelled`).

| Transition | Side effects |
|------------|--------------|
| **Confirm** | Snapshots the BOM components (scaled by quantity + scrap) onto the order. Reserves raw materials on `inventory.reserved_quantity`. |
| **Start** | No accounting impact — pure status change so the floor knows the order is in flight. |
| **Complete** | Releases the reservation, consumes the **actual** quantities recorded by the operator (variance vs plan is captured per line), prices overhead from the assigned resources × the actual production hours, and raises finished-goods stock at the frozen unit cost (or routes it to **QC quarantine** when `qc_required`). Supports **partial runs** (accumulate output + cost, auto-close at the planned qty). Posts `stock_movements`, all in one transaction — atomicity is preserved on shortage. |
| **Cancel** | Releases any reservation; no stock or cost impact. |

**Costing.** **Material** is valued at the moment of consumption by the
configured inventory costing method (weighted-average / FIFO / LIFO — see §7.6)
net of recoverable VAT, so manufacturing cost stays consistent with POS COGS and
inventory valuation. **Overhead** cost comes from the assigned resources ×
actual production hours as above. The finished good's
`unit_cost` is updated weighted-average on each completion. Producing goods posts
**no expense** — it transforms raw-material inventory value (plus conversion
cost) into finished-goods value.

---

### 7.25 Fixed Assets

**URL:** `/fixed-assets` &nbsp;|&nbsp;
**Router:** `routers/assets.py` &nbsp;|&nbsp;
**Permission:** `assets`

Capital register with **straight-line depreciation** posted as expenses.

**Asset states.** `Active → Fully Depreciated` (auto when the
depreciable base reaches zero) or `Active → Disposed` (manual). A new
**`Pending Approval`** state is set on creation when the seeded "Capex >
$5k" approval policy triggers.

**Depreciation.** Per month per asset, the system posts one row into the
shared `expenses` table (category `Depreciation`, `fixed_asset_id` set)
so the charge appears on the Finance P&L exactly like any other expense.
Locked accounting periods stop the run cleanly at the first locked
month rather than writing into a sealed period.

**Disposal.** Stamps `disposal_date`, `disposal_proceeds` and computes
the gain/loss against net book value. A rejected approval auto-stamps a
same-day disposal with zero proceeds so the ledger stays internally
consistent.

---

### 7.26 Recurring Expenses

**URL:** Expenses → Recurring tab &nbsp;|&nbsp;
**Router:** `routers/recurring.py` &nbsp;|&nbsp;
**Permission:** `expenses`

Templates that generate real `expenses` rows on a schedule. The template
itself is never counted on the P&L — only the rows it produces are.

**Frequencies.** `weekly`, `monthly`, `quarterly`, `annual`.

**Cursor model.** `next_run_date` is advanced one frequency step at a
time. It only ever moves forward, so running a template twice cannot
double-post. A template paused on a locked accounting period stops
cleanly at that month and reports it in `locked_stop`.

**Tax snapshot.** Re-resolved on every iteration so a rate change between
runs is respected for occurrences posted after the change — but never
rewrites historical ones.

---

### 7.27 Attachments (cross-cutting)

**Router:** `routers/attachments.py` &nbsp;|&nbsp; **Base URL:** `/api/attachments`

File attachments on any business record. One generic table and one router back
every entity, mirroring how HR/recruitment store files — as **DB BLOBs** (no
filesystem path, so no path-traversal surface).

**Supported entities** (`entity_type`): `invoices`, `purchases`, `projects`,
`expenses`, `assets`, `suppliers`, `clients`, `quotations`, `inventory`.

**Allowed file types.** PDF, images (PNG/JPG/GIF/WEBP), Word (`.doc`/`.docx`),
Excel (`.xls`/`.xlsx`), CSV, and plain text — **15 MB** max per file. The
content-type is resolved to a **canonical value from a fixed allowlist** (with
an extension fallback for files that arrive as `application/octet-stream`); the
raw client-supplied type is never stored.

**Permissions.** Attachments have **no module of their own** — access is gated
by the host record's existing RBAC module: the module's `view` to list/download,
`edit` to upload/delete. The check is imperative (`permissions.check_perm`)
because the module is resolved at runtime from the entity type.

**Security.** Downloads send `X-Content-Type-Options: nosniff` and are served
**inline only** for a safe set (PDF + images); every other type is forced as a
download (`?download=true` forces it for any file). This prevents a stored file
from executing as HTML/script in the app origin.

**Frontend.** A single reusable `<Attachments entityType entityId canEdit />`
component (in `components/Attachments.jsx`) is embedded on the client and
project detail pages and in the invoice, purchase, expense, asset, supplier and
quotation detail/edit dialogs. It lists files with type icons, supports inline
preview + forced download, and gates upload/delete on `canEdit`.

---

### 7.28 Accounting (General Ledger)

**URL:** `/accounting` &nbsp;|&nbsp; **Router:** `routers/accounting.py` &nbsp;|&nbsp; **Engine:** `accounting.py` &nbsp;|&nbsp; **Permission:** `accounting`

A real **double-entry** general ledger sitting alongside the cash-basis Finance views. Every entry balances by construction, so the Trial Balance always ties out and the Balance Sheet always balances (Assets = Liabilities + Equity + Net Income).

#### Chart of Accounts

A seeded, professional default chart (codes `1000`–`6900`) spanning the five types — **Asset, Liability, Equity, Income, Expense** — each with a normal balance side. Seeded accounts are flagged `is_system` (used by the auto-posting engine; cannot be deleted or deactivated). Accountants can add custom accounts, rename/group existing ones, deactivate unused custom accounts, and delete custom accounts that have no postings.

#### Journal Entries

Balanced debit/credit entries (`entry_number` `JE-YYYY-NNNNN`). Most are **auto-posted** from business events; accountants can also post **manual** entries (opening balances, accruals, adjustments). Corrections are made by **reversing** an entry (a mirror entry is posted and both are linked) — entries are never deleted, preserving the audit trail. Manual entries and reversals respect locked accounting periods.

#### Automatic posting

Recognition is **cash-basis**, matching the Finance dashboard exactly — so the GL Income Statement reconciles to the cent with Finance's income/expense. Posting is **idempotent** per source event.

| Business event | Debit | Credit |
|---|---|---|
| Invoice **payment** received | Cash & Bank (`1000`) | Sales Revenue (`4000`) |
| **Expense** recorded | Expense account (by category) | Cash & Bank (`1000`) |
| **Payroll** marked paid | Salaries & Wages (`6000`) | Cash & Bank (`1000`) |
| **Depreciation** posted | Depreciation Expense (`6300`) | Accumulated Depreciation (`1510`) |
| **Purchase** marked paid | Cost of Goods Sold (`5000`) | Cash & Bank (`1000`) |

Reversing events unwind automatically: **voiding an invoice** or **deleting a payment** reverses the revenue entry; **voiding an expense** reverses its entry. Expense categories map to ledger accounts (e.g. Rent → `6100`, Utilities → `6200`, Labour → `6500`); unmapped categories fall back to *General & Other Expense* (`6900`).

#### Statements

- **Trial Balance** — debit/credit balance per account as of a date; totals always equal.
- **Income Statement** — revenue − expenses over a period (its net income equals the Finance dashboard profit for the same range).
- **Balance Sheet** — assets vs. liabilities + equity as of a date, with current-period net income surfaced as a live equity line (no year-end closing entry required).
- **General Ledger** — every posting for one account over a range, with opening/running/closing balances.

#### Financial-Year Closing

A whole financial year can be **closed** (e.g. `2025 → closed`) from **Accounting → Year-End**. Closing a year:

1. **Posts a year-end closing entry** (`source_type='closing'`, dated Dec 31) that zeroes the year's income and expense accounts into **Retained Earnings** (`3900`) — the classic close-to-equity move. Net result is snapshotted on the `fiscal_years` row.
2. **Locks every transaction dated in that year.** The shared period-lock guard (`_check_period_locked`) also consults `fiscal_years`, so any create/edit/void/delete dated in a closed year — invoices, payments, expenses, journal entries, etc. — is rejected with *"The financial year YYYY is closed."*

The **Income Statement excludes** closing entries (and their reversals), so a closed year still shows its real operating result; the **Balance Sheet / Trial Balance include** them, so the profit shows up in Retained Earnings. **Reopening** a year (admin / `accounting:delete`) reverses the closing entry and unlocks the year. Closing requires `accounting:edit`.

> **Scope (simplified).** Posting is **forward-only** — entries accrue from the moment the module ships; there is no automatic backfill of historical transactions (post an opening-balance manual entry to seed balances). Inventory valuation and VAT liability are not split into the GL in this version (purchases are expensed on payment and invoice payments are recognised gross), keeping the ledger perfectly aligned with the existing cash-basis reports.

---

### 7.29 Client Communications

**Module key:** `communications` · **Requires:** `clients` · **Sidebar:** Sales →
Communications

Sends invoices and quotations to the client who owes them, and records what went
out. Full design rationale in [§21](#21-client-communications--share-links); this
section is the operational view.

**Permissions** — `view` reads the history, `create` sends. Split on purpose: a
bookkeeper can be allowed to check whether an invoice was delivered without being
allowed to send anything to a customer.

**Sending.** The `Send` button on an invoice or quotation row opens a dialog with
an Email and a WhatsApp tab, the recipient pre-filled from the client record, and
the per-document history. The ⋯ menu carries one-click **Send by WhatsApp** and
**Send by email** for when no changes are needed.

| Channel | Configuration | What the log records |
|---------|---------------|----------------------|
| WhatsApp | none — a `wa.me` deep link opens the user's own WhatsApp | `opened` (nothing observes delivery) |
| Email | `RESEND_API_KEY` + `MAIL_FROM` | `sent`, or `failed` with the provider error |

Every send mints a fresh expiring, revocable link to a client-facing document page
— no login, and a Print / Save-PDF button. Opening it increments a view count.

**The Communications page** aggregates every send across every document:

- counters for **sent**, **opened**, **failed**, and **never opened**
- filters by channel, status and recipient search
- revoke any live link
- a warning when email is unconfigured, since that is where someone lands when
  wondering why mail is not going out

*Never opened* is the number worth watching. A failure is loud and gets fixed; a
delivered-but-ignored invoice is silent, and it is the one that ages into a
collections problem.

**Endpoints**

```
GET   /api/communications/status                # can email actually send?
POST  /api/communications/send                  # {entity_type, entity_id, channel, to?, note?}
GET   /api/communications/log?entity_type=&entity_id=
GET   /api/communications/history?channel=&status=&q=
POST  /api/communications/shares/{id}/revoke
GET   /api/communications/public/{token}        # UNAUTHENTICATED — the client's view
```

**Tables** — `communications_log` (channel, recipient, subject, status, error,
share id, sender, timestamp) and `document_shares` (token hash, expiry, revocation,
view count). Both live in the tenant schema, so a token from one customer is
meaningless against another.

**Not included:** the WhatsApp Business API (needs per-customer Meta onboarding),
per-tenant DKIM, and PDF attachments — email currently carries the link rather than
the file, though the renderer for one exists (§20).

---

## 8. Taxation & Multi-Currency

### 8.1 Tax Model

The tax engine has a **single canonical helper** (`utils.money()` —
`Decimal` + `ROUND_HALF_UP`) and a **frozen per-line snapshot** invariant
that runs through every module. The four resolvers in `backend/utils.py`
share a `_pick_rate` core:

| Helper | Used by | Base | Default fallback |
|---|---|---|---|
| `resolve_line_tax(ctx, rid, net)` | Invoices, Quotations, Purchases | **Exclusive** — `tax = net × rate / 100` | Yes |
| `resolve_purchase_tax(...)` | Purchases | Same as `resolve_line_tax` | Yes |
| `resolve_inclusive_tax(...)` | POS | **Inclusive** — `tax = gross × rate / (100 + rate)` | Yes |
| `resolve_expense_tax(...)` | Expenses, Recurring expenses | Inclusive | **No** — an expense is tax-free unless a rate is explicitly chosen |

**Rounding policy.** All persisted monetary amounts are quantised to 2 dp
through `money()`. Lines are cent-rounded individually so that:

```
SUM(line.tax_amount) == document.tax_total
```

holds **exactly** for every document — no 1¢ drift on 30-line invoices.

**Snapshot invariance.** Each line stores `tax_rate_id`, `tax_rate` (the
rate value at the moment of write) and the computed `tax_amount`. Changing
a rate in the `tax_rates` table — even deactivating it — never rewrites
historical documents. Reports read these frozen columns; they never
recompute against the live rate table.

**Master switch.** `settings.tax_enabled` is the on/off flag. When off,
every resolver short-circuits to `(None, 0.0, 0.0)` regardless of what
clients send.

**Document totals.**
- Invoices: `subtotal` + `tax_total` (with `amount` = grand total). POS
  invoices follow the same shape so VAT reports treat them identically.
- Quotations: `total` (net subtotal) + `tax_total`.
- Purchases: header `tax_amount`. Tax applies only to `quantity × unit_cost`,
  not to additional shipping/customs costs.
- Expenses: gross `amount` + extracted `tax_amount` (when a rate is chosen).

**VAT report.** `/api/reports/vat` returns output / input / net VAT for the
selected period plus a **per-rate breakdown** (`output_by_rate`,
`input_by_rate`) — each bucket carries the taxable base + the VAT amount.
A monthly timeline includes both base and VAT for the income and expense
sides, so external reconciliations have everything they need.

**Procurement → Expenses bridge.** A paid PO automatically posts a matching
expense row carrying the *same tax snapshot*; the VAT report reads input
VAT from expenses only, so PO input VAT is counted exactly once. Inventory
`unit_cost` updates to the landed cost (goods + additional costs ÷ qty) —
**net of recoverable VAT** — so manufacturing weighted-average costing
pulls clean NET costs without ever touching tax math.

### 8.2 Multi-Currency

The system operates with a **base currency** (`default_currency`, e.g. `USD`) and one **secondary currency** (`secondary_currency`, e.g. `LBP`).

- **All ledger amounts** — invoice balances, expenses, project costs, reports — are stored and computed in the **base currency**.
- The secondary currency exists for **payment capture only**: a client may settle an invoice in LBP.
- Exchange rates are **entered manually** by an admin and kept as a full **history** (`exchange_rates` table). Each rate change records who set it and an optional note. There is no live/automatic rate feed — this is deliberate for offline, single-machine deployments.
- When a payment is recorded in the secondary currency, the request must include an `exchange_rate`. The payment row stores `paid_currency`, `paid_amount` (what the client handed over), `exchange_rate`, and `amount` (the converted base-currency value applied to the balance).

---

## 9. API Reference

**Base URL:** `http://localhost:8765/api`

All endpoints require a valid session cookie except:
- `POST /api/auth/login`
- `GET /api/settings/setup-status`
- `POST /api/settings/complete-setup`

Interactive API documentation is available at:
- **Swagger UI:** `http://localhost:8765/docs`
- **ReDoc:** `http://localhost:8765/redoc`

---

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/login` | Login (rate-limited: 5 attempts / 15 min per IP) |
| POST | `/auth/logout` | Revoke the current session |
| GET | `/auth/me` | Current user info and full permission set |
| POST | `/auth/change-password` | Change own password (rate-limited) |
| POST | `/auth/force-change-password` | First-login mandatory password change |

---

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard/` | Summary metrics for the current month |

---

### Clients

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/clients/` | List clients (search, type filter) |
| POST | `/clients/` | Create a client |
| GET | `/clients/{id}` | Client detail with projects, invoices, and quotations |
| PUT | `/clients/{id}` | Update a client |
| PATCH | `/clients/{id}/archive` | Archive with reason |
| PATCH | `/clients/{id}/unarchive` | Restore from archives |

---

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/projects/` | List projects (search, status filter) |
| POST | `/projects/` | Create a project |
| GET | `/projects/{id}` | Project detail |
| PUT | `/projects/{id}` | Update a project |
| PATCH | `/projects/{id}/status` | Change project status |
| PATCH | `/projects/{id}/cancel` | Cancel with reason |
| PATCH | `/projects/{id}/archive` | Archive |
| PATCH | `/projects/{id}/unarchive` | Restore from archives |

---

### Quotations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/quotations/` | List quotations (status filter) |
| POST | `/quotations/` | Create a quotation with line items |
| GET | `/quotations/{id}` | Detail with line items |
| PUT | `/quotations/{id}` | Update a quotation |
| POST | `/quotations/{id}/convert-to-invoice` | Create an invoice from this quotation |
| POST | `/quotations/{id}/convert-to-project` | Create a project from this quotation |
| PATCH | `/quotations/{id}/cancel` | Cancel with reason |
| PATCH | `/quotations/{id}/archive` | Archive |
| PATCH | `/quotations/{id}/unarchive` | Restore from archives |

---

### Invoices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/invoices/` | List invoices (status filter) |
| POST | `/invoices/` | Create an invoice with line items |
| GET | `/invoices/{id}` | Detail with payments and line items |
| PUT | `/invoices/{id}` | Update (locked after first payment) |
| PATCH | `/invoices/{id}/void` | Void with reason |
| POST | `/invoices/{id}/payments` | Record a payment (`idempotency_key` required) |
| GET | `/invoices/{id}/payments` | List payments on an invoice |
| DELETE | `/invoices/{id}/payments/{pid}` | Delete a payment |
| PATCH | `/invoices/{id}/archive` | Archive |
| PATCH | `/invoices/{id}/unarchive` | Restore from archives |

---

### Inventory

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/inventory/` | List inventory items |
| GET | `/inventory/categories` | Available category values |
| POST | `/inventory/` | Create an item |
| GET | `/inventory/{id}` | Item detail |
| GET | `/inventory/{id}/movements` | Stock movement history |
| PUT | `/inventory/{id}` | Update an item |
| PATCH | `/inventory/{id}/stock` | Manual stock adjustment |
| POST | `/inventory/{id}/deduct-to-project` | Deduct stock and link to a project |
| PATCH | `/inventory/{id}/archive` | Archive |
| PATCH | `/inventory/{id}/unarchive` | Restore from archives |

---

### Purchases

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/purchases/` | List purchase orders |
| GET | `/purchases/stats` | Purchase statistics |
| POST | `/purchases/` | Create a PO |
| GET | `/purchases/{id}` | PO detail |
| PUT | `/purchases/{id}` | Update a PO |
| PATCH | `/purchases/{id}/status` | Change PO status |
| GET | `/purchases/supplier/{name}/history` | Supplier PO history |
| PATCH | `/purchases/{id}/archive` | Archive |
| PATCH | `/purchases/{id}/unarchive` | Restore from archives |

---

### Suppliers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/suppliers/` | List suppliers |
| POST | `/suppliers/` | Create a supplier |
| GET | `/suppliers/{id}` | Supplier detail |
| PUT | `/suppliers/{id}` | Update a supplier |
| PATCH | `/suppliers/{id}/archive` | Archive |
| PATCH | `/suppliers/{id}/unarchive` | Restore from archives |

---

### Finance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/finance/summary` | Current month financial summary |
| GET | `/finance/range-summary` | Summary for a custom date range |
| GET | `/finance/range-monthly` | Monthly breakdown for a date range |
| GET | `/finance/range-detail` | Detailed line items for a date range |
| GET | `/finance/monthly` | Full monthly history |
| GET | `/finance/expenses` | List expenses |
| POST | `/finance/expenses` | Create an expense |
| PUT | `/finance/expenses/{id}` | Update an expense |
| PATCH | `/finance/expenses/{id}/void` | Void an expense |
| PATCH | `/finance/expenses/{id}/archive` | Archive |
| PATCH | `/finance/expenses/{id}/unarchive` | Restore from archives |
| GET | `/finance/periods` | List accounting periods |
| POST | `/finance/periods/{year}/{month}/lock` | Lock an accounting period |
| POST | `/finance/periods/{year}/{month}/unlock` | Unlock an accounting period |
| GET | `/finance/reconciliation` | Reconciliation view |

---

### Accounting

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/accounting/accounts` | List chart of accounts (filter by type / active) |
| POST | `/accounting/accounts` | Create a custom account |
| PUT | `/accounting/accounts/{id}` | Rename / regroup / (de)activate an account |
| DELETE | `/accounting/accounts/{id}` | Delete a custom account with no postings |
| GET | `/accounting/journal-entries` | List entries (filter by date range / source) |
| GET | `/accounting/journal-entries/{id}` | Entry with its debit/credit lines |
| POST | `/accounting/journal-entries` | Post a manual balanced entry |
| POST | `/accounting/journal-entries/{id}/reverse` | Post a reversing entry |
| GET | `/accounting/general-ledger` | Account ledger with running balance (`account_id`, range) |
| GET | `/accounting/trial-balance` | Trial balance as of a date |
| GET | `/accounting/income-statement` | P&L over a date range |
| GET | `/accounting/balance-sheet` | Balance sheet as of a date |
| GET | `/accounting/fiscal-years` | List years with status + P&L (open = live, closed = snapshot) |
| POST | `/accounting/fiscal-years/{year}/close` | Close a year (posts the closing entry, locks the year) |
| POST | `/accounting/fiscal-years/{year}/reopen` | Reopen a closed year (reverses the closing entry) |
| GET | `/accounting/summary` | Dashboard KPIs (month P&L, totals, balanced check) |

---

### CRM

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/crm/dashboard` | CRM summary KPIs |
| GET | `/crm/leads` | List leads |
| POST | `/crm/leads` | Create a lead |
| GET | `/crm/leads/{id}` | Lead detail |
| PUT | `/crm/leads/{id}` | Update a lead |
| PATCH | `/crm/leads/{id}/archive` | Archive a lead |
| POST | `/crm/leads/{id}/convert` | Convert lead to client |
| GET | `/crm/contacts` | List contacts |
| POST | `/crm/contacts` | Create a contact |
| PUT | `/crm/contacts/{id}` | Update a contact |
| DELETE | `/crm/contacts/{id}` | Delete a contact |
| GET | `/crm/activities` | List activities |
| POST | `/crm/activities` | Create an activity |
| PUT | `/crm/activities/{id}` | Update an activity |
| PATCH | `/crm/activities/{id}/done` | Mark activity as complete |
| DELETE | `/crm/activities/{id}` | Delete an activity |
| GET | `/crm/deals` | List deals |
| POST | `/crm/deals` | Create a deal |
| PUT | `/crm/deals/{id}` | Update a deal |
| PATCH | `/crm/deals/{id}/stage` | Move deal to a new stage |

---

### Planning

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/planning/projects` | List planning projects |
| POST | `/planning/projects` | Create a planning project |
| GET | `/planning/projects/{id}` | Project detail |
| PUT | `/planning/projects/{id}` | Update a project |
| PATCH | `/planning/projects/{id}/archive` | Archive a project |
| GET | `/planning/tasks` | List tasks |
| POST | `/planning/tasks` | Create a task |
| GET | `/planning/tasks/{id}` | Task detail |
| PUT | `/planning/tasks/{id}` | Update a task |
| PATCH | `/planning/tasks/{id}/dates` | Update task start/end dates |
| PATCH | `/planning/tasks/{id}/status` | Change task status |
| PATCH | `/planning/tasks/{id}/progress` | Update task progress percentage |
| PATCH | `/planning/tasks/{id}/archive` | Archive a task |
| GET | `/planning/milestones` | List milestones |
| POST | `/planning/milestones` | Create a milestone |
| PUT | `/planning/milestones/{id}` | Update a milestone |
| PATCH | `/planning/milestones/{id}/archive` | Soft-delete a milestone |
| GET | `/planning/summary` | Planning summary statistics |

---

### HR

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hr/departments` | List departments |
| POST | `/hr/departments` | Create a department |
| PUT | `/hr/departments/{dept_id}` | Update a department |
| PATCH | `/hr/departments/{dept_id}/archive` | Archive a department |
| PATCH | `/hr/departments/{dept_id}/unarchive` | Restore a department |
| GET | `/hr/employees` | List employees (search, filter by department/status/type) |
| GET | `/hr/employees/{emp_id}` | Employee detail |
| POST | `/hr/employees` | Create an employee |
| PUT | `/hr/employees/{emp_id}` | Update an employee |
| PATCH | `/hr/employees/{emp_id}/archive` | Archive an employee |
| PATCH | `/hr/employees/{emp_id}/unarchive` | Restore an employee |
| GET | `/hr/leave` | List leave requests (filter by status / employee) |
| POST | `/hr/leave` | Submit a leave request |
| PUT | `/hr/leave/{leave_id}` | Update a pending leave request |
| POST | `/hr/leave/{leave_id}/approve` | Approve a leave request |
| POST | `/hr/leave/{leave_id}/reject` | Reject a leave request |
| DELETE | `/hr/leave/{leave_id}` | Delete a pending leave request |
| POST | `/hr/employees/{emp_id}/files` | Upload an employee PDF (cv / contract / other) |
| GET | `/hr/employees/{emp_id}/files` | List an employee's file metadata |
| GET | `/hr/files/{file_id}/download` | Stream a file inline |
| DELETE | `/hr/files/{file_id}` | Delete a file |
| GET | `/hr/payroll/runs` | List payroll runs (status filter) |
| POST | `/hr/payroll/runs` | Open a draft run (seeds one line per active employee) |
| GET | `/hr/payroll/runs/{run_id}` | Run detail with per-employee lines |
| PUT | `/hr/payroll/lines/{line_id}` | Edit a line (recomputes the breakdown) |
| POST | `/hr/payroll/runs/{run_id}/approve` | Approve a draft run |
| POST | `/hr/payroll/runs/{run_id}/mark-paid` | Finalise + post a single expense to Finance (idempotent) |
| POST | `/hr/payroll/runs/{run_id}/cancel` | Cancel a Draft/Approved run |
| GET | `/hr/summary` | Headcount, leave, and payroll KPIs |

---

### HR Contracts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hr/contracts/` | List contracts (filter by employee / status) |
| POST | `/hr/contracts/` | Create a contract |
| GET | `/hr/contracts/{id}` | Contract detail (with employee + company fields) |
| PUT | `/hr/contracts/{id}` | Update a contract |
| POST | `/hr/contracts/{id}/status` | Transition status (Activate syncs salary + timeline) |
| PATCH | `/hr/contracts/{id}/archive` | Archive a contract |
| GET | `/hr/contracts/{id}/print-data` | Contract + company branding for client-side PDF |

---

### HR Activities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hr-activities` | List the caller's activities (scope: upcoming / today / overdue / done / all) |
| GET | `/hr-activities/summary` | Today / upcoming-14 / overdue / done-7d counters |
| GET | `/hr-activities/{id}` | Activity detail |
| POST | `/hr-activities` | Create an activity (schedules a reminder) |
| PUT | `/hr-activities/{id}` | Update an activity (rebuilds the reminder) |
| PATCH | `/hr-activities/{id}/complete` | Mark an activity done |
| PATCH | `/hr-activities/{id}/archive` | Archive an activity |
| GET | `/hr-activities/dropdown/applicants` | Applicant options for the form |
| GET | `/hr-activities/dropdown/employees` | Employee options for the form |

---

### Recruitment

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/recruitment/positions` | List positions (status filter) |
| POST | `/recruitment/positions` | Create a position |
| GET | `/recruitment/positions/{id}` | Position detail with applicants |
| PUT | `/recruitment/positions/{id}` | Update a position |
| PATCH | `/recruitment/positions/{id}/archive` | Archive a position |
| GET | `/recruitment/applicants` | List applicants (status / position / search) |
| POST | `/recruitment/applicants` | Register an applicant |
| GET | `/recruitment/applicants/{id}` | Applicant detail (interviews, history, files) |
| PUT | `/recruitment/applicants/{id}` | Update an applicant |
| POST | `/recruitment/applicants/{id}/status` | Move the applicant through the pipeline |
| PATCH | `/recruitment/applicants/{id}/archive` | Archive an applicant |
| POST | `/recruitment/applicants/{id}/interviews` | Schedule an interview (mirrors an HR Activity) |
| PUT | `/recruitment/interviews/{id}` | Update an interview |
| DELETE | `/recruitment/interviews/{id}` | Remove an interview |
| POST | `/recruitment/applicants/{id}/files` | Upload a PDF/Word document |
| GET | `/recruitment/applicants/{id}/files` | List applicant file metadata |
| GET | `/recruitment/files/{id}/download` | Stream a file inline |
| DELETE | `/recruitment/files/{id}` | Delete a file |
| GET | `/recruitment/applicants/{id}/offers` | List an applicant's offer letters |
| POST | `/recruitment/applicants/{id}/offers` | Draft an offer letter |
| PUT | `/recruitment/offers/{id}` | Update an offer |
| POST | `/recruitment/offers/{id}/status` | Transition an offer (Sent / Accepted / …) |
| PATCH | `/recruitment/offers/{id}/archive` | Archive an offer |
| GET | `/recruitment/offers/{id}/print-data` | Offer + company branding for client-side PDF |
| POST | `/recruitment/applicants/{id}/convert` | Onboard an Accepted applicant as an employee |
| GET | `/recruitment/summary` | Recruitment pipeline KPIs |

---

### Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/reports/financial` | Financial summary report |
| GET | `/reports/projects` | Projects performance report |
| GET | `/reports/clients` | Clients revenue report |
| GET | `/reports/invoice-aging` | Invoice aging analysis |
| GET | `/reports/expenses` | Expense report by category |
| GET | `/reports/pipeline` | Sales pipeline report |
| GET | `/reports/vat` | VAT summary report |

---

### Documents

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/documents/` | Generate and store a document |
| GET | `/documents/` | List stored documents |
| GET | `/documents/{id}/content` | Download a document |
| DELETE | `/documents/{id}` | Delete a document |

---

### Users (admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/` | List users |
| POST | `/users/` | Create a user |
| GET | `/users/{id}` | User detail |
| PUT | `/users/{id}` | Update a user |
| POST | `/users/{id}/reset-password` | Force a password reset |
| PATCH | `/users/{id}/toggle-active` | Enable or disable a user |
| DELETE | `/users/{id}` | Soft-delete a user |
| GET | `/users/sessions` | List all active sessions |
| DELETE | `/users/sessions/{sid}` | Revoke a specific session |

---

### Roles (admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/roles/` | List roles |
| GET | `/roles/modules` | Available modules and their actions |
| POST | `/roles/` | Create a role |
| GET | `/roles/{id}` | Role detail |
| PUT | `/roles/{id}` | Update a role |
| PUT | `/roles/{id}/permissions` | Update role permissions |
| DELETE | `/roles/{id}` | Delete a role |

---

### Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/settings/` | Get all system settings |
| PUT | `/settings/` | Update system settings |
| GET | `/settings/exchange-rate` | Get the current exchange rate configuration |
| POST | `/settings/exchange-rate` | Update the exchange rate |
| GET | `/settings/logo` | Get the company logo |
| POST | `/settings/logo` | Upload a new company logo |
| GET | `/settings/backup` | Download the current database backup |
| GET | `/settings/backup-status` | List backups and their status |
| POST | `/settings/backup-now` | Trigger an immediate manual backup |
| POST | `/settings/backup-export` | Back up the database to an external folder (USB drive / network share) |
| POST | `/settings/restore` | Restore the database from a backup file |
| GET | `/settings/setup-status` | First-run check (public endpoint) |
| POST | `/settings/complete-setup` | Complete the first-run setup (public endpoint) |
| GET | `/settings/integrity-check` | Run SQLite PRAGMA integrity_check |

---

### Approval Policies (admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/approval-policies/` | List all approval policies |
| POST | `/approval-policies/` | Create a policy |
| GET | `/approval-policies/{id}` | Policy detail with steps |
| PUT | `/approval-policies/{id}` | Update a policy |
| DELETE | `/approval-policies/{id}` | Delete a policy |

---

### Approval Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/approval-requests/` | List requests (filterable by status and entity type) |
| GET | `/approval-requests/{id}` | Request detail (requester, approver role, or admin only) |
| POST | `/approval-requests/{id}/approve` | Approve the current step |
| POST | `/approval-requests/{id}/reject` | Reject the request |

---

### Tax Rates

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tax-rates/` | List tax rates (any signed-in user — document forms need them) |
| POST | `/tax-rates/` | Create a tax rate (admin only) |
| PUT | `/tax-rates/{id}` | Update a tax rate (admin only) |
| DELETE | `/tax-rates/{id}` | Deactivate a tax rate — soft, preserves historical references (admin only) |

---

### Exchange Rate

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/settings/exchange-rate` | Latest rate + recent change history (any signed-in user) |
| POST | `/settings/exchange-rate` | Record a new manual exchange rate (admin only) |

---

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/notifications/` | List notifications for the current user |
| GET | `/notifications/count` | Unread notification count |
| PATCH | `/notifications/{id}/read` | Mark a notification as read |
| POST | `/notifications/read-all` | Mark all notifications as read |

---

### Attachments

Generic file attachments on any supported entity (`entity_type` ∈ invoices, purchases, projects, expenses, assets, suppliers, clients, quotations, inventory). Gated by the host module's `view` (list/download) and `edit` (upload/delete).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/attachments/{entity_type}/{entity_id}` | List a record's attachments (metadata only) |
| POST | `/attachments/{entity_type}/{entity_id}` | Upload a file (multipart) |
| GET | `/attachments/file/{id}` | Stream a file (`?download=true` forces download) |
| DELETE | `/attachments/file/{id}` | Delete an attachment |

---

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/search/` | Global search across all modules |
| GET | `/archives/` | List archived items |
| PATCH | `/archives/{module}/{id}/unarchive` | Restore an archived item |
| GET | `/audit/` | Audit log |
| DELETE | `/audit/purge` | Purge old audit entries (superadmin only) |

---

## 10. Database Schema

The database is **SQLite** (`erp.db`) running in **WAL journal mode** with foreign-key enforcement enabled. All tables use `INTEGER PRIMARY KEY` (autoincrement). Timestamps are stored as ISO 8601 UTC strings.

The schema evolves through **numbered, idempotent migrations** recorded in the `schema_migrations` table; each runs at most once on startup. As of this version the latest applied migration is `045_line_item_tax`.

### Core Tables

#### `clients`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `name` | TEXT | Full name |
| `company` | TEXT | Company name |
| `phone` | TEXT | Phone number |
| `email` | TEXT | Email address |
| `address` | TEXT | Street address |
| `type` | TEXT | `Individual` or `Company` |
| `notes` | TEXT | Free-form notes |
| `archived_at` | TEXT | Soft-archive timestamp |
| `created_at` | TEXT | Creation timestamp |

#### `projects`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | Project name |
| `client_id` | INTEGER FK | → clients |
| `location` | TEXT | Site / location |
| `status` | TEXT | Planning / In Progress / Completed / On Hold / Cancelled |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `estimated_cost` | REAL | Budget |
| `actual_cost` | REAL | Sum of linked approved expenses and inventory deductions |
| `expected_revenue` | REAL | |
| `source_quotation_id` | INTEGER FK | → quotations (if converted from a quotation) |
| `description` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `quotations`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `quote_number` | TEXT UNIQUE | e.g., QTN-0001 |
| `project_id` | INTEGER FK | → projects |
| `client_id` | INTEGER FK | → clients |
| `project_name` | TEXT | Snapshot of project name at time of creation |
| `status` | TEXT | Draft / Sent / Accepted / Rejected / Cancelled |
| `notes` | TEXT | |
| `total` | REAL | Net subtotal (sum of line item totals, before tax) |
| `tax_total` | REAL | Rolled-up tax across all line items |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `quotation_items`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `quotation_id` | INTEGER FK | → quotations |
| `name` | TEXT | Item description |
| `quantity` | REAL | |
| `unit_price` | REAL | |
| `total` | REAL | quantity × unit_price |
| `tax_rate_id` | INTEGER FK | → tax_rates (rate applied to this line) |
| `tax_rate` | REAL | Snapshot of the rate percentage at creation time |
| `tax_amount` | REAL | Computed tax for this line |

#### `invoices`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `invoice_number` | TEXT UNIQUE | e.g., INV-0001 |
| `quotation_id` | INTEGER FK | → quotations |
| `project_id` | INTEGER FK | → projects |
| `client_id` | INTEGER FK | → clients |
| `amount` | REAL | Grand total (tax-inclusive) |
| `subtotal` | REAL | Net total before tax |
| `tax_total` | REAL | Rolled-up tax across all line items |
| `due_date` | TEXT | Payment deadline |
| `notes` | TEXT | |
| `version` | INTEGER | Optimistic lock counter |
| `voided_at` | TEXT | Void timestamp |
| `void_reason` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `invoice_items`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `invoice_id` | INTEGER FK | → invoices |
| `name` | TEXT | |
| `quantity` | REAL | |
| `unit_price` | REAL | |
| `tax_rate_id` | INTEGER FK | → tax_rates (rate applied to this line) |
| `tax_rate` | REAL | Snapshot of the rate percentage at creation time |
| `tax_amount` | REAL | Computed tax for this line |

#### `invoice_payments`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `invoice_id` | INTEGER FK | → invoices |
| `amount` | REAL | Value applied to the invoice balance, in the **base currency** |
| `method` | TEXT | Cash / Bank Transfer / Cheque / Card / Other |
| `note` | TEXT | |
| `idempotency_key` | TEXT UNIQUE | Duplicate-prevention key — **required** on every payment request |
| `paid_currency` | TEXT | Currency the client actually paid in (`USD` / `LBP`); default `USD` |
| `paid_amount` | REAL | Amount tendered in `paid_currency` |
| `exchange_rate` | REAL | Rate used to convert an LBP payment to the base currency |
| `paid_at` | TEXT | |

#### `inventory`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | Item name |
| `category` | TEXT | Product / Material / Equipment / Other |
| `quantity` | REAL | Current stock level |
| `min_stock` | REAL | Low-stock alert threshold |
| `unit_cost` | REAL | Cost per unit |
| `supplier` | TEXT | Supplier name |
| `unit` | TEXT | Unit of measure (kg, pcs, m, etc.) |
| `archived_at` | TEXT | |
| `deleted_at` | TEXT | Soft-delete timestamp (Recycle Bin) |
| `created_at` | TEXT | |

#### `stock_movements`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `inventory_id` | INTEGER FK | → inventory |
| `type` | TEXT | purchase / adjustment / deduction / return |
| `delta` | REAL | Quantity change (positive or negative) |
| `qty_before` | REAL | Stock level before the movement |
| `qty_after` | REAL | Stock level after the movement |
| `reference` | TEXT | PO number or project name |
| `note` | TEXT | |
| `created_at` | TEXT | |

#### `inventory_cost_layers`
Surviving cost lots for FIFO/LIFO costing (see §7.6 → Inventory Costing Method). Only populated/consumed when `inventory_costing_method` is `fifo` or `lifo`; empty and unused under `weighted_avg`.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `inventory_id` | INTEGER FK | → inventory (CASCADE delete) |
| `qty_remaining` | REAL | Units left in this lot (drawn down on stock-OUT) |
| `unit_cost` | REAL | Landed cost per unit for this lot |
| `source_type` | TEXT | purchase / production / adjustment / opening / return |
| `source_ref` | TEXT | PO number, order number, etc. |
| `created_at` | TEXT | Lot timestamp — FIFO consumes oldest, LIFO newest |

#### `purchases`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `po_number` | TEXT UNIQUE | e.g., PO-0001 |
| `supplier` | TEXT | Supplier name (snapshot at creation) |
| `supplier_id` | INTEGER FK | → suppliers |
| `inventory_id` | INTEGER FK | → inventory |
| `product_name` | TEXT | |
| `quantity` | REAL | |
| `unit_cost` | REAL | |
| `additional_costs` | REAL | Shipping, duties, and other costs |
| `tax_rate_id` | INTEGER FK | → tax_rates (rate applied to the order) |
| `tax_rate` | REAL | Snapshot of the rate percentage at creation time |
| `tax_amount` | REAL | Computed tax for the order |
| `status` | TEXT | Draft / Ordered / Received / Paid |
| `stock_updated` | INTEGER | `1` if inventory stock has been incremented |
| `expense_recorded` | INTEGER | `1` if an expense has been auto-created |
| `notes` | TEXT | |
| `ordered_at` | TEXT | |
| `received_at` | TEXT | |
| `paid_at` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `suppliers`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | |
| `contact_name` | TEXT | |
| `phone` | TEXT | |
| `email` | TEXT | |
| `payment_terms_days` | INTEGER | |
| `notes` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `expenses`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `project_id` | INTEGER FK | → projects (optional) |
| `category` | TEXT | Labour / Materials / Equipment / Transport / Subcontractor / Permits / Purchase / Other |
| `description` | TEXT | |
| `amount` | REAL | Gross amount (tax-inclusive). Must be > 0 (enforced at the API layer) |
| `tax_rate_id` | INTEGER FK | → tax_rates (optional — no default fallback) |
| `tax_rate` | REAL | Snapshot of the rate percentage at creation time |
| `tax_amount` | REAL | Tax *extracted* from the gross amount |
| `date` | TEXT | Expense date |
| `status` | TEXT | Recorded / Pending Approval / Approved / Rejected |
| `voided_at` | TEXT | |
| `void_reason` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

---

### Financial / Accounting Tables

#### `accounting_periods`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `year` | INTEGER | |
| `month` | INTEGER | 1–12 |
| `locked_at` | TEXT | Lock timestamp |
| `locked_by` | INTEGER FK | → users |

#### `period_snapshots`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `year` | INTEGER | |
| `month` | INTEGER | |
| `income` | REAL | Total paid invoices for the period |
| `expenses` | REAL | Total expenses for the period |
| `profit` | REAL | income − expenses |
| `payment_count` | INTEGER | |
| `expense_count` | INTEGER | |
| `locked_at` | TEXT | |
| `locked_by` | INTEGER FK | → users |

#### `tax_rates`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | Display name (e.g., `VAT 11%`) |
| `rate` | REAL | Percentage, 0–100 |
| `tax_type` | TEXT | `standard` / `zero` / `exempt` |
| `is_default` | INTEGER | `1` = the rate applied to new lines by default (exactly one row) |
| `is_active` | INTEGER | `1` = selectable in new-document forms; `0` = soft-deactivated |
| `created_at` | TEXT | |

#### `exchange_rates`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `rate` | REAL | Secondary-currency units per one base-currency unit (e.g., LBP per USD) |
| `set_by` | INTEGER FK | → users |
| `set_by_name` | TEXT | Username snapshot at the time of the change |
| `note` | TEXT | Optional note describing the change |
| `created_at` | TEXT | The latest row is the active rate; older rows form the history |

#### `chart_of_accounts`
The general-ledger account list (see §7.28). Seeded `is_system` accounts are used by the auto-posting engine.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `code` | TEXT UNIQUE | e.g. `1000`, `4000` |
| `name` | TEXT | Account name |
| `type` | TEXT | Asset / Liability / Equity / Income / Expense |
| `subtype` | TEXT | Reporting group (e.g. Current Asset) |
| `normal_balance` | TEXT | `debit` or `credit` |
| `parent_code` | TEXT | Optional hierarchy |
| `is_system` | INTEGER | `1` = seeded, protected from delete/deactivate |
| `is_active` | INTEGER | |
| `description` | TEXT | |
| `created_at` | TEXT | |

#### `journal_entries`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `entry_number` | TEXT | `JE-YYYY-NNNNN` |
| `entry_date` | TEXT | |
| `memo` | TEXT | |
| `source_type` | TEXT | manual / invoice_payment / expense / payroll / depreciation / purchase / reversal |
| `source_id` | INTEGER | The originating record (idempotency key with source_type) |
| `status` | TEXT | posted / reversed |
| `reverses_id` | INTEGER FK | → journal_entries (entry this one reverses) |
| `reversed_by` | INTEGER FK | → journal_entries (the reversal of this entry) |
| `total_debit`, `total_credit` | REAL | Always equal |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |

#### `journal_entry_lines`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `journal_entry_id` | INTEGER FK | → journal_entries (CASCADE) |
| `account_id` | INTEGER FK | → chart_of_accounts |
| `debit` | REAL | |
| `credit` | REAL | One of debit/credit is zero per line |
| `memo` | TEXT | |
| `line_no` | INTEGER | Ordering within the entry |

#### `fiscal_years`
A closed year locks all dated-in-year modifications (see §7.28).
| Column | Type | Description |
|--------|------|-------------|
| `year` | INTEGER PK | e.g. `2025` |
| `status` | TEXT | open / closed |
| `total_income`, `total_expense`, `net_income` | REAL | Snapshot at close |
| `closing_entry_id` | INTEGER FK | → journal_entries (the year-end closing entry) |
| `closed_at` | TEXT | |
| `closed_by` | INTEGER FK | → users |
| `notes` | TEXT | |

---

### Auth Tables

#### `users`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `username` | TEXT UNIQUE | Login identifier |
| `password_hash` | TEXT | PBKDF2-SHA256 hash |
| `full_name` | TEXT | Display name |
| `email` | TEXT | |
| `role` | TEXT | Legacy role name (kept for compatibility) |
| `role_id` | INTEGER FK | → roles |
| `is_active` | INTEGER | `1` = enabled |
| `is_superadmin` | INTEGER | `1` = bypass all RBAC checks |
| `last_login` | TEXT | |
| `must_change_password` | INTEGER | `1` = force password change on next login |
| `deleted_at` | TEXT | Soft-delete timestamp |
| `created_at` | TEXT | |

#### `roles`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT UNIQUE | |
| `description` | TEXT | |
| `color` | TEXT | Hex color for the UI badge |
| `is_system` | INTEGER | `1` = built-in role, cannot be deleted |
| `created_at` | TEXT | |

#### `role_permissions`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `role_id` | INTEGER FK | → roles |
| `module` | TEXT | Module permission key |
| `can_view` | INTEGER | |
| `can_create` | INTEGER | |
| `can_edit` | INTEGER | |
| `can_delete` | INTEGER | |
| `can_approve` | INTEGER | |

#### `user_sessions`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `user_id` | INTEGER FK | → users |
| `jti` | TEXT UNIQUE | JWT ID (revocation key) |
| `ip_address` | TEXT | |
| `user_agent` | TEXT | Browser / client string |
| `created_at` | TEXT | |
| `last_active` | TEXT | |
| `expires_at` | TEXT | |
| `revoked` | INTEGER | `1` = revoked |

#### `login_attempts`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `ip` | TEXT | |
| `attempted_at` | TEXT | |

---

### CRM Tables

#### `crm_leads`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | |
| `company` | TEXT | |
| `email` | TEXT | |
| `phone` | TEXT | |
| `source` | TEXT | Website / Referral / Cold Call / etc. |
| `status` | TEXT | New / Contacted / Qualified / Lost |
| `score` | INTEGER | 0–100 |
| `estimated_value` | REAL | |
| `expected_close` | TEXT | Date |
| `assigned_to` | INTEGER FK | → users |
| `client_id` | INTEGER FK | → clients (populated after conversion) |
| `notes` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `crm_contacts`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `client_id` | INTEGER FK | → clients |
| `lead_id` | INTEGER FK | → crm_leads |
| `name` | TEXT | |
| `title` | TEXT | Job title |
| `email` | TEXT | |
| `phone` | TEXT | |
| `is_primary` | INTEGER | `1` = primary contact |
| `notes` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `crm_activities`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `type` | TEXT | call / email / meeting / task / note |
| `subject` | TEXT | |
| `description` | TEXT | |
| `client_id` | INTEGER FK | |
| `lead_id` | INTEGER FK | |
| `contact_id` | INTEGER FK | |
| `user_id` | INTEGER FK | → users |
| `due_date` | TEXT | |
| `done_at` | TEXT | Completion timestamp |
| `outcome` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `crm_deals`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `title` | TEXT | |
| `client_id` | INTEGER FK | |
| `lead_id` | INTEGER FK | |
| `quotation_id` | INTEGER FK | |
| `stage` | TEXT | Qualification / Proposal / Negotiation / Won / Lost |
| `value` | REAL | |
| `probability` | INTEGER | 0–100% |
| `expected_close` | TEXT | |
| `won_at` | TEXT | |
| `lost_at` | TEXT | |
| `lost_reason` | TEXT | |
| `assigned_to` | INTEGER FK | → users |
| `notes` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

---

### Planning Tables

#### `planning_projects`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | |
| `description` | TEXT | |
| `client_id` | INTEGER FK | → clients |
| `color` | TEXT | Hex color for the Gantt chart |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `status` | TEXT | Active / Completed / On Hold |
| `created_by` | INTEGER FK | → users |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `planning_tasks`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `project_id` | INTEGER FK | → planning_projects |
| `name` | TEXT | |
| `description` | TEXT | |
| `assigned_to` | INTEGER FK | → users |
| `status` | TEXT | To Do / In Progress / Done |
| `priority` | TEXT | Low / Medium / High / Critical |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `progress` | INTEGER | 0–100 |
| `milestone_id` | INTEGER FK | → planning_milestones |
| `depends_on` | INTEGER FK | → planning_tasks (self-referential) |
| `color` | TEXT | |
| `sort_order` | INTEGER | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `planning_milestones`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `project_id` | INTEGER FK | → planning_projects |
| `name` | TEXT | |
| `due_date` | TEXT | |
| `reached_at` | TEXT | Completion timestamp |
| `archived_at` | TEXT | Soft-delete timestamp |
| `created_at` | TEXT | |

---

### HR Tables

> All HR tables are namespaced with an `hr_` prefix.

#### `hr_departments`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | Unique among non-archived rows |
| `description` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `hr_employees`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `employee_code` | TEXT | Auto-assigned `EMP-0001`, … |
| `full_name` | TEXT | |
| `job_title` | TEXT | |
| `department_id` | INTEGER FK | → hr_departments |
| `employment_type` | TEXT | Full-time / Part-time / Contract / Intern |
| `status` | TEXT | Active / On Leave / Terminated |
| `hire_date` | TEXT | |
| `end_date` | TEXT | |
| `email` | TEXT | |
| `phone` | TEXT | |
| `salary` | REAL | |
| `manager_id` | INTEGER FK | → hr_employees (self-referential) |
| `user_id` | INTEGER FK | → users (optional link to a user account) |
| `address` | TEXT | |
| `notes` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `hr_employment_changes`
Append-only salary / role / department / manager audit trail. Never edited.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `employee_id` | INTEGER FK | → hr_employees |
| `effective_date` | TEXT | |
| `change_type` | TEXT | hire / raise / promotion / demotion / role_change / transfer / termination / adjustment |
| `old_salary`, `new_salary` | REAL | |
| `old_title`, `new_title` | TEXT | |
| `old_department_id`, `new_department_id` | INTEGER FK | → hr_departments |
| `old_manager_id`, `new_manager_id` | INTEGER FK | → hr_employees |
| `reason` | TEXT | |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |

#### `hr_leave_requests`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `employee_id` | INTEGER FK | → hr_employees |
| `leave_type` | TEXT | Annual / Sick / Unpaid / Maternity / Paternity / Bereavement / Other |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `days` | INTEGER | Inclusive day count, calculated on submit |
| `reason` | TEXT | |
| `status` | TEXT | Pending / Approved / Rejected |
| `reviewed_by` | INTEGER FK | → users |
| `reviewed_at` | TEXT | |
| `review_note` | TEXT | |
| `created_at` | TEXT | |

#### `hr_employee_files`
PDFs stored as BLOBs. CV / contract are single-slot per employee.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `employee_id` | INTEGER FK | → hr_employees |
| `kind` | TEXT | cv / contract / other |
| `filename` | TEXT | |
| `content_type` | TEXT | `application/pdf` |
| `size_bytes` | INTEGER | |
| `data` | BLOB | File bytes |
| `uploaded_by` | INTEGER FK | → users |
| `created_at` | TEXT | |

#### `hr_payroll_runs`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `period_start`, `period_end` | TEXT | |
| `status` | TEXT | Draft / Approved / Paid / Cancelled |
| `notes` | TEXT | |
| `total_gross`, `total_bonuses`, `total_deductions`, `total_net` | REAL | Header roll-ups |
| `total_tax`, `total_nssf_employee`, `total_nssf_employer`, `total_overtime` | REAL | |
| `approved_by` | INTEGER FK | → users |
| `approved_at` | TEXT | |
| `paid_by` | INTEGER FK | → users |
| `paid_at` | TEXT | |
| `posted_expense_id` | INTEGER FK | → expenses (the single auto-posted Payroll expense) |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |
| `archived_at` | TEXT | |

#### `hr_payroll_lines`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `payroll_run_id` | INTEGER FK | → hr_payroll_runs |
| `employee_id` | INTEGER FK | → hr_employees |
| `base_salary`, `bonuses`, `deductions` | REAL | |
| `overtime_hours`, `overtime_amount` | REAL | |
| `gross_total`, `tax_amount`, `nssf_employee`, `nssf_employer`, `net_amount` | REAL | Computed breakdown |
| `notes` | TEXT | |
| `created_at` | TEXT | |

#### `hr_contracts`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `employee_id` | INTEGER FK | → hr_employees |
| `contract_number` | TEXT | Auto `CTR-YYYY-NNNN` |
| `contract_type` | TEXT | Permanent / Fixed-term / Probation / Internship / Consultant |
| `status` | TEXT | Draft / Active / Expired / Terminated |
| `start_date`, `end_date`, `probation_end_date` | TEXT | |
| `job_title` | TEXT | |
| `work_schedule` | TEXT | |
| `weekly_hours` | REAL | |
| `salary` | REAL | |
| `salary_currency` | TEXT | Default `USD` |
| `benefits`, `terms` | TEXT | |
| `signed_at`, `terminated_at` | TEXT | |
| `terminated_reason` | TEXT | |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |
| `archived_at` | TEXT | |

#### `hr_activities`
Personal HR touchpoints + reminders (owner-scoped).
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `owner_id` | INTEGER FK | → users (visible only to owner + superadmins) |
| `activity_type` | TEXT | Call / Meeting / Interview / Email / Note / Task |
| `subject` | TEXT | |
| `description` | TEXT | |
| `scheduled_at` | TEXT | |
| `duration_min` | INTEGER | |
| `location` | TEXT | |
| `status` | TEXT | Planned / Done / Cancelled |
| `applicant_id` | INTEGER FK | → recruitment_applicants (optional) |
| `employee_id` | INTEGER FK | → hr_employees (optional) |
| `reminder_minutes_before` | INTEGER | 0 / 5 / 15 / 30 / 60 / 120 / 1440 |
| `reminder_notif_id` | INTEGER FK | → notifications (the pending reminder) |
| `completed_at` | TEXT | |
| `completed_notes` | TEXT | |
| `updated_at` | TEXT | |
| `created_at` | TEXT | |
| `archived_at` | TEXT | |

---

### Recruitment Tables

#### `recruitment_positions`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `title` | TEXT | |
| `department_id` | INTEGER FK | → hr_departments |
| `employment_type` | TEXT | Full-time / Part-time / Contract / Intern |
| `location` | TEXT | |
| `salary_min`, `salary_max` | REAL | |
| `headcount` | INTEGER | ≥ 1 |
| `status` | TEXT | Open / On Hold / Filled / Cancelled |
| `description`, `requirements` | TEXT | |
| `posted_at`, `closed_at` | TEXT | |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |
| `archived_at` | TEXT | |

#### `recruitment_applicants`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `position_id` | INTEGER FK | → recruitment_positions |
| `full_name` | TEXT | |
| `email`, `phone` | TEXT | |
| `source` | TEXT | |
| `expected_salary`, `offered_salary` | REAL | |
| `rating` | INTEGER | 1–5 |
| `assigned_to` | INTEGER FK | → users (recruiter) |
| `notes` | TEXT | |
| `status` | TEXT | Applied / Screening / Interview / Technical Test / Accepted / Rejected / Withdrawn |
| `accepted_reason`, `rejected_reason` | TEXT | |
| `applied_at`, `last_status_change` | TEXT | |
| `converted_employee_id` | INTEGER FK | → hr_employees (set on onboarding) |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |
| `archived_at` | TEXT | |

#### `recruitment_status_history`
Append-only pipeline audit trail (one row per transition).
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `applicant_id` | INTEGER FK | → recruitment_applicants |
| `old_status`, `new_status` | TEXT | |
| `note` | TEXT | |
| `changed_by` | INTEGER FK | → users |
| `created_at` | TEXT | |

#### `recruitment_interviews`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `applicant_id` | INTEGER FK | → recruitment_applicants |
| `interview_type` | TEXT | Phone / Video / On-site / Technical / Final |
| `scheduled_at` | TEXT | |
| `duration_min` | INTEGER | |
| `location` | TEXT | |
| `interviewer_id` | INTEGER FK | → users (optional) |
| `interviewer_name` | TEXT | External interviewer label |
| `status` | TEXT | Scheduled / Completed / Cancelled / No-show |
| `score` | INTEGER | 1–10 |
| `decision` | TEXT | Hire / No hire / Maybe / Strong hire / Strong no hire |
| `notes` | TEXT | |
| `hr_activity_id` | INTEGER FK | → hr_activities (the mirrored activity) |
| `completed_at` | TEXT | |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |

#### `recruitment_applicant_files`
PDF / Word documents stored as BLOBs. CV is single-slot per applicant.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `applicant_id` | INTEGER FK | → recruitment_applicants |
| `kind` | TEXT | cv / cover_letter / portfolio / certificate / other |
| `filename` | TEXT | |
| `content_type` | TEXT | PDF or Word (.doc / .docx) |
| `size_bytes` | INTEGER | |
| `data` | BLOB | File bytes |
| `uploaded_by` | INTEGER FK | → users |
| `created_at` | TEXT | |

#### `recruitment_offers`
Lebanon-aware pre-employment offer letters. On acceptance + conversion a matching Active row is minted in `hr_contracts`.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `applicant_id` | INTEGER FK | → recruitment_applicants |
| `offer_number` | TEXT | |
| `status` | TEXT | Draft / Sent / Accepted / Declined / Expired |
| `contract_type` | TEXT | Permanent / Fixed-term / Probation / Internship / Consultant |
| `job_title` | TEXT | |
| `start_date`, `end_date`, `probation_end_date` | TEXT | |
| `work_schedule` | TEXT | |
| `weekly_hours` | REAL | Lebanese Labor Code caps the week at 48h |
| `salary` | REAL | |
| `salary_currency` | TEXT | USD / EUR / LBP / AED / SAR |
| `payment_schedule` | TEXT | Monthly / Bi-weekly / Weekly |
| `benefits`, `additional_terms` | TEXT | |
| `place_of_work` | TEXT | |
| `include_nssf`, `include_eos`, `include_confidentiality`, `include_non_compete` | INTEGER | Clause toggles (0/1) |
| `non_compete_months`, `notice_period_days`, `annual_leave_days`, `probation_months` | INTEGER | |
| `expires_at` | TEXT | Offer expiry (Sent → Expired) |
| `created_by` | INTEGER FK | → users |
| `created_at` | TEXT | |
| `archived_at` | TEXT | |

---

### Approval Tables

#### `approval_policies`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `entity_type` | TEXT | `expense` / `invoice` / `purchase` |
| `description` | TEXT | Human-readable policy name |
| `created_at` | TEXT | |

#### `approval_steps`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `policy_id` | INTEGER FK | → approval_policies |
| `step_number` | INTEGER | Sequence order (1 = first step) |
| `approver_role` | TEXT | Name of the role that must approve this step |

A compound index on `(request_id, step_number)` supports fast step lookups.

#### `approval_requests`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `policy_id` | INTEGER FK | → approval_policies |
| `entity_type` | TEXT | Mirrors the policy entity type |
| `entity_id` | INTEGER | ID of the record being approved |
| `requested_by` | INTEGER FK | → users |
| `current_step` | INTEGER | Current step number |
| `status` | TEXT | `pending` / `approved` / `rejected` |
| `created_at` | TEXT | |
| `resolved_at` | TEXT | Timestamp of the final decision |

---

### Admin / System Tables

#### `audit_log`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `user_id` | INTEGER | |
| `username` | TEXT | Username snapshot at the time of the action |
| `action` | TEXT | create / edit / delete / login / etc. |
| `module` | TEXT | |
| `record_id` | INTEGER | |
| `record_ref` | TEXT | Human-readable record reference |
| `detail` | TEXT | JSON payload or plain description |
| `created_at` | TEXT | |

#### `settings`
| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT PK | Setting name |
| `value` | TEXT | Setting value |

#### `attachments`
Generic file attachments on any business entity (see §7.27). Files are stored as BLOBs; access is gated by the host entity's RBAC module.
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `entity_type` | TEXT | invoices / purchases / projects / expenses / assets / suppliers / clients / quotations / inventory |
| `entity_id` | INTEGER | ID of the host record |
| `filename` | TEXT | Original file name |
| `content_type` | TEXT | Canonical, allow-listed MIME type |
| `size_bytes` | INTEGER | |
| `data` | BLOB | File bytes |
| `uploaded_by` | INTEGER FK | → users |
| `uploaded_by_name` | TEXT | Snapshot of uploader name |
| `created_at` | TEXT | |

#### `documents`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `record_type` | TEXT | `invoice` or `quotation` |
| `record_id` | INTEGER | |
| `client_id` | INTEGER FK | |
| `project_id` | INTEGER FK | |
| `title` | TEXT | |
| `html_content` | TEXT | Full rendered HTML of the document |
| `created_at` | TEXT | |

#### `schema_migrations`
| Column | Type | Description |
|--------|------|-------------|
| `name` | TEXT PK | Migration identifier |
| `applied_at` | TEXT | |

---

## 11. Frontend Architecture

### Routing

All routes are defined in `App.jsx` using React Router v6. Protected routes check `localStorage.user` — unauthenticated users are redirected to `/login`.

| Path | Component | Access |
|------|-----------|--------|
| `/login` | Login.jsx | Public |
| `/setup` | Setup.jsx | Public (first run only) |
| `/force-change-password` | ForceChangePassword.jsx | Authenticated |
| `/` | Dashboard.jsx | `dashboard` view |
| `/clients` | Clients.jsx | `clients` view |
| `/clients/:id` | ClientDetail.jsx | `clients` view |
| `/projects` | Projects.jsx | `projects` view |
| `/projects/:id` | ProjectDetail.jsx | `projects` view |
| `/quotations` | Quotations.jsx | `quotations` view |
| `/invoices` | Invoices.jsx | `invoices` view |
| `/inventory` | Inventory.jsx | `inventory` view |
| `/purchases` | Purchases.jsx | `purchases` view |
| `/suppliers` | Suppliers.jsx | `suppliers` view |
| `/finance` | Finance.jsx | `finance` view |
| `/expenses` | Expenses.jsx | `expenses` view |
| `/crm` | CRM.jsx | `crm` view |
| `/planning` | Planning.jsx | `planning` view |
| `/hr` | HR.jsx | `hr` view |
| `/reports` | Reports.jsx | `reports` view |
| `/archives` | Archives.jsx | Authenticated |
| `/notifications` | Notifications.jsx | Authenticated |
| `/approvals` | ApprovalRequests.jsx | `approvals` view |
| `/approval-policies` | ApprovalPolicies.jsx | Admin only |
| `/settings` | Settings.jsx | `settings` view |
| `/users` | UserManagement.jsx | Superadmin only |
| `/roles` | RoleManagement.jsx | Superadmin only |
| `/admin` | AdminDashboard.jsx | Superadmin only |

### Key Custom Hooks

| Hook | File | Purpose |
|------|------|---------|
| `usePermissions` | `hooks/usePermissions.js` | Exposes `can(module, action)`, `user`, and `isSuperadmin` |
| `useSettings` | `hooks/useSettings.jsx` | Company settings context (company name, currency, etc.) |
| `useLocale` | `hooks/useLocale.jsx` | i18n: `t(key)`, `locale`, `setLocale`, `dir` |

### Shared Components (`components/shared.jsx`)

| Component | Purpose |
|-----------|---------|
| `Badge` | Colored status pill with translated status text |
| `LoadingSpinner` | Centered loading indicator |
| `EmptyState` | Empty list placeholder with icon |
| `ConfirmModal` | Reusable confirmation dialog |
| `Pagination` | Page navigation with item count |
| `ExportButton` | Excel export trigger |

### Command Palette

Press **Ctrl+K** anywhere in the application to open the global search / command palette. It searches across clients, projects, invoices, and other records in real time via `/api/search/`.

### Design System

No CSS framework is used. All styles are defined in `index.css` using CSS custom properties (design tokens):

```css
--bg, --bg-2, --bg-3          /* Background levels */
--text, --text-2, --text-3    /* Text levels */
--primary, --primary-2        /* Brand accent colors */
--border                      /* Border color */
--sidebar-w                   /* Sidebar width */
--radius-sm, --radius         /* Border radius values */
--shadow-sm, --shadow-md      /* Box shadow levels */
```

Dark/light mode is toggled by setting `data-theme="dark"` on the `<html>` element.

---

## 12. Backup & Recovery

### Automatic Backups

`backup_manager.py` runs automatic backups on a scheduled basis. Backups are stored as `.db` files in the `backups/daily/` and `backups/weekly/` directories alongside the main database. Each backup file is accompanied by a `.sha256` checksum file for integrity verification.

### Manual Backup

From **Settings → Backup**:
- Click **Download Backup** to download the current `erp.db` as a timestamped file
- View backup history (file name, size, and date)

### Backup to USB / External Folder

A one-click **Backup to USB** action (`POST /settings/backup-export`) copies the live database to any folder reachable by the server machine — a USB drive, a network share, or any local path. It is intended for off-machine, offline disaster recovery.

For each export the system:
1. Creates the destination folder if it does not exist and verifies it is writable
2. Checks there is at least **2× the database size** of free space (room for the copy plus an in-place restore test)
3. Writes a timestamped `erp_backup_<date>_<time>.db` using SQLite's online-backup API (safe while the app is running)
4. Writes a `.sha256` checksum sidecar
5. Runs a **restore test** on the copy and reports whether it `verified` successfully

Everything happens locally — nothing leaves the machine.

### Restore

From **Settings → Backup**:
1. Click **Restore from Backup**
2. Upload a `.db` backup file
3. The system replaces the live database and restarts

> **Warning:** Restoring overwrites all current data permanently. Always download a fresh backup before restoring.

### Database Integrity Check

From **Settings → Backup**, click **Run Integrity Check** to execute SQLite's `PRAGMA integrity_check`. Returns `ok` if the database is healthy.

### Archives vs. Recycle Bin

The system provides two distinct soft-deletion mechanisms:

- **Archive** — items removed via the Archive action in any module are soft-deleted (`archived_at` timestamp set) and visible at `/archives`. Items can be unarchived at any time with no data loss.
- **Recycle Bin** — items soft-deleted via the delete action have a `deleted_at` timestamp and appear in the Recycle Bin at `/recycle-bin`. They can be restored individually or in bulk, or permanently purged. Items older than 30 days are automatically purged.

There is no permanent-delete action directly from module views; permanent deletion requires an explicit action in the Recycle Bin.

---

## 13. Localization

The system supports **English** and **Arabic** with full RTL layout.

### Switching Language

Click the **ع / EN** toggle button in the top navigation bar. The language preference is persisted in `localStorage`.

### RTL Support

When Arabic is active, `dir="rtl"` is set on `<html>` and CSS logical properties handle layout mirroring — the sidebar, flex directions, text alignment, and padding all adapt automatically.

### Values that are NOT `t('…')` keys

Most UI text is a translation key, so the toggle reaches it. Three kinds of value
are not, and each needed its own translator on `useLocale`:

| Helper | Covers | Keyed by |
|---|---|---|
| `tStatus` | statuses stored in the DB | the English value |
| `tCategory` | preset categories | the English value |
| `tAccount` | the 30 seeded chart-of-accounts rows | account **code** |
| `tRole` | the 18 seeded role names | the English name |
| `tEnumValue` | 54 fixed option lists in code — account types, employment / leave / contract types, payment methods, units, cash-movement categories, journal source types | the English value |

Anything absent from a dictionary passes through unchanged, so an account, role,
unit or category the customer created themselves stays exactly as they typed it.

`tAccount` is keyed by **code**, not name, and translates only while the stored
name still equals the seeded English (`en` is the canonical seed text). A
mismatch means the owner renamed the account, and their wording wins over ours.
A typo in `en.js` therefore does not show a wrong label — it silently disables
translation for that account.

> **A missing translation is invisible.** English is the fallback, so nothing
> errors and nothing looks broken; the value simply stays English on an
> otherwise Arabic screen. That is how the General Ledger's account picker
> shipped untranslated, and how four accounts seeded by migration 120
> (`4910 Foreign Exchange Gain`, `6910 Cash Short & Over`,
> `6920 Foreign Exchange Loss`, `1010 Cash — LBP`) were missed on the first
> pass: the chart of accounts is seeded in **two** places and only the first
> list was translated.

`backend/tests/test_locale_account_parity.py` reads the seed lists from
`database.py` **and** `pg_baseline.sql` as text — no database, no app import —
and fails when a seeded account is missing from either locale, when the English
entry drifts from the seed, or when an Arabic entry is still its English source.

### Translation Files

| File | Content |
|------|---------|
| `src/locales/en.js` | English strings |
| `src/locales/ar.js` | Arabic strings |

Both files export a flat object with dot-notation keys, for example:

```js
// en.js
export default {
  'nav.dashboard': 'Dashboard',
  'nav.clients': 'Clients',
  'common.save': 'Save',
  'status.paid': 'Paid',
  // ...
}
```

### Adding New Strings

1. Add the key/value pair to both `en.js` and `ar.js`
2. Import `useLocale` in your component: `const { t } = useLocale()`
3. Call `t('your.key')` — falls back to the key itself if a translation is missing

---

## 14. Testing & QA

The backend ships with a **pytest** suite under `backend/tests/`. It runs against FastAPI's `TestClient`, so no live server is required.

### Running the Tests

The suite needs dev-only dependencies that are not in `requirements.txt`:

```bash
pip install pytest httpx moto fakeredis pypdf

cd backend
python -m pytest tests/ -q          # ~13 minutes
```

`pypdf` is not optional in spirit: without it every PDF content assertion in
`test_pdf.py` calls `importorskip` and silently passes, producing a green run that
checked nothing about the documents.

**Current baseline: 1074 passing, 33 skipped, 1 known failure** across 81 files.
The known failure is
`test_module_provisioning.py::test_get_surfaces_overridden_constant`, verified
pre-existing by reproducing it at HEAD with the working tree stashed.

### Run it alone

Every test shares the single on-disk `backend/erp.db`. Starting a second pytest —
even one file — while another run is in progress **corrupts both**: the new run
dies with `UNIQUE constraint failed: users.username` or
`duplicate column name: void_prev_status`, and the original picks up spurious
failures, so its result has to be discarded. Check for a live run before
invoking:

```bash
ps -W | grep -c python          # expect 1
```

`-k` subsets are unreliable for the same reason — they deselect the tests that
build state others depend on, so a subset failure is usually not a regression.

### Postgres-only suites

Four files skip silently on SQLite, and they are the ones proving tenant
isolation and licensing — a green run that does not mention them has tested
neither:

```bash
TENANCY=schema DB_BACKEND=postgres DATABASE_URL=postgresql://...   python -m pytest tests/test_multitenancy.py tests/test_platform.py                    tests/test_tenant_security.py tests/test_module_licensing.py -q
```

Baseline: **27 passing**. `test_tenant_security.py` is the adversarial half —
forged `Host`, forged `X-Tenant`, both together, an attempted cross-tenant write,
tenant sessions reaching for Control Center endpoints, and schema-name injection.

### Frontend gate

```bash
cd frontend_src
npm run lint     # no-undef / jsx-no-undef / rules-of-hooks
npm test         # 73 tests: every page mounts, plus module editor, safeNav, send dialog
npm run build
```

esbuild does no scope analysis, so a missing import builds cleanly and
white-screens at runtime. Lint is the only thing that catches that class.

### Isolation Model

`conftest.py` configures the environment **before** the backend is imported (it sets `SECRET_KEY`, points `DB_PATH` at a throwaway `_test_erp.db`, and disables `COOKIE_SECURE` so cookies survive HTTP `TestClient` requests).

An autouse `fresh_db` fixture rebuilds the SQLite database from scratch before **every test** — so tests are fully order-independent, and rate-limit / session tests cannot bleed state into their neighbours.

### Coverage

| Test File | Area |
|-----------|------|
| `test_smoke_endpoints.py` | Every router responds; no import/registration regressions |
| `test_auth_session.py` | Login, logout, JWT revocation, inactivity timeout, rate limiting |
| `test_role_permission_matrix.py` | RBAC — each role can only reach its permitted modules/actions |
| `test_workflow_approvals.py` | Multi-step approval routing and side effects |
| `test_state_transitions.py` | Valid/invalid status transitions across modules |
| `test_concurrency.py` | Optimistic locking, idempotent payments, simultaneous approvals |
| `test_edge_cases.py` | Boundary inputs and error handling |
| `test_tax_system.py` | Tax rate CRUD, default-rate invariants, per-line tax computation |
| `test_tax_engine.py` | End-to-end tax regressions: cent-perfect reconciliation, mixed rates, snapshot invariance, POS refund, per-rate breakdown, PO→expense bridge, recurring rate refresh, net-of-VAT P&L |
| `test_vat_report.py` | Output vs. input VAT aggregation |
| `test_pos.py` | POS session lifecycle, checkout, refund, idempotency |
| `test_cash.py` | Cash-drawer reconciliation, variance, auto-capture |
| `test_manufacturing.py` | BOM costing, production-order lifecycle, scrap, atomicity on shortage |
| `test_exchange_rate.py` | Manual exchange-rate recording and history |
| `test_lbp_payment.py` | Secondary-currency (LBP) invoice payments and conversion |
| `test_usb_backup.py` | Backup-to-folder export, checksum, and restore verification |

Latest baseline: **431 passing, 1 skipped** across the whole suite.

---

## 15. Notifications

The system emits in-app notifications to surface time-sensitive events
without polling. They render in two places:

- The bell icon in the topbar (with an animated badge for unread count).
- The full Notifications page (`/notifications`) with filter tabs:
  All / Unread / Finance / Inventory / CRM / **Approvals** / Tasks.

**Types emitted today:**

| Type | Triggered by | Body summarises |
|------|--------------|-----------------|
| `invoice_paid` | Full-payment of an invoice | Invoice # + amount |
| `payment_received` | Any payment received | Invoice + amount + method |
| `invoice_overdue` | Periodic check | Invoice # + days overdue |
| `low_stock` | Stock dropping to/below `min_stock` (purchase, POS sale, production consumption) | Item + remaining qty + min. Dedup 24 h. |
| `purchase_received` | PO marked Received | PO# + supplier + qty + value |
| `quotation_accepted` | Quotation transitions into Accepted | Quote # + total |
| `production_completed` | Production order completed | Order # + qty produced + total cost |
| `asset_depreciated` | Bulk depreciation run posts something | Total amount + assets affected |
| `cash_variance` | Cash reconciliation closed with `\|USD\|≥$5` or `\|LBP\|≥100,000` | Day + variance values. Dedup 24 h. |
| `deal_won` / `deal_lost` | CRM deal stage transition | Title + value |
| `lead_converted` | Lead → client conversion | Lead name + new client id |
| `task_due_soon` | Periodic planning sweep | Task name + due date |
| `approval_request` | A new approval step activates | Policy + entity label. Sent to every active user holding the step's role. |
| `approval_approved` / `approval_rejected` | Request resolves | Sent to the original requester only. |
| `system` | Generic catch-all | — |

All notification types are styled with theme tokens (icon + colour) in
both `Notifications.jsx` (full page) and `NotificationBell.jsx`
(dropdown), so dark mode is supported without extra rules. The filter tabs,
type badges, and relative-time strings are localized on the client.

### Localized notification text (Arabic)

Notification `title` / `body` are generated on the backend and stored in
English, but re-render in the viewer's language:

- Each row stores a stable **`msg_key`** + JSON **`params`** alongside the
  English `title` / `body` (the canonical fallback). `notify(..., msg=, params=)`
  writes them (`backend/utils.py`).
- `GET /api/notifications/?lang=ar` calls `notif_messages.localize(row, lang)`
  ([`backend/notif_messages.py`](backend/notif_messages.py)), which renders the
  Arabic template with the row's params. Anything missing (unknown key/lang, or
  a param the template needs but the row lacks) falls back to the stored English,
  so a row can never render blank.
- The bell and page pass the current language automatically. Only notifications
  created **after** this feature shipped carry a `msg_key`; older rows keep their
  stored English. Announcement titles/bodies stay as authored (free user content).

---

## 16. Product Variants & Attributes

A single physical product (e.g. an iPhone 15) is sold in many **variants**
(128 GB Black, 256 GB Blue, …). The system models this without hard-coding any
industry's fields — the **owner defines the attributes**.

### Concepts

| Concept | Meaning |
|---------|---------|
| **Attribute def** | A named field an item can carry — e.g. `Size`, `Color`, `Storage`. Has an `input_type` and an `is_variant_axis` flag. Stored in `attribute_defs`. |
| **Variant axis** | An attribute flagged as a variant axis. The product builder fans out one SKU per combination of the selected axis values. |
| **Descriptor** | A non-axis attribute (metadata that doesn't multiply SKUs, e.g. `Material`). |
| **Scope** | `global` — attributes the owner defines for the whole shop (Settings → **Inventory Fields**). `business` — presets seeded for the chosen **Business type**. |
| **Parent product** | A `products` row grouping its variant SKUs. A simple item has `product_id = NULL`. Each variant SKU is an ordinary `inventory` row + its `item_attributes`. |

### How the owner sets it up

1. **Pick a Business type** in Settings → *Inventory & Costing* (Apparel /
   Electronics / Food & Beverage / General). Choosing one **seeds preset
   attribute defs** for that vertical (Apparel → Size / Color / Brand, etc.),
   scoped `business`. Idempotent, additive — switching type never deletes
   anything. Leaving it "General" seeds nothing.
2. Optionally add **custom attributes** in Settings → *Inventory Fields*
   (scope `global`). These always load, regardless of business type.
3. In **Inventory → New Product**, the builder loads `global` + current
   `business` attributes (de-duped by name), you tick the axis values, and it
   generates the SKU grid. An unwanted combination can be removed from the
   preview before saving.

> The relationship between the two systems is deliberate: **Business type** is a
> convenience starter-pack; **Inventory Fields** is the general mechanism. A shop
> that defines its own fields can leave Business type on "General" and lose nothing.

### Purchasing variants

Purchases are variant-aware: the **Order Variants** flow on a parent product
creates one purchase line per selected variant SKU (each PO row is still
single-item), reusing the standard create path so tax, currency-lock, approval
and stock all behave identically.

### Currency on items

Each inventory item carries its **unit cost** and **sale price** in USD *or* LBP.
Cost is locked to USD at entry (inventory is carried at historical USD cost); an
LBP **sale price** stays native and is converted at the sale-time rate by POS.
See §8.2.

---

## 17. Category Registry

Categories (for inventory items, expenses, fixed assets, project costs) are
**owner-managed**, not hard-coded. One place to edit them: Settings → **Categories**.

### Model

- Table `categories`: `(domain, name, sort_order, active, archived_at, account_code)`,
  `UNIQUE(domain, name)`. **Domains:** `inventory`, `expense`, `asset`, `project`.
- Seeded on first install with sensible starters per domain (idempotent
  `_seed_categories`), so a new business isn't empty; the owner then adds /
  renames / archives freely.
- Archiving removes a category from the pickers **without** rewriting any
  existing record — stored values are just names, and old data keeps displaying.

### Consumption

- Router `backend/routers/categories.py` — `GET` (any signed-in user, for the
  dropdowns) and admin-only `POST` / `PUT` / `PATCH …/archive`.
- Frontend hook `useCategories(domain)` (module-cached) feeds every category
  dropdown. Inventory & Purchases also merge in categories already present on
  existing records so nothing disappears from those pickers.
- **Expense → GL account.** An expense category may carry an `account_code`
  (edited in Settings → Categories for the Expense domain). The posting resolver
  `accounting.expense_account_code(category, db)` prefers that mapping, then a
  built-in default map, then falls back to **Other Expense** — so an owner-added
  category always posts and the books always balance.

Translation: preset category names are shown via `tCategory` (English stored,
Arabic looked up); owner-typed custom names show as entered.

---

## 18. Multi-Branch & Multi-Warehouse

### A filtered list is not enforcement

The two layers are independent: `users.branch_id` + `branch_access.py` decide
what a user can **see**; `user_warehouse_access` + `warehouse_access.py` decide
where they may **transact stock**. Only the vendor superadmin and `is_admin`
roles (Business Owner alone, in the seed) are global; every other role is pinned
to its home branch.

List endpoints were branch-filtered from the start. **The ids in URLs were
not.** A manager in one branch got a 404 opening another branch's invoice, and
could still act on it by putting the id in the URL, across invoices,
quotations, expenses, cash drawers and HR — only two by-id endpoints in the
whole system carried the check. A $1,000 invoice could be
rewritten to $1, a payment recorded on it, a quotation converted into an invoice
in the attacker's branch, a salary rewritten, and employment contracts
downloaded. Global search returned other branches' documents outright.

So: **every by-id endpoint calls `branch_access.assert_can_view_branch`**, which
raises **404, not 403** — a 403 confirms the record exists and lets ids be
probed. Endpoints keyed on a CHILD id (`/hr/files/{file_id}/download`) resolve
the parent and check that; that one had no check of any kind.

Two traps worth knowing:

- **RBAC can disguise the gap.** `DELETE /invoices/{id}/payments/{payment_id}`
  returned 403 cross-branch — from `require_perm("invoices","delete")`, which the
  Manager role happens to lack, not from branch scoping. A role holding delete
  crossed freely. Never read a 403 as proof of branch isolation.
- **The guard must sit AFTER the `if not row:` block.** One indent level deeper
  it lands after an unconditional `raise`, becomes unreachable, and every check
  silently passes.

`backend/tests/test_branch_isolation.py` covers it, and asserts global users are
still unrestricted — a fix that fences off the Business Owner is worse than the
bug.

### Warehouse access is opt-in, and revoking the last grant re-opens everything

A user with **zero** rows in `user_warehouse_access` can transact in **every**
warehouse. That is the migration-safe default: nobody loses access on upgrade.
Restriction begins with their first grant.

The corollary surprises people. Revoking a user's *last* grant does not leave
them with nothing — it returns them to the default, which is everything. The
Control Center asks for confirmation on that specific case rather than inverting
the default, which would lock out every existing user at once.

### Warehouses & stock transfers

Stock lives in **warehouses** (types: Main / Branch / Production / Damaged /
Transit / Returns). Inventory quantity is tracked per warehouse, and a low-stock
alert can fire either company-wide or for a specific warehouse.

**Transfers** move stock between warehouses with a lifecycle:

| Step | Effect |
|------|--------|
| Dispatch | Stock leaves the source into *Transit*; users at the destination are notified (`transfer_dispatched`). |
| Receive | Stock lands at the destination; any shortfall is recorded as loss (`transfer_received`). |
| Cancel / roll back | In-transit stock is re-credited to the source (`transfer_cancelled`). |

### Branches

A **branch is a warehouse**. When multi-branch is in use, records that carry a
`branch_id` (invoices, quotations, purchases, expenses, POS sales, cash, …) are
**scoped** so a branch-restricted user sees and reports only their own branch,
while global (admin-tier) users see everything and can consolidate. The scoping
is centralized in `backend/branch_access.py` (`branch_filter`,
`assert_can_view_branch`, `resolve_branch_id`); the **Branch Manager** role is
the built-in single-branch operator.

---

## 19. Module Licensing

The same codebase serves customers who bought different module sets. Licensing is
resolved in three layers, and only the last one is a paywall.

### Where a licence lives

| Layer | Source | Precedence |
|-------|--------|-----------|
| Per-tenant licence | `public.tenants.modules` — comma-separated **selected** keys | highest |
| Deployment default | `ENABLED_MODULES` environment variable | middle |
| Build-time constant | `backend/vendor_config.py` | lowest |

`vendor_config.enabled_modules_set()` consults them in that order.
`tenancy.tenant_modules(schema)` reads the catalog row and expands it.

### Selected vs effective

The catalog stores what the operator **picked**. The effective set is the
dependency closure of that, recomputed on read by `capabilities.resolve()`.
Storing the closure instead would freeze today's dependency graph into every
existing customer's licence, so a later change to the graph would leave old
tenants silently wrong.

`capabilities.ALWAYS_ON` — `dashboard`, `users`, `roles`, `settings`, `audit`,
`accounting` — is never paywalled. `_REQUIRES` is derived from the cross-module
table reads each module actually performs, so ticking Point of Sale forces
Invoices, Inventory, Cash and Clients on and locks them as required.

### Fail-open, and why it is visible

**An empty `modules` value means unrestricted.** That is deliberate — a dev or
demo tenant should not be locked out of its own ERP — but on a paying deployment
it means a licence that never got written silently grants every module. The
Control Center therefore shows such a business with a yellow **Unrestricted**
badge in the Modules column rather than leaving the state invisible.
`test_module_licensing.py::test_no_licence_means_every_module` pins the behaviour
so it stays a decision someone can see.

### Enforcement

`permissions.check_perm` consults the licence **before** the superadmin bypass, so
an unlicensed module's endpoints return **403** to the owner too. The sidebar
hides unlicensed entries as well, but that is cosmetic; the API check is the
paywall.

### Changing a licence at runtime

Control Center → Businesses → **Modules** opens the same dependency-aware picker
the provisioning wizard uses (`ModulePicker.jsx`, shared so the two cannot drift).
It leads with the diff — what is being enabled, what is being disabled — because
removing a module from a live business hides screens from people mid-task.
**A downgrade never deletes data**; the tables stay and re-enabling restores
access to the same records.

`PUT /api/platform/tenants/{slug}` writes it. Because it is the shared
`_apply_profile` path, keys are filtered through `capabilities.known_module()` —
so a stale or misspelled key is discarded rather than stored.

### The cache, and multi-worker staleness

`tenant_modules()` is consulted on every permission check, so it is cached per
process. Two consequences:

1. `update_tenant()` invalidates by **schema**, not slug. It once popped the slug,
   which was a no-op — a licence change appeared to save and then did nothing.
2. The cache is per-process and production runs `WEB_CONCURRENCY>1`, so popping on
   write only corrects the worker that handled it. Entries therefore expire after
   `_MODULES_TTL` (30 s), which bounds how long another worker can serve a stale
   licence.

### Keeping the catalogue and the UI in step

The picker renders only modules listed in its own presentation `GROUPS`, so a
module added to the backend but forgotten in the frontend **cannot be licensed at
all** — invisible in the editor, and (because empty means unrestricted) appearing
to work until the first real licence. `tests/test_module_catalog_ui.py` reads
`ModulePicker.jsx` and asserts every sellable module is offered, every offered key
exists, and every one has a human label.

### Hosting variants

**Desktop / self-hosted (SQLite):** set the constant in `vendor_config.py`, run
the Windows build pipeline, ship the installer. Immutable at runtime, by design.

**Cloud (multi-tenant):** one deployment, per-tenant licences in the catalog,
edited from the Control Center. No rebuild, no redeploy, no per-customer branch.

---

## 20. Document Rendering

> **This section was rewritten.** It previously stated that
> `backend/pdf_render.py` was the *only* place a document is laid out and that
> the browser template had been deleted. That was reversed: the web UI renders
> in the browser again, and the server renderer is now the secondary path.

### Where the template lives

`buildInvoiceHTML` and `buildQuotationHTML` in
`frontend_src/src/utils/exportUtils.js` are what the web UI renders. They return
a complete HTML document; `printHTML` writes it into a hidden iframe and calls
`print()`, so the operator saves a PDF through the browser's own dialog.

**The same two functions render the customer's copy.** `PublicDocument.jsx`
builds the document from them and shows it in an `<iframe srcDoc>` — an iframe
rather than inline markup so the app's stylesheet cannot reshape a financial
document and so printing uses the template's own `@page` rules.

That sharing is the whole point. The share page previously had a simplified
layout of its own: different fonts, no logo, no bank details, no line discounts.
A customer was told an invoice had been sent, opened the link, and found
something that did not look like the invoice — with no way to pay it, because
the bank details were absent.

`exportInvoicePDF` / `exportQuotationPDF` are thin wrappers that fetch settings
and the logo, build the HTML, snapshot it, then print. Keeping the builders
separate from the wrappers is what lets the share page reuse them.

### The server-side renderer is still there

`backend/pdf_render.py` (fpdf2 + embedded Amiri, contextually shaped and
bidi-reordered Arabic) remains mounted at `/api/pdf/...` for programmatic
callers such as the mobile app, which has no browser print dialog.

**The web UI does not call it.** Nothing in `frontend_src` references
`/api/pdf`. If you change the document design, change the browser template —
the server one will not follow, and the two can drift.

### Endpoints

```
GET /api/pdf/invoices/{id}.pdf     ?download=1  ?lang=ar
GET /api/pdf/quotations/{id}.pdf   ?download=1  ?lang=ar
GET /api/pdf/status
```

`inline` by default so a viewer opens it; `?download=1` switches the disposition
to `attachment`. `Cache-Control: no-store` is deliberate — an invoice can be paid,
edited or voided between two opens, and a proxy-cached PDF of a financial document
is a real problem.

The payload is obtained by **calling the existing get-one handlers**
(`routers.invoices.get_invoice`) rather than re-querying. Their `Depends(...)`
defaults are only resolved by FastAPI, so passing `db` and `user` explicitly runs
the same function bodies the API serves, and the PDF cannot disagree with the
screen. Permission is therefore enforced on the PDF route itself — calling a
handler directly bypasses its own dependency.

### Money is formatted, never calculated

The API already returns `subtotal`, `tax_total`, `total_paid` and `remaining`.
`pdf_render` prints those. A second implementation of the arithmetic that decides
what a customer owes would eventually disagree with the first; a test feeds a
payload whose total contradicts its line items and asserts the payload wins.

### What the document carries

Logo · company name, tagline, address, phone, email, website · tax and
registration numbers · bill-to block · issued / due / project / payment terms ·
per-line discount and tax columns honouring the Document Settings toggles ·
subtotal, discount (parenthesised, in amber — a minus sign in a totals column
reads as a credit), tax, **Grand Total**, paid, balance · a coloured
**payment-state band** (green *paid* / amber *overdue* / accent *due*) · payment
history · notes · bank details · secondary-currency note · configurable footer ·
a three-column document footer identifying issuer, document and date.

A quotation deliberately shows **no** balance-due or payment history — it is not a
bill, and inviting payment against one is wrong.

### Bilingual means mirrored

`?lang=ar` does not merely translate. `_D` carries the direction and every
horizontal placement asks it: the company block moves to the right, the totals to
the left, and the item columns reverse. A test extracts the x-coordinate of the
invoice number and asserts it sits on the opposite edge, so the assertion is about
layout rather than alignment.

Arabic needs contextual shaping and bidi reordering applied **before** the glyphs
reach the page, because fpdf2 draws them in the order given. `shape()` does that
via `arabic_reshaper` + `python-bidi`. The tests assert Unicode presentation forms
(U+FE70–FEFF) are **present** and unshaped base letters **absent** — unshaped
Arabic still produces a file starting with `%PDF`, so a check that only asserts
"it rendered" passes on a garbled document.

**Mixed-direction strings are the trap.** Bank details were once a single joined
line: an Arabic label with a Latin value is mixed-direction, bidi put the Latin run
first and the Arabic last, and `multi_cell` then dropped most of it — so the IBAN
and SWIFT a client needs in order to pay silently vanished from Arabic invoices
while English looked perfect. Each field is now its own label/value row, keeping
every run in one direction.

### Why pure Python

WeasyPrint would allow HTML/CSS templates but needs pango and cairo system
libraries, which cannot be installed or exercised on a plain developer machine —
and PDF code that cannot be tested locally gets shipped unverified. fpdf2 costs a
hand-written layout and buys a stack identical in dev, CI and the container, with
no Dockerfile change.

**Amiri** (OFL, `backend/assets/fonts/`) is embedded because it is the one bundled
font covering both scripts. Noto Sans Arabic was tried first and rejected when a
glyph probe showed it has **no Latin letters at all** — every English word in a
bilingual invoice would have rendered as blanks.

`pdf_render.available()` reports whether rendering can run and why not, so a caller
can degrade to the share link and say something true instead of returning a 500.
Missing dependencies produce **503 with the reason named**, not a stack trace.

### POS receipts

Receipts are a separate, deliberately different path: they print from the browser
because a till has a thermal printer attached to that machine.
`Settings → Financial → Receipt paper width` switches the layout and `@page` size
between **80 mm** and **58 mm** — a receipt laid out for one prints clipped or
half-empty on the other, a defect that only ever shows on real hardware. No web
page can bypass the browser print dialog; for a dedicated till, launch Chrome with
`--kiosk-printing` and it goes straight to the default printer. See the POS manual
page for the limits (no paper cut, drawer kick or beep without raw ESC/POS).

---

## 21. Client Communications & Share Links

Module key `communications`, requiring only `clients` — not invoices or
quotations, so a tenant licensed for one can send that one without being forced
into an upsell. It is its own RBAC surface: a role can be allowed to *see* what was
sent without being allowed to send.

### Channels

**WhatsApp** needs no configuration. The server returns a `wa.me` deep link and the
message leaves the user's own WhatsApp. The Business API was deliberately not used:
it requires Meta verification, approved templates, per-message billing and —
fatally for a multi-tenant product — a separate number and onboarding per
customer. You cannot send as ten different businesses from one number. The log
entry reads **opened**, not *sent*, because nothing here observes delivery.

**Email** goes through Resend's HTTP API over `urllib` — no new dependency, no SMTP
socket handling. Unconfigured, it fails loudly *and records the failure*: a send
that vanishes without a trace is indistinguishable from never having tried. The
Send dialog's email tab stays clickable when email is unavailable and explains what
to set; disabling it made the explanation unreachable. Per-tenant DKIM is not
implemented — mail sends from the vendor domain with the customer's name and their
address as reply-to.

### The share link

This is the only route in the application that returns business data without a
session, so it is built to be boring:

- **128-bit token**, only its SHA-256 stored — a database dump yields no working links
- **one document**, read-only, no listing, no neighbouring records
- **expiring** (`SHARE_LINK_TTL_DAYS`) and **revocable**
- **payload enumerated by hand** rather than spread from the row, so a later
  `SELECT *` cannot start leaking costs or private notes
- **every rejection is an identical 404** — distinguishing expired from revoked
  from never-existed confirms to a prober that a token was once real
- tokens live in the **tenant schema** and links are served from the tenant's own
  host, so a token is meaningless against another customer

A **new token per send**: sending again after a correction must not silently reuse
a link the client may have forwarded, and revoking one send must not break another.

### URL shape

```
/d/inv-2026-0042/Zso33zVa1v_XFZ7iUxKMUA
```

The document number is in the path because a bare random string reads exactly like
a phishing link, and an invoice nobody opens has not been delivered. The segment is
**cosmetic** — only the token is checked, and `/d/<token>` without it still
resolves, which keeps every link already sent to a client working. It discloses
nothing: anyone holding the link can read the whole document anyway.

The token is 128-bit rather than 256-bit for the same reason. 43 characters made an
untrustworthy-looking URL; 128 bits is unguessable over HTTP, the same strength
used for session identifiers, on a link that also expires and is revocable.

### What is recorded

`communications_log` holds channel, recipient, subject, status, error, the share
id, who sent it and when. `document_shares` holds the token hash, expiry,
revocation and a view count.

`GET /api/communications/history` aggregates across every document — the
Communications page (Sales → Communications). Its **never opened** counter is the
only number there that prompts an action: a failure is loud and gets fixed, while a
delivered-but-ignored invoice is silent and ages into a collections problem.

### Reporting problems

`ReportProblem.jsx` is reachable from the topbar on every page **and** from the
ErrorBoundary of a crashed one. The user is only ever asked what they were trying
to do; page, browser, error and stack are attached automatically, because a
frustrated user will not paste a stack trace and should not be asked to. Reports
land in `public.error_reports` and surface in the Control Center inbox.

---

## 22. Subscription Lifecycle

Applies to multi-tenant deployments (`TENANCY=schema`). The commercial record
for each customer lives in `public.tenants`: `plan`, `max_users`,
`trial_ends_at`, `license_expires_at`, `modules`, `status`.

Those columns existed from the start and were written at provisioning. Nothing
read them afterwards — the console could create a licence and never change it,
so taking a renewal meant editing the catalog by hand, and a lapsed licence kept
working indefinitely.

### Managing a licence

`PUT /api/platform/tenants/{slug}` accepts the profile fields; the Control
Center's **Licence** panel is the UI. A Licence column on the tenant table shows
each customer's state (green / yellow / orange / red) so "who needs chasing" is
answerable without opening every business.

Renewal buttons (+1 month / +3 months / +1 year / Perpetual) extend from
**whichever is later**, today or the date on file, so renewing early adds to the
remaining term instead of quietly shortening it.

> Dates here are calendar days and are built from local date parts, never
> `toISOString()`. That converts to UTC first, so east of UTC a renewal computed
> at local midnight lands a day early — a day of access the customer paid for.

### Expiry

`tenancy.expire_due_licences(grace_days)` runs on the metrics flush cycle. It
suspends a tenant whose **trial or licence** ended more than `LICENCE_GRACE_DAYS`
ago (default 7; `0` cuts on the day). Previously only `trial_ends_at` was swept.

Grace exists because a renewal is usually late, not absent — cutting a customer
off on the day is how you lose one over a bank transfer. Suspension uses the
existing 402 "workspace is suspended" path: the data stays, and taking payment is
flipping `status` back.

### Telling the customer

`GET /api/settings/licence-status` returns days remaining and whether grace has
started. The dates live in `public.tenants`, which a tenant's own schema cannot
read, so without this endpoint the business had no way to know — the first sign
was being locked out.

`LicenceBanner` renders above every page: nothing on a perpetual licence or
beyond 30 days, then yellow inside 30 days, orange inside 7, red in grace.
During grace it counts down what is **left**, not how long ago it lapsed.

It is shown to every user, not only admins — everyone is affected when the system
stops. It carries days remaining and the grace window only; the plan, seat count
and operator notes stay in the console.

### Licensed seats

`max_users` is enforced at login as **concurrent sign-ins**, not user accounts.
Counting accounts and refusing at the door would punish everyone for an admin
adding one person too many, and could never free itself — the people who could
fix it would be the ones locked out.

Every exemption is deliberate:

| Case | Result | Why |
|---|---|---|
| Admin or superadmin | always allowed | whoever can deactivate a user or call the vendor must be able to get in |
| User already holds a live session | allowed | login replaces their own session; a second device is the same seat |
| `max_users` blank or `0` | unlimited | a zero is an empty box, not a licence for nobody |
| Catalog lookup fails | allowed | an infrastructure hiccup must not become a lockout |
| Session idle > 30 min | seat released | idle revocation is lazy, so a closed browser would otherwise hold a seat for good |

The check runs **after** authentication, so a failed login never reveals how full
the licence is. Raising the limit takes effect immediately: the seat count shares
the licence cache and a `PUT` evicts it.

Known and accepted: two people logging in at the same instant can both clear the
check for the last seat. A one-seat overshoot that self-corrects is not worth
serialising the login path.

---

## 23. Scale & Performance

Measured on PostgreSQL, not estimated.

### Connection pooling

`database.get_db` used to open a **new** PostgreSQL connection per request and
close it. On localhost that handshake measured ~33 ms against ~0.05 ms for a
simple query, so the connection dominated the request — and in-flight requests
could outnumber the server's `max_connections`, which fails everything at once
rather than merely slowing it down.

It now uses a `psycopg_pool.ConnectionPool` per worker process. Identical load,
80 concurrent requests:

| | throughput | median latency |
|---|---|---|
| connect-per-request | 59.5 req/s | 766 ms |
| pooled (`max_size=10`) | 104.7 req/s | 387 ms |

Two details that are load-bearing:

- **`search_path` is set on every checkout**, not at connect time. Pooled
  connections are reused, so a connection last used by one tenant would
  otherwise serve the next request still pointing at the previous tenant's
  schema. This SET is the entire isolation guarantee — never make it
  conditional.
- **Server-side prepared statements are disabled** (`prepare_threshold=None`).
  psycopg auto-prepares a repeated query, and a prepared plan resolves table
  names once, against the `search_path` in force at prepare time. On a pooled
  connection later serving another tenant, that plan would still read the first
  tenant's tables — a cross-tenant leak no `SET search_path` could correct.

`backend/tests/test_connection_pool.py` pins both, driving two tenants through a
`max_size=1` pool so reuse is certain.

### The connection budget

    WEB_CONCURRENCY x DB_POOL_MAX x replicas  <  max_connections

`max_size` is per worker process. The app reads `max_connections` at boot and
warns when the demand exceeds 80% of it, because exceeding it happens under load,
which is exactly when nobody wants to be reading tuning notes.

### Server-side paging

The invoice, quotation and client lists fetched every row and filtered, sorted
and paged in the browser:

| invoices | dashboard | full list | payload | `limit=50` |
|---|---|---|---|---|
| 200 | 117 ms | 115 ms | 0.1 MB | 68 ms |
| 10,000 | 174 ms | 549 ms | 4.9 MB | 80 ms |
| 40,000 | 306 ms | 1,984 ms | 19.8 MB | 96 ms |

Paging, sorting and searching moved to the server **together** — moving one
without the others is worse than moving none, since sorting a page of fifty
sorts the wrong rows and searching a page finds only what is already on screen.
`useServerList` owns page, size, sort, direction and a debounced search.

Two things that would have broken silently:

- **Exports** fetch the whole filtered set (no `limit`) rather than the visible
  page. An export that quietly drops rows is worse than one that fails.
- **`?focus=<id>` deep links** fetch by id instead of searching the loaded array,
  which now usually does not contain the record.

### Tenants

101 tables and 270 indexes per tenant schema. The boot-time
`upgrade_all_tenant_schemas()` costs ~52 ms per tenant, so 200 tenants adds ~10 s
to startup — well inside the 300 s healthcheck. Schema-per-tenant is comfortable
into the low hundreds; past that `pg_dump` and autovacuum become the constraint,
not the app.

### What is deliberately NOT cached

There is no Redis. The bottleneck was connection setup, not query execution, and
Redis does not touch that. A cache key that forgets the tenant is also the same
class of bug as a missing per-record scope check. It earns its place when several
replicas need shared state — rate limiting, a job queue — not for read-caching
financial data.

---
