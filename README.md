# ERP System

A full-stack business management platform for small-to-medium enterprises.
Centralises sales, point-of-sale, accounting, finance, inventory, multi-
warehouse stock, manufacturing, fixed assets, project management, HR, payroll,
recruitment and CRM into a single self-hosted application.

> **Version 2.2** · Python + FastAPI · React 18 · SQLite · Dual-currency (USD/LBP)

---

## Features

| Module | Capabilities |
|--------|-------------|
| **Sales & CRM** | Leads → quotations → invoices → payments; deal pipeline, contacts, activity log |
| **POS** | Cash-drawer sessions, USD/LBP checkout, refunds that void invoices and restock |
| **Inventory** | Raw / semi-finished / finished / consumable items, FIFO / LIFO / weighted-average costing, lot tracking with FEFO, weighted-average landed cost, low-stock alerts |
| **Multi-warehouse** | Multiple locations with row-level access (a clerk authorised for "BRANCH-A" never sees MAIN stock), `Draft → In Transit → Completed / Cancelled` transfer workflow gated on both endpoints, per-warehouse valuation report |
| **Procurement** | Suppliers, PO lifecycle (`Ordered → Received → Paid`) that auto-posts expenses and adjusts inventory cost |
| **Manufacturing** | Versioned BOMs with scrap %, multi-level sub-assemblies, production-order lifecycle (`Draft → Confirmed → In Progress → Completed`), QC pass/fail, resource costing, weighted-average production costing |
| **Accounting (GL)** | Double-entry general ledger: Chart of Accounts with 30 seeded accounts, journal entries (manual + auto-posted), reversals, Trial Balance, Income Statement, Balance Sheet, period locks, year-end closing to Retained Earnings |
| **Finance** | Cash-basis P&L dashboards, expense tracking, recurring expense templates, period locking with snapshots, Smart Insights v2 (cross-module: period locks, FX freshness, recurring run-rate, cash variance, A/R aging, fiscal-year close) |
| **Fixed Assets** | Capital register, straight-line depreciation auto-posted as expenses + GL entries, disposal with gain/loss, capex approval workflow |
| **Cash** | Daily till reconciliation with auto-captured sales + expenses, USD/LBP variance reporting, GL posting of variance to `6910 Cash Short & Over` |
| **Taxation** | Admin-managed named tax rates (standard / reduced / zero / exempt); per-line tax snapshot so rate changes don't retroactively alter old documents; VAT report with per-rate breakdown |
| **Multi-currency** | Dual-currency (USD base + LBP secondary by default) with manual exchange-rate history, currency-aware GL routing (1000 Cash vs 1010 Cash–LBP), FX gain/loss posting (4910 / 6920) |
| **Projects & Planning** | Project lifecycle, budget-vs-actual, Gantt-style planning board, milestones, calendar events with attendee notifications |
| **HR & Payroll** | Departments, employees, employment history timeline, leave requests (with auto-status flip while on leave), monthly payroll runs (`Draft → Approved → Paid`) with tax + NSSF + overtime breakdown, currency-aware payroll posting |
| **HR Contracts** | First-class employment contract records with type / probation / salary / benefits / terms, PDF rendering, expiration alerts |
| **HR Activities** | Per-employee personal calendar with reminders that surface in the notification bell |
| **Recruitment** | Positions → applicants → interviews → offers; status timeline, hired-applicant promotion to employee |
| **Reports & Analytics** | Financial, VAT (per-rate base + tax), invoice aging, project profitability, sales pipeline, inventory by warehouse, Excel export |
| **Approvals** | Rule-based multi-step approval chains for expenses, invoices, purchases, projects and fixed-asset purchases |
| **Announcements** | Internal top-down communications with audience targeting (all / role / department / individuals) + acknowledgements |
| **Notifications** | 30+ typed alerts (overdue invoices, low stock, leave requests, payroll, transfers, FX stale, period unlocked, contract expiring, approvals…) — gated by module permission |
| **Global Search** | Cross-module command palette (Ctrl+K) over 45+ entity types, grouped by category, with match highlighting and recent-records list |
| **Client Communications** | Send invoices and quotations by email or WhatsApp; every send mints an expiring, revocable capability link to a client-facing document page, with view tracking and a cross-document history of what went out, to whom, and whether it was opened |
| **Documents (PDF)** | One server-rendered template for invoices and quotations — bilingual English / Arabic with a genuinely mirrored RTL layout, logo, tax and registration numbers, per-line discount and tax columns, payment history, bank details, and a payment-state band. No browser required, so the mobile app, an email attachment and a client link all get the same document |
| **Access Control** | RBAC across 25 permissioned modules (plus 4 admin surfaces) with 18 seeded roles, JWT sessions with revocation, append-only audit log, recycle bin |
| **Localization** | Full English and Arabic (RTL) across every module — including payroll, contracts, accounting filters, reports, and the command palette |
| **Module licensing** | Per-tenant licences held in the shared catalog and editable at runtime from the Control Center, with automatic dependency resolution; enforced in the API before the superadmin bypass, so an unlicensed module returns 403 rather than merely hiding. The desktop build can still bake a fixed set in at build time |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11+, FastAPI, Uvicorn |
| Database | PostgreSQL (cloud / multi-tenant) or SQLite in WAL mode (desktop / self-hosted) |
| Frontend | React 18, Vite, React Router v6 |
| Auth | JWT (HS256) via HttpOnly cookies, PBKDF2-SHA256 passwords |
| Documents | fpdf2 + arabic-reshaper + python-bidi, Amiri embedded (pure Python — no system libraries) |
| Packaging | PyInstaller (Windows .exe), Inno Setup 6 |
| Documentation | MkDocs Material (53 pages with Operator / Administrator / Auditor tabs) |

