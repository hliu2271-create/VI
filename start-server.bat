@echo off
title ComputeShield Local Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found in PATH.
  echo   Please install Node.js first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo.
echo   ============================================
echo    ComputeShield local server is starting...
echo    Browser will open: http://127.0.0.1:8788/
echo    Keep this window OPEN. Close it to stop.
echo   ============================================
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:8788/"
node server\start.js
echo.
echo   Server exited. Press any key to close this window.
pause >nul
