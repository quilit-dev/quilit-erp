@echo off
rem ============================================================================
rem  Quilit time clock -- remove
rem
rem  Stops the agent and removes the scheduled task.
rem
rem  It deliberately LEAVES C:\Quilit\TimeClock alone. agent.log is the record
rem  of what the clock did and config.ini holds settings somebody spent time
rem  getting right; neither is ours to delete because a task is being removed.
rem  Delete the folder by hand if that is what you meant.
rem
rem  Punches already sent to the ERP stay in the ERP. This removes the collector,
rem  not the attendance.
rem ============================================================================

setlocal

net session >nul 2>&1
if errorlevel 1 (
    echo Asking Windows for permission...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',('\"%~f0\"') -Verb RunAs"
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$t='QuilitTimeClock';" ^
    "if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {" ^
    "  Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue;" ^
    "  Unregister-ScheduledTask -TaskName $t -Confirm:$false;" ^
    "  Write-Host '  Removed. The agent is no longer running or starting at boot.'" ^
    "} else { Write-Host '  Nothing to remove -- no such task on this PC.' }"

echo.
echo   C:\Quilit\TimeClock was left in place (log and settings).
echo.
pause
