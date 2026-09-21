@echo off
title Next.js App - Development Server
color 0A

echo ========================================
echo   Starting Next.js Development Server
echo ========================================
echo.

REM Get the directory where the batch file is located
cd /d "%~dp0"

REM Check if node_modules exists, if not install dependencies
if not exist "node_modules" (
    echo Dependencies not found. Installing...
    echo.
    call npm install
    echo.
    echo Installation complete!
    echo.
)

REM Start the development server on port 3010
echo Starting development server on port 3010...
echo.
echo Server will be available at: http://localhost:3010
echo Press Ctrl+C to stop the server
echo.
call npm run dev -- -p 3010

REM Keep window open if there's an error
if errorlevel 1 (
    echo.
    echo ========================================
    echo   Server stopped or encountered an error
    echo ========================================
    pause
)

