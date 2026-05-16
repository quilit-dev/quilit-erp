# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules

uvicorn_datas, uvicorn_binaries, uvicorn_hiddenimports = collect_all('uvicorn')
fastapi_datas, fastapi_binaries, fastapi_hiddenimports = collect_all('fastapi')
anyio_datas,   anyio_binaries,   anyio_hiddenimports   = collect_all('anyio')

a = Analysis(
    ['launcher.py'],
    pathex=['.', 'backend'],
    binaries=uvicorn_binaries + fastapi_binaries + anyio_binaries,
    datas=[
        # Ship the entire backend folder as real files on disk next to the exe.
        # PyInstaller's pathex makes Python *find* the modules, but without datas
        # the .py files don't actually exist on disk — so sys.path tricks fail.
        ('backend',  'backend'),
        ('static',   'static'),
    ] + uvicorn_datas + fastapi_datas + anyio_datas,
    hiddenimports=[
        'fastapi', 'fastapi.middleware', 'fastapi.middleware.cors',
        'fastapi.responses',
        'starlette', 'starlette.middleware', 'starlette.middleware.cors',
        'starlette.responses', 'starlette.routing',
        'uvicorn', 'uvicorn.loops', 'uvicorn.loops.asyncio',
        'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan', 'uvicorn.lifespan.on',
        'anyio', 'anyio._backends._asyncio',
        'pydantic', 'pydantic.networks', 'pydantic.types', 'pydantic_core',
        'jwt', 'jwt.algorithms',
        'sqlite3', 'hashlib', 'hmac', 'base64',
        'multipart', 'python_multipart',
        'h11', 'httptools', 'websockets',
        'routers', 'routers.auth', 'routers.dashboard',
        'routers.clients', 'routers.projects', 'routers.quotations',
        'routers.inventory', 'routers.invoices', 'routers.finance',
        'routers.purchases', 'routers.settings', 'routers.recycle_bin',
        'routers.suppliers', 'routers.audit', 'routers.users', 'routers.roles',
        'routers.search',
        'database', 'auth_utils', 'backup_manager', 'permissions', 'utils',
    ] + uvicorn_hiddenimports + fastapi_hiddenimports + anyio_hiddenimports
      + collect_submodules('starlette')
      + collect_submodules('pydantic'),
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'pandas', 'PIL', 'cv2',
              'scipy', 'sklearn', 'torch', 'tensorflow'],
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
