# Signal: швидкий запуск і діагностика

Цей документ описує, як підняти Signal-інтеграцію для проєкту через Docker та перевірити, що все працює.

## 1. Що використовується

- `docker-compose.signal.yml` підіймає:
  - `signal-cli-api` (образ `bbernhard/signal-cli-rest-api`)
  - `signal-bridge` (локальний адаптер з endpoint-ами для бота)
- Бот читає Signal через:
  - `SIGNAL_API_URL` (наприклад `http://localhost:3002`)
  - `SIGNAL_POLL_MS` (інтервал полінгу)

## 2. Підготовка `.env` бота

У файлі `.env` (корінь проєкту) встановіть:

```env
SIGNAL_API_URL=http://localhost:3002
SIGNAL_POLL_MS=5000
```

## 3. Підняти Docker сервіси

З кореня проєкту:

```bash
docker compose -f docker-compose.signal.yml up -d --build
```

Перевірити статус:

```bash
docker ps
```

Очікується, що `signal-cli-api` і `signal-bridge` мають статус `Up`.

## 4. Перевірка bridge API

В браузері:

- `http://localhost:3002/health`
- `http://localhost:3002/`

Очікувано:
- `/health` повертає `ok: true`
- `/` показує список endpoint-ів (`/health`, `/chats`, `/messages`, `/send`, `/link`)

## 5. Підключення Signal через QR в панелі

1. Запустіть бот (`node index.cjs` або ваш батник).
2. В панелі відкрийте: **Інтеграція -> Signal**.
3. Натисніть **Увійти (QR)**.
4. У Signal на телефоні: `Settings -> Linked devices -> Link new device`.
5. Відскануйте QR із панелі.

Після успіху оновіть:

- `http://localhost:3002/chats`

і перевірте, що список чатів не порожній.

## 6. Що тестувати після підключення

Перевірити маршрути:

- `Signal -> WhatsApp`
- `Signal -> Signal`
- `Signal -> FastAPI`
- `WhatsApp -> Signal`

У панелі автоматизацій:

- виберіть `Звідки`/`Куди`,
- задайте джерело(а),
- для цілі не `FastAPI` задайте `Куди надсилати`,
- збережіть і перевірте повідомлення.

## 7. Типові проблеми і рішення

### 7.1 `Link request error: Connection closed`

- Оновіть сторінку (`Ctrl+F5`), згенеруйте QR повторно.
- Переконайтесь, що запущений свіжий процес бота.
- Перевірте `http://localhost:3002/health`.
- Переконайтесь, що в `.env` **не увімкнено** `SIGNAL_LINK_ALLOW_DOCKER_FALLBACK=1` (штатно має бути `0`).

### 7.2 `/chats` повертає `signal-cli API is unavailable`

- Подивіться логи:
  - `docker logs signal-cli-api --tail 200`
  - `docker logs signal-bridge --tail 200`
- Перевірте, що `signal-cli-api` не падає в рестарт.

### 7.3 `/chats` повертає `Specified account does not exist`

- Signal-акаунт не прив’язаний у `signal-cli`.
- Зробіть лінкування через QR у панелі ще раз.

### 7.4 Порожній список чатів після успішного лінку

- Перевірте, що у Signal є реальні контакти/групи.
- Спробуйте оновити список у панелі кнопкою `Оновити`.
- Збільште `SIGNAL_POLL_MS` до `7000-10000`, якщо система перевантажена.

## 8. Корисні команди

```bash
# Перезапуск тільки bridge
docker compose -f docker-compose.signal.yml up -d --build signal-bridge

# Перезапуск усього стека
docker compose -f docker-compose.signal.yml down
docker compose -f docker-compose.signal.yml up -d --build

# Логи
docker logs signal-cli-api --tail 200
docker logs signal-bridge --tail 200
```

## 9. Де дивитись стан у UI

- **Інтеграція -> Signal**:
  - `Стан worker`
  - `Останній poll`
  - `Остання помилка`
  - `signalConsole` (технічний лог кнопки QR)
- **Інтеграція -> Загальні -> Журнал**:
  - серверні події (`Signal link request`, `Signal polling failed`, інші помилки)