---

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 18+

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/alikoteich/erp-system.git
cd erp-system
```

```bash
# 2. Install backend dependencies
#    -c constraints.txt pins the whole transitive tree, so two installs of the
#    same commit get the same versions. requirements.txt keeps the >= security
#    floors and the reasoning behind them.
cd backend
pip install -r requirements.txt -c constraints.txt
cd ..
```

```bash
# 3. Configure environment
cp backend/env.example backend/.env
# Edit backend/.env and set your SECRET_KEY:
# python -c "import secrets; print(secrets.token_hex(32))"
```

```bash
# 4. Build the frontend
cd frontend_src
npm install
npm run build
cd ..
```

```bash
# 5. Start the server (run from the project root, not the backend folder)
python launcher.py
```

The app will be available at **http://localhost:8765**.

### First-Run Setup

On first launch you'll be redirected to `/setup` to configure:

- Company details (name, address, tax number, bank info)
- Default currency, tax rate, payment terms
- Invoice and quotation number prefixes
- Admin account credentials

---

## Development

Run the backend and Vite dev server separately for hot reload:

```bash
# Terminal 1 — backend (run from the project root)
python launcher.py

# Terminal 2 — frontend (hot reload on http://localhost:5173)
cd frontend_src
npm run dev
```

The Vite dev server proxies API requests to the backend automatically.

### Seeding Sample Data

A single, comprehensive script fills every module with realistic, varied
data — clients, invoices in every payment state, manufacturing orders across
the lifecycle, depreciated assets, cash reconciliations, journal entries,
warehouses with seeded stock, CRM leads, HR records, payroll runs, contracts,
applicants, approval policies, and more:

```bash
cd backend
python seed.py            # seeds against $DB_PATH (or ../erp.db)
python seed.py --reset    # WIPES that DB file first, then seeds
```

After seeding, log in with **`admin` / `Admin123!`**.

### Running Tests

Backend:

```bash
cd backend
python -m pytest -q       # ~13 min. 1074 passing across 81 files: auth, RBAC,
                          # tax, POS, multi-currency (F-1..F-9), period locking,
                          # fiscal-year close, multi-warehouse, payroll,
                          # contracts, recruitment, approvals, VAT, PDF
                          # rendering, communications, module licensing …
```

**Run it alone.** Every test shares the single on-disk `backend/erp.db`, so a
second pytest — even one file — corrupts both runs and produces failures that
look like regressions but are not. `-k` subsets are unreliable for the same
reason: they deselect the tests that build state others depend on.

Tests that need PostgreSQL skip silently on SQLite. They are the ones proving
tenant isolation and module licensing, so a green run that does not mention them
has not tested either:

```bash
TENANCY=schema DB_BACKEND=postgres DATABASE_URL=postgresql://...   python -m pytest tests/test_multitenancy.py tests/test_platform.py                    tests/test_tenant_security.py tests/test_module_licensing.py -q
```


Frontend — run all three before committing:

```bash
cd frontend_src
npm run lint     # no-undef / jsx-no-undef: catches references the bundler
                 # resolves but that crash at runtime (the "white screen" class)
npm test         # mounts every page against an empty mocked API and asserts
                 # none of them throw
