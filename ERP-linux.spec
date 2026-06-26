# -*- mode: python ; coding: utf-8 -*-
#
# Linux build spec — produces a PyInstaller onedir under dist/erp-system/.
# This is the Linux counterpart to ERP.spec (Windows) and ERP-mac.spec (macOS).
# The Analysis / hiddenimports / datas are identical to those specs; the only
# Linux-specific choices are:
#
#   * name='erp-system'    — a space-free binary name. The AppImage/.desktop
#                            tooling uses this as the Exec= target, and spaces
#                            in that field are a constant source of breakage.
#   * console=False        — windowed launch. (On Linux this flag is largely
#                            cosmetic; the launcher writes startup_log.txt to
#                            ~/.local/share/ERP System/ so diagnostics survive
#                            regardless of how it was started.)
#   * no BUNDLE(...)       — that step is macOS-only (.app). On Linux the
#                            onedir folder is wrapped into an AppImage by the
#                            CI workflow instead.
#
# Build (ON LINUX — PyInstaller cannot cross-compile from Windows/macOS):
#     python -m PyInstaller --noconfirm ERP-linux.spec
#     # → dist/erp-system/   (the "erp-system" executable + _internal/ payload)
#
# The GitHub Actions workflow (.github/workflows/build-linux.yml) runs this on
# an ubuntu runner and wraps the onedir into a portable .AppImage (plus a
# plain .tar.gz fallback) for distribution.

import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

uvicorn_datas, uvicorn_binaries, uvicorn_hiddenimports = collect_all('uvicorn')
fastapi_datas, fastapi_binaries, fastapi_hiddenimports = collect_all('fastapi')
anyio_datas,   anyio_binaries,   anyio_hiddenimports   = collect_all('anyio')

# Ship the populated database as a read-only template (`default.db`). The CI
# workflow produces it from the freshly-seeded erp.db via `VACUUM INTO` just
# before this spec runs; the launcher copies it into the per-user data dir on
# first launch. Included only if present so a clean checkout still builds.
seed_db_datas = [('default.db', '.')] if os.path.exists('default.db') else []

a = Analysis(
    ['launcher.py'],
    pathex=['.', 'backend'],
    binaries=uvicorn_binaries + fastapi_binaries + anyio_binaries,
    datas=[
        ('backend', 'backend'),
        ('static',  'static'),
    ] + seed_db_datas + uvicorn_datas + fastapi_datas + anyio_datas,
    hiddenimports=[
        # FastAPI / Starlette
        'fastapi', 'fastapi.middleware', 'fastapi.middleware.cors',
        'fastapi.responses', 'fastapi.staticfiles',
        'starlette', 'starlette.middleware', 'starlette.middleware.cors',
        'starlette.responses', 'starlette.routing', 'starlette.staticfiles',

        # Uvicorn
        'uvicorn', 'uvicorn.loops', 'uvicorn.loops.asyncio',
        'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan', 'uvicorn.lifespan.on',

        # Async / networking
        'anyio', 'anyio._backends._asyncio',
        'h11', 'httptools', 'websockets',

        # Pydantic
        'pydantic', 'pydantic.networks', 'pydantic.types', 'pydantic_core',

        # Auth
        'jwt', 'jwt.algorithms',
        'python_dotenv', 'dotenv',

        # File uploads
        'multipart', 'python_multipart',

        # Stdlib used explicitly
        'sqlite3', 'hashlib', 'hmac', 'base64',
        'socket', 'threading', 'webbrowser', 'traceback',

        # Backend core modules
        'database', 'db_compat', 'dialect', 'tenancy', 'tenant_context', 'storage', 'auth_utils', 'backup_manager', 'permissions', 'utils',
        'approval_engine',
        # Shared helpers routers import dynamically (function-level imports
        # PyInstaller's static analyser can miss):
        'warehouse_access', 'accounting', 'costing', 'lots', 'currency',
        # SaaS infra wrappers (default backends are no-ops; redis/rq/boto3 stay
        # lazy so they are NOT pulled into the desktop bundle):
        'storage', 'cache', 'jobs', 'mailer', 'email_templates',

        # All routers (keep in sync with launcher.py imports)
        'routers',
        'routers.auth',
        'routers.dashboard',
        'routers.clients',
        'routers.projects',
        'routers.quotations',
        'routers.inventory',
        'routers.invoices',
        'routers.finance',
        'routers.purchases',
        'routers.settings',
        'routers.archives',
        'routers.documents',
        'routers.suppliers',
        'routers.audit',
        'routers.users',
        'routers.roles',
        'routers.search',
        'routers.reports',
        'routers.crm',
        'routers.planning',
        'routers.recycle_bin',
        'routers.notifications',
        'routers.approval_policies',
        'routers.approval_requests',
        'routers.hr',
        'routers.warehouses',
        'routers.platform',
        'routers.imports',
        'routers.products',
        'routers.promotions',
    ] + uvicorn_hiddenimports + fastapi_hiddenimports + anyio_hiddenimports
      + collect_submodules('starlette')
      + collect_submodules('pydantic'),
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'numpy', 'pandas', 'PIL', 'cv2',
        'scipy', 'sklearn', 'torch', 'tensorflow',
        'IPython', 'notebook', 'pytest',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='erp-system',      # space-free — used as the AppImage Exec= target
    debug=False,
    strip=False,
    upx=False,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='erp-system',
)
