# ERP System

A full-stack business management platform for small-to-medium enterprises.
Centralises sales, point-of-sale, finance, inventory, manufacturing, fixed
assets, project management, HR and CRM into a single self-hosted application.

> **Version 2.1** · Python + FastAPI · React 18 · SQLite

---

## Features

| Module | Capabilities |
|--------|-------------|
| **Sales & CRM** | Leads → quotations → invoices → payments; deal pipeline, contacts, activity log |
| **POS** | Cash-drawer sessions, USD/LBP checkout, refunds that void invoices and restock |
| **Inventory** | Raw / semi-finished / finished / consumable items, weighted-average landed cost, low-stock alerts, stock movements |
| **Procurement** | Suppliers, PO lifecycle (Ordered → Received → Paid) that auto-posts expenses and adjusts inventory cost |
| **Manufacturing** | Versioned BOMs with scrap %, multi-level sub-assemblies, production-order lifecycle (Draft → Confirmed → In Progress → Completed), weighted-average production costing |
| **Finance** | P&L dashboards, expense tracking, recurring expense templates, period locking, smart insights |
| **Fixed Assets** | Capital register, straight-line depreciation auto-posted as expenses, disposal with gain/loss, capex approval workflow |
| **Cash** | Daily till reconciliation with auto-captured sales + expenses, USD/LBP variance reporting |
| **Taxation** | Admin-managed named tax rates (standard / reduced / zero / exempt); per-line tax snapshot; VAT report with per-rate breakdown |
| **Multi-currency** | Dual-currency (USD base + LBP secondary by default) with manual exchange-rate history |
| **Projects & Planning** | Project lifecycle, budget-vs-actual, Gantt-style planning board, milestones |
| **HR** | Departments, employees, leave requests (with auto-status flip while on leave) |
| **Reports & Analytics** | Financial, VAT (per-rate base + tax), invoice aging, project profitability, sales pipeline, Excel + PDF export |
| **Approvals** | Rule-based multi-step approval chains for expenses, invoices, purchases, projects and fixed-asset purchases |
| **Access Control** | RBAC across 19+ modules, JWT sessions with revocation, audit log, recycle bin |
| **Localization** | Full English and Arabic (RTL) |
| **Per-customer builds** | Module visibility baked in at build time via `backend/vendor_config.py` — immutable at runtime |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11+, FastAPI, Uvicorn |
| Database | SQLite (zero-config, single file) |
| Frontend | React 18, Vite, React Router v6 |
| Auth | JWT (HS256) via HttpOnly cookies, PBKDF2-SHA256 passwords |
| Packaging | PyInstaller (Windows .exe), Inno Setup |

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
cd backend
pip install -r requirements.txt
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
data (~110 records across 18 sections — clients, invoices in every payment
state, manufacturing orders across the lifecycle, depreciated assets, cash
reconciliations, CRM leads, HR records, approval policies, and more):

```bash
cd backend
python seed.py            # seeds against $DB_PATH (or ../erp.db)
python seed.py --reset    # WIPES that DB file first, then seeds
```

After seeding, log in with **`admin` / `Admin123!`**.

---

## Per-customer module builds

Module visibility is configured by the vendor at **build time**, not at
runtime. The single source of truth is `backend/vendor_config.py`:

```python
ENABLED_MODULES = "sales,clients,quotations,invoices,inventory"
```

An empty string means "every module visible" (dev and demo default). To
slim a customer's build, edit the constant before running `build.ps1` —
the value is baked into the installer and cannot be changed from a running
ERP, even by a superadmin. This closes the "delete `erp.db` + relaunch"
attack against module gating.

The prospect-facing module catalogue (`/discover`) and the inbox that
collects submissions are vendor-hosted in the `marketing-site/` directory,
separate from the customer's install.

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
DB_PATH=erp.db                         # Path to the SQLite database file
```

---

## Project Structure

```
erp-system/
├── backend/
│   ├── main.py                # FastAPI app and router registration
│   ├── database.py            # SQLite schema, numbered migrations
│   ├── auth_utils.py          # JWT + PBKDF2 password hashing
│   ├── permissions.py         # RBAC middleware (19+ modules)
│   ├── approval_engine.py     # Multi-step approval workflow
│   ├── backup_manager.py      # Daily/weekly backups + USB export
│   ├── utils.py               # Tax math (Decimal-based), notify(), helpers
│   ├── routers/               # One file per module
│   │   ├── auth.py            clients.py     projects.py
│   │   ├── quotations.py      invoices.py    inventory.py
│   │   ├── purchases.py       suppliers.py   finance.py
│   │   ├── pos.py             cash.py        manufacturing.py
│   │   ├── assets.py          recurring.py   tax_rates.py
│   │   ├── crm.py             planning.py    hr.py
│   │   ├── reports.py         dashboard.py   search.py
│   │   ├── notifications.py   approval_policies.py  approval_requests.py
│   │   ├── announcements.py   settings.py    documents.py
│   │   ├── audit.py           archives.py
│   │   └── users.py           roles.py
│   ├── tests/                 # Pytest suite — 431 tests, full coverage of
│   │                          # auth, tax, POS, manufacturing, VAT, RBAC
│   ├── seed.py                # Single comprehensive sample-data seeder
│   ├── env.example
│   └── requirements.txt
├── frontend_src/
│   ├── src/
│   │   ├── pages/             # One component per page (Discover.jsx + others)
│   │   ├── components/        # Sidebar, NotificationBell, CommandPalette, shared
│   │   ├── hooks/             # useSettings, usePermissions, useLocale
│   │   ├── api/client.js      # All HTTP calls
│   │   ├── locales/           # en.js and ar.js translation strings
│   │   └── index.css          # Design tokens + base component classes
│   └── vite.config.js
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

Key endpoint groups: `/api/auth`, `/api/clients`, `/api/projects`,
`/api/quotations`, `/api/invoices`, `/api/inventory`, `/api/purchases`,
`/api/suppliers`, `/api/pos`, `/api/cash`, `/api/manufacturing`, `/api/assets`,
`/api/recurring-expenses`, `/api/finance`, `/api/tax-rates`, `/api/crm`,
`/api/planning`, `/api/hr`, `/api/reports`, `/api/approval-policies`,
`/api/approval-requests`, `/api/notifications`, `/api/announcements`,
`/api/search`, `/api/audit`, `/api/settings`.

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

---

## Backups

The system automatically creates daily and weekly SQLite backups in `backups/`.
Each backup includes a `.sha256` checksum file for integrity verification. You
can also trigger a manual backup, export to a USB drive, or restore from the
Settings page in the app.

---

## License

Private — all rights reserved.
