@echo off
cd /d "%~dp0"
start "" node src/server.mjs
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
echo Server started. Open http://localhost:3000
echo To stop: close the node window or run: taskkill /F /IM node.exe
pause