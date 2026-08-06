# OPERATIONS — операційний runbook (для оператора / Claude)

Цей документ — керівництво з підтримки працездатності бота SWBot. Тут зібрані типові збої, їх ознаки, причини й точні команди відновлення. Розрахований на оператора та на Claude Code, який йому допомагає.

> **Розподіл ролей:** рутина (перезапуск WA, QR, моніторинг) робиться через **панель + `restart_wa.sh`** — Claude для цього не обов'язковий. Claude потрібен для **діагностики складних збоїв** (чому не пересилає, send-only, помилки signal-cli тощо).

---

## 1. Що це за система

- **SWBot** — Node.js-процес на сервері `ocheret-63`, пересилає повідомлення між **WhatsApp**, **Signal** і **ГОІ (FastAPI/radio_63ombr)** за правилами-«автоматизаціями».
- **Сервер:** `ocheret-63`, доступ через **Tailscale** (IP `100.120.93.120`), користувач `shaen`.
- **Панель керування:** `http://100.120.93.120:3001` (потрібен Tailscale).
- **Стан у JSON:** `http://100.120.93.120:3001/api/state`.
- **Signal-інфраструктура:** Docker-контейнери `signal-cli-api` + `signal-bridge` (порт 3002).
- **ГОІ (RER):** окремий сервіс `radio63.service` (FastAPI, порт 8000) — це **не** SWBot.
- **Час:** сервер у UTC; оператор — київський (UTC+3). У логах час у UTC (суфікс `Z`).

---

## 2. Як перевірити роботу бота

Панель → **Моніторинг**: таблиця «Продуктивність автоматизацій» + журнал + банер здоров'я WA.

Або через API (з сервера або через Tailscale):
```bash
curl -s http://localhost:3001/api/state | python3 -m json.tool | head -40
```

**Ключові поля стану:**
| Поле | Норма | Що означає |
|---|---|---|
| `status` | `ready` | стан WhatsApp-клієнта |
| `ready` / `authenticated` | `true` | WA підключений і авторизований |
| `qrAvailable` | `false` | якщо `true` — чекає сканування QR |
| `waLastIncomingAt` | свіжий час | останнє **вхідне** WA-повідомлення (fromMe:false). Якщо давно — можлива «send-only» сесія |
| `waChatsPrefetchErrors` | `0` | збої читання списку чатів (`r`). Ріст = деградація WA Web |
| `signal.running` / `signal.linked` | `true` | Signal працює й прив'язаний |
| `signal.lastMessageReceivedAt` | свіжий час | Signal отримує повідомлення |

**Ознака здорового пересилання** — у логах свіжі `Signal→WA sent` і `WA→Signal sent`:
```bash
grep -E "Signal→WA sent|WA→Signal sent|Forward sent" logs/bot.log | tail -5
```

---

## 3. Типові збої → діагностика → усунення

### 3.1. WA завис на `status: "starting"` (найчастіше)
- **Ознака:** `status=starting`, `ready=false`, `authenticated=true`, `qr=false` довше ~30–60с. У логах `WA init timeout` / `Runtime.callFunctionOn timed out`. Signal→WA дає `клієнт WhatsApp не готовий`.
- **Причина:** Chromium/Puppeteer завис на ініціалізації. Сесія ЦІЛА (QR не потрібен).
- **Фікс:** `~/Desktop/restart_wa.sh` (робить `/api/stop` → пауза → `/api/start`; stop вбиває завислий Chromium і звільняє лок).
- **Важливо:** звичайний `pkill node` / рестарт systemd тут **НЕ допомагає** — orphan-Chromium лишається. Треба саме stop+start.

### 3.2. WA у `awaiting_qr` (втрачена сесія)
- **Ознака:** `status=awaiting_qr`, `qrAvailable=true`.
- **Причина:** сесію розлогінили / detached-frame знищив її.
- **Фікс:** панель → Інтеграція → WhatsApp → сканувати QR з телефону (Прив'язані пристрої → Прив'язати). QR живий ~20с — якщо застарів, зроби `restart_wa.sh` для свіжого й скануй одразу.

### 3.3. «Send-only» сесія (шле, але не приймає) — підступний
- **Ознака:** WA `ready`, Signal→WA працює, АЛЕ повідомлення від людей у WA-групах **не пересилаються** (WA→WA, WA→Signal мовчать). Явних помилок немає. Банер у Моніторингу засвітиться. У логах усі WA-повідомлення `fromMe:true`, жодного `fromMe:false`.
- **Перевірка:** `awk '/Source message accepted/ && /whatsapp/' logs/bot.log | grep -oE 'fromMe":(true|false)' | sort | uniq -c` — якщо `false` = 0 при явному трафіку.
- **Причина:** після relink web-сесія стала «тільки надсилання».
- **Фікс (потрібне підтвердження, бо руйнівне + новий QR):**
  1. На телефоні: видалити **ВСІ** прив'язані пристрої.
  2. На сервері: `curl -X POST http://localhost:3001/api/stop` → `mv ~/Armor/SWBot/.wwebjs_auth ~/Armor/SWBot/.wwebjs_auth.bak_$(date +%s)` + `rm -rf ~/Armor/SWBot/.wwebjs_cache` → `curl -X POST http://localhost:3001/api/start`.
  3. Сканувати новий QR у панелі.
  4. Перевірити: у логах з'явились `fromMe:false` (попроси когось написати у WA-групу-джерело).

