@echo off
rem ============================================================================
rem  Quilit time clock -- setup
rem
rem  Double-click this file. That is the whole instruction.
rem
rem  It exists because the person installing this is an office manager standing
rem  at a PC, not an engineer at a shell. Windows will ask for permission once
rem  (registering a task that survives a reboot needs it); everything after that
rem  is questions with sensible answers already filled in.
rem
rem  A .cmd rather than a .ps1 because double-clicking a .ps1 opens Notepad on a
rem  default Windows install, which looks like nothing happened.
rem ============================================================================

setlocal
set "HERE=%~dp0"

if not exist "%HERE%install-agent.ps1" (
    echo.
    echo   install-agent.ps1 is missing from this folder.
    echo   Copy the WHOLE folder you were sent, not just this file.
    echo.
    pause
    exit /b 1
)

rem Re-launch elevated. -Verb RunAs raises the one UAC prompt; without it the
rem scheduled task cannot be registered and the failure arrives 40 lines later,
rem after the installer has already asked for the token.
net session >nul 2>&1
if errorlevel 1 (
    echo Asking Windows for permission...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',('\"%~f0\"') -Verb RunAs"
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install-agent.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo   Setup finished.
) else (
    echo   Setup did not finish. Nothing was left running.
    echo   Read the message above -- it says which part failed.
)
echo.
pause
exit /b %RC%
