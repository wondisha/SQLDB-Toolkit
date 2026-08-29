@echo off
title SQLDB Toolkit Launcher
cd /d "%~dp0"

echo Starting SQLDB Toolkit...
start "" "SQLDB-Toolkit.exe"

:: Wait 1.5 seconds for the local HTTP server to bind
timeout /t 2 /nobreak >nul

echo Opening browser...
start http://localhost:4000

exit
