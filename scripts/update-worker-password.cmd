@echo off
rem Double-click to update the MailVault worker's Windows password (after the account password changed).
rem Asks for administrator rights, then for the password.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-worker-password.ps1"
echo.
pause
