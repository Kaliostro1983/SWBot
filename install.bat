@echo off
chcp 65001 > nul

echo ============================================
echo   WS Bridge - Installation
echo ============================================
echo.

:: Log file next to this bat
set LOGFILE=%~dp0install_log.txt
echo Installation started %date% %time% > "%LOGFILE%"

:: Check Node.js
node -v > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js 18+ from https://nodejs.org
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
    echo Please install Git from https://git-scm.com
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
    echo Install Docker Desktop from https://www.docker.com/products/docker-desktop
    echo WARN: Docker not found >> "%LOGFILE%"
) else (
    echo [OK] Docker found
    echo OK: Docker found >> "%LOGFILE%"
)

echo.

:: Determine install folder — subfolder SWBot next to this bat
set INSTALL_DIR=%~dp0SWBot

if exist "%INSTALL_DIR%\.git" (
    echo [INFO] Folder already exists, pulling latest changes...
    echo INFO: git pull in %INSTALL_DIR% >> "%LOGFILE%"
    cd /d "%INSTALL_DIR%"
    git pull >> "%LOGFILE%" 2>&1
    if errorlevel 1 (
        echo [ERROR] git pull failed. See install_log.txt for details.
        echo ERROR: git pull failed >> "%LOGFILE%"
        pause
        exit /b 1
    )
    goto install_deps
)

:: Clone repository
echo Cloning from https://github.com/Kaliostro1983/SWBot.git ...
echo INFO: cloning into %INSTALL_DIR% >> "%LOGFILE%"
git clone https://github.com/Kaliostro1983/SWBot.git "%INSTALL_DIR%" >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to clone repository.
    echo Check internet connection and that Git is working.
    echo See install_log.txt for details.
    echo ERROR: git clone failed >> "%LOGFILE%"
    pause
    exit /b 1
)
echo [OK] Repository cloned
echo OK: cloned >> "%LOGFILE%"

:install_deps
cd /d "%INSTALL_DIR%"
echo INFO: working dir %CD% >> "%LOGFILE%"

:: Install npm dependencies
echo.
echo Installing npm dependencies (may take 1-3 min)...
npm install --legacy-peer-deps >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] npm install failed.
    echo See install_log.txt for details.
    echo ERROR: npm install failed >> "%LOGFILE%"
    pause
    exit /b 1
)
echo [OK] Dependencies installed
echo OK: npm install done >> "%LOGFILE%"

:: Create .env if missing
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" > nul
        echo [OK] Created .env from .env.example - edit it before starting!
        echo OK: .env created from example >> "%LOGFILE%"
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
echo   Installation complete!
echo ============================================
echo.
echo Next steps:
echo   1. Open %INSTALL_DIR%
echo   2. Edit .env  ^(set PANEL_PASSWORD, check SIGNAL_API_URL^)
echo   3. Edit docker-compose.signal.yml  ^(set SIGNAL_ACCOUNT_NUMBER^)
echo   4. Run setup_docker.bat  ^(builds Signal containers^)
echo   5. Run run_bot.bat  ^(starts the service^)
echo   6. Open http://localhost:3001
echo.
echo Log saved to: %~dp0install_log.txt
echo.
pause