npm run build
```

---

## Control Center

The vendor's operations console, at `/platform` on a cloud deployment. Separate
identity from every customer: its own table, its own cookie, its own guard.

Provisioning (company details, subdomain, plan, modules, language, currency,
licence), fleet health scored per customer with the reasons behind the score,
a support inbox fed by the ERP's own **Report problem** action, per-business
analytics, password administration and factory reset.

See [docs/DEPLOYMENT-RAILWAY.md](docs/DEPLOYMENT-RAILWAY.md) for the deployment
and first-operator steps.

---

## Documents & client delivery

**One template.** Invoices and quotations are rendered by
`backend/pdf_render.py` and served from `/api/pdf/...`. There is deliberately no
second template: a browser-printed document cannot be attached to an email,
opened by the mobile app, or shown on a client's link, and maintaining two meant
the copy a customer received could drift from the one their supplier saw.

**Bilingual, and mirrored.** `?lang=ar` does not merely translate — the company
block moves to the right, the totals to the left, and the item columns reverse.
Arabic is contextually shaped and bidi-reordered before it reaches the page,
because fpdf2 draws glyphs in the order given. Amiri is embedded (OFL, in
`backend/assets/fonts/`) because it is the one bundled font covering both Arabic
and Latin — an Arabic-only font renders every English word as blanks.

The stack is pure Python on purpose. WeasyPrint would allow HTML/CSS templates
but needs pango and cairo system libraries, which cannot be installed or tested
on a plain developer machine — and PDF code that cannot be tested locally gets
shipped unverified.

**Sending.** `Send` on an invoice or quotation row offers email and WhatsApp, and
the ⋯ menu carries one-click variants plus both PDF languages. Every send mints a
fresh capability link:

- 128-bit token, only its SHA-256 stored, so a database dump yields no working links
- one document, read-only, expiring (`SHARE_LINK_TTL_DAYS`) and revocable
- served from the tenant's own host, so a token is meaningless against another customer
- every rejection is an identical 404 — distinguishing expired from revoked from
  never-existed confirms to a prober that a token was once real

WhatsApp needs no configuration: the server returns a `wa.me` deep link and the
message leaves the user's own WhatsApp. Its log entry reads *opened*, not *sent*,
because nothing here observes delivery. Email needs `RESEND_API_KEY` and
`MAIL_FROM`; without them the channel says so in the UI rather than failing at
the moment of sending.

The **Communications** page (Sales → Communications, licensed under
`communications`) shows everything sent across every document, with a
*never opened* counter — the only number on the page that prompts an action.

---

## Module licensing

Which modules a customer gets is resolved in three layers, most specific first.

**1. Per tenant (cloud).** On a multi-tenant deployment the licence belongs to
the customer, stored in `public.tenants.modules` and managed from the Control
Center. One deployment therefore serves many customers with different module
sets.

**2. Environment (per instance).** `ENABLED_MODULES` overrides the build-time
constant, so a single image can be deployed several times with different module
sets without rebuilding.

**3. Build-time constant** — `backend/vendor_config.py`, used by desktop and
self-hosted installs:

```python
ENABLED_MODULES = "sales,clients,quotations,invoices,inventory,warehouses"
```

An empty value means "every module visible" (dev and demo default).

Whatever the source, the selected set is expanded to its **dependency closure**
by `backend/capabilities.py` before it is stored or enforced: buying `pos`
automatically grants `invoices`, `inventory`, `cash` and `clients`, because POS
writes an invoice, moves stock and settles into a drawer. Invalid combinations
are therefore unrepresentable rather than merely discouraged.

Enforcement is server-side in `permissions.check_perm`, ahead of the superadmin
bypass, so a disabled module's API cannot be reached by guessing the URL.

> **Note on the desktop build.** Only layer 3 is immutable at runtime. In a
> cloud deployment the module set is data and configuration — an operator with
> Control Center access or the ability to set environment variables can change
> it. Do not rely on it as a security boundary against your own infrastructure;
> it is a licensing control, and RBAC remains the per-user boundary.

---

## User Manual

A 54-page MkDocs Material site lives under `docs/manual/` with separate
tabs for each audience (Operator / Administrator / Auditor) on every module
page. Build and preview locally:

```bash
cd docs/manual
pip install mkdocs-material
mkdocs serve              # http://localhost:8000
mkdocs build              # static HTML in ../../static-manual/
```

Coverage spans Architecture, Foundation (auth, RBAC, warehouse access, audit
trail, backups), Sales, Operations, Finance (including period-close and
multi-currency), People (HR / payroll / contracts / recruitment / planning /
approvals / announcements / notifications), and a Reference section with
the full Chart of Accounts, permissions matrix and API surface.

---

## Environment Variables

Copy `backend/env.example` to `backend/.env` and fill in your values. Never
commit the real `.env` file.

```env
# Required
SECRET_KEY=your_secret_key_here        # python -c "import secrets; print(secrets.token_hex(32))"

