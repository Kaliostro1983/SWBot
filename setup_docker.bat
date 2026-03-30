@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Signal Docker Setup
echo ============================================
echo.

:: Check Docker installed
docker --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker not found.
    echo Install Docker Desktop: https://www.docker.com/products/docker-desktop/
    echo.
    pause
    exit /b 1
)
echo [OK] Docker found

:: Check Docker running
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Desktop is not running.
    echo Start Docker Desktop and try again.
    echo.
    pause
    exit /b 1
)
echo [OK] Docker Desktop is running
echo.

:: Check compose file
if not exist "docker-compose.signal.yml" (
    echo [ERROR] docker-compose.signal.yml not found.
    echo Run this bat from the project folder.
    echo.
    pause
    exit /b 1
)

:: Stop and remove old containers by name (in case they exist from a previous run)
echo Stopping old containers if any...
docker stop signal-cli-api >nul 2>&1
docker stop signal-bridge >nul 2>&1
docker rm signal-cli-api >nul 2>&1
docker rm signal-bridge >nul 2>&1
echo.

:: Build and start containers
echo Building and starting containers...
echo (First run may take 2-5 min to download signal-cli-rest-api image)
echo.
docker compose -f docker-compose.signal.yml up -d --build
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start containers.
    echo See errors above.
    echo.
    pause
    exit /b 1
)

echo.
echo Waiting for containers to start...
timeout /t 5 /nobreak >nul

echo.
echo Container status:
docker compose -f docker-compose.signal.yml ps

echo.
curl -s --max-time 10 http://localhost:3002/health >nul 2>&1
if errorlevel 1 (
    echo [WARN] signal-bridge not responding yet.
    echo Wait 1 minute then run run_bot.bat
) else (
    echo [OK] signal-bridge is up at http://localhost:3002
)

echo.
echo ============================================
echo   Done! Now run run_bot.bat
echo ============================================
echo.
pause
endlocal
