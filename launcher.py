"""
ERP System Launcher
"""
import sys, os, time, socket, threading, webbrowser, traceback, shutil

NO_BROWSER = '--no-browser' in sys.argv

# Honour `backend/.env` exactly like `backend/main.py` does — without this,
# COOKIE_SECURE / SECRET_KEY / etc. silently fall back to defaults, and
# `Secure`-flagged cookies get dropped by browsers on plain-HTTP LAN access
# (the localhost-only exception means same-machine login still works,
# masking the bug until a second PC tries to connect).
try:
    from dotenv import load_dotenv
    _env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend', '.env')
    if os.path.exists(_env_path):
        load_dotenv(_env_path)
except ImportError:
    pass  # python-dotenv missing in a frozen build — env vars still work via OS

# ── Paths ──────────────────────────────────────────────────────────────────
# When frozen by PyInstaller (onedir / .app):
#   - Read-only bundled files (backend .py, static) live in sys._MEIPASS
#     because they are declared in datas[] in the spec.
#   - Writable files (erp.db, logs, backups) go to a per-user data dir so
#     they work even when the app is installed to a read-protected location
#     (Program Files on Windows, /Applications on macOS).
# When running from source (dev mode) everything stays next to this file.

FROZEN = getattr(sys, 'frozen', False)


def _user_data_dir(app_name='ERP System'):
    """Per-user writable data directory, using the right convention per OS:

      * Windows  → %APPDATA%\\ERP System
      * macOS    → ~/Library/Application Support/ERP System
      * Linux    → $XDG_DATA_HOME/ERP System  (or ~/.local/share/ERP System)

    Falls back to ~/ERP System if nothing else resolves. This keeps the
    customer's database out of the read-only app bundle on every platform.
    """
    if sys.platform == 'win32':
        base = os.environ.get('APPDATA') or os.path.expanduser('~')
    elif sys.platform == 'darwin':
        base = os.path.join(os.path.expanduser('~'), 'Library', 'Application Support')
    else:  # linux / other unix
        base = os.environ.get('XDG_DATA_HOME') or os.path.join(
            os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, app_name)


if FROZEN:
    BUNDLE_DIR = sys._MEIPASS
    DATA_DIR   = _user_data_dir()
else:
    BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_DIR   = BUNDLE_DIR

BACKEND_DIR = os.path.join(BUNDLE_DIR, 'backend')
STATIC_DIR  = os.path.join(BUNDLE_DIR, 'static')

# Writable files always go to DATA_DIR — safe on every Windows install location
DB_PATH  = os.environ.get('DB_PATH', os.path.join(DATA_DIR, 'erp.db'))
LOG_FILE = os.path.join(DATA_DIR, 'startup_log.txt')

# Create the writable data dir on first run
os.makedirs(DATA_DIR, exist_ok=True)

# Ship the current/populated database with the installer as a read-only
# template (`default.db`, bundled next to the backend via ERP.spec).
SEED_DB = os.path.join(BUNDLE_DIR, 'default.db')

os.environ['DB_PATH'] = DB_PATH
sys.path.insert(0, BACKEND_DIR)

# ── Logger ─────────────────────────────────────────────────────────────────
def log(msg):
    print(msg, flush=True)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(msg + '\n')
    except Exception:
        pass

log(f'\n=== ERP System {time.strftime("%Y-%m-%d %H:%M:%S")} ===')
log(f'Bundle dir : {BUNDLE_DIR}')
log(f'Data dir   : {DATA_DIR}')
log(f'Static dir : {STATIC_DIR}  exists={os.path.isdir(STATIC_DIR)}')
log(f'Backend dir: {BACKEND_DIR}  exists={os.path.isdir(BACKEND_DIR)}')
log(f'DB path    : {DB_PATH}')

# ── First-run database seeding ───────────────────────────────────────────────
# On the very first run — when no DB exists yet in DATA_DIR — copy the bundled
# template into place so a fresh install already contains the real data instead
# of an empty schema. On every later run the existing DB is left untouched, so
# upgrades and re-installs never clobber the customer's live data.
# `database.init_db()` (auto-run on import below) then applies any pending
# schema migrations to the copy idempotently.
if not os.path.exists(DB_PATH) and os.path.isfile(SEED_DB):
    try:
        shutil.copy2(SEED_DB, DB_PATH)
        # A freshly checkpointed template has no WAL sidecars; drop any stale
        # ones just in case so SQLite re-creates them cleanly against the copy.
        for _sfx in ('-wal', '-shm'):
            _stale = DB_PATH + _sfx
            if os.path.exists(_stale):
                os.remove(_stale)
        log(f'First run  : seeded DB from bundled template {SEED_DB}')
    except Exception:  # never let seeding block startup
        # If the copy fails, init_db() falls back to an empty seeded schema.
        log('First run  : seeding from template FAILED:\n' + traceback.format_exc())
