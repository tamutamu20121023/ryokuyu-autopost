@echo off
cd /d "%~dp0"
echo Removing the scheduled posting task...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\unregister-scheduler-task.ps1
echo.
pause
