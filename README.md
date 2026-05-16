# ERP System

A full-stack business management platform for small-to-medium enterprises. Centralizes sales, finance, inventory, project management, HR, and CRM into a single self-hosted application.

> **Version 2.0** · Python + FastAPI · React 18 · SQLite

---

## Features

| Module | Capabilities |
|--------|-------------|
| **Sales** | Quotations, invoices, payment tracking, aging reports |
| **Finance** | Revenue/expense tracking, period locking, reconciliation, financial reports |
| **Projects** | Project lifecycle, cost tracking, milestone planning, Gantt charts |
| **CRM** | Lead management, deal pipeline, contact tracking, activity logging |
| **Inventory** | Stock management, low-stock alerts, stock movements, purchase integration |
| **HR & Access** | Role-based permissions, multi-user sessions, approval workflows, audit trail |
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
```

```bash
# 3. Configure environment
cp .env.example .env
# Edit backend/.env and set your SECRET_KEY:
# python -c "import secrets; print(secrets.token_hex(32))"
```

```bash
# 4. Set up the frontend
cd ../frontend_src
npm install
npm run build
```

```bash
# 5. Start the server
cd ..
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
# Terminal 1 — backend
cd backend
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

Create `backend/.env` from the example below. Never commit the real file.

```env
SECRET_KEY=your_secret_key_here        # Required — generate with secrets.token_hex(32)
COOKIE_SECURE=false                    # Set to true in production (HTTPS only)
ALLOWED_ORIGINS=http://localhost:5173  # Comma-separated list of allowed frontend origins
```

---

## Project Structure

```
erp-system/
├── backend/
│   ├── main.py              # FastAPI app and router registration
│   ├── launcher.py          # Entry point — DB init, port detection, server start
│   ├── database.py          # SQLite schema, migrations, connection management
│   ├── auth_utils.py        # JWT and password hashing
│   ├── permissions.py       # RBAC middleware
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
├── launcher.py              # Desktop launcher with port detection
├── ERP.spec                 # PyInstaller build spec
├── installer.iss            # Inno Setup Windows installer script
└── DOCUMENTATION.md         # Full technical documentation
```

---

## API

The backend exposes a REST API at `/api/*`. Interactive docs are available at:

- Swagger UI: `http://localhost:8765/docs`
- ReDoc: `http://localhost:8765/redoc`

Key endpoint groups: `/api/auth`, `/api/clients`, `/api/projects`, `/api/invoices`, `/api/finance`, `/api/inventory`, `/api/hr`, `/api/crm`, `/api/reports`, and more.

---

## Building for Windows

Requires PyInstaller and Inno Setup (Windows only):

```bash
# Build standalone .exe
pyinstaller ERP.spec

# Package into installer (run installer.iss in Inno Setup)
```

---

## Backups

The system automatically creates daily and weekly SQLite backups in `backups/`. Each backup includes a `.sha256` checksum file for integrity verification. You can also trigger a manual backup from the Settings page in the app.

---

## License

Private — all rights reserved.