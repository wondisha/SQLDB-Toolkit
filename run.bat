@echo off
title SQLDB Toolkit Ops Console
cd /d "%~dp0"

echo ========================================
echo  Starting SQLDB Toolkit Backend Service
echo ========================================

start "SQLDB Toolkit Backend" cmd /k "SQLDB-Toolkit.exe"

echo Waiting for backend server on port 4000...
timeout /t 3 /nobreak >nul

echo Opening SQLDB Toolkit in browser...
start http://localhost:4000

exit
