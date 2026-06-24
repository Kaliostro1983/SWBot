@echo off
schtasks /end /tn "SWBotMonitor" >nul 2>&1
schtasks /delete /tn "SWBotMonitor" /f >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Задачу "SWBotMonitor" видалено з Планувальника завдань.
    echo      Щоб відновити — запустіть install_monitor.bat
) else (
    echo [INFO] Задача не знайдена (вже видалена або не була встановлена).
)
pause
