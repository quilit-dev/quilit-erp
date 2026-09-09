# -*- mode: python ; coding: utf-8 -*-
#
# The site agent as a single .exe, so an office PC does not need Python.
#
# Deliberately NOT part of the ERP's own build. The ERP is a hosted web
# application with no installer of its own; this packages one small program
# that runs in a customer's office and talks to a fingerprint terminal. They share no
# code, ship on different schedules, and the agent must never drag pyzk into
# the ERP image.
#
# Build (on Windows, from this directory):
#     python -m pip install -r requirements.txt pyinstaller
#     python -m PyInstaller --noconfirm timeclock-agent.spec
#     # -> dist/timeclock-agent.exe
#
# onefile, not onedir: whoever installs this is following a printed page and
# copying one thing to one folder. A directory of DLLs beside it is a directory
# somebody will move half of.
#
# console=True on purpose. `--check` and `--dry-run` are how an installation is
# verified, and their output is the entire point -- a windowed build would run
# them into a void. The scheduled task runs it hidden anyway.

import os

block_cipher = None

a = Analysis(
    ['agent.py'],
    pathex=[],
    binaries=[],
    # config.example.ini rides along so a fresh install has something to copy
    # from, and the README so the troubleshooting steps are with the binary
    # rather than in a repository the customer cannot see.
    datas=[('config.example.ini', '.'), ('README.md', '.')],
    # pyzk imports these lazily; PyInstaller cannot see them by static analysis
    # and the exe would fail at the first device read without them.
    hiddenimports=['zk', 'zk.base', 'zk.user', 'zk.finger', 'zk.attendance',
                   'zk.const', 'zk.exception', 'requests'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Nothing here draws anything. Excluding the GUI and science stacks keeps
    # the binary small enough to email to a customer.
    excludes=['tkinter', 'matplotlib', 'numpy', 'pandas', 'PIL', 'PySide6',
              'PyQt5', 'PyQt6', 'scipy', 'fastapi', 'uvicorn'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='timeclock-agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX-packed binaries are what antivirus flags first
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
