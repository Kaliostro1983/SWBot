# Розгортання та інфраструктура

Цей документ описує серверне середовище, сервіси та процедури розгортання проєкту.
Прикріпіть його до нового діалогу з AI разом з `docs/PROJECT.md`, щоб агент швидко зорієнтувався.

---

## 1. Інфраструктура

| Параметр | Значення |
|----------|----------|
| Сервер | `ocheret-63` |
| ОС | Ubuntu 24.04 LTS |
| Tailscale IP | `100.120.93.120` |
| Доступ | SSH через Tailscale: `ssh shaen@100.120.93.120` |
| Користувач | `shaen` |

> **sudo:** passwordless sudo (`sudo -n`) для `systemctl` через SSH **недоступне** (вимагає пароль) — попри окремі інструкції, що стверджують протилежне. Перезапуск сервісу робиться **без sudo** через `pkill` (див. розділ 4). Docker-команди працюють без sudo (користувач `shaen` у групі `docker`).

---

## 2. Розташування проєктів

| Проєкт | Шлях |
|--------|------|
| SWBot (Node.js бот) | `~/Armor/SWBot` |
| radio_63ombr (FastAPI) | `~/Armor/radio_63ombr` |

---

## 3. Встановлене ПЗ

| Компонент | Версія |
|-----------|--------|
| Node.js | v20.20.2 |
| npm | 10.8.2 |
| Python | 3.12.3 |
| Docker | встановлено |

---

## 4. Systemd сервіси

Обидва сервіси запускаються автоматично після перезавантаження.

### swbot.service — SWBot

```bash
# Статус
systemctl status swbot --no-pager | head -20

# Логи
journalctl -u swbot -f --no-pager
```

Файл: `/etc/systemd/system/swbot.service`

```ini
[Unit]
Description=SWBot WhatsApp-Signal Bridge
After=network.target docker.service
Requires=docker.service

[Service]
User=shaen
WorkingDirectory=/home/shaen/Armor/SWBot
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Перезапуск/деплой коду (без sudo).** Оскільки сервіс працює під `shaen` і має `Restart=always`, перезавантаження виконується вбивством node-процесу — systemd підніме його заново (~10 с) з новим кодом:

```bash
# 1. scp оновлені файли у ~/Armor/SWBot/...
# 2. перезавантажити код:
pkill -f "node index.cjs"
sleep 14
systemctl is-active swbot   # очікувано: active
```

> `sudo systemctl restart swbot` **не спрацює** через SSH (потрібен пароль). Використовуйте `pkill`.

### radio63.service — FastAPI

```bash
systemctl status radio63 --no-pager | head -20
journalctl -u radio63 -f --no-pager
```

Файл: `/etc/systemd/system/radio63.service`

```ini
[Unit]
Description=Radio 63 FastAPI
After=network.target

[Service]
User=shaen
WorkingDirectory=/home/shaen/Armor/radio_63ombr
ExecStart=/home/shaen/Armor/radio_63ombr/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

---

## 5. Docker (Signal bridge)

Signal bridge запускається через Docker Compose (без sudo).

```bash
cd ~/Armor/SWBot

# Запуск
docker compose -f docker-compose.signal.yml up -d

# Перезапуск
docker compose -f docker-compose.signal.yml restart

# Логи
docker logs signal-bridge --tail 100
docker logs signal-cli-api --tail 100

# Зупинка
docker compose -f docker-compose.signal.yml down
```

Контейнери: `signal-cli-api`, `signal-bridge` (порт `3002`).

**Швидкий ресет при проблемах Signal:** на робочому столі сервера є `~/Desktop/reset_docker.sh` — перезапускає контейнери Signal з compose-файлу проєкту і перезавантажує бота (через `pkill`, без sudo).

---

## 6. Порти

| Сервіс | Порт |
|--------|------|
| SWBot панель | `3001` |
| FastAPI (radio_63ombr) | `8000` |
| Signal bridge | `3002` |

Веб-панель SWBot доступна з Windows за адресою: `http://100.120.93.120:3001`

---

## 7. Змінні середовища

### SWBot (`~/Armor/SWBot/.env`)