else:
    log(f'Seed template: {SEED_DB}  exists={os.path.isfile(SEED_DB)}  '
        f'(skipped — DB already present={os.path.exists(DB_PATH)})')

# ── Port ───────────────────────────────────────────────────────────────────
PORT      = int(os.environ.get('PORT', 8765))
BIND_HOST = os.environ.get('BIND_HOST', '0.0.0.0')   # 0.0.0.0 = LAN accessible

def port_free(p):
    # Probe the SAME interface uvicorn will actually bind (BIND_HOST), not
    # 127.0.0.1. On Windows, binding 127.0.0.1:p succeeds even while another
    # process holds 0.0.0.0:p, so a loopback-only probe reports the port "free"
    # and uvicorn then dies with WinError 10048 ("only one usage of each socket
    # address"). Probing BIND_HOST matches uvicorn's real bind, so a busy port
    # is detected and we fall through to the next one.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind((BIND_HOST, p))
            return True
    except OSError:
        return False

for _ in range(20):
    if port_free(PORT):
        break
    PORT += 1
log(f'Port       : {PORT}')
log(f'Bind host  : {BIND_HOST}')

# Discover LAN IP for display
def _lan_ip():
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'

LAN_IP = _lan_ip()
log(f'LAN access : http://{LAN_IP}:{PORT}  (share this URL with office computers)')

