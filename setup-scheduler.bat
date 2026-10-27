@echo off
cd /d "%~dp0"
echo Registering the scheduled posting task...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-scheduler-task.ps1
echo.
pause
