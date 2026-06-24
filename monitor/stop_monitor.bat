@echo off
schtasks /end /tn "SWBotMonitor" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Моніторинг зупинено.
) else (
    echo [INFO] Задача не запущена або не знайдена.
)
pause
