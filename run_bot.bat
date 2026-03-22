@echo off
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

echo Starting WhatsApp bot control panel...
start "" http://localhost:3001

node index.cjs
pause