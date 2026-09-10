# Quilit time-clock agent -- installer for a PC with no Python on it.
#
# Run it by double-clicking Setup.cmd, which elevates and calls this.
#
# What it does, in order, and why that order:
#
#   1. copies timeclock-agent.exe into C:\Quilit\TimeClock
#   2. writes config.ini there, asking only for what it cannot guess
#   3. proves the ERP accepts the token          (--check)
#   4. proves the terminal answers on the network (--dry-run)
#   5. registers a scheduled task and starts it
#
# Steps 3 and 4 come BEFORE step 5 deliberately. A wrong token or a mistyped IP
# is a thing the person installing this can fix while they are standing there;
# discovered later it is a silent scheduled task, an empty attendance screen,
# and a phone call in a fortnight when somebody notices payroll is short.
#
# This is a scheduled task rather than a Windows service on purpose. A service
# needs a wrapper process and an uninstaller; a task survives a reboot just as
# well, is visible in a UI the customer already has, and can be removed by
# deleting one line.

param(
    [string]$TaskName  = "QuilitTimeClock",
    [string]$InstallTo = "C:\Quilit\TimeClock"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

function Say($text)  { Write-Host $text }
function Head($text) {
    Write-Host ""
    Write-Host ("-- " + $text + " " + ("-" * [Math]::Max(1, 68 - $text.Length))) -ForegroundColor Cyan
}
function Fail($text) {
    Write-Host ""
    Write-Host ("  " + $text) -ForegroundColor Red
    exit 1
}

# A question with the usual answer already in it. Enter accepts the default,
# which is the answer for every field except two.
function Ask($label, $default) {
    if ($default) { $prompt = "$label [$default]" } else { $prompt = $label }
    $value = Read-Host $prompt
    if ([string]::IsNullOrWhiteSpace($value)) { return $default }
    return $value.Trim()
}

# A question with NO default, because the wrong answer here is worse than no
# answer. 192.168.1.201 is ZKTeco's factory address: an unconfigured Ethernet
# menu shows it, so offering it as the default meant one Enter keypress could
# produce a config that looks right, matches what the device screen says, and
# points at nothing --- which is exactly what happens on a terminal that is
# actually on Wi-Fi.
function AskRequired($label) {
    while ($true) {
        $value = Read-Host $label
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
        Write-Host "    This one has no sensible default. Please type it." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  Quilit time clock -- setup" -ForegroundColor White
Write-Host "  =========================="

# ── 0. Is everything here? ───────────────────────────────────────────────────
$exeSource = Join-Path $here "timeclock-agent.exe"
if (-not (Test-Path $exeSource)) {
    Fail ("timeclock-agent.exe is not in this folder.`n" +
          "  Copy the whole folder you were sent, not just Setup.cmd.")
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "This needs to run as Administrator. Close this and double-click Setup.cmd instead."
}

# ── 1. Copy the program into place ───────────────────────────────────────────
Head "Installing to $InstallTo"

# Stop an older copy first, or the file is locked and the copy fails halfway.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Say "  An older agent is already installed. Stopping it first."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

if (-not (Test-Path $InstallTo)) {
    New-Item -ItemType Directory -Path $InstallTo -Force | Out-Null
}
$exe = Join-Path $InstallTo "timeclock-agent.exe"
Copy-Item -Path $exeSource -Destination $exe -Force
Say "  timeclock-agent.exe copied."

$readme = Join-Path $here "README.md"
if (Test-Path $readme) { Copy-Item $readme (Join-Path $InstallTo "README.md") -Force }

# ── 2. Settings ──────────────────────────────────────────────────────────────
$config = Join-Path $InstallTo "config.ini"
$shipped = Join-Path $here "config.ini"

$writeConfig = $true
if (Test-Path $shipped) {
    # Pre-filled by whoever prepared the folder. Nothing to ask.
    Copy-Item $shipped $config -Force
    $writeConfig = $false
    Head "Settings"
    Say "  Using the config.ini that came with this folder."
} elseif (Test-Path $config) {
    Head "Settings"
    Say "  This PC already has settings from a previous install."
    $again = Ask "  Type them in again? (y/N)" "n"
    if ($again -notmatch '^[Yy]') { $writeConfig = $false }
}

if ($writeConfig) {
    Head "The fingerprint terminal"
    Say "  Read the address off the interface the terminal is ACTUALLY using:"
    Say "     cabled    Menu > Comm > Ethernet"
    Say "     wireless  Menu > Comm > Wi-Fi   (e.g. BioPro SA40)"
    Say ""
    Say "  A terminal with both has an address for EACH. On a Wi-Fi terminal"
    Say "  the Ethernet menu often still shows 192.168.1.201 -- the factory"
    Say "  value, belonging to a socket with no cable in it. Using it means"
    Say "  the agent never finds the device, and nothing says why."
    Say ""
    Say "  It must be a FIXED address, or reserved on your router -- if the"
    Say "  router hands it a different one next month the agent stops finding it."
    Say ""
    $deviceIp   = AskRequired "  Device IP address (no default -- type it)"
    $devicePort = Ask "  Device port" "4370"
    $devicePass = Ask "  Comm key (Menu > Comm > Security; 0 unless changed)" "0"

    Head "Your Quilit workspace"
    $erpUrl = Ask "  ERP address" "https://app.quilit.dev"
    $erpUrl = $erpUrl.TrimEnd('/')
    $slug   = Ask "  Workspace name (the part before .quilit.dev when you sign in)" ""

    Say ""
    Say "  The device token comes from the ERP:"
    Say "     HR > Time clock > Devices > Add device"
    Say "  It is shown ONCE. If this window is open too long and you lose it,"
    Say "  use 'Rotate token' on that same screen and paste the new one."
    Say ""
    Say "  It is hidden as you paste it. Right-click pastes into this window."
    $secure = Read-Host "  Device token" -AsSecureString
    $bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ([string]::IsNullOrWhiteSpace($token)) { Fail "No token was entered. Nothing has been installed." }
    $token = $token.Trim()

    # start_date is deliberately left blank: the agent then starts from today.
    # These terminals hold years of history, and pulling it in would post
    # attendance into months that have already been paid.
    $lines = @(
        "; Written by Setup.cmd on $(Get-Date -Format 'yyyy-MM-dd HH:mm').",
        "; This file holds a token that can write attendance to your ERP.",
        "",
        "[timeclock]",
        "device_ip = $deviceIp",
        "device_port = $devicePort",
        "device_password = $devicePass",
        "",
        "erp_url = $erpUrl",
        "tenant_slug = $slug",
        "device_token = $token",
        "",
        "poll_seconds = 300",
        "start_date =",
        "timeout = 20"
    )
    Set-Content -Path $config -Value $lines -Encoding utf8
    Say ""
    Say "  Settings saved."
}

# The file holds a credential. Only the account that runs the agent (SYSTEM)
# and administrators have any business reading it.
$acl = Get-Acl $config
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
foreach ($who in @("SYSTEM", "Administrators")) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $who, "FullControl", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl -Path $config -AclObject $acl
Say "  config.ini locked to SYSTEM and Administrators."

# ── 3. Does the ERP accept this token? ───────────────────────────────────────
Head "Checking the ERP"
& $exe --check
if ($LASTEXITCODE -ne 0) {
    Fail ("The ERP did not accept this device.`n" +
          "  Nothing has been scheduled -- the agent is not running.`n`n" +
          "  Usually one of:`n" +
          "    * the token was pasted with a space, or is from another workspace`n" +
          "    * the workspace name is wrong`n" +
          "    * this PC has no internet`n`n" +
          "  Fix it and double-click Setup.cmd again.")
}

# ── 4. Does the terminal answer? ─────────────────────────────────────────────
Head "Checking the fingerprint terminal"
Say "  Reading the device. Nothing is sent to the ERP by this step."
& $exe --dry-run
if ($LASTEXITCODE -ne 0) {
    Fail ("The fingerprint terminal did not answer.`n" +
          "  Nothing has been scheduled -- the agent is not running.`n`n" +
          "  Usually one of:`n" +
          "    * the IP address is wrong (Menu > Comm > Ethernet, or Wi-Fi)`n" +
          "    * the terminal is on a different network from this PC`n" +
          "    * the comm key is not 0 and was not entered`n`n" +
          "  Fix it and double-click Setup.cmd again.")
}

# ── 5. Make it run by itself ─────────────────────────────────────────────────
Head "Setting it to run automatically"

$action  = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $InstallTo
$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM so it runs with nobody logged in -- an office PC sits at a lock screen
# most of the day. RunLevel Limited because reading a file and making two
# network calls is not work that needs Administrator.
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" `
    -LogonType ServiceAccount -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description "Reads the fingerprint terminal and sends punches to Quilit ERP." | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$state = (Get-ScheduledTask -TaskName $TaskName).State
Say "  Task '$TaskName' registered and started (state: $state)."

Write-Host ""
Write-Host "  Done. The clock is live." -ForegroundColor Green
Write-Host ""
Write-Host "  It is running now, and starts again by itself after a reboot."
Write-Host "  Punches are collected every 5 minutes."
Write-Host ""
Write-Host "  Where things are"
Write-Host "    Program and log   $InstallTo"
Write-Host "    Log file          $(Join-Path $InstallTo 'agent.log')"
Write-Host "    Windows task      Task Scheduler, '$TaskName'"
Write-Host ""
Write-Host "  Check it worked"
Write-Host "    In the ERP: HR > Time clock. 'Last seen' should show a time"
Write-Host "    from the last few minutes."
Write-Host ""
Write-Host "  Still to do in the ERP (once)"
Write-Host "    1. HR > Time clock > Employees -- match each device user to a"
Write-Host "       person, or their punches have nowhere to go."
Write-Host "    2. Settings > HR -- set Attendance source to 'Fingerprint"
Write-Host "       device' when you are ready for it to fill in attendance."
Write-Host "       Punches are recorded either way, so you can watch it for a"
Write-Host "       week before anything you read is computed from it."
Write-Host ""
exit 0
