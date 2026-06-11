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

# ── Hand off to the ONE app definition (backend/main.py) ─────────────────────
# launcher and the server share a SINGLE FastAPI app — main.py is the sole
# source of truth for routers, middleware, error handlers and SPA serving. The
# launcher used to keep a parallel copy of all that, which is exactly how the
# imports router got missed here once. Now we only point main.py at the desktop's
# runtime settings via env vars it already honours, then import its `app`; any
# router added to main.py is automatically available in the desktop build too.
#
# These MUST be set before `import main`: main.py reads STATIC_DIR / ALLOWED_
# ORIGINS at module load and hard-exits if SECRET_KEY is missing.
os.environ.setdefault('STATIC_DIR', STATIC_DIR)              # serve the bundled SPA
os.environ.setdefault('ALLOWED_ORIGINS',                     # same-origin LAN URLs
                      f'http://localhost:{PORT},http://127.0.0.1:{PORT},http://{LAN_IP}:{PORT}')
if not os.environ.get('SECRET_KEY'):
    # The packaged build has no env vars; auth_utils loads-or-creates a key
    # persisted next to the DB. Surface it as SECRET_KEY so main.py's required
    # check passes while keeping the SAME key (sessions survive restarts).
    import auth_utils
    os.environ['SECRET_KEY'] = auth_utils.SECRET_KEY

try:
    import uvicorn

    # Defensive imports of shared, top-level backend modules that routers pull
    # in DYNAMICALLY (e.g. `import warehouse_access as wha` inside a function
    # body). PyInstaller's static analyser only reliably catches module-level
    # imports, so naming them here guarantees the frozen build bundles them.
    import warehouse_access as _wha    # noqa: F401 — row-level RBAC helper
    import accounting       as _acct   # noqa: F401 — double-entry posting engine
    import costing          as _cost   # noqa: F401 — FIFO/LIFO/weighted-average
    import lots             as _lots   # noqa: F401 — lot-tracked stock IO
    import backup_manager
    backup_manager.init(DB_PATH)

    # Importing main builds the app AND runs database.init_db() against DB_PATH
    # (set above), applying any pending migrations to the seeded/existing DB.
    from main import app

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