### 3.4. `detached frame, restarting WA`
- **Ознака:** у логах `detached frame — scheduling restart`, потім WA перезапускається сам.
- **Причина:** Chromium-фрейм відвалився (нестабільність Puppeteer).
- **Дія:** зазвичай **самовідновлюється** за ~10с. Якщо після нього застряг на `starting` — `restart_wa.sh`. Якщо впав у `awaiting_qr` або «send-only» — див. 3.2 / 3.3.

### 3.5. `WhatsApp chats prefetch failed {"message":"r"}` / нова група не в списку
- **Ознака:** нова WA-група не з'являється в автоматизаціях навіть після «оновити список чатів».
- **Причина:** `client.getChats()` кидає `r` (поломка Meta-протоколу) → віддається старий кеш. **Виправлено** функцією `getChatsSafe()` (обхід через `Store.Chat`). Якщо все одно не видно — перевір `waChatsPrefetchErrors` і зроби `restart_wa.sh`.

### 3.6. `WA→Signal відправка провалена — status code 400`
- **Причина А (постійна):** акаунт Signal **не є учасником** цільової групи → перевір, що ціль потоку правильна і бот доданий у групу.
- **Причина Б (транзієнт):** поодинокі 400 під навантаженням — signal-cli моментально зайнятий. Якщо їх одиниці на тисячі — ігнорувати.
- **Діагностика тіла помилки:** `curl -s -X POST http://localhost:3002/send -H 'Content-Type: application/json' -d '{"chatId":"<group.ID>","text":"test"}'` — відповідь містить точну причину.

### 3.7. `FastAPI POST failed — ECONNREFUSED 127.0.0.1:8000`
- **Причина:** сервіс ГОІ (`radio63.service`) недоступний. Це **окремий** сервіс, не SWBot.
- **Перевірка:** `systemctl is-active radio63` і `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/`.
- **Дія:** поодинокі — транзієнт (перезавантаження radio63). Постійні — розбиратись із radio63 окремо.

### 3.8. Signal не отримує повідомлень
- **Перевірка:** `signal.running`, `signal.linked`, `signal.lastMessageReceivedAt`.
- **Дія:** перезапуск бриджу: `docker restart signal-bridge`. Якщо не linked — перелінкувати Signal через панель.

---

## 4. Маршрутизація (чому переслалось / не переслалось)

- Автоматизація зіставляється **за чатом-джерелом**, потім застосовує фільтри `keywords` / `frequencies` (підрядок у всьому тексті; `*` = пропустити все).
- Якщо `keywords: *` — пересилається все. Якщо задано частоти/слова — лише збіги.
- У логах видно рішення: `Signal flows matched`, `Signal filter decision {passed, reason}`, далі `... sent`.
- Часта причина «не те переслалось» — ключове слово збіглося в **іншій частині** склеєного повідомлення.

---

## 5. Доступ і команди

```bash
# SSH на сервер (з машини оператора; потрібен Tailscale)
ssh -i ~/.ssh/swbot_operator shaen@100.120.93.120

# стан
curl -s http://localhost:3001/api/state | python3 -m json.tool | head -40

# перезапуск WA при зависанні
~/Desktop/restart_wa.sh

# логи
tail -f /home/shaen/Armor/SWBot/logs/bot.log
grep -E "ERROR|WARN" /home/shaen/Armor/SWBot/logs/bot.log | tail -20

# Signal-контейнери
docker ps
docker restart signal-bridge         # безпечно
docker logs signal-bridge --since 20m | tail

# сервіс бота (systemd, Restart=always)
systemctl is-active swbot
```

---

## 6. ЗАБОРОНЕНО (жорсткі правила)

- ❌ **`docker exec signal-cli-api signal-cli ...`** — блокує/ламає SQLite сесії Signal.
- ❌ Видаляти теку **`data/`** (там автоматизації, каталог чатів, креденшали панелі).
- ❌ **`git push --force`**.
- ❌ Чіпати **`.wwebjs_auth`** — крім підтвердженого сценарію «send-only» (3.3).
- ⚠️ `sudo systemctl restart` через SSH **не працює** (вимагає пароль); бот перезапускається через `pkill -f "node index.cjs"` (systemd підніме), а WA — через `restart_wa.sh`.

---

## 7. Коли кликати Claude

Claude корисний для: аналізу логів, пошуку причини «чому не пересилає», діагностики send-only / detached-frame / signal-cli помилок, правок коду. Для рутинного «WA завис → підняти» достатньо `restart_wa.sh` і панелі.
