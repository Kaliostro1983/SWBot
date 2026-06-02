#!/usr/bin/env bash
#
# reset_docker.sh — перезапуск Signal-контейнерів SWBot з налаштуваннями проєкту.
#
# Запускати, коли в панелі Signal не підключається («connecting» довше хвилини).
# Скрипт перезапускає Docker-контейнери Signal (signal-cli-api + signal-bridge)
# з docker-compose.signal.yml і перезапускає сервіс swbot, щоб бот заново
# під'єднався до моста.
#
# Шлях до проєкту можна перевизначити першим аргументом або змінною SWBOT_DIR:
#   ./reset_docker.sh /custom/path/SWBot
#
set -euo pipefail

PROJECT_DIR="${1:-${SWBOT_DIR:-/home/shaen/Armor/SWBot}}"
COMPOSE_FILE="docker-compose.signal.yml"

if [ ! -f "$PROJECT_DIR/$COMPOSE_FILE" ]; then
  echo "✗ Не знайдено $PROJECT_DIR/$COMPOSE_FILE"
  echo "  Вкажіть правильний шлях: ./reset_docker.sh /шлях/до/SWBot"
  exit 1
fi

cd "$PROJECT_DIR"

echo "==> Зупиняю Signal-контейнери..."
docker compose -f "$COMPOSE_FILE" down

echo "==> Запускаю Signal-контейнери..."
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Чекаю 5 секунд на старт..."
sleep 5

# Перезапускаємо бота, щоб він заново під'єднався до Signal-моста.
# Сервіс swbot працює під цим користувачем, тому процес можна зупинити без sudo —
# systemd (Restart=always) автоматично підніме його за ~10 секунд із новим підключенням.
echo "==> Перезапускаю бота swbot (systemd підніме його автоматично)..."
if pkill -f "node index.cjs"; then
  echo "    Процес зупинено. systemd перезапустить swbot за ~10 секунд."
else
  echo "    (процес node не знайдено — можливо swbot уже перезапускається)"
fi

echo "==> Статус контейнерів Signal:"
docker ps --filter "name=signal" --format "    {{.Names}}\t{{.Status}}"

echo ""
echo "✓ Готово. Перевірте панель: http://localhost:3001 (Інтеграція → Signal)."
