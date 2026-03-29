@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Signal Docker — первинне налаштування
echo ============================================
echo.

:: Перевіряємо наявність Docker
docker --version >nul 2>&1
if errorlevel 1 (
    echo [ПОМИЛКА] Docker не знайдено.
    echo Завантажте та встановіть Docker Desktop:
    echo https://www.docker.com/products/docker-desktop/
    echo.
    pause
    exit /b 1
)

echo [OK] Docker знайдено:
docker --version
echo.

:: Перевіряємо що Docker запущений
docker info >nul 2>&1
if errorlevel 1 (
    echo [ПОМИЛКА] Docker Desktop не запущений.
    echo Запустіть Docker Desktop і спробуйте знову.
    echo.
    pause
    exit /b 1
)

echo [OK] Docker Desktop запущений.
echo.

:: Перевіряємо наявність docker-compose файлу
if not exist "docker-compose.signal.yml" (
    echo [ПОМИЛКА] Файл docker-compose.signal.yml не знайдено.
    echo Переконайтесь, що батник запускається з папки проєкту.
    echo.
    pause
    exit /b 1
)

:: Зупиняємо старі контейнери якщо є
echo Зупиняємо старі контейнери (якщо є)...
docker compose -f docker-compose.signal.yml down 2>nul
echo.

:: Збираємо та запускаємо контейнери
echo Збираємо та запускаємо контейнери...
echo (Перший запуск може тривати 2-5 хвилин — завантажується образ signal-cli-rest-api)
echo.
docker compose -f docker-compose.signal.yml up -d --build
if errorlevel 1 (
    echo.
    echo [ПОМИЛКА] Не вдалося запустити контейнери.
    echo Перегляньте помилки вище.
    echo.
    pause
    exit /b 1
)

echo.
echo Чекаємо поки контейнери стартують...
timeout /t 5 /nobreak >nul

:: Перевіряємо статус
echo.
echo Статус контейнерів:
docker compose -f docker-compose.signal.yml ps
echo.

:: Перевіряємо доступність bridge
echo Перевіряємо signal-bridge...
curl -s --max-time 10 http://localhost:3002/health >nul 2>&1
if errorlevel 1 (
    echo [УВАГА] signal-bridge ще не відповідає. Зачекайте хвилину і спробуйте запустити run_bot.bat
) else (
    echo [OK] signal-bridge доступний на http://localhost:3002
)

echo.
echo ============================================
echo   Готово! Тепер запустіть run_bot.bat
echo   щоб під'єднати Signal через QR-код.
echo ============================================
echo.
pause
