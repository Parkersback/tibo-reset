@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-site.ps1" %*
set "launcherExitCode=%ERRORLEVEL%"

if not "%launcherExitCode%"=="0" (
    echo.
    echo Tibo Reset failed to start. Review the error above.
    pause >nul
)

exit /b %launcherExitCode%
