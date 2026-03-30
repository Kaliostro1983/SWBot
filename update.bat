@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   WS Bridge - Update
echo ============================================
echo.

:: Check Git
git --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not found. Install from https://git-scm.com
    pause
    exit /b 1
)

:: Show current version
echo Current version:
git log -1 --format="  %%h  %%s  (%%ar)" 2>nul
echo.

:: Pull latest changes
echo Pulling latest changes...
git pull
if errorlevel 1 (
    echo.
    echo [ERROR] git pull failed.
    echo If you have local changes blocking the pull, run:
    echo   git stash
    echo   update.bat
    echo.
    pause
    exit /b 1
)
echo.

:: Install/update npm dependencies
echo Updating npm dependencies...
set PUPPETEER_SKIP_DOWNLOAD=true
npm install --legacy-peer-deps
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)
echo.

:: Check if signal-bridge was updated — rebuild container if so
git diff HEAD@{1} --name-only 2>nul | findstr /i "signal-bridge" >nul 2>&1
if not errorlevel 1 (
    echo [INFO] signal-bridge changed - rebuilding Docker container...
    docker --version >nul 2>&1
    if errorlevel 1 (
        echo [WARN] Docker not found, skipping container rebuild.
    ) else (
        docker info >nul 2>&1
        if errorlevel 1 (
            echo [WARN] Docker Desktop not running, skipping container rebuild.
        ) else (
            docker compose -f docker-compose.signal.yml up -d --build signal-bridge
            if errorlevel 1 (
                echo [WARN] Docker rebuild failed. Run setup_docker.bat manually.
            ) else (
                echo [OK] signal-bridge container rebuilt.
            )
        )
    )
    echo.
)

:: Show new version
echo Updated to:
git log -1 --format="  %%h  %%s  (%%ar)" 2>nul
echo.

echo ============================================
echo   Update complete. Restart run_bot.bat
echo ============================================
echo.
pause
endlocal
