# Register the Quilit time-clock agent as a Windows scheduled task.
#
# Run this ONCE, from an Administrator command prompt, in this folder:
#
#     powershell -ExecutionPolicy Bypass -File install-task.ps1
#
# A scheduled task rather than a Windows service, on purpose: a service needs a
# wrapper and an installer, while this needs neither and survives a reboot just
# as well. The agent runs its own loop, so the task starts it once at boot and
# Windows restarts it if it ever dies.

param(
    [string]$TaskName = "QuilitTimeClock",
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition

if (-not $PythonExe) {
    $found = Get-Command python -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-Error "Python is not on PATH. Install it from python.org and tick 'Add Python to PATH', or re-run with -PythonExe C:\path\to\python.exe"
    }
    $PythonExe = $found.Source
}

$agent = Join-Path $here "agent.py"
$config = Join-Path $here "config.ini"

if (-not (Test-Path $agent))  { Write-Error "agent.py is not beside this script." }
if (-not (Test-Path $config)) {
    Write-Error "config.ini does not exist yet. Copy config.example.ini to config.ini and fill it in first."
}

# Fail loudly here rather than in a log nobody reads at 6am: if the token or the
# device address is wrong, the person installing this is standing right there
# and can fix it.
Write-Host "Checking the ERP accepts this device token..."
& $PythonExe $agent --check
if ($LASTEXITCODE -ne 0) {
    Write-Error "The agent could not reach the ERP. Fix config.ini before installing the task."
}

$action = New-ScheduledTaskAction -Execute $PythonExe `
    -Argument "`"$agent`"" -WorkingDirectory $here

$trigger = New-ScheduledTaskTrigger -AtStartup

# RunLevel Limited: this only needs to read a file and talk to the network, and
# it holds a credential that can write attendance. It has no reason to be
# Administrator.
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" `
    -LogonType ServiceAccount -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Replacing the existing '$TaskName' task."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description "Reads the fingerprint terminal and sends punches to Quilit ERP." | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Installed. The agent is running now and will start again on every reboot."
Write-Host ""
Write-Host "  See it:    Task Scheduler, task '$TaskName'"
Write-Host "  Its log:   $(Join-Path $here 'agent.log')"
Write-Host "  Is it alive?  HR -> Time clock in the ERP shows 'Last seen'."
Write-Host ""
Write-Host "config.ini holds a token that can write to your ERP. Restrict who can read it."
