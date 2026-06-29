# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

uvicorn_datas, uvicorn_binaries, uvicorn_hiddenimports = collect_all('uvicorn')
fastapi_datas, fastapi_binaries, fastapi_hiddenimports = collect_all('fastapi')
anyio_datas,   anyio_binaries,   anyio_hiddenimports   = collect_all('anyio')

# Ship the current/populated database as a read-only template (`default.db`).
# build.ps1 produces it from the live erp.db via `VACUUM INTO` just before this
# spec runs; the launcher copies it into APPDATA on first run. Included only if
# present, so a clean checkout without a database still builds (the app then
# starts with an empty, freshly-seeded schema).
seed_db_datas = [('default.db', '.')] if os.path.exists('default.db') else []

a = Analysis(
    ['launcher.py'],
    pathex=['.', 'backend'],
    binaries=uvicorn_binaries + fastapi_binaries + anyio_binaries,
    datas=[
        # Ship the entire backend folder as real files on disk next to the exe.
        # PyInstaller's pathex makes Python *find* the modules, but without datas
        # the .py files don't actually exist on disk — so sys.path tricks fail.
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
        # Shared helpers that routers import dynamically (function-level
        # imports that PyInstaller's static analyser can miss):
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
        'routers.categories',
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
    name='ERP System',
    debug=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='ERP System',
)
