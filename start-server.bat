@echo off
cd /d "%~dp0"
echo Starting server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
ping -n 2 127.0.0.1 >nul
start "RyokuyuServer" "C:\Program Files\nodejs\node.exe" src/server.mjs
ping -n 3 127.0.0.1 >nul
start "" http://localhost:3000
echo.
echo Server started. Browser should open automatically.
echo If not, open http://localhost:3000 manually.
echo.
echo To stop: close the "RyokuyuServer" window.
pause