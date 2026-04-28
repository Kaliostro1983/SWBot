@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   SWBot — Чистий старт (скидання сесій)
echo ============================================
echo.
echo Буде видалено:
echo   .wwebjs_auth\              (WhatsApp сесія)
echo   .wwebjs_cache\             (Chrome кеш)
echo   logs\                      (логи)
echo   data\chat-directory.json   (кеш чатів)
echo   data\signal-chats-cache.json
echo   data\whatsapp-chats-cache.json
echo.
echo Збережеться: flows.json, налаштування панелі
echo.
set /p CONFIRM="Продовжити? (y/N): "
if /i not "%CONFIRM%"=="y" (
  echo Скасовано.
  pause
  exit /b 0
)

echo.
echo [1/3] Зупиняємо orphaned Chrome...
powershell -NonInteractive -Command ^
  "$procs = Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*wwebjs_auth*' }; $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; if ($procs) { Start-Sleep -Seconds 2 }"
echo    Готово.

echo [2/3] Видаляємо файли сесій та кешу...
if exist .wwebjs_auth  rmdir /s /q .wwebjs_auth
if exist .wwebjs_cache rmdir /s /q .wwebjs_cache
if exist logs          rmdir /s /q logs
if exist data\chat-directory.json        del /q data\chat-directory.json
if exist data\signal-chats-cache.json    del /q data\signal-chats-cache.json
if exist data\whatsapp-chats-cache.json  del /q data\whatsapp-chats-cache.json
echo    Готово.

echo [3/3] Перевірка...
if exist .wwebjs_auth (
  echo    УВАГА: .wwebjs_auth не вдалося видалити — Chrome ще живий?
) else (
  echo    .wwebjs_auth — видалено
)
if exist .wwebjs_cache (
  echo    УВАГА: .wwebjs_cache не вдалося видалити
) else (
  echo    .wwebjs_cache — видалено
)

echo.
echo ============================================
echo   Готово! Тепер запустіть бота:
echo     node index.cjs
echo   При першому запуску з'явиться QR-код.
echo ============================================
echo.
pause
endlocal
