# ERP System — Full Documentation

> Version: 2.0 | Last Updated: 2026-05-16

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Installation & Setup](#3-installation--setup)
4. [Configuration Reference](#4-configuration-reference)
5. [Authentication & Security](#5-authentication--security)
6. [User Management & RBAC](#6-user-management--rbac)
7. [Modules](#7-modules)
   - 7.1 [Dashboard](#71-dashboard)
   - 7.2 [Clients](#72-clients)
   - 7.3 [Projects](#73-projects)
   - 7.4 [Quotations](#74-quotations)
   - 7.5 [Invoices](#75-invoices)
   - 7.6 [Inventory](#76-inventory)
   - 7.7 [Purchases](#77-purchases)
   - 7.8 [Suppliers](#78-suppliers)
   - 7.9 [Finance](#79-finance)
   - 7.10 [Expenses](#710-expenses)
   - 7.11 [CRM](#711-crm)
   - 7.12 [Planning](#712-planning)
   - 7.13 [Reports](#713-reports)
   - 7.14 [Archives](#714-archives)
   - 7.15 [Audit Log](#715-audit-log)
   - 7.16 [Settings](#716-settings)
   - 7.17 [Approval Policies](#717-approval-policies)
   - 7.18 [Approval Requests](#718-approval-requests)
8. [API Reference](#8-api-reference)
9. [Database Schema](#9-database-schema)
10. [Frontend Architecture](#10-frontend-architecture)
11. [Backup & Recovery](#11-backup--recovery)
12. [Localization](#12-localization)

---

## 1. System Overview

This ERP (Enterprise Resource Planning) system is a full-stack business management platform designed for small-to-medium enterprises. It centralizes operations across sales, finance, inventory, project management, and customer relations into a single application.

### Key Capabilities

| Area | Capabilities |
|------|-------------|
| **Sales** | Quotations, invoices, payment tracking, aging reports |
| **Finance** | Revenue/expense tracking, period locking, reconciliation, financial reports |
| **Projects** | Project lifecycle, cost tracking, milestone planning, Gantt charts |
| **CRM** | Lead management, deal pipeline, contact tracking, activity logging |
| **Inventory** | Stock management, min-stock alerts, stock movements, purchase integration |
| **HR/Access** | Role-based permissions, multi-user sessions, audit trail |

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
│   ├── launcher.py             # Entry point — DB init, port detection, server start
│   ├── database.py             # SQLite schema, migrations, connection management
│   ├── auth_utils.py           # Password hashing, JWT generation/verification
│   ├── permissions.py          # RBAC middleware and permission checks
│   ├── backup_manager.py       # Automatic and manual backup logic
│   ├── utils.py                # Shared helpers (timestamps, tax calculations)
│   ├── routers/                # API endpoints (one file per module)
│   │   ├── auth.py
│   │   ├── clients.py
│   │   ├── projects.py
│   │   ├── quotations.py
│   │   ├── invoices.py
│   │   ├── inventory.py
│   │   ├── purchases.py
│   │   ├── suppliers.py
│   │   ├── finance.py
│   │   ├── expenses.py (part of finance.py)
│   │   ├── crm.py
│   │   ├── planning.py
│   │   ├── reports.py
│   │   ├── documents.py
│   │   ├── audit.py
│   │   ├── users.py
│   │   ├── roles.py
│   │   ├── archives.py
│   │   ├── notifications.py
│   │   ├── approval_policies.py
│   │   ├── approval_requests.py
│   │   ├── settings.py
│   │   ├── dashboard.py
│   │   └── search.py
│   ├── seed.py                 # Sample business data seeder
│   ├── seed_inventory.py       # Sample inventory seeder
│   └── requirements.txt
│
├── frontend_src/               # React frontend
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
│   │   │   ├── useSettings.jsx # Company settings context
│   │   │   ├── usePermissions.js  # RBAC permission checks
│   │   │   └── useLocale.jsx   # i18n translation context
│   │   ├── api/
│   │   │   └── client.js       # Axios instance + all API calls
│   │   └── locales/
│   │       ├── en.js           # English translations
│   │       └── ar.js           # Arabic translations
│   ├── package.json
│   └── vite.config.js
│
├── static/                     # Server-side static files (logo.png)
├── erp.db                      # SQLite database (auto-created)
├── DOCUMENTATION.md            # This file
├── ERP.spec                    # PyInstaller build spec
└── installer.iss               # Inno Setup installer script
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

### Development

**Prerequisites:** Python 3.11+, Node.js 18+

```bash
# 1. Install backend dependencies
cd backend
pip install -r requirements.txt

# 2. Install frontend dependencies
cd ../frontend_src
npm install

# 3. Start backend (auto-initializes DB)
cd ../backend
python launcher.py

# 4. Start frontend dev server (separate terminal)
cd frontend_src
npm run dev
```

The backend starts on **http://localhost:8765** and the frontend dev server on **http://localhost:5173**.

### First-Run Setup Wizard

On first launch, the app redirects to `/setup`. The setup wizard collects:

- Company name, address, country, phone, email, website
- Tax number / registration number
- Bank details (name, account, IBAN, SWIFT)
- Default currency, tax rate, payment terms
- Invoice and quotation number prefixes
- Admin account (username + password)

Once completed, `settings.setup_complete` is set to `"1"` and the wizard is disabled permanently.

### Production Build

```bash
# Build frontend for production
cd frontend_src
npm run build
# Output goes to frontend_src/dist/

# Run backend serving the built frontend
cd ../backend
python launcher.py
```

The backend serves the built frontend automatically from `frontend_src/dist/`.

### Windows Executable

Build a standalone Windows `.exe` using PyInstaller:

```bash
pyinstaller ERP.spec
# Output: dist/ERP.exe
```

Run the installer (built with Inno Setup) for a one-click setup that installs the app as a Windows service/startup application.

---

## 4. Configuration Reference

All configuration is via **environment variables**. Create a `.env` file in the project root or set them in your environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | *(required)* | JWT signing key. Generate: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `TOKEN_EXPIRE_HOURS` | `24` | JWT token lifetime in hours |
| `COOKIE_SECURE` | `true` | Set `false` for local HTTP development (no HTTPS) |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Comma-separated CORS allowed origins |
| `DB_PATH` | `erp.db` | Path to the SQLite database file |
| `PORT` | `8765` | Backend HTTP port. Auto-increments if occupied |
| `BIND_HOST` | `0.0.0.0` | Bind address (`0.0.0.0` = LAN accessible, `127.0.0.1` = localhost only) |

### System Settings (via UI)

Stored in the `settings` table, editable from **Settings → Company / Finance / Documents**:

| Setting Key | Description |
|------------|-------------|
| `company_name` | Appears in sidebar and documents |
| `company_tagline` | Subtitle under company name |
| `company_address`, `company_city`, `company_country` | Address for documents |
| `company_phone`, `company_email`, `company_website` | Contact info |
| `company_tax_number`, `company_reg_number` | Legal identifiers |
| `bank_name`, `bank_account`, `bank_iban`, `bank_swift` | Banking info on invoices |
| `default_currency` | Currency symbol (e.g., `USD`, `SAR`) |
| `default_tax_rate` | Default tax percentage |
| `tax_enabled` | `1` to show tax column on documents |
| `payment_terms_days` | Default payment due days |
| `invoice_prefix` | Invoice number prefix (e.g., `INV-`) |
| `quotation_prefix` | Quotation number prefix (e.g., `QTN-`) |
| `footer_text` | Footer text on invoices and quotations |
| `show_discount_col` | `1` to show discount column |
| `show_tax_col` | `1` to show tax column |

---

## 5. Authentication & Security

### Password Security

- Algorithm: **PBKDF2-SHA256** with 260,000 iterations (OWASP recommended minimum)
- Salt: 16 bytes, randomly generated per password
- Storage format: Base64(salt + derived_key) — never stored in plaintext

### Session Management

- Sessions use **JWT (HS256)** stored as `HttpOnly`, `Secure`, `SameSite=Strict` cookies
- Each JWT contains a **JTI** (JWT ID) that maps to the `user_sessions` table
- **Server-side revocation**: logging out or an admin revoking a session invalidates the JTI
- **One active session per user**: new login revokes all previous sessions
- **Inactivity timeout**: 30 minutes of no activity auto-revokes the session
- **Session tracking**: IP address and User-Agent are recorded per session

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

- Max **5 failed login attempts** per IP per **15-minute window**
- Exceeded: returns `429 Too Many Requests`
- Tracked in `login_attempts` table

### Force Password Change

If `users.must_change_password = 1`, the user is redirected to `/force-change-password` on login and **cannot navigate to any other page** until they set a new password. This is enforced at the React route level by the `RequirePasswordChange` guard component wrapping all authenticated routes — it is not bypassable by directly navigating to a URL. This flag is set when an admin creates a new user or resets a password.

### Password Change Rate Limiting

The `/auth/change-password` endpoint applies the same IP-based rate limit as login (5 attempts per 15-minute window) to prevent brute-force attacks against an authenticated user's current password.

---

## 6. User Management & RBAC

### Roles

The system ships with **6 built-in (system) roles** that cannot be deleted:

| Role | Description |
|------|-------------|
| **Admin** | Full access to all modules including users, roles, and audit |
| **Manager** | Clients, projects, quotations, invoices, suppliers (view/create/edit/approve) |
| **Accountant** | Invoices, finance, expenses (create/edit) |
| **Sales** | Clients, quotations, invoices (create/edit) |
| **Inventory** | Inventory, purchases, suppliers (create/edit) |
| **Viewer** | Read-only access across all modules |

Custom roles can be created from **Admin → Roles** with any combination of module/action permissions and a display color. A role cannot be deleted while it is assigned to active users or while it is referenced by any pending approval steps.

### Modules & Actions

Each role can be granted permissions per module and per action:

**Modules:**

| Module | Key |
|--------|-----|
| Dashboard | `dashboard` |
| Clients | `clients` |
| Projects | `projects` |
| Quotations | `quotations` |
| Invoices | `invoices` |
| Inventory | `inventory` |
| Purchases | `purchases` |
| Suppliers | `suppliers` |
| Finance | `finance` |
| Expenses | `expenses` |
| Reports | `reports` |
| CRM | `crm` |
| Planning | `planning` |
| Approvals | `approvals` |
| Settings | `settings` |
| Users | `users` |
| Roles | `roles` |
| Audit Log | `audit` |

**Actions per module:** `view`, `create`, `edit`, `delete`, `approve`

### Superadmin

The `is_superadmin` flag bypasses all RBAC checks. The initial admin created during setup is a superadmin. Superadmin status can only be granted by another superadmin via direct DB or the user management UI.

### Sidebar Visibility

Navigation links are automatically hidden for modules the logged-in user cannot `view`. The sidebar reflects the user's actual permissions in real time.

---

## 7. Modules

### 7.1 Dashboard

**URL:** `/`

Displays a real-time business summary:

- **Revenue** — total paid invoices (current month)
- **Expenses** — total expenses (current month)
- **Net Profit** — revenue minus expenses
- **Outstanding** — total unpaid/partial invoice balances
- **Active Projects** — count of in-progress projects
- **Overdue Invoices** — invoices past due date
- Recent activity feed

---

### 7.2 Clients

**URL:** `/clients`

Manages the client database.

**Fields:** Name, company, phone, email, address, client type (Individual / Company), notes.

**Features:**
- Search by name, company, email, or phone
- Filter by type
- View client detail with linked projects, quotations, invoices, and contacts
- Archive clients (soft-delete with reason, reversible)
- Export to Excel

**Client Detail page** shows a tabbed view:
- Overview (contact info, summary stats)
- Projects linked to this client
- Quotations issued to this client
- Invoices for this client
- CRM contacts associated with this client

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
- Deduct inventory items from stock and link to a project
- Link invoices and quotations
- Archive projects

**Cost Tracking:** Actual cost is the sum of all linked expenses and inventory deductions. The project detail page shows a cost breakdown table.

---

### 7.4 Quotations

**URL:** `/quotations`

Creates and tracks sales quotations.

**Fields:** Quote number (auto-generated), client, project, status, line items (name, quantity, unit price, total), notes.

**Statuses:** `Draft` → `Sent` → `Accepted` | `Rejected`

**Workflow:**
1. Create quotation with line items
2. Send to client (status → Sent)
3. Client accepts → **Convert to Invoice** (creates invoice with same line items)
4. Optionally **Convert to Project** (creates a linked project)

**Features:**
- PDF document generation
- Line items with subtotals, tax, discount
- Cancel with reason

---

### 7.5 Invoices

**URL:** `/invoices`

Manages billing and payment collection.

**Fields:** Invoice number (auto-generated), client, project, linked quotation, amount, due date, line items, notes.

**Statuses:** `Unpaid` → `Partial` → `Paid` | `Void` | `Overdue` (calculated)

**Features:**
- Record multiple payments against one invoice (partial payments)
- Idempotent payment recording (duplicate prevention via `idempotency_key` — required on every request)
- Optimistic locking (version field) — prevents editing an invoice if another session updated it
- Once any payment is recorded, the invoice amount is locked (cannot edit)
- Void invoice with reason (does not delete, marks as void); voiding reverses any contribution to the linked project's `actual_cost`
- Payment methods: Cash, Bank Transfer, Cheque, Card, Other
- Export to Excel
- Generate PDF

**Payment recording** stores: amount, method, note, date, and a unique idempotency key to prevent accidental duplicate charges.

---

### 7.6 Inventory

**URL:** `/inventory`

Manages stock items and tracks movements.

**Fields:** Name, category (Product / Material / Equipment / Other), quantity, minimum stock level, unit cost, supplier, unit of measure.

**Features:**
- Low-stock alerts (items below `min_stock` are highlighted)
- Manual stock adjustment with reason note
- **Deduct to Project**: deduct quantity and link movement to a project (records actual project cost)
- Full stock movement history per item (type: purchase received, manual adjustment, project deduction, etc.)
- Category filter

**Stock Movement Types:**
- `purchase` — received from a purchase order
- `adjustment` — manual stock correction
- `deduction` — used on a project
- `return` — returned stock

---

### 7.7 Purchases

**URL:** `/purchases`

Manages purchase orders from suppliers.

**Fields:** PO number (auto-generated), supplier, inventory item, product name, quantity, unit cost, additional costs, status, notes.

**Statuses:** `Draft` → `Ordered` → `Received` → `Paid`

**Features:**
- Link PO to a supplier and an inventory item
- On status → `Received`: automatically updates inventory stock (stock movement logged)
- On status → `Paid`: automatically records an expense
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
Accounting periods (year + month) can be **locked** to prevent editing historical data. Once a period is locked:
- Payments in that period cannot be added or deleted
- Expenses in that period cannot be edited or voided
- A lock badge appears on the period in the monthly table

Periods can be unlocked by admin if correction is needed (action is logged in audit trail).

---

### 7.10 Expenses

**URL:** `/expenses`

Tracks business expenses.

**Fields:** Category, description, amount, date, linked project (optional), status.

**Categories (validated):** Labour, Materials, Equipment, Transport, Subcontractor, Permits, Purchase, Other.

**Statuses:** `Recorded` → `Pending Approval` → `Approved` | `Rejected`

Manually entered expenses go through the approval workflow if an approval policy is configured for the `expense` entity. Auto-generated expenses (from purchase orders or inventory deductions) bypass the approval workflow and are recorded directly with status `Recorded`.

**Features:**
- Optional project linkage (contributes to project `actual_cost` once approved)
- Filter by date range, category, project, status
- Void expense with reason (does not delete, marks as voided; voided expenses are excluded from period snapshots)
- Period locking: expenses in a locked accounting period cannot be edited or voided
- Export to Excel

**Expense approval flow:**
1. Finance user creates an expense → status becomes `Pending Approval`
2. Approvers review via the Approvals module
3. On approval → status → `Approved`; project `actual_cost` is updated
4. On rejection → status → `Rejected`; no cost impact

---

### 7.11 CRM

**URL:** `/crm`

Customer Relationship Management.

**Four sub-modules:**

#### Leads
Track prospective customers.

**Fields:** Name, company, email, phone, source (Website, Referral, Cold Call, etc.), status (New, Contacted, Qualified, Lost), lead score, estimated value, expected close date, assigned user.

**Convert to Client**: a qualified lead can be promoted to a full client record, preserving all linked contacts and activities.

#### Contacts
Individuals linked to clients or leads.

**Fields:** Name, title, email, phone, primary contact flag, notes.

#### Activities
Log all customer interactions.

**Types:** Call, Email, Meeting, Task, Note.

**Fields:** Type, subject, description, linked client/lead/contact, due date, done flag, outcome.

Activities can be marked complete with an outcome note.

#### Deals
Sales pipeline management.

**Stages:** Qualification → Proposal → Negotiation → Won | Lost

**Fields:** Title, linked client/lead, linked quotation, value, probability (%), expected close, assigned user, lost reason.

**CRM Dashboard** shows:
- Lead count by status
- Deal count and value by stage
- Activities due today / overdue
- Pipeline total value

---

### 7.12 Planning

**URL:** `/planning`

Project task planning and scheduling.

**Four views:**

#### Gantt View
- Timeline visualization of tasks across a month or week
- Navigate between periods with Previous / Next buttons
- Toggle between **Week** (7 days, scaled to full width) and **Month** (full month) views
- Drag task bars left/right to reschedule
- Drag right edge to resize duration
- Today highlighted with a vertical line
- Color-coded by project
- Progress percentage shown inside bars

#### Board View (Kanban)
- Cards grouped by status column: **To Do | In Progress | Done**
- Shows task name, project, priority, assignee, progress bar

#### List View
- Full filterable table: search by name, filter by project, status, priority
- Inline status and progress display
- Edit and archive actions

#### Calendar View
- Monthly calendar showing tasks by due date
- Fits within one screen without scrolling

**Planning Projects** group tasks. Each planning project has:
- Name, description, client, color, start/end date, status
- Linked milestones

**Tasks:**
Fields: Name, project, assignee, status, priority (Low/Medium/High/Critical), start date, end date, progress (0–100%), milestone, depends-on, color.

**Milestones:**
Named checkpoints with a due date. Tasks can be linked to milestones. Milestones appear on the Gantt timeline. Milestones must belong to an existing planning project (FK-validated on creation). Deleting a milestone performs a **soft-delete** (sets `archived_at`); the milestone can be recovered if needed. All tasks previously linked to a soft-deleted milestone retain their `milestone_id`.

---

### 7.13 Reports

**URL:** `/reports`

Business intelligence and reporting.

**Report Types:**

#### Financial Summary
- Revenue, expenses, net profit by period
- Trend charts (monthly bar chart)
- Expense breakdown by category (donut + horizontal bar chart)

#### Projects Report
- Project list with status, estimated vs. actual cost, expected vs. billed revenue
- Profit margin per project

#### Clients Report
- Revenue, outstanding balance, project count per client
- Sorted by total revenue

#### Invoice Aging
- Outstanding invoices grouped by age: 0–30, 31–60, 61–90, 90+ days overdue
- Total at-risk amount per bucket

#### Expense Report
- Expenses grouped by category with totals and percentages
- Date range filter

#### Sales Pipeline
- CRM deals by stage with value and weighted value (value × probability)
- Win/loss rate

All reports support **date range filtering** and **Excel export**.

---

### 7.14 Archives

**URL:** `/archives`

Soft-deleted items (archived with a reason). Items appear here after clicking "Archive" in any module.

- View all archived items across all modules (clients, projects, quotations, invoices, inventory, purchases, suppliers, expenses, CRM records, planning items)
- **Unarchive** restores the item to its original module
- Items remain fully intact in the database with an `archived_at` timestamp — no data is lost

---

### 7.15 Audit Log

**URL:** Admin → Audit Panel

Complete tamper-evident activity log.

**Recorded fields:** User, action (create/edit/delete/login/etc.), module, record ID, record reference, detail text, timestamp.

**Features:**
- Filter by user, action type, module, date range
- Cannot be edited or deleted by normal admin (only purged by superadmin)
- Every API mutation is automatically logged

---

### 7.16 Settings

**URL:** `/settings` (admin only)

System configuration panel.

**Tabs:**
- **Company** — Name, tagline, address, contact info, tax/reg numbers, logo upload (PNG/JPG, max 2MB)
- **Finance** — Currency, tax rate, payment terms, invoice/quotation prefixes
- **Documents** — Footer text, show/hide discount and tax columns
- **Bank** — Bank name, account number, IBAN, SWIFT code
- **Backup** — Manual backup download, backup history, restore from file, integrity check

**Logo** is displayed in the sidebar and on generated documents (invoices, quotations).

> **Logo upload security:** Uploaded files are validated by inspecting their magic bytes (file header), not just the Content-Type header. Only valid PNG, JPEG, GIF, and WebP images are accepted (max 2 MB).

---

### 7.17 Approval Policies

**URL:** `/approval-policies` (admin only)

Defines the approval workflows that apply to specific business actions.

**Fields:** Entity type, step number, approver role, description.

**Supported entity types:**
| Entity | Trigger |
|--------|---------|
| `expense` | Manually created expenses |
| `invoice` | Invoice creation (if configured) |
| `purchase` | Purchase order creation (if configured) |

**How policies work:**
- Each policy defines one or more sequential approval **steps**
- Each step specifies an **approver role** (e.g., Manager, Accountant)
- When a triggering action occurs, an approval request is automatically created and routed to the first step's role
- After each step is approved, the request advances to the next step
- Only after all steps are approved is the underlying record considered fully approved

**Features:**
- Create multi-step approval chains (e.g., Step 1: Accountant → Step 2: Manager)
- Edit or delete policies (deletion blocked if pending approvals reference the policy)
- Role deletion blocked if any pending approval steps reference that role

---

### 7.18 Approval Requests

**URL:** `/approvals`

Tracks all in-flight and historical approval requests.

**Fields:** Entity type, entity ID, requester, current step, status, created date.

**Statuses:** `pending` → `approved` | `rejected`

**Workflow:**
1. A triggering action (e.g., creating an expense) generates an approval request
2. Users with the approver role see pending requests in the Approvals page
3. Approver reviews the linked record and clicks **Approve** or **Reject**
4. On rejection, the request is closed and the underlying record is marked `Rejected`
5. On approval of the final step, the request is closed, the record is marked `Approved`, and any side effects execute (e.g., `actual_cost` updated on the linked project)

**Authorization:**
- Only the original requester, a user with a matching approver role, or an admin can view a specific approval request
- Race condition protection: if two approvers act simultaneously, only the first action is accepted (the second receives a 409 Conflict)

**Notifications:**
- Approvers receive in-app notifications when a new request reaches their step
- Requesters receive notifications when their request is approved or rejected

---

## 8. API Reference

**Base URL:** `http://localhost:8765/api`

All endpoints require a valid session cookie except:
- `POST /api/auth/login`
- `GET /api/settings/setup-status`
- `POST /api/settings/complete-setup`

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/login` | Login (rate-limited: 5 attempts / 15 min) |
| POST | `/auth/logout` | Revoke current session |
| GET | `/auth/me` | Current user + full permissions |
| POST | `/auth/change-password` | Change own password |
| POST | `/auth/force-change-password` | First-login password change |

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard/` | Summary metrics |

### Clients

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/clients/` | List (search, type filter) |
| POST | `/clients/` | Create |
| GET | `/clients/{id}` | Detail with projects, invoices, quotations |
| PUT | `/clients/{id}` | Update |
| PATCH | `/clients/{id}/archive` | Archive with reason |
| PATCH | `/clients/{id}/unarchive` | Restore |

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/projects/` | List (search, status filter) |
| POST | `/projects/` | Create |
| GET | `/projects/{id}` | Detail |
| PUT | `/projects/{id}` | Update |
| PATCH | `/projects/{id}/status` | Change status |
| PATCH | `/projects/{id}/cancel` | Cancel with reason |
| PATCH | `/projects/{id}/archive` | Archive |
| PATCH | `/projects/{id}/unarchive` | Restore |

### Quotations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/quotations/` | List (status filter) |
| POST | `/quotations/` | Create with line items |
| GET | `/quotations/{id}` | Detail with items |
| PUT | `/quotations/{id}` | Update |
| POST | `/quotations/{id}/convert-to-invoice` | Create invoice from quotation |
| POST | `/quotations/{id}/convert-to-project` | Create project from quotation |
| PATCH | `/quotations/{id}/cancel` | Cancel |
| PATCH | `/quotations/{id}/archive` | Archive |
| PATCH | `/quotations/{id}/unarchive` | Restore |

### Invoices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/invoices/` | List (status filter) |
| POST | `/invoices/` | Create with line items |
| GET | `/invoices/{id}` | Detail with payments and items |
| PUT | `/invoices/{id}` | Update (locked after first payment) |
| PATCH | `/invoices/{id}/void` | Void with reason |
| POST | `/invoices/{id}/payments` | Record payment |
| GET | `/invoices/{id}/payments` | List payments |
| DELETE | `/invoices/{id}/payments/{pid}` | Delete payment |
| PATCH | `/invoices/{id}/archive` | Archive |
| PATCH | `/invoices/{id}/unarchive` | Restore |

### Inventory

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/inventory/` | List items |
| GET | `/inventory/categories` | Available categories |
| POST | `/inventory/` | Create item |
| GET | `/inventory/{id}` | Item detail |
| GET | `/inventory/{id}/movements` | Stock movement history |
| PUT | `/inventory/{id}` | Update item |
| PATCH | `/inventory/{id}/stock` | Manual stock adjustment |
| POST | `/inventory/{id}/deduct-to-project` | Deduct stock for a project |
| PATCH | `/inventory/{id}/archive` | Archive |
| PATCH | `/inventory/{id}/unarchive` | Restore |

### Purchases

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/purchases/` | List POs |
| GET | `/purchases/stats` | Purchase statistics |
| POST | `/purchases/` | Create PO |
| GET | `/purchases/{id}` | PO detail |
| PUT | `/purchases/{id}` | Update PO |
| PATCH | `/purchases/{id}/status` | Change status |
| GET | `/purchases/supplier/{name}/history` | Supplier PO history |
| PATCH | `/purchases/{id}/archive` | Archive |
| PATCH | `/purchases/{id}/unarchive` | Restore |

### Suppliers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/suppliers/` | List |
| POST | `/suppliers/` | Create |
| GET | `/suppliers/{id}` | Detail |
| PUT | `/suppliers/{id}` | Update |
| PATCH | `/suppliers/{id}/archive` | Archive |
| PATCH | `/suppliers/{id}/unarchive` | Restore |

### Finance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/finance/summary` | Current month summary |
| GET | `/finance/range-summary` | Summary for date range |
| GET | `/finance/range-monthly` | Monthly breakdown for range |
| GET | `/finance/range-detail` | Detailed line items for range |
| GET | `/finance/monthly` | Full monthly history |
| GET | `/finance/expenses` | List expenses |
| POST | `/finance/expenses` | Create expense |
| PUT | `/finance/expenses/{id}` | Update expense |
| PATCH | `/finance/expenses/{id}/void` | Void expense |
| PATCH | `/finance/expenses/{id}/archive` | Archive |
| PATCH | `/finance/expenses/{id}/unarchive` | Restore |
| GET | `/finance/periods` | List accounting periods |
| POST | `/finance/periods/{year}/{month}/lock` | Lock period |
| POST | `/finance/periods/{year}/{month}/unlock` | Unlock period |
| GET | `/finance/reconciliation` | Reconciliation view |

### CRM

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/crm/dashboard` | CRM summary |
| GET | `/crm/leads` | List leads |
| POST | `/crm/leads` | Create lead |
| GET | `/crm/leads/{id}` | Lead detail |
| PUT | `/crm/leads/{id}` | Update lead |
| PATCH | `/crm/leads/{id}/archive` | Archive lead |
| POST | `/crm/leads/{id}/convert` | Convert to client |
| GET | `/crm/contacts` | List contacts |
| POST | `/crm/contacts` | Create contact |
| PUT | `/crm/contacts/{id}` | Update contact |
| DELETE | `/crm/contacts/{id}` | Delete contact |
| GET | `/crm/activities` | List activities |
| POST | `/crm/activities` | Create activity |
| PUT | `/crm/activities/{id}` | Update activity |
| PATCH | `/crm/activities/{id}/done` | Mark done |
| DELETE | `/crm/activities/{id}` | Delete activity |
| GET | `/crm/deals` | List deals |
| POST | `/crm/deals` | Create deal |
| PUT | `/crm/deals/{id}` | Update deal |
| PATCH | `/crm/deals/{id}/stage` | Move to stage |

### Planning

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/planning/projects` | List planning projects |
| POST | `/planning/projects` | Create project |
| GET | `/planning/projects/{id}` | Project detail |
| PUT | `/planning/projects/{id}` | Update project |
| PATCH | `/planning/projects/{id}/archive` | Archive |
| GET | `/planning/tasks` | List tasks |
| POST | `/planning/tasks` | Create task |
| GET | `/planning/tasks/{id}` | Task detail |
| PUT | `/planning/tasks/{id}` | Update task |
| PATCH | `/planning/tasks/{id}/dates` | Update dates |
| PATCH | `/planning/tasks/{id}/status` | Change status |
| PATCH | `/planning/tasks/{id}/progress` | Update progress % |
| PATCH | `/planning/tasks/{id}/archive` | Archive |
| GET | `/planning/milestones` | List milestones |
| POST | `/planning/milestones` | Create milestone |
| PUT | `/planning/milestones/{id}` | Update milestone |
| PATCH | `/planning/milestones/{id}/archive` | Soft-delete milestone |
| GET | `/planning/summary` | Planning summary stats |

### Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/reports/financial` | Financial report |
| GET | `/reports/projects` | Projects report |
| GET | `/reports/clients` | Clients report |
| GET | `/reports/invoice-aging` | Invoice aging analysis |
| GET | `/reports/expenses` | Expense report by category |
| GET | `/reports/pipeline` | Sales pipeline report |

### Documents

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/documents/` | Generate/store document |
| GET | `/documents/` | List documents |
| GET | `/documents/{id}/content` | Download document |
| DELETE | `/documents/{id}` | Delete document |

### Users (admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/` | List users |
| POST | `/users/` | Create user |
| GET | `/users/{id}` | User detail |
| PUT | `/users/{id}` | Update user |
| POST | `/users/{id}/reset-password` | Force password reset |
| PATCH | `/users/{id}/toggle-active` | Enable/disable user |
| DELETE | `/users/{id}` | Soft-delete user |
| GET | `/users/sessions` | Active sessions |
| DELETE | `/users/sessions/{sid}` | Revoke session |

### Roles (admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/roles/` | List roles |
| GET | `/roles/modules` | Available modules and actions |
| POST | `/roles/` | Create role |
| GET | `/roles/{id}` | Role detail |
| PUT | `/roles/{id}` | Update role |
| PUT | `/roles/{id}/permissions` | Update permissions |
| DELETE | `/roles/{id}` | Delete role |

### Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/settings/` | Get all settings |
| PUT | `/settings/` | Update settings |
| GET | `/settings/logo` | Get company logo |
| POST | `/settings/logo` | Upload logo |
| GET | `/settings/backup` | Download backup file |
| GET | `/settings/backup-status` | Backup list and status |
| POST | `/settings/backup-now` | Trigger manual backup |
| POST | `/settings/restore` | Restore from backup |
| GET | `/settings/setup-status` | First-run check (public) |
| POST | `/settings/complete-setup` | Complete first-run setup (public) |
| GET | `/settings/integrity-check` | SQLite integrity check |

### Approval Policies (admin only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/approval-policies/` | List all policies |
| POST | `/approval-policies/` | Create policy |
| GET | `/approval-policies/{id}` | Policy detail with steps |
| PUT | `/approval-policies/{id}` | Update policy |
| DELETE | `/approval-policies/{id}` | Delete policy |

### Approval Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/approval-requests/` | List requests (filterable by status/entity) |
| GET | `/approval-requests/{id}` | Request detail (requester, approver, or admin only) |
| POST | `/approval-requests/{id}/approve` | Approve current step |
| POST | `/approval-requests/{id}/reject` | Reject request |

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/notifications/` | List notifications for current user |
| GET | `/notifications/count` | Unread notification count |
| PATCH | `/notifications/{id}/read` | Mark notification as read |
| POST | `/notifications/read-all` | Mark all as read |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/search/` | Global search (all modules) |
| GET | `/archives/` | List archived items |
| PATCH | `/archives/{module}/{id}/unarchive` | Restore archived item |
| GET | `/audit/` | Audit log |
| DELETE | `/audit/purge` | Purge old audit entries |

---

## 9. Database Schema

The database is **SQLite** (`erp.db`). All tables use `INTEGER PRIMARY KEY` (auto-increment). Timestamps are stored as ISO 8601 UTC strings.

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
| `location` | TEXT | Site/location |
| `status` | TEXT | Planning/In Progress/Completed/On Hold/Cancelled |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `estimated_cost` | REAL | Budget |
| `actual_cost` | REAL | Sum of linked expenses |
| `expected_revenue` | REAL | |
| `source_quotation_id` | INTEGER FK | → quotations (if converted) |
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
| `project_name` | TEXT | Snapshot of project name |
| `status` | TEXT | Draft/Sent/Accepted/Rejected/Cancelled |
| `notes` | TEXT | |
| `total` | REAL | Sum of items |
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

#### `invoices`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `invoice_number` | TEXT UNIQUE | e.g., INV-0001 |
| `quotation_id` | INTEGER FK | → quotations |
| `project_id` | INTEGER FK | → projects |
| `client_id` | INTEGER FK | → clients |
| `amount` | REAL | Total invoice amount |
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

#### `invoice_payments`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `invoice_id` | INTEGER FK | → invoices |
| `amount` | REAL | |
| `method` | TEXT | Cash/Bank Transfer/Cheque/Card/Other |
| `note` | TEXT | |
| `idempotency_key` | TEXT UNIQUE | Duplicate prevention — **required** on every payment request |
| `paid_at` | TEXT | |

#### `inventory`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | Item name |
| `category` | TEXT | Product/Material/Equipment/Other |
| `quantity` | REAL | Current stock |
| `min_stock` | REAL | Low-stock threshold |
| `unit_cost` | REAL | Cost per unit |
| `supplier` | TEXT | Supplier name |
| `unit` | TEXT | Unit of measure (kg, pcs, m, etc.) |
| `archived_at` | TEXT | |
| `deleted_at` | TEXT | |
| `created_at` | TEXT | |

#### `stock_movements`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `inventory_id` | INTEGER FK | → inventory |
| `type` | TEXT | purchase/adjustment/deduction/return |
| `delta` | REAL | Quantity change (+ or −) |
| `qty_before` | REAL | Stock before |
| `qty_after` | REAL | Stock after |
| `reference` | TEXT | PO number / project name |
| `note` | TEXT | |
| `created_at` | TEXT | |

#### `purchases`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `po_number` | TEXT UNIQUE | e.g., PO-0001 |
| `supplier` | TEXT | Supplier name (snapshot) |
| `supplier_id` | INTEGER FK | → suppliers |
| `inventory_id` | INTEGER FK | → inventory |
| `product_name` | TEXT | |
| `quantity` | REAL | |
| `unit_cost` | REAL | |
| `additional_costs` | REAL | Shipping, duties, etc. |
| `status` | TEXT | Draft/Ordered/Received/Paid |
| `stock_updated` | INTEGER | 1 if stock was incremented |
| `expense_recorded` | INTEGER | 1 if expense was created |
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
| `category` | TEXT | Labour/Materials/Equipment/Transport/Subcontractor/Permits/Purchase/Other |
| `description` | TEXT | |
| `amount` | REAL | Must be > 0 (enforced at API layer) |
| `date` | TEXT | Expense date |
| `status` | TEXT | `Recorded` / `Pending Approval` / `Approved` / `Rejected` |
| `voided_at` | TEXT | |
| `void_reason` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

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
| `income` | REAL | Total paid invoices |
| `expenses` | REAL | Total expenses |
| `profit` | REAL | income − expenses |
| `payment_count` | INTEGER | |
| `expense_count` | INTEGER | |
| `locked_at` | TEXT | |
| `locked_by` | INTEGER FK | → users |

### Auth Tables

#### `users`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `username` | TEXT UNIQUE | Login identifier |
| `password_hash` | TEXT | PBKDF2-SHA256 hash |
| `full_name` | TEXT | Display name |
| `email` | TEXT | |
| `role` | TEXT | Legacy role name |
| `role_id` | INTEGER FK | → roles |
| `is_active` | INTEGER | 1 = enabled |
| `is_superadmin` | INTEGER | 1 = bypass all RBAC |
| `last_login` | TEXT | |
| `must_change_password` | INTEGER | 1 = force change on next login |
| `deleted_at` | TEXT | Soft-delete |
| `created_at` | TEXT | |

#### `roles`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT UNIQUE | |
| `description` | TEXT | |
| `color` | TEXT | Hex color for UI badge |
| `is_system` | INTEGER | 1 = cannot delete |
| `created_at` | TEXT | |

#### `role_permissions`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `role_id` | INTEGER FK | → roles |
| `module` | TEXT | Module key |
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
| `user_agent` | TEXT | Browser/client |
| `created_at` | TEXT | |
| `last_active` | TEXT | |
| `expires_at` | TEXT | |
| `revoked` | INTEGER | 1 = revoked |

#### `login_attempts`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `ip` | TEXT | |
| `attempted_at` | TEXT | |

### CRM Tables

#### `crm_leads`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | |
| `company` | TEXT | |
| `email` | TEXT | |
| `phone` | TEXT | |
| `source` | TEXT | Website/Referral/Cold Call/etc. |
| `status` | TEXT | New/Contacted/Qualified/Lost |
| `score` | INTEGER | 0–100 |
| `estimated_value` | REAL | |
| `expected_close` | TEXT | Date |
| `assigned_to` | INTEGER FK | → users |
| `client_id` | INTEGER FK | → clients (after conversion) |
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
| `is_primary` | INTEGER | 1 = primary contact |
| `notes` | TEXT | |
| `archived_at` | TEXT | |
| `created_at` | TEXT | |

#### `crm_activities`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `type` | TEXT | call/email/meeting/task/note |
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
| `stage` | TEXT | Qualification/Proposal/Negotiation/Won/Lost |
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

### Planning Tables

#### `planning_projects`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `name` | TEXT | |
| `description` | TEXT | |
| `client_id` | INTEGER FK | → clients |
| `color` | TEXT | Hex color |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `status` | TEXT | Active/Completed/On Hold |
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
| `status` | TEXT | To Do/In Progress/Done |
| `priority` | TEXT | Low/Medium/High/Critical |
| `start_date` | TEXT | |
| `end_date` | TEXT | |
| `progress` | INTEGER | 0–100 |
| `milestone_id` | INTEGER FK | → planning_milestones |
| `depends_on` | INTEGER FK | → planning_tasks |
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
| `step_number` | INTEGER | Sequence (1 = first) |
| `approver_role` | TEXT | Role name that must approve this step |

Compound index on `(request_id, step_number)` for fast step lookups.

#### `approval_requests`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `policy_id` | INTEGER FK | → approval_policies |
| `entity_type` | TEXT | Mirrors policy entity type |
| `entity_id` | INTEGER | ID of the record being approved |
| `requested_by` | INTEGER FK | → users |
| `current_step` | INTEGER | Current step number |
| `status` | TEXT | `pending` / `approved` / `rejected` |
| `created_at` | TEXT | |
| `resolved_at` | TEXT | Timestamp of final decision |

### Admin Tables

#### `audit_log`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `user_id` | INTEGER | |
| `username` | TEXT | Snapshot at time of action |
| `action` | TEXT | create/edit/delete/login/etc. |
| `module` | TEXT | |
| `record_id` | INTEGER | |
| `record_ref` | TEXT | Human-readable reference |
| `detail` | TEXT | JSON or description |
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
| `record_type` | TEXT | invoice/quotation |
| `record_id` | INTEGER | |
| `client_id` | INTEGER FK | |
| `project_id` | INTEGER FK | |
| `title` | TEXT | |
| `html_content` | TEXT | Full rendered HTML |
| `created_at` | TEXT | |

#### `schema_migrations`
| Column | Type | Description |
|--------|------|-------------|
| `name` | TEXT PK | Migration identifier |
| `applied_at` | TEXT | |

---

## 10. Frontend Architecture

### Routing

All routes are defined in `App.jsx` using React Router v6. Protected routes check `localStorage.user` — unauthenticated users are redirected to `/login`.

| Path | Component | Access |
|------|-----------|--------|
| `/login` | Login.jsx | Public |
| `/setup` | Setup.jsx | Public (first run only) |
| `/force-change-password` | ForceChangePassword.jsx | Authenticated |
| `/` | Dashboard.jsx | `dashboard` module |
| `/clients` | Clients.jsx | `clients` module |
| `/clients/:id` | ClientDetail.jsx | `clients` module |
| `/projects` | Projects.jsx | `projects` module |
| `/projects/:id` | ProjectDetail.jsx | `projects` module |
| `/quotations` | Quotations.jsx | `quotations` module |
| `/invoices` | Invoices.jsx | `invoices` module |
| `/inventory` | Inventory.jsx | `inventory` module |
| `/purchases` | Purchases.jsx | `purchases` module |
| `/suppliers` | Suppliers.jsx | `suppliers` module |
| `/finance` | Finance.jsx | `finance` module |
| `/expenses` | Expenses.jsx | `expenses` module |
| `/crm` | CRM.jsx | `crm` module |
| `/planning` | Planning.jsx | `planning` module |
| `/reports` | Reports.jsx | `reports` module |
| `/archives` | Archives.jsx | Authenticated |
| `/approvals` | Approvals.jsx | `approvals` module |
| `/approval-policies` | ApprovalPolicies.jsx | Admin only |
| `/settings` | Settings.jsx | `settings` module |
| `/users` | UserManagement.jsx | Superadmin only |
| `/roles` | RoleManagement.jsx | Superadmin only |
| `/admin` | AdminDashboard.jsx | Superadmin only |

### Key Custom Hooks

| Hook | File | Purpose |
|------|------|---------|
| `usePermissions` | `hooks/usePermissions.js` | Exposes `can(module, action)`, `user`, `isSuperadmin` |
| `useSettings` | `hooks/useSettings.jsx` | Company settings context (company name, currency, etc.) |
| `useLocale` | `hooks/useLocale.jsx` | i18n: `t(key)`, `locale`, `setLocale`, `dir` |

### Shared Components (`components/shared.jsx`)

| Component | Purpose |
|-----------|---------|
| `Badge` | Colored status pill (translates status text) |
| `LoadingSpinner` | Centered loading indicator |
| `EmptyState` | Empty list placeholder with icon |
| `ConfirmModal` | Reusable confirmation dialog |
| `Pagination` | Page navigation with item count |
| `ExportButton` | Excel export trigger |

### Command Palette

Press **Ctrl+K** anywhere to open the global search / command palette. It searches across clients, projects, invoices, and other records in real time via `/api/search/`.

### Design System

No CSS framework. All styles are in `index.css` using CSS custom properties (design tokens):

```css
--bg, --bg-2, --bg-3     /* background levels */
--text, --text-2, --text-3  /* text levels */
--primary, --primary-2      /* brand accent */
--border                    /* border color */
--sidebar-w                 /* sidebar width */
--radius-sm, --radius       /* border radius */
--shadow-sm, --shadow-md    /* box shadows */
```

Dark/light mode is toggled by adding `data-theme="dark"` to `<html>`.

---

## 11. Backup & Recovery

### Automatic Backups

`backup_manager.py` runs automatic backups on a configurable schedule. Backups are stored as `.db` files in a `backups/` directory alongside the main database.

### Manual Backup

From **Settings → Backup**:
- Click **Download Backup** to download the current `erp.db` as a timestamped file
- View backup history (file name, size, date)

### Restore

From **Settings → Backup**:
1. Click **Restore from Backup**
2. Upload a `.db` backup file
3. The system replaces the live database and restarts

> **Warning:** Restore overwrites all current data. Always download a backup before restoring.

### Database Integrity Check

From **Settings → Backup**, click **Run Integrity Check** to execute SQLite's `PRAGMA integrity_check`. Returns `ok` if the database is healthy.

### Archives

Items removed via the **Archive** action in any module are soft-deleted (`archived_at` timestamp set) and visible at `/archives`. Items can be unarchived at any time — no data is lost. There is no permanent-delete action from the UI; deletion of records requires direct database access by a superadmin.

---

## 12. Localization

The system supports **English** and **Arabic** with full RTL layout.

### Switching Language

Click the **ع / EN** toggle button in the top bar. The language preference is persisted in `localStorage`.

### RTL Support

When Arabic is active, `dir="rtl"` is set on `<html>` and CSS logical properties handle layout mirroring (sidebar, flex direction, text alignment, padding).

### Translation Files

| File | Content |
|------|---------|
| `src/locales/en.js` | English strings |
| `src/locales/ar.js` | Arabic strings |

Both files export a flat object with dot-notation keys, e.g.:

```js
// en.js
export default {
  'nav.dashboard': 'Dashboard',
  'nav.clients': 'Clients',
  'common.save': 'Save',
  'status.paid': 'Paid',
  ...
}
```

### Adding New Strings

1. Add the key/value to both `en.js` and `ar.js`
2. Use `const { t } = useLocale()` in your component
3. Call `t('your.key')` — falls back to the key itself if missing

---

*End of Documentation*