```env
PORT=3001
FASTAPI_URL=http://127.0.0.1:8000/api/ingest/whatsapp
SOURCE_CHAT=120363425828018712@g.us
TARGET_CHAT=120363407577191397@g.us
SEND_PREFIX=#go
SEND_DELAY_MS=2000
OPEN_BROWSER=1
HEADLESS=1
SIGNAL_RAW_CAPTURE=1
PANEL_USER=
PANEL_PASSWORD=
SIGNAL_API_URL=http://localhost:3002
SIGNAL_POLL_MS=1000
SIGNAL_CHATS_TIMEOUT_MS=120000
```

> Повний перелік змінних — у `docs/PROJECT.md` (розділ 4) і `CLAUDE.md`. `.env` **не комітиться** — перед заміною забирайте поточну копію й порівнюйте, щоб не затерти секрети.

### radio_63ombr (`~/Armor/radio_63ombr/.env`)

Скопійовано з `config.env.example`. Значення за замовчуванням.

---

## 8. Деплой оновлень (з Windows)

Локальна копія: `D:\Armor\SWBot`. Ключ SSH: `C:\Users\StoicX\.ssh\new_agent_key` (передавати `-i` явно).

```bash
KEY="$USERPROFILE/.ssh/new_agent_key"
H="shaen@100.120.93.120"

# 1. Перенести файли (структура зберігається):
scp -i "$KEY" index.cjs "$H:Armor/SWBot/index.cjs"
scp -i "$KEY" public/index.html "$H:Armor/SWBot/public/index.html"

# 2. Перезавантажити код (без sudo) і перевірити:
ssh -i "$KEY" "$H" '
  cd ~/Armor/SWBot && node --check index.cjs &&
  pkill -f "node index.cjs"; sleep 14;
  systemctl is-active swbot;
  curl -s -m 6 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/push/accounts'
```

**Чек-лист:**
- Перед перезаписом: звірити, що git HEAD на сервері = локальному і робоче дерево чисте (`git -C ~/Armor/SWBot status --short`), щоб scp не затер серверні зміни.
- Для нових залежностей: `scp package.json package-lock.json` + `npm ci --omit=dev`.
- Після рестарту: `systemctl is-active swbot` = `active` **і** HTTP `200` на `/api/push/accounts`.
- Перші ~30 с `journalctl -u swbot --since "30 sec ago"` — без stack trace.

---

## 9. Швидкий старт після перезавантаження сервера

Systemd сервіси (`swbot`, `radio63`) і Docker-контейнери Signal (`restart: unless-stopped`) стартують автоматично.

```bash
systemctl status swbot radio63 --no-pager | head
docker ps
```

---

## 10. Інтеграція з radio_63ombr (Push API)

`radio_63ombr` ходить у SWBot через проксі-роутер `app/routers/push.py`:

- `GET /api/push/accounts` — підключені месенджер-акаунти
- `GET /api/push/chats?platform=whatsapp` — список чатів
- `POST /api/push/send` — `{platform, chat_id, text, image_base64}`

Базова URL — `BOT_SERVICE_URL` у `~/Armor/radio_63ombr/config.env` (за замовч. `http://localhost:3001`). Якщо ламаєте контракт API SWBot — синхронізуйте з `app/routers/push.py`. Контракт з боку бота: `docs/PUSH_API.md`.

---

## 11. Швидкий контекст для AI (новий діалог)

- **Сервер:** Ubuntu 24.04, `ocheret-63`, SSH: `shaen@100.120.93.120` (ключ `new_agent_key`).
- **SWBot:** `~/Armor/SWBot`, systemd сервіс `swbot`, панель на порту `3001`. Перезапуск — `pkill -f "node index.cjs"` (НЕ sudo systemctl).
- **FastAPI:** `~/Armor/radio_63ombr`, systemd сервіс `radio63`, порт `8000`.
- **Signal bridge:** Docker, порт `3002`, `docker-compose.signal.yml`.
- **Архітектура проєкту:** `docs/PROJECT.md`; журнал змін — `docs/CHANGELOG.md`; Push API — `docs/PUSH_API.md`.
