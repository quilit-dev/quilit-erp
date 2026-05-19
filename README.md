# ERP System

A full-stack business management platform for small-to-medium enterprises. Centralizes sales, finance, inventory, project management, HR, and CRM into a single self-hosted application.

> **Version 2.0** · Python + FastAPI · React 18 · SQLite

---

## Features

| Module | Capabilities |
|--------|-------------|
| **Sales** | Quotations, invoices, partial & multi-currency payment tracking, aging reports |
| **Finance** | Revenue/expense tracking, period locking, VAT reporting, reconciliation |
| **Taxation** | Admin-managed named tax rates (standard / zero-rated / exempt), per-line tax |
| **Multi-Currency** | Dual-currency (USD base + secondary, e.g. LBP) with manual exchange-rate history |
| **Projects** | Project lifecycle, cost tracking, milestone planning, Gantt charts |
| **CRM** | Lead management, deal pipeline, contact tracking, activity logging |
| **Inventory** | Stock management, low-stock alerts, stock movements, purchase integration |
| **HR** | Employee directory, departments, leave requests and approval |
| **Access Control** | Role-based permissions, multi-user sessions, approval workflows, audit trail |
| **Localization** | Full English and Arabic (RTL) support |

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
# 2. Set up the backend
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
# 4. Set up the frontend
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

On first launch, you'll be redirected to `/setup` where you configure:

- Company details (name, address, tax number, bank info)
- Default currency, tax rate, and payment terms
- Invoice and quotation number prefixes
- Admin account credentials

---

## Development

Run the backend and frontend dev servers separately for hot reload:

```bash
# Terminal 1 — backend (run from the project root)
python launcher.py

# Terminal 2 — frontend (hot reload on http://localhost:5173)
cd frontend_src
npm run dev
```

The Vite dev server proxies API requests to the backend automatically.

### Seeding Sample Data

```bash
cd backend
python seed.py           # Business data (clients, invoices, projects…)
python seed_inventory.py # Inventory items and stock movements
```

---

## Environment Variables

Copy `.env.example` to `backend/.env` and fill in your values. Never commit the real `.env` file.

```env
# Required
SECRET_KEY=your_secret_key_here        # Generate with: python -c "import secrets; print(secrets.token_hex(32))"

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
│   ├── main.py              # FastAPI app and router registration
│   ├── database.py          # SQLite schema, migrations, connection management
│   ├── auth_utils.py        # JWT and password hashing
│   ├── permissions.py       # RBAC middleware
│   ├── approval_engine.py   # Multi-step approval workflow logic
│   ├── backup_manager.py    # Automatic and manual backup logic
│   ├── routers/             # One file per module (clients, invoices, hr…)
│   ├── seed.py              # Sample data seeder
│   └── requirements.txt
├── frontend_src/
│   ├── src/
│   │   ├── pages/           # One component per module
│   │   ├── components/      # Shared UI (Sidebar, modals, command palette)
│   │   ├── hooks/           # useSettings, usePermissions, useLocale
│   │   ├── api/client.js    # Axios instance and all API calls
│   │   └── locales/         # en.js and ar.js translation strings
│   └── vite.config.js
├── backups/                 # Auto-managed daily/weekly DB backups (gitignored)
├── installer/               # Inno Setup installer files
├── launcher.py              # Entry point — run this from the project root
├── build.ps1                # Windows build script (frontend + exe + installer)
├── backend/env.example      # Environment variable template
├── ERP.spec                 # PyInstaller build spec
└── DOCUMENTATION.md         # Full technical documentation
```

---

## API

The backend exposes a REST API at `/api/*`. Interactive docs are available at:

- Swagger UI: `http://localhost:8765/docs`
- ReDoc: `http://localhost:8765/redoc`

Key endpoint groups: `/api/auth`, `/api/clients`, `/api/projects`, `/api/invoices`, `/api/finance`, `/api/inventory`, `/api/purchases`, `/api/suppliers`, `/api/hr`, `/api/crm`, `/api/planning`, `/api/reports`, `/api/tax-rates`, `/api/approval-policies`, `/api/approval-requests`, `/api/notifications`, `/api/recycle_bin`, `/api/search`, `/api/audit`, and more.

---

## Building for Windows

Requires Node.js, PyInstaller, and Inno Setup 6 (Windows only). The `build.ps1`
script runs the full pipeline — frontend build, executable bundling, and installer
compilation:

```powershell
.\build.ps1
```

The compiled installer is written to `installer/Output/`. To build only the
standalone executable, run `python -m PyInstaller ERP.spec`.

---

## Backups

The system automatically creates daily and weekly SQLite backups in `backups/`. Each backup includes a `.sha256` checksum file for integrity verification. You can also trigger a manual backup or restore from the Settings page in the app.

---

## License

Private — all rights reserved.
