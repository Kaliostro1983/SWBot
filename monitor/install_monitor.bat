@echo off
:: Встановлює monitor_server.ps1 у Планувальник завдань Windows.
:: Запускати від імені Адміністратора один раз.
:: Після цього моніторинг стартує автоматично при кожному вході в систему.

set "SCRIPT=%~dp0monitor_server.ps1"
set "TASKNAME=SWBotMonitor"

echo.
echo Встановлення завдання: %TASKNAME%
echo Скрипт: %SCRIPT%
echo.

schtasks /delete /tn "%TASKNAME%" /f >nul 2>&1

schtasks /create ^
  /tn "%TASKNAME%" ^
  /tr "powershell.exe -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%SCRIPT%\"" ^
  /sc onlogon ^
  /rl limited ^
  /f

if %errorlevel% equ 0 (
    echo.
    echo [OK] Завдання '%TASKNAME%' створено.
    echo      Запуститься автоматично при наступному вході в систему.
    echo.
    echo Запустити зараз?
    choice /c YN /m "Y=Так  N=Ні"
    if errorlevel 2 goto done
    schtasks /run /tn "%TASKNAME%"
    echo [OK] Запущено.
) else (
    echo [ПОМИЛКА] Не вдалося створити завдання.
    echo          Перевір що запускаєш від Адміністратора.
)

:done
echo.
pause
