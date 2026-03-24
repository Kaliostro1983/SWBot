# Signal Bridge (Docker)

Цей сервіс надає API, яке очікує ваш бот:

- `GET /chats`
- `GET /messages`
- `POST /send`

Всередині він проксить запити у `signal-cli-rest-api`.

## Швидкий запуск

1. Відредагуйте `docker-compose.signal.yml`:
   - `SIGNAL_ACCOUNT_NUMBER` — ваш номер Signal (у форматі `+380...`).
2. Підніміть сервіси:
   - `docker compose -f docker-compose.signal.yml up -d --build`
3. Перевірте health:
   - `http://localhost:3002/health`
4. У `.env` бота задайте:
   - `SIGNAL_API_URL=http://localhost:3002`

## Важливо

- Номер має бути зареєстрований у `signal-cli` контейнері.
- Якщо `GET /chats` або `GET /messages` повертають помилки, перевірте логи:
  - `docker logs signal-cli-api`
  - `docker logs signal-bridge`
