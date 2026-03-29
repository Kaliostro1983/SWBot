@echo off
chcp 65001 > nul

echo ============================================
echo   WS Bridge - Installation
echo ============================================
echo.

:: Check Node.js
node -v > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js 18+ from https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

:: Check Git
git --version > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not found.
    echo Please install Git from https://git-scm.com
    echo.
    pause
    exit /b 1
)
echo [OK] Git found

:: Check Docker
docker --version > nul 2>&1
if errorlevel 1 (
    echo [WARN] Docker not found. Signal bridge will not work.
    echo Install Docker Desktop from https://www.docker.com/products/docker-desktop
) else (
    echo [OK] Docker found
)

echo.

:: Determine install folder (same folder as this bat file)
set INSTALL_DIR=%~dp0SWBot
if exist "%INSTALL_DIR%" (
    echo [INFO] Folder already exists: %INSTALL_DIR%
    echo Pulling latest changes...
    cd /d "%INSTALL_DIR%"
    git pull
    goto install_deps
)

:: Clone repository
echo Cloning repository into %INSTALL_DIR% ...
git clone https://github.com/Kaliostro1983/SWBot.git "%INSTALL_DIR%"
if errorlevel 1 (
    echo [ERROR] Failed to clone repository.
    pause
    exit /b 1
)
echo [OK] Repository cloned

:install_deps
cd /d "%INSTALL_DIR%"

:: Install npm dependencies
echo.
echo Installing npm dependencies...
npm install --legacy-peer-deps
if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)
echo [OK] Dependencies installed

:: Create .env if missing
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" > nul
        echo [OK] Created .env from .env.example
        echo [!]  Edit .env and fill in your settings before starting.
    ) else (
        echo [WARN] No .env.example found. Create .env manually.
    )
) else (
    echo [OK] .env already exists
)

echo.
echo ============================================
echo   Installation complete!
echo ============================================
echo.
echo Next steps:
echo   1. Edit .env - set PANEL_PASSWORD and other settings
echo   2. Edit docker-compose.signal.yml - set SIGNAL_ACCOUNT_NUMBER
echo   3. Start Docker Desktop
echo   4. Run: docker compose -f docker-compose.signal.yml up -d
echo   5. Run: node index.cjs
echo   6. Open: http://localhost:3001
echo.
echo Full instructions: http://localhost:3001/deploy.html
echo.
pause
