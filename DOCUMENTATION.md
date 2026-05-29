# ERP System — Technical Documentation

> **Version:** 2.1 &nbsp;|&nbsp; **Last Updated:** 2026-05-20 &nbsp;|&nbsp; **Stack:** Python · FastAPI · React 18 · SQLite

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
8. [Taxation & Multi-Currency](#8-taxation--multi-currency)
9. [API Reference](#9-api-reference)
10. [Database Schema](#10-database-schema)
11. [Frontend Architecture](#11-frontend-architecture)
12. [Backup & Recovery](#12-backup--recovery)
13. [Localization](#13-localization)
14. [Testing & QA](#14-testing--qa)
15. [Notifications](#15-notifications)

---

## 1. System Overview

This ERP (Enterprise Resource Planning) system is a full-stack business management platform designed for small-to-medium enterprises. It centralizes operations across sales, finance, inventory, project management, human resources, and customer relations into a single self-hosted application.

### Key Capabilities

| Area | Capabilities |
|------|-------------|
| **Sales** | Quotations → invoices → payments, partial / multi-currency payment tracking, aging reports, WhatsApp share |
| **POS** | Cash-drawer sessions, USD/LBP checkout, refunds that void invoices + restock, inventory autocomplete on custom lines |
| **Manufacturing** | Versioned BOMs with scrap %, multi-level sub-assemblies, production-order lifecycle, weighted-average production costing |
| **Inventory** | Raw / semi-finished / finished / consumable items, weighted-average landed cost, low-stock alerts, stock movements |
| **Procurement** | Suppliers, PO lifecycle (Ordered → Received → Paid) that auto-posts expense + adjusts landed cost |
| **Finance** | Revenue / expense tracking, accrual + cash views, period locking, smart insights, recurring expense templates |
| **Fixed Assets** | Capital register, straight-line depreciation auto-posted as expenses, disposal, capex approval workflow |
| **Cash** | Daily till reconciliation with auto-captured sales + expenses, USD/LBP variance reporting |
| **Taxation** | Admin-managed named tax rates (multiple standard / reduced / zero / exempt), per-line tax snapshot, VAT report with per-rate breakdown |
| **Multi-Currency** | Dual-currency (USD base + LBP secondary by default) with manual exchange-rate history |
| **Projects** | Project lifecycle, budget-vs-actual, milestone planning, Gantt-style planning board |
| **CRM** | Leads → deals → conversion to clients, contact directory, activity log |
| **HR** | Employee directory, departments, leave requests (auto-status flip while on leave) |
| **Approvals** | Rule-based multi-step approval chains; expenses, invoices, purchases, projects, fixed-asset purchases |
| **Access Control** | RBAC across 19+ modules, JWT sessions with revocation, audit trail, recycle bin |
| **Localization** | Full English and Arabic (RTL) |
| **Resilience** | Automatic + manual backups, one-click backup to USB / network folder |
| **Per-customer builds** | Module visibility baked in via `backend/vendor_config.py` (immutable at runtime). The vendor edits the constant before building each customer's installer |

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
│   ├── tests/                  # Pytest QA suite (see §14) — 431 tests
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
| Reports | `reports` | |
| CRM | `crm` | |
| Planning | `planning` | |
| HR | `hr` | |
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
   (comma-separated module keys) baked into each customer's build. Empty
   string means every module is visible (the dev + demo default). When
   set, only modules in the whitelist appear in the sidebar. The value is
   immutable at runtime — even a vendor superadmin cannot change it via
   the API; the source must be edited and the installer rebuilt. This
   closes the "delete `erp.db` + relaunch to get a fresh superadmin"
   attack against module gating.
2. **RBAC `view` permission** — the per-user check. The sidebar reflects
   the logged-in user's permissions in real time.

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

**Period Locking:**

Accounting periods (year + month) can be **locked** to prevent editing historical financial data. Once a period is locked:
- Payments dated in that period cannot be added or deleted
- Expenses dated in that period cannot be edited or voided
- A lock badge is displayed on the period in the monthly table

Periods can be unlocked by an admin when a correction is required. All lock and unlock actions are recorded in the audit trail.

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

**URL:** `/hr`

Employee directory, organizational structure, and leave management.

> **Scope note:** Payroll is intentionally out of scope. The HR module focuses on the employee lifecycle and time-off tracking.

#### Departments

Organizational units that employees belong to.

**Fields:** Name, description.

**Features:**
- List and manage all departments
- Archive/unarchive departments

#### Employees

The core staff directory with full lifecycle tracking.

**Fields:** Full name, job title, department, employment type, status, hire date, end date, email, phone, salary, manager (self-referential FK), linked user account, address, notes.

**Employment Types:** Full-time, Part-time, Contract, Intern.

**Statuses:** Active, On Leave, Terminated.

**Features:**
- Filter by department, status, and employment type
- Link an employee record to a user account
- Hierarchical manager relationships
- Archive / unarchive employees (soft-delete)

#### Leave Requests

Time-off tracking with a simple approval flow.

**Fields:** Employee, leave type, start date, end date, reason.

**Leave Types:** Annual, Sick, Unpaid, Maternity, Paternity, Bereavement, Other.

**Statuses:** Pending → Approved | Rejected.

**Features:**
- Managers or admins approve or reject leave requests
- Calculated leave duration (working days)
- Full leave history per employee

#### HR Summary

Dashboard-style KPIs: total headcount, breakdown by employment type and status, and pending leave requests.

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

**Tabs:**
- **Company** — Name, tagline, address, contact info, tax/reg numbers, logo upload (PNG/JPG/GIF/WebP, max 2 MB)
- **Finance** — Base & secondary currency, payment terms, invoice/quotation number prefixes; the **Tax Rates** table (§7.21) and the **exchange-rate** entry + history
- **Documents** — Footer text, show/hide discount and tax columns on documents
- **Bank** — Bank name, account number, IBAN, SWIFT code
- **Backup** — Manual backup download, backup history list, backup-to-USB/folder export, restore from file, database integrity check

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

**Production-order lifecycle.**
`Draft → Confirmed → In Progress → Completed` (or `Cancelled`).

| Transition | Side effects |
|------------|--------------|
| **Confirm** | Snapshots the BOM components (scaled by quantity + scrap) onto the order. Reserves raw materials on `inventory.reserved_quantity`. |
| **Start** | No accounting impact — pure status change so the floor knows the order is in flight. |
| **Complete** | Releases the reservation, consumes the **actual** quantities recorded by the operator (variance vs plan is captured per line), raises finished-goods stock at the frozen unit cost, posts `stock_movements`. All in one transaction — atomicity is preserved on shortage. |
| **Cancel** | Releases any reservation; no stock or cost impact. |

**Costing.** Weighted-average. Material is valued at the moving-average
`inventory.unit_cost` at the moment of consumption — net of recoverable
VAT — so manufacturing cost stays consistent with POS COGS and inventory
valuation. The finished good's `unit_cost` is updated weighted-average on
each completion. Producing goods posts **no expense** — it transforms
raw-material inventory value into finished-goods value.

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
| GET | `/hr/leave` | List leave requests |
| POST | `/hr/leave` | Submit a leave request |
| PUT | `/hr/leave/{leave_id}` | Update a leave request |
| POST | `/hr/leave/{leave_id}/approve` | Approve a leave request |
| POST | `/hr/leave/{leave_id}/reject` | Reject a leave request |
| DELETE | `/hr/leave/{leave_id}` | Delete a leave request |
| GET | `/hr/summary` | HR headcount and leave KPIs |

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

#### `departments`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT UNIQUE | |
| `description` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `employees`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `full_name` | TEXT | |
| `job_title` | TEXT | |
| `department_id` | INTEGER FK | → departments |
| `employment_type` | TEXT | Full-time / Part-time / Contract / Intern |
| `status` | TEXT | Active / On Leave / Terminated |
| `hire_date` | TEXT | |
| `end_date` | TEXT | |
| `email` | TEXT | |
| `phone` | TEXT | |
| `salary` | REAL | |
| `manager_id` | INTEGER FK | → employees (self-referential) |
| `user_id` | INTEGER FK | → users (optional link to a user account) |
| `address` | TEXT | |
| `notes` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `leave_requests`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `employee_id` | INTEGER FK | → employees |
| `leave_type` | TEXT | Annual / Sick / Unpaid / Maternity / Paternity / Bereavement / Other |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `days` | INTEGER | Calculated leave duration |
| `reason` | TEXT | |
| `status` | TEXT | Pending / Approved / Rejected |
| `reviewed_by` | INTEGER FK | → users |
| `review_note` | TEXT | |
| `created_at` | TEXT | |

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

The suite needs two dev-only dependencies that are not in `requirements.txt`:

```bash
pip install pytest httpx

cd backend
python -m pytest tests/ -v
```

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
(dropdown), so dark mode is supported without extra rules.

---

*End of Documentation*