try:
    from fastapi import FastAPI
    from fastapi.responses import FileResponse, Response
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn

    from routers import (auth, dashboard, clients, projects, quotations,
                         inventory, invoices, finance, purchases, settings,
                         archives, documents, suppliers, audit, users, roles, search, reports, crm, planning,
                         notifications, approval_policies, approval_requests, hr,
                         hr_contracts, recruitment, hr_activities,
                         tax_rates, pos, cash, manufacturing,
                         assets, recurring, announcements, attachments, accounting,
                         warehouses, platform, imports)
    import database
    import backup_manager
    # Defensive imports of shared, top-level backend modules that routers
    # pull in DYNAMICALLY (e.g. `import warehouse_access as wha` inside a
    # function body). PyInstaller's static analyser only reliably catches
    # module-level imports, so naming them here guarantees the frozen build
    # bundles them and the routers don't ImportError at runtime.
    #
    # IMPORTANT: aliased with `as _xxx` so they don't shadow router names from
    # the `from routers import (...)` block above. `routers.accounting` and
    # the top-level `accounting.py` (double-entry engine) are different
    # modules sharing the same short name — a plain `import accounting` here
    # rebinds the name and would break `accounting.router` below.
    import mailer            as _mailer  # noqa: F401 — registers email.send job
    import warehouse_access as _wha    # noqa: F401 — row-level RBAC helper
    import accounting       as _acct   # noqa: F401 — double-entry posting engine
    import costing          as _cost   # noqa: F401 — FIFO/LIFO/weighted-average
    import lots             as _lots   # noqa: F401 — lot-tracked stock IO
    backup_manager.init(DB_PATH)

    app = FastAPI(title='ERP System')
    # Restrict CORS to the exact origins this server is reachable on — the SPA
    # is served same-origin, so a wildcard policy is unnecessary and unsafe.
    app.add_middleware(CORSMiddleware,
                       allow_origins=[f'http://localhost:{PORT}',
                                      f'http://127.0.0.1:{PORT}',
                                      f'http://{LAN_IP}:{PORT}'],
                       allow_credentials=False, allow_methods=['*'], allow_headers=['*'])

    # Schema-per-tenant routing (Phase 2). Inert unless TENANCY=schema, so the
    # desktop / single-tenant install is unaffected.
    from tenancy import TenantMiddleware
    app.add_middleware(TenantMiddleware)

    # Bad-input safety net: known failures -> clean 4xx instead of 500.
    from error_handlers import register_error_handlers
    register_error_handlers(app)

    app.include_router(auth.router,               prefix='/api/auth')
    app.include_router(dashboard.router,          prefix='/api/dashboard')
    app.include_router(clients.router,            prefix='/api/clients')
    app.include_router(projects.router,           prefix='/api/projects')
    app.include_router(quotations.router,         prefix='/api/quotations')
    app.include_router(inventory.router,          prefix='/api/inventory')
    app.include_router(invoices.router,           prefix='/api/invoices')
    app.include_router(finance.router,            prefix='/api/finance')
    app.include_router(purchases.router,          prefix='/api/purchases')
    app.include_router(settings.router,           prefix='/api/settings')
    app.include_router(archives.router,           prefix='/api/archives')
    app.include_router(documents.router,          prefix='/api/documents')
    app.include_router(suppliers.router,          prefix='/api/suppliers')
    app.include_router(audit.router,              prefix='/api/audit')
    app.include_router(users.router,              prefix='/api/users')
    app.include_router(roles.router,              prefix='/api/roles')
    app.include_router(search.router,             prefix='/api/search')
    app.include_router(reports.router,            prefix='/api/reports')
    app.include_router(crm.router,               prefix='/api/crm')
    app.include_router(planning.router,           prefix='/api/planning')
    app.include_router(notifications.router,      prefix='/api/notifications')
    app.include_router(approval_policies.router,  prefix='/api/approval-policies')
    app.include_router(approval_requests.router,  prefix='/api/approval-requests')
    app.include_router(hr.router,                 prefix='/api/hr')
    app.include_router(hr_contracts.router,       prefix='/api/hr/contracts')
    app.include_router(recruitment.router,        prefix='/api/recruitment')
    app.include_router(hr_activities.router,      prefix='/api/hr-activities')
    app.include_router(tax_rates.router,          prefix='/api/tax-rates')
    app.include_router(pos.router,                prefix='/api/pos')
    app.include_router(cash.router,               prefix='/api/cash')
    app.include_router(manufacturing.router,      prefix='/api/manufacturing')
    app.include_router(assets.router,             prefix='/api/assets')
    app.include_router(recurring.router,          prefix='/api/recurring-expenses')
    app.include_router(announcements.router,      prefix='/api/announcements')
    app.include_router(attachments.router,        prefix='/api/attachments')
    app.include_router(accounting.router,         prefix='/api/accounting')
    app.include_router(warehouses.router,         prefix='/api/warehouses')
    app.include_router(platform.router,           prefix='/api/platform')
    app.include_router(imports.router,            prefix='/api/imports')

    @app.get('/api/health')
    def health():
        return {'status': 'ok', 'db': DB_PATH}

    NO_CACHE    = {'Cache-Control': 'no-store, no-cache, must-revalidate',
                   'Pragma': 'no-cache', 'Expires': '0'}
    STATIC_EXTS = ('.png','.jpg','.jpeg','.gif','.svg','.ico',
                   '.css','.js','.woff','.woff2','.ttf','.map','.webp')

    @app.get('/{full_path:path}')
    @app.get('/')
    def serve_spa(full_path: str = ''):
        if full_path.startswith('api/'):
            return Response('{"detail":"Not found"}', status_code=404,
                            media_type='application/json')
        if full_path:
            p = os.path.join(STATIC_DIR, full_path)
            if os.path.isfile(p):
                hdrs = {'Cache-Control': 'public, max-age=31536000, immutable'} \
                       if '/assets/' in full_path else {}
                return FileResponse(p, headers=hdrs)
            if any(full_path.endswith(e) for e in STATIC_EXTS):
                return Response(status_code=404)
        idx = os.path.join(STATIC_DIR, 'index.html')
        if os.path.exists(idx):
            return FileResponse(idx, headers=NO_CACHE)
        return Response(f'Frontend missing at {STATIC_DIR}', status_code=500)

    def open_browser():
        url = f'http://127.0.0.1:{PORT}'   # localhost for the server machine itself
        for _ in range(60):
            try:
                with socket.create_connection(('127.0.0.1', PORT), timeout=1):
                    break
            except OSError:
                time.sleep(0.25)
        webbrowser.open(url)

    if not NO_BROWSER:
        threading.Thread(target=open_browser, daemon=True).start()

    log('Server starting...')

    log_config = {
        'version': 1, 'disable_existing_loggers': False,
        'formatters': {'plain': {'format': '%(asctime)s %(levelname)s %(message)s'}},
        'handlers': {'h': {'class': 'logging.StreamHandler', 'formatter': 'plain',
                           'stream': 'ext://sys.stdout'}},
        'loggers': {
            'uvicorn':        {'handlers': ['h'], 'level': 'WARNING'},
            'uvicorn.error':  {'handlers': ['h'], 'level': 'WARNING'},
            'uvicorn.access': {'handlers': ['h'], 'level': 'WARNING'},
        },
    }
    try:
        uvicorn.run(app, host=BIND_HOST, port=PORT, log_config=log_config)
    except SystemExit as exc:
        # uvicorn raises SystemExit (not a normal Exception) when it cannot bind
        # the socket — e.g. the port is held by another program. Without this,
        # the process would exit silently and the console window would vanish
        # instantly. Re-raise as a clear error the outer handler will surface.
        raise RuntimeError(
            f'The web server could not start on {BIND_HOST}:{PORT} — that port '
            f'is already in use by another program. Close the other program, or '
            f'set the PORT environment variable to a free port, then try again.'
        ) from exc

except Exception:
    err = traceback.format_exc()
    log(f'\nFATAL ERROR:\n{err}')
    try:
        input('\nPress Enter to close...')
    except Exception:
        time.sleep(60)
    sys.exit(1)
