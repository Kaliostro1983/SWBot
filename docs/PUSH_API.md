# Push API — інтеграція зовнішнього сервісу з ботом

Цей документ описує HTTP API для зовнішніх сервісів (наприклад FastAPI), які хочуть:
- отримати список активних акаунтів (WhatsApp / Signal)
- отримати список доступних чатів
- надіслати повідомлення (текст + зображення) у конкретний чат

Базовий URL бота: `http://<HOST>:3001` (порт визначається змінною `PORT` у `.env`).

---

## 1. GET /api/push/accounts

Повертає список підключених платформ і їх акаунтів.

### Запит
```
GET /api/push/accounts
```

### Відповідь
```json
{
  "ok": true,
  "accounts": [
    {
      "platform": "whatsapp",
      "connected": true,
      "phone": "+380500641672",
      "name": "Рибалка"
    },
    {
      "platform": "signal",
      "connected": true,
      "phone": "+380500641672"
    }
  ]
}
```

| Поле | Тип | Опис |
|------|-----|------|
| `platform` | string | `"whatsapp"` або `"signal"` |
| `connected` | bool | `true` — акаунт активний і готовий до надсилання |
| `phone` | string\|null | Номер телефону акаунта (якщо відомий) |
| `name` | string\|null | Відображуване ім'я (лише WhatsApp) |

> Signal з'являється у відповіді лише якщо `SIGNAL_API_URL` налаштований у `.env` бота.

---

## 2. GET /api/push/chats

Повертає список доступних чатів для надсилання повідомлень.

### Запит
```
GET /api/push/chats?platform=all&refresh=0&only_groups=0
```

| Параметр | Значення за замовчуванням | Опис |
|----------|--------------------------|------|
| `platform` | `all` | `whatsapp` / `signal` / `all` |
| `refresh` | `0` | `1` — примусово оновити список з месенджера (повільніше) |
| `only_groups` | `0` | `1` — повернути лише групи, `0` — всі чати |

### Відповідь (platform=all)
```json
{
  "ok": true,
  "platforms": {
    "whatsapp": {
      "connected": true,
      "chats": [
        {
          "id": "120363423068157733@g.us",
          "name": "Аналітика 63",
          "is_group": true
        },
        {
          "id": "380632445475@c.us",
          "name": "Іван Петренко",
          "is_group": false
        }
      ]
    },
    "signal": {
      "connected": true,
      "chats": [
        {
          "id": "signal_group_AAAA...==",
          "name": "Каменярі",
          "is_group": true
        }
      ]
    }
  }
}
```

### Відповідь (platform=whatsapp або signal)
```json
{
  "ok": true,
  "platform": "whatsapp",
  "connected": true,
  "chats": [
    { "id": "120363423068157733@g.us", "name": "Аналітика 63", "is_group": true }
  ]
}
```

### Формат chat_id

| Платформа | Тип | Формат | Приклад |
|-----------|-----|--------|---------|
| WhatsApp | особистий чат | `{phone}@c.us` | `380632445475@c.us` |
| WhatsApp | група | `{id}@g.us` | `120363423068157733@g.us` |
| Signal | особистий чат | UUID або `+{phone}` | `+380500641672` |
| Signal | група | base64 рядок (~44 символи) | `signal_group_AAAA...==` |

> Використовуйте поле `id` з відповіді `/api/push/chats` без змін як `chat_id` при надсиланні.

---

## 3. POST /api/push/send

Надсилає повідомлення (текст і/або зображення) у вказаний чат.

### Запит
```
POST /api/push/send
Content-Type: application/json

{
  "platform": "whatsapp",
  "chat_id": "120363423068157733@g.us",
  "text": "Текст повідомлення",
  "image_base64": "<raw base64 без префіксу data:...>"
}
```

| Поле | Обов'язкове | Опис |
|------|-------------|------|
| `platform` | ✅ | `"whatsapp"` або `"signal"` |
| `chat_id` | ✅ | ID чату з `/api/push/chats` |
| `text` | ⚠️ | Текст повідомлення. Обов'язкове якщо немає `image_base64` |
| `image_base64` | ⚠️ | Зображення (PNG) у raw base64. Обов'язкове якщо немає `text` |

> `image_base64` — **чистий base64** без префіксу `data:image/png;base64,`. Наприклад: `iVBORw0KGgoAAAANSUhEUg...`

Можна передавати обидва поля — тоді зображення надсилається з підписом (`text` стає caption).

### Відповідь (успіх)
```json
{ "ok": true }
```

### Відповідь (помилка)
```json
{
  "ok": false,
  "message": "WhatsApp client is not ready. Start the bot and complete QR login first."
}
```

### HTTP-коди відповіді

| Код | Значення |
|-----|---------|
| 200 | Надіслано успішно |
| 400 | Невірні параметри (відсутній `chat_id`, `platform`, або ні `text`, ні `image_base64`) |
| 503 | Платформа не підключена (WA не готовий / Signal не залінкований) |
| 500 | Помилка надсилання (наприклад чат не знайдений) |

---

## 4. Типовий сценарій роботи

```python
import httpx, base64

BOT_URL = "http://ocheret-63:3001"

# 1. Перевірити підключення
accounts = httpx.get(f"{BOT_URL}/api/push/accounts").json()
wa = next((a for a in accounts["accounts"] if a["platform"] == "whatsapp"), None)
assert wa and wa["connected"], "WhatsApp не підключений"

# 2. Отримати чати (з кешу) або оновити (?refresh=1)
chats = httpx.get(f"{BOT_URL}/api/push/chats", params={"platform": "whatsapp"}).json()
chat = next(c for c in chats["chats"] if "Аналітика" in c["name"])

# 3. Надіслати повідомлення з картою
with open("map.png", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

resp = httpx.post(f"{BOT_URL}/api/push/send", json={
    "platform": "whatsapp",
    "chat_id": chat["id"],
    "text": "🗺 Оперативна зведення за 06:00",
    "image_base64": img_b64
})
assert resp.json()["ok"], resp.json()["message"]
```

---

## 5. Рекомендації

- **Кешування чатів**: не викликайте `/api/push/chats?refresh=1` частіше ніж раз на 5 хвилин — це навантажує WA-клієнт. Без `refresh=1` повертається кеш.
- **Перевірка підключення**: перевіряйте `connected: true` перед надсиланням. Якщо `false` — бот ще не готовий або вийшов з акаунта.
- **image_base64**: передавайте PNG. JPEG також підтримується (змінювати `image/png` на стороні бота не потрібно — він відправить як PNG незалежно від реального формату). Для коректного відображення у месенджері краще використовувати саме PNG.
- **Затримка між надсиланнями**: бот автоматично дотримується `SEND_DELAY_MS` (за замовчуванням 2000 мс) між повідомленнями, щоб не отримати бан від WhatsApp.
