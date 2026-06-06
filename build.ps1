<#
  build.ps1 — Build the ERP System Windows installer end to end.

  Pipeline:
    1. Vite        — build the React frontend           ->  static\
    1b. Seed DB    — snapshot live erp.db -> default.db  (bundled as default)
    2. PyInstaller — bundle launcher + backend (onedir)  ->  dist\ERP System\
    3. Inno Setup  — compile the installer               ->  installer\Output\

  One-time prerequisites:
    * Node.js                      https://nodejs.org
    * PyInstaller                  pip install pyinstaller
    * Inno Setup 6                 https://jrsoftware.org/isdl.php

  Usage (from the repo root, in PowerShell):
    .\build.ps1
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

Write-Host ''
Write-Host '== 1/3  Building frontend (Vite) ==============================' -ForegroundColor Cyan
Push-Location "$root\frontend_src"
try {
    if (-not (Test-Path 'node_modules')) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
if (-not (Test-Path "$root\static\index.html")) {
    throw 'Frontend build failed — static\index.html was not produced.'
}

Write-Host ''
Write-Host '== 1b/3 Seeding default database (snapshot of erp.db) =========' -ForegroundColor Cyan
# Produce default.db — the database that ships with the installer and is copied
# into APPDATA on a fresh install (see launcher.py). VACUUM INTO writes a fully
# checkpointed, defragmented copy, so any pending WAL is folded in and the
# template is self-contained and consistent.
$srcDb  = "$root\erp.db"
$seedDb = "$root\default.db"
if (Test-Path $srcDb) {
    if (Test-Path $seedDb) { Remove-Item $seedDb -Force }
    python -c "import sqlite3,sys; src,dst=sys.argv[1],sys.argv[2]; c=sqlite3.connect(src); c.execute('VACUUM INTO ?',(dst,)); c.close()" $srcDb $seedDb
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $seedDb)) {
        throw "Failed to create default.db from $srcDb (exit $LASTEXITCODE)."
    }
    Write-Host ('  default.db -> {0}  ({1:N1} MB)' -f $seedDb, ((Get-Item $seedDb).Length / 1MB)) -ForegroundColor Green
} else {
    Write-Host "  WARNING: $srcDb not found — installer will ship WITHOUT a seeded database (fresh installs start empty)." -ForegroundColor Yellow
}

Write-Host ''
Write-Host '== 2/3  Bundling executable (PyInstaller) =====================' -ForegroundColor Cyan
if (Test-Path "$root\build") { Remove-Item "$root\build" -Recurse -Force }
if (Test-Path "$root\dist")  { Remove-Item "$root\dist"  -Recurse -Force }
python -m PyInstaller --noconfirm "$root\ERP.spec"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)." }
$appExe = "$root\dist\ERP System\ERP System.exe"
if (-not (Test-Path $appExe)) {
    throw "PyInstaller build failed — '$appExe' was not produced."
}
# Guard: the seeded DB must have been bundled (catches a stale/cached dist).
if ((Test-Path $seedDb) -and -not (Test-Path "$root\dist\ERP System\_internal\default.db")) {
    throw "default.db was produced but did not get bundled into dist - aborting."
}

Write-Host ''
Write-Host '== 3/3  Compiling installer (Inno Setup) ======================' -ForegroundColor Cyan
$iscc = (Get-Command 'iscc.exe' -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
    foreach ($p in @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
        if (Test-Path $p) { $iscc = $p; break }
    }
}
if (-not $iscc) {
    throw 'Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php'
}
& $iscc "$root\installer\ERP-System.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed (exit code $LASTEXITCODE)." }

Write-Host ''
Write-Host 'BUILD COMPLETE.' -ForegroundColor Green
Get-ChildItem "$root\installer\Output\*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ('  Installer -> {0}  ({1:N1} MB)' -f $_.FullName, ($_.Length / 1MB)) -ForegroundColor Green
}
