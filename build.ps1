<#
  build.ps1 — Build the ERP System Windows installer end to end.

  Pipeline:
    1. Vite        — build the React frontend          ->  static\
    2. PyInstaller — bundle launcher + backend (onedir) ->  dist\ERP System\
    3. Inno Setup  — compile the installer              ->  installer\Output\

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
    if (-not (Test-Path 'node_modules')) { npm install }
    npm run build
} finally { Pop-Location }
if (-not (Test-Path "$root\static\index.html")) {
    throw 'Frontend build failed — static\index.html was not produced.'
}

Write-Host ''
Write-Host '== 2/3  Bundling executable (PyInstaller) =====================' -ForegroundColor Cyan
if (Test-Path "$root\build") { Remove-Item "$root\build" -Recurse -Force }
if (Test-Path "$root\dist")  { Remove-Item "$root\dist"  -Recurse -Force }
python -m PyInstaller --noconfirm "$root\ERP.spec"
$appExe = "$root\dist\ERP System\ERP System.exe"
if (-not (Test-Path $appExe)) {
    throw "PyInstaller build failed — '$appExe' was not produced."
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
