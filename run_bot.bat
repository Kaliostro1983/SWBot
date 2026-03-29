@echo off
cd /d "%~dp0"

echo ============================================
echo   WhatsApp / Signal Bot
echo ============================================
echo.

taskkill /F /FI "WINDOWTITLE eq node index.cjs" >nul 2>&1
for /f "tokens=5" %%p in ('netstat -aon 2^>nul ^| findstr ":3001 "') do taskkill /F /PID %%p >nul 2>&1

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Download from https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do echo Node.js %%v
echo.

if not exist node_modules (
    echo Installing npm dependencies...
    npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

docker info >nul 2>&1
if errorlevel 1 (
    echo [WARN] Docker is not running - Signal unavailable.
    echo.
) else (
    docker compose -f docker-compose.signal.yml ps --status running 2>nul | findstr "signal-bridge" >nul 2>&1
    if errorlevel 1 (
        echo Starting Signal containers...
        docker compose -f docker-compose.signal.yml up -d
        if errorlevel 1 (
            echo [WARN] Failed to start Signal containers.
        ) else (
            echo [OK] Signal containers started.
        )
    ) else (
        echo [OK] Signal containers already running.
    )
    echo.
)

echo Starting bot... (http://localhost:3001)
start "" http://localhost:3001
echo.

cmd /k node index.cjs
