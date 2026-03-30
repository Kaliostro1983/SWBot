@echo off
setlocal

set LOGFILE=%~dp0install_log.txt
echo Installation started %date% %time% > "%LOGFILE%"
echo.
echo ============================================
echo   WS Bridge - Installation
echo ============================================
echo.

:: Check Node.js
node -v > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Install Node.js 18+ from https://nodejs.org
    echo ERROR: Node.js not found >> "%LOGFILE%"
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%
echo OK: Node.js %NODE_VER% >> "%LOGFILE%"

:: Check Git
git --version > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not found.
    echo         Install Git from https://git-scm.com
    echo ERROR: Git not found >> "%LOGFILE%"
    echo.
    pause
    exit /b 1
)
echo [OK] Git found
echo OK: Git found >> "%LOGFILE%"

:: Check Docker
docker --version > nul 2>&1
if errorlevel 1 (
    echo [WARN] Docker not found. Signal bridge will not work.
    echo        Install Docker Desktop: https://www.docker.com/products/docker-desktop
    echo WARN: Docker not found >> "%LOGFILE%"
) else (
    echo [OK] Docker found
    echo OK: Docker found >> "%LOGFILE%"
)

echo.

:: Install folder = SWBot subfolder next to this bat file
set INSTALL_DIR=%~dp0SWBot

if exist "%INSTALL_DIR%\.git" (
    echo [INFO] Folder exists, pulling latest changes...
    echo INFO: git pull >> "%LOGFILE%"
    cd /d "%INSTALL_DIR%"
    git pull >> "%LOGFILE%" 2>&1
    if errorlevel 1 (
        echo [ERROR] git pull failed. See install_log.txt
        echo ERROR: git pull failed >> "%LOGFILE%"
        pause
        exit /b 1
    )
    goto install_deps
)

:: Clone
echo Cloning repository...
echo INFO: cloning into %INSTALL_DIR% >> "%LOGFILE%"
git clone https://github.com/Kaliostro1983/SWBot.git "%INSTALL_DIR%" >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] Clone failed. See install_log.txt
    echo ERROR: git clone failed >> "%LOGFILE%"
    pause
    exit /b 1
)
echo [OK] Repository cloned
echo OK: cloned >> "%LOGFILE%"

:install_deps
cd /d "%INSTALL_DIR%"
echo INFO: dir=%CD% >> "%LOGFILE%"

echo.
echo Installing npm dependencies (1-3 min)...
set PUPPETEER_SKIP_DOWNLOAD=true
npm install --legacy-peer-deps --no-audit >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] npm install failed. See install_log.txt
    echo ERROR: npm install failed >> "%LOGFILE%"
    pause
    exit /b 1
)
echo [OK] Dependencies installed
echo OK: npm install done >> "%LOGFILE%"

:: Create .env
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" > nul
        echo [OK] Created .env from .env.example
        echo OK: .env created >> "%LOGFILE%"
    ) else (
        echo [WARN] .env.example not found. Create .env manually.
        echo WARN: no .env.example >> "%LOGFILE%"
    )
) else (
    echo [OK] .env already exists
    echo OK: .env exists >> "%LOGFILE%"
)

echo Installation finished %date% %time% >> "%LOGFILE%"

echo.
echo ============================================
echo   Done! Next steps:
echo ============================================
echo.
echo   1. Edit %INSTALL_DIR%\.env
echo      - set PANEL_PASSWORD
echo      - check SIGNAL_API_URL
echo.
echo   2. Edit docker-compose.signal.yml
echo      - set SIGNAL_ACCOUNT_NUMBER
echo.
echo   3. Run setup_docker.bat
echo   4. Run run_bot.bat
echo   5. Open http://localhost:3001
echo.
echo   Log: %~dp0install_log.txt
echo.
pause
endlocal