# Auth
TOKEN_EXPIRE_HOURS=24                  # JWT lifetime in hours (default: 24)
COOKIE_SECURE=false                    # Set to true in production (HTTPS only)

# CORS
ALLOWED_ORIGINS=http://localhost:5173  # Comma-separated list of allowed frontend origins

# Server
PORT=8765                              # Auto-increments if port is already in use
BIND_HOST=0.0.0.0                      # Use 127.0.0.1 to restrict to localhost only

# Database
DB_PATH=erp.db                         # SQLite file (desktop / self-hosted)
DB_BACKEND=sqlite                      # or 'postgres' for a cloud deployment
DATABASE_URL=                          # postgres DSN; required when DB_BACKEND=postgres

# Cloud / multi-tenant (see docs/DEPLOYMENT-RAILWAY.md)
TENANCY=single                         # 'schema' = one isolated schema per customer
ENABLED_MODULES=                       # empty = all; overrides the build-time constant
STORAGE=db                             # 's3' stores documents in S3/R2 instead of the DB
S3_BUCKET=                             # required when STORAGE=s3
S3_ENDPOINT_URL=                       # set for Cloudflare R2 / MinIO; omit for AWS
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
LOG_FORMAT=text                        # 'json' for structured logs
TENANT_BASE_DOMAIN=                    # e.g. quilit.dev — makes an unknown
                                       # subdomain return a branded 404 instead
                                       # of serving an ERP nobody can log into.
                                       # Only matters with wildcard DNS; unset
                                       # leaves the guard inert.
API_DOCS=                              # 'on' re-enables /docs and /openapi.json,
                                       # which are OFF automatically whenever
                                       # TENANCY is a multi-tenant mode

# Client communications (email). WhatsApp needs no configuration — the server
# returns a wa.me deep link and the message leaves the user's own WhatsApp.
RESEND_API_KEY=                        # unset = the email channel reports itself
                                       # unavailable and explains why in the UI
