# Build the thing you actually send a customer.
#
#     powershell -ExecutionPolicy Bypass -File build-release.ps1
#
# Produces  release\QuilitTimeClock\  and  release\QuilitTimeClock.zip
# containing exactly five files: the agent, the two double-click scripts, the
# installer they call, and the README.
#
# Run it on Windows. A PyInstaller build is not cross-platform -- the exe has to
# be produced on the OS it will run on.
#
# The one thing this script guards hardest is that **config.ini never ships**.
# The developer's own config.ini sits in this folder and holds a live device
# token; shipping it would hand one customer another customer's credential, and
# would also silently skip the setup questions on their PC. The assertion at the
# end is not paranoia, it is the failure that would be least visible.

param([switch]$SkipDeps)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $here

function Head($t) { Write-Host ""; Write-Host ("== " + $t) -ForegroundColor Cyan }

if (-not $SkipDeps) {
    Head "Dependencies"
    python -m pip install -q -r requirements.txt pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
}

Head "Building timeclock-agent.exe"
python -m PyInstaller --noconfirm --clean timeclock-agent.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$exe = Join-Path $here "dist\timeclock-agent.exe"
if (-not (Test-Path $exe)) { throw "PyInstaller reported success but produced no exe" }

Head "Smoke-testing the binary"
# --help needs no config, no device and no network, and still exercises the
# whole frozen import graph. A missing hiddenimport dies here rather than at a
# customer's first punch.
& $exe --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw "the built exe cannot even print its own help" }
Write-Host "  the exe runs."

Head "Assembling the folder to send"
$out = Join-Path $here "release\QuilitTimeClock"
if (Test-Path (Join-Path $here "release")) {
    Remove-Item (Join-Path $here "release") -Recurse -Force
}
New-Item -ItemType Directory -Path $out -Force | Out-Null

foreach ($f in @("Setup.cmd", "Uninstall.cmd", "install-agent.ps1", "README.md")) {
    Copy-Item (Join-Path $here $f) (Join-Path $out $f) -Force
}
Copy-Item $exe (Join-Path $out "timeclock-agent.exe") -Force

# The guard. Not a warning -- a failure.
#
# config.ini is the dangerous one: it holds a live device token, and shipping
# it would also skip the setup questions on the customer's PC. agent.log and
# state.json are merely embarrassing --- a log of another site's punches, and a
# cursor that would make a fresh install think it had already collected them.
foreach ($name in @("config.ini", "agent.log", "state.json")) {
    $leaked = Get-ChildItem $out -Recurse -Filter $name -ErrorAction SilentlyContinue
    if ($leaked) {
        throw ("$name reached the release folder. Nothing from a working " +
               "install may ship. Aborting.")
    }
}

$zip = Join-Path $here "release\QuilitTimeClock.zip"
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip -Force

$size = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "  release\QuilitTimeClock.zip  ($size MB)" -ForegroundColor Green
Get-ChildItem $out | ForEach-Object { Write-Host ("    " + $_.Name) }
Write-Host ""
Write-Host "  Send the ZIP. Send the device token separately -- read it to them,"
Write-Host "  or have them read it off their own screen. Not in the same email."
Write-Host ""
