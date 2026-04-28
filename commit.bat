@echo off
setlocal

cd /d "%~dp0"

echo === Git status ===
git status --short
echo.

if "%~1"=="" (
  set /p MSG="Commit message: "
) else (
  set MSG=%*
)

if "%MSG%"=="" (
  echo ERROR: Commit message is empty.
  pause
  exit /b 1
)

git add --ignore-errors index.cjs public\index.html signal-bridge\server.cjs
git add --ignore-errors install.bat update.bat setup_docker.bat commit.bat
git add --ignore-errors docker-compose.signal.yml
git add --ignore-errors public\deploy.html public\faq.html
git add --ignore-errors src\chat-directory\chatDirectory.js src\normalization\chatIdentity.js
git add --ignore-errors .gitignore

echo.
echo === Staged files ===
git diff --cached --name-only
echo.

git commit -m "%MSG%"
if %errorlevel% neq 0 (
  echo.
  echo ERROR: Commit failed.
  pause
  exit /b 1
)

echo.
echo Committed successfully.
echo.
git log --oneline -5
echo.
pause
endlocal