MAIL_FROM=invoices@yourdomain.com      # must be a domain verified in Resend
MAIL_FROM_NAME=Your Company
SHARE_LINK_TTL_DAYS=30                 # 0 = share links never expire
```

---

## Project Structure

```
erp-system/
├── backend/
│   ├── main.py                # FastAPI app and router registration
│   ├── database.py            # SQLite schema, numbered migrations (120+)
│   ├── auth_utils.py          # JWT + PBKDF2 password hashing
│   ├── permissions.py         # RBAC middleware (25 modules + 4 admin)
│   ├── warehouse_access.py    # Row-level warehouse access helpers
│   ├── accounting.py          # Double-entry posting engine, GL reports
│   ├── costing.py             # FIFO / LIFO / weighted-average inventory costing
│   ├── lots.py                # Lot tracking + FEFO consumption
│   ├── approval_engine.py     # Multi-step approval workflow
│   ├── backup_manager.py      # Daily/weekly backups + USB export
│   ├── utils.py               # Tax math (Decimal-based), notify(), helpers
│   ├── vendor_config.py       # Enabled-modules resolution (tenant → env → constant)
│   ├── capabilities.py        # Module dependency graph + licence closure
│   ├── tenancy.py             # Schema-per-tenant catalog, provisioning, licences
│   ├── communications.py      # Share tokens, email delivery, WhatsApp text
│   ├── pdf_render.py          # THE invoice/quotation template (bilingual, RTL)
│   ├── assets/fonts/          # Amiri Regular + Bold (OFL) embedded in every PDF
│   ├── routers/               # One file per module (44 routers)
│   │   ├── auth.py            clients.py     projects.py
│   │   ├── quotations.py      invoices.py    inventory.py
│   │   ├── warehouses.py      purchases.py   suppliers.py
│   │   ├── pos.py             cash.py        manufacturing.py
│   │   ├── assets.py          recurring.py   tax_rates.py
│   │   ├── accounting.py      finance.py     reports.py
│   │   ├── crm.py             planning.py    hr.py
│   │   ├── hr_contracts.py    hr_activities.py  recruitment.py
│   │   ├── dashboard.py       search.py      notifications.py
│   │   ├── approval_policies.py  approval_requests.py
│   │   ├── announcements.py   settings.py    documents.py
│   │   ├── attachments.py     audit.py       categories.py
│   │   ├── platform.py        support.py
│   │   ├── imports.py         support.py     communications.py
│   │   ├── pdf.py             products.py    promotions.py
│   │   └── users.py           roles.py
│   ├── tests/                 # Pytest suite — 1074 passing across 81 files:
│   │                          # multi-currency audit (F-1..F-9), period
│   │                          # locking, fiscal-year close, multi-warehouse,
│   │                          # tenant isolation, module licensing, PDF
│   │                          # rendering, communications. Run it ALONE.
│   ├── seed.py                # Single comprehensive sample-data seeder
│   ├── env.example
│   ├── requirements.txt       # >= floors with security rationale in comments
│   ├── requirements-cloud.txt # psycopg / boto3 / gunicorn — cloud only
│   └── constraints.txt        # lockfile: all 44 transitive pins, audited
├── frontend_src/
│   ├── src/
│   │   ├── pages/             # Page per route; large pages are folders
│   │   │                      # of sections (pages/accounting/, crm/ …)
│   │   ├── components/        # Sidebar, NotificationBell, CommandPalette, shared
│   │   ├── hooks/             # useSettings, usePermissions, useLocale, useWarehouses
│   │   ├── api/client.js      # All HTTP calls
│   │   ├── locales/           # en.js and ar.js — 3726 keys each, exact parity
│   │   ├── test/              # Vitest: page smoke suite + targeted units
│   │   └── index.css          # Design tokens + base component classes
│   ├── public/                # PWA manifest + icons (installable on mobile)
│   └── vite.config.js
├── docs/manual/               # MkDocs Material user manual (53 pages,
│                              # three-audience tabs per module)
├── backups/                   # Daily/weekly DB backups (gitignored)
├── installer/                 # Inno Setup files
├── launcher.py                # Entry point — run this from the project root
├── build.ps1                  # Windows build pipeline (frontend + exe + installer)
├── ERP.spec                   # PyInstaller spec
└── DOCUMENTATION.md           # Full technical documentation
```

---

## API

The backend exposes a REST API under `/api/*`. Interactive docs:

- Swagger UI: `http://localhost:8765/docs`
- ReDoc: `http://localhost:8765/redoc`

Both are **disabled automatically** on a multi-tenant deployment (`TENANCY=schema`)
— they publish the whole API surface to anyone who asks. Set `API_DOCS=on` to get
them back for debugging a cloud instance.

Key endpoint groups:

```
/api/auth                   /api/users                 /api/roles
/api/clients                /api/projects              /api/planning
/api/quotations             /api/invoices              /api/pos
/api/suppliers              /api/purchases             /api/inventory
/api/warehouses             /api/manufacturing         /api/assets
/api/cash                   /api/expenses              /api/recurring-expenses
/api/finance                /api/accounting            /api/tax-rates
/api/crm                    /api/reports               /api/search
/api/hr                     /api/hr-contracts          /api/hr-activities
/api/recruitment            /api/approval-policies     /api/approval-requests
/api/notifications          /api/announcements         /api/documents
/api/attachments            /api/audit                 /api/archives
/api/settings               /api/dashboard             /api/imports
/api/communications         /api/pdf                   /api/support
/api/platform               /api/products              /api/categories
```

Two of those are worth calling out:

```
GET  /api/pdf/invoices/{id}.pdf?download=1&lang=ar   # server-rendered document
GET  /api/pdf/quotations/{id}.pdf                    # inline unless ?download=1
GET  /api/pdf/status                                 # is rendering available?

POST /api/communications/send                        # email, or a wa.me deep link
GET  /api/communications/history                     # everything ever sent
GET  /api/communications/public/{token}              # the CLIENT's view — the
                                                     # only unauthenticated route
                                                     # returning business data
```

---

## Building for Windows

Requires Node.js, PyInstaller and Inno Setup 6 (Windows only). The `build.ps1`
script runs the full pipeline — frontend build, executable bundling and
installer compilation:

```powershell
.\build.ps1
```

The compiled installer is written to `installer/Output/`. To build only the
standalone executable, run `python -m PyInstaller ERP.spec`.

The installer bundles the current `erp.db` as the default database so a fresh
install ships seeded with whatever state was on the build machine. Customer
data lives under `%APPDATA%\ERP System\` on first launch.

---

## Backups

The system automatically creates daily and weekly SQLite backups in `backups/`.
Each backup includes a `.sha256` checksum file for integrity verification. You
can also trigger a manual backup, export to a USB drive, or restore from the
Settings page in the app.

---

## License

Private — all rights reserved.
