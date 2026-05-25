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

### Реальна відповідь
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
GET /api/push/chats?platform=whatsapp&refresh=0&only_groups=0
```

| Параметр | За замовчуванням | Допустимі значення | Опис |
|----------|-----------------|---------------------|------|
| `platform` | `all` | `whatsapp` / `signal` / `all` | Яку платформу повернути |
| `refresh` | `0` | `0` / `1` | `1` — живий запит до месенджера (повільніше) |
| `only_groups` | `0` | `0` / `1` | `1` — лише групи; `0` — всі чати |

### Реальна відповідь: platform=whatsapp (групи)

```json
{
  "ok": true,
  "platform": "whatsapp",
  "connected": true,
  "chats": [
    {
      "id": "120363423068157733@g.us",
      "name": "Аналітика 63",
      "type": "group"
    },
    {
      "id": "120363403015520336@g.us",
      "name": "Батальйони 63",
      "type": "group"
    },
    {
      "id": "120363389265215284@g.us",
      "name": "Бордель",
      "type": "group"
    }
  ]
}
```

### Реальна відповідь: platform=whatsapp (особисті чати)

```json
{
  "ok": true,
  "platform": "whatsapp",
  "connected": true,
  "chats": [
    {
      "id": "110046289596462@lid",
      "name": "+380 50 064 1672",
      "type": "contact"
    },
    {
      "id": "204487771828268@lid",
      "name": "+380 63 169 0099",
      "type": "contact"
    }
  ]
}
```

> ⚠️ Особисті чати WhatsApp у новому протоколі multi-device мають суфікс `@lid` (linked device ID),
> а не `@c.us`. Це нормальна поведінка. Використовуйте `id` як є при надсиланні.

### Реальна відповідь: platform=signal

```json
{
  "ok": true,
  "platform": "signal",
  "connected": true,
  "chats": [
    {
      "id": "+380632445475",
      "name": "+380632445475",
      "type": "contact"
    },
    {
      "id": "group./v7TKy0pE385VOijwvkPFbFT+3xWU4yAc0eCIq6+6tU=",
      "name": "221",
      "type": "group"
    },
    {
      "id": "group.c0RizJNRvXFQyd78BXYLYkushdASm7BSCFfa86pjmNQ=",
      "name": "Formula - 1",
      "type": "group"
    }
  ]
}
```

### Поля об'єкта чату

| Поле | Тип | Опис |
|------|-----|------|
| `id` | string | **Ідентифікатор чату** — передавати як `chat_id` при надсиланні |
| `name` | string | Відображувана назва групи або ім'я контакту |
| `type` | string | `"group"` або `"contact"` |

### Формати `id` по платформах

| Платформа | Тип | Формат | Приклад |
|-----------|-----|--------|---------|
| WhatsApp | група | `{digits}@g.us` | `120363423068157733@g.us` |
| WhatsApp | контакт | `{digits}@lid` | `110046289596462@lid` |
| Signal | контакт | `+{phone}` | `+380632445475` |
| Signal | група | `group.{base64}` | `group.c0RizJN...NQ=` |

> Використовуйте `id` з відповіді `/api/push/chats` **без змін** як `chat_id` при надсиланні.

---

## 3. POST /api/push/send

Надсилає повідомлення (текст і/або зображення) у вказаний чат.

### Запит
```
POST /api/push/send
Content-Type: application/json
```

```json
{
  "platform": "whatsapp",
  "chat_id": "120363423068157733@g.us",
  "text": "Текст повідомлення",
  "image_base64": "<raw base64 без префіксу data:...>"
}
```

| Поле | Обов'язкове | Тип | Опис |
|------|-------------|-----|------|
| `platform` | ✅ | string | `"whatsapp"` або `"signal"` |
| `chat_id` | ✅ | string | ID чату з `/api/push/chats` — передавати як є |
| `text` | ⚠️ | string | Текст. Обов'язковий якщо немає `image_base64` |
| `image_base64` | ⚠️ | string | PNG у **чистому base64** (без `data:image/png;base64,`). Обов'язковий якщо немає `text` |

Якщо передати обидва поля — зображення надсилається з підписом (`text` стає caption).

### Відповідь (успіх)
```json
{ "ok": true }
```

### Відповіді (помилки)

```json
{ "ok": false, "message": "platform must be \"whatsapp\" or \"signal\"" }
{ "ok": false, "message": "chat_id is required" }
{ "ok": false, "message": "text or image_base64 is required" }
{ "ok": false, "message": "WhatsApp client is not ready. Start the bot and complete QR login first." }
{ "ok": false, "message": "Signal is not connected. Link account first." }
```

### HTTP-коди відповіді

| Код | Причина |
|-----|---------|
| 200 | Надіслано успішно |
| 400 | Невірні параметри запиту |
| 503 | Платформа не підключена (перевір `/api/push/accounts`) |
| 500 | Помилка надсилання (чат не знайдений, WA збій тощо) |

---

## 4. Типовий Python-сценарій

```python
import httpx, base64

BOT_URL = "http://ocheret-63:3001"

# 1. Перевірити підключення
accounts = httpx.get(f"{BOT_URL}/api/push/accounts").json()
wa = next((a for a in accounts["accounts"] if a["platform"] == "whatsapp"), None)
if not wa or not wa["connected"]:
    raise RuntimeError("WhatsApp не підключений")

# 2. Отримати групи (з кешу — без refresh)
resp = httpx.get(f"{BOT_URL}/api/push/chats", params={
    "platform": "whatsapp",
    "only_groups": "1"
})
chats = resp.json()["chats"]
chat = next((c for c in chats if "Аналітика" in c["name"]), None)
# chat["id"] = "120363423068157733@g.us"
# chat["type"] = "group"

# 3. Надіслати повідомлення з картою (PNG)
with open("map.png", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

resp = httpx.post(f"{BOT_URL}/api/push/send", json={
    "platform": "whatsapp",
    "chat_id": chat["id"],
    "text": "🗺 Оперативна зведення за 06:00",
    "image_base64": img_b64   # чистий base64, без data:image/...
}, timeout=30)

data = resp.json()
if not data["ok"]:
    raise RuntimeError(data["message"])
```

---

## 5. Рекомендації

- **Кешування**: не викликайте `?refresh=1` частіше ніж раз на 5 хвилин — це навантажує WA-клієнт. Без цього параметра відповідь миттєва (кеш).
- **Перевірка підключення**: перед надсиланням перевіряйте `connected: true` у `/api/push/accounts`. Якщо `false` — бот ще не готовий або вийшов з акаунта.
- **image_base64**: передавайте **чистий base64** (без `data:image/png;base64,`). Якщо передати з префіксом — картинка відправиться в базі64-тексті, а не як зображення.
- **Затримка**: бот автоматично витримує `SEND_DELAY_MS` (за замовчуванням 2000 мс) між відправками.
- **Пошук чату по назві**: назви чатів зберігаються мовою, якою задані в WhatsApp/Signal. Для надійного пошуку використовуйте `id` (збережіть його після першого `/api/push/chats`) замість пошуку по `name` щоразу.
