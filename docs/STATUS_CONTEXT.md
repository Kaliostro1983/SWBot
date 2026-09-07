# Статус проєкту та план робіт

Оновлено: 2026-06-02

Поточна версія збірки: **1.5** (`VERSION`, узгоджено з `package.json` **1.5.0**).

## Що вже зроблено

- Етап 1: базова інтеграція WhatsApp (QR, логін/логаут, reset сесії, SSE-лог).
- Етап 2: автоматизації з CRUD, мульти-джерела, пауза, дублювання.
- Етап 3: фільтри за текстом і частотами (`keywords` / `frequencies`) з підтримкою `*`.
- Етап 4: напрямок `WhatsApp -> WhatsApp`, пересилання тексту та зображень.
- Етап 5 (базово): платформи `sourcePlatform/targetPlatform` і маршрути між WhatsApp/Signal/FastAPI.
- Панель:
  - сторінка `Налаштування` (показ ID, лише групи),
  - вкладки в інтеграції: `Загальні`, `WhatsApp`, `Signal`,
  - вкладка `Signal` з кнопкою `Увійти (QR)` і локальною debug-консоллю.
- Інфраструктура Signal:
  - `docker-compose.signal.yml`,
  - `signal-bridge` (`/health`, `/chats`, `/messages`, `/send`, `/link`, `/linked`).
- Етап 6: **Push API** для зворотного напрямку ГОІ → чат **без автоматизації** — `GET /api/push/accounts`, `GET /api/push/chats`, `POST /api/push/send` (текст + зображення). Контракт: `docs/PUSH_API.md`. *(Старий підхід через flow з `sourcePlatform: 'http'` замінено на прямий API.)*
- Етап 7: надійність і операційні фічі:
  - Signal → WhatsApp пересилання вкладень (зображення).
  - Сторінка **Моніторинг** (зведення активності по платформах, кольори Signal/WA, UTC+3).
  - **Addon-система** в автоматизаціях: вимірювач затримки (`delayMeter`) і контроль пропущених повідомлень (`missingMessages`).
  - Незалежний start/stop WhatsApp і Signal; зміна WhatsApp-акаунта; watchdog зависань WA.
  - Надійність Chrome/Puppeteer (kill orphaned, graceful shutdown), захист від `ENOSPC`.
  - Адмін-ендпоінти для виправлення aliases в chat-directory (`/api/admin/chat-directory/:key/...`).

## Чотири напрямки сервісу (канонічна модель)

1. **Signal ↔ WhatsApp** (будь-який напрямок) — через автоматизації (`flows.json`, `sourcePlatform`/`targetPlatform`).
2. **Чат → ГОІ** (radio_63ombr / FastAPI RER) — через автоматизацію з `targetPlatform: fastapi` (`POST FASTAPI_URL`, див. `docs/FASTAPI_INGEST.md`).
3. **ГОІ → чат** (зворотній) — **без автоматизації**, через Push API (`POST /api/push/send`); контракт `docs/PUSH_API.md`.

## Що зроблено останнім (2026-06-02)

- Інструкція перезапуску Docker у панелі (підказка при проблемах підключення Signal) більше не захардкоджена: бекенд віддає `env` у `/api/state` (ОС + `projectDir` + команди), а UI (`applyDockerEnvToHint`) рендерить її під фактичну ОС/шлях сервера.
- Додано `reset_docker.sh` (корінь репо + `~/Desktop` на сервері) для ручного перезапуску Signal-контейнерів і бота.
- Зафіксовано: на сервері `ocheret-63` `sudo -n` для systemctl недоступне — перезапуск сервісу через `pkill -f "node index.cjs"` (systemd `Restart=always`).

## Що зроблено 2026-09-07

- **WhatsApp `ready` не спрацьовував** (WA Web 2.3000.x несумісний з `whatsapp-web.js` 1.34.6 — `getChat` undefined, Signal→WA 60% помилок, цикл session-stale→QR). Перевели `whatsapp-web.js` на форк `github:Eonus21/whatsapp-web.js#06ee466...` (v1.34.8) — той самий, що працює в SWApp. WA виходить у `ready`, пересилання відновлено.
- **Відкрита задача:** форк вантажить чати ліниво → `getChatsSafe()` повертає 0 груп (live-список WA у конструкторі автоматизацій порожній). Роутинг наявних flow працює. Треба адаптувати `getChatsSafe` під форк.

## Що зроблено 2026-07-27

- **Фікс списку WA-чатів** (`getChatsSafe()`): `client.getChats()` кидав `r` (broken Meta-серіалізація), тому нові WA-групи не з'являлись в панелі — віддавався старий кеш. Нова функція читає id+назву напряму зі `Store.Chat` через `pupPage.evaluate`, підключена в усі 4 місця виклику. Аналогічно до `downloadMediaSafe`.
- **Індикатор здоров'я WhatsApp** у Моніторингу: банер попереджає про "send-only" сесію (WA `ready`, але вхідних fromMe:false немає ≥15 хв) та про деградацію WA Web (≥5 збоїв prefetch "r"). Нові поля стану: `waLastIncomingAt`, `waChatsPrefetchErrors` (у `/api/state`). Причина — після relink WA-сесія іноді надсилає, але не приймає; лікується лише повним скидом `.wwebjs_auth` + новий QR.

## Що зроблено 2026-07-16

- **WA→Signal flows** («Перехоплення 63 W→S», «Батальйони 63 W→S»): усунуто HTTP 400 «Invalid identifier» — `signal-bridge/server.cjs` `/send` endpoint тепер re-encode-ує group ID з single-encoded назад у double-encoded (`Buffer.from(rawId).toString('base64')`), яким чекає signal-cli-api.
- **signal-cli 0.14.6 авто-патч через wrapper**: новий `signal-cli-api-patch/Dockerfile` замінює `/usr/bin/jsonrpc2-helper` wrapper-скриптом, який спочатку генерує supervisor конфіг оригінальним бінарником, а потім одразу патчить `command=` на 0.14.6 з `/cache`. Тепер `docker restart signal-cli-api` НЕ потребує ручного `restore_signal_patch.sh`.

## Що робимо зараз

> Примітка (2026-06-02): більшість пунктів нижче — це **вже впроваджена** робота над Signal-онбордингом і routing'ом (деталі та дати — у `docs/CHANGELOG.md`). Список лишається як довідка про поточну поведінку; активні відкриті задачі — у розділі «Що ще потрібно зробити».

- Стабілізуємо Signal onboarding через QR-link у панелі.
- Зафіксовано режим `bridge-first` для `POST /api/signal/link`: без автопереходу на `docker exec signal-cli link` за замовчуванням.
- Діагностика помилки на телефоні: `Неприйнятна відповідь від сервісу` (перевірка якості payload від `signal-bridge /link` і стану `signal-cli-api`).
- Додано перевірку `linked` стану акаунта через `signal-bridge /linked` та відображення в UI.
- Додано UI-попередження, якщо після показу QR прив'язка не завершується (`linked=false`) протягом 30 секунд.
- Для діагностики/стабілізації лінкування переведено `signal-cli-api` в `MODE=normal`.
- Для списків чатів увімкнено єдину опцію `only_groups` для WhatsApp + Signal (щоб уникати перевантаження контактами).
- Додано щохвилинний backend-дайджест активності (`Minute activity`) для контролю прогресу обробки повідомлень.
- У конфігурації flow зберігаються `sourceChatRefs[]`/`targetChatRef` (`id + name`), тому в модалці редагування назви вибраних чатів показуються одразу без очікування повного завантаження списків.
- Додатково виправлено UX модалки: вибрані чати рендеряться негайно при відкритті форми (до завершення `loadChats`), навіть коли Signal chat-list ще підтягується у фоні.
- Для Signal chat refresh (`/api/signal/chats/refresh`) збільшено таймаут завантаження списку чатів через `SIGNAL_CHATS_TIMEOUT_MS` (default 90000), щоб уникати помилок `timeout of 30000ms exceeded` на повільному bridge.
- У модалці створення/редагування automation після `Оновити` тепер показується явний підсумок (`Оновлення завершено: N чатів` / попередження про частковий успіх).
- Додано діагностику резолву Signal chat id: `GET /api/chats/debug-resolve?platform=signal&chatKey=...` (показує aliases, нормалізовані ключі та результат зіставлення з `signal-chats-cache.json`).
- У `Налаштування` додано блок `Безпека`: логін/пароль панелі можна змінювати з UI; нові креденшали зберігаються в `data/panel-auth.json` (пріоритет над `.env`).
- Сервіс запускає інтеграції автоматично: `startBot()` стартує при піднятті сервера, а для Signal (коли не linked) автоматично генерується QR для перелінкування.
- Додано персистентний кеш назв чатів (`data/chat-directory.json`) та фоновий prefetch чатів одразу після старту сервісу; automation UI будується з конфігурації без показу сирих довгих chat ID.
- Після прогріву chat-directory automation refs у `flows.json` автоматично збагачуються назвами чатів, тому старі записи поступово очищуються від технічних `group.*` назв без ручного редагування.
- Увімкнено авто-ремап Signal джерел: при зміні Signal ID після relink система намагається автоматично оновити `sourceChatIds` за назвами чатів із `chat-directory`, щоб уникати ручного перевибору в кожній automation.
- Стартова політика Signal переведена у безпечний режим: без автоперелінкування за замовчуванням, лише `linked`-перевірка з ретраями; новий QR запускається вручну.
- Структуру Signal-джерел у flow посилено до dual-id/aliases: для `sourceChatRefs` зберігаються `aliases[]`, а маршрутизація порівнює вхідні `chatCandidates` з alias-набором, що знижує ризик `no_flow_match` після relink/зміни формату Signal ID.
- Додано окремий Chat Directory layer (`src/chat-directory/chatDirectory.js`) із внутрішніми стабільними `chatKey` (`<platform>:chat:<id>`), щоб flow могли посилатися на чат не через сирі alias/UUID.
- Маршрутизація підтримує `sourceChatKey`: коли ключ присутній, збіг — через `findChatByMessage` (кандидати з повідомлення) і порівняння `entry.chatKey === flow.sourceChatKey`; логи `[ROUTING] matched by sourceChatKey` / `sourceChatKey mismatch`. Якщо ключа немає — fallback на старий alias-матчинг.
- Вхідні Signal/WhatsApp повідомлення тепер спочатку upsert-яться в chat-directory (оновлення `lastSeenAt`, `lastMessagePreview`, aliases), після чого проходять routing.
- Signal: upsert у chat-directory виконується одразу після `normalizeSignalMessages` (до routing); логи каталогу — `[CHAT-DIR] …` у консоль процесу.
- Chat-directory upsert ігнорує порожні/короткі/системні повідомлення та події старші за 24 год за `sentAt`, щоб не засмічувати каталог неактивними чатами.
- Тимчасово upsert у chat-directory лише для `platform === "signal"` (`SIGNAL_ONLY_UPSERT` у `chatDirectory.js`); skip-логи містять `platform`, `chatId`, `senderId`, прев’ю тексту та `textLength`.
- `GET /api/chats` за замовчуванням — список з **Chat Directory** для панелі (`resolvedName`, без aliases, окрім `debug=1`); `GET /api/chats?live=1` — колишній live-список (WA клієнт / Signal bridge) для мультивибору за `id`. Окремо: `GET /api/chat-directory/recent` (debug — aliases).
- Signal source picker: підпис у UI — **manualLabel** каталогу > збережена **назва з flow** (`sourceChatRefs[0].name`) > **resolvedName** API; збереження flow не затирає людську назву UUID-ом; за відсутності `manualLabel` у каталозі після збереження — **`setManualLabelIfEmpty`** для стабільного `/api/chats`; autocomplete з **`GET /api/chats?platform=signal`**, префіл без ключа — `resolve-source`.

## Що ще потрібно зробити

### Найближчі кроки

- Підтвердити E2E-лінкування в UI після `bridge-first` фіксу (сканування QR без fallback).
- Перевірити повний E2E для маршрутів:
  - `Signal -> WhatsApp`
  - `Signal -> Signal`
  - `Signal -> FastAPI`
  - `WhatsApp -> Signal`
- Уніфікувати статуси інтеграцій (WhatsApp + Signal) у загальному health-блоці.

### Технічний борг

- Додати явний endpoint перевірки Signal-авторизації (на кшталт `isLinked`).
- Додати retry/backoff для Signal polling при мережевих помилках.
- Додати окремий тестовий сценарій “no chats / account not linked”.

## Як швидко увійти в контекст

Читати в такому порядку:

1. `docs/STATUS_CONTEXT.md` (цей файл)
2. `docs/PROJECT.md`
3. `docs/CHANGELOG.md`
4. `index.cjs`
5. `public/index.html`
6. `docker-compose.signal.yml`
7. `signal-bridge/server.cjs`
8. `data/flows.json`

## Критичні змінні середовища

- Бот: `FASTAPI_URL`, `SOURCE_CHAT`, `TARGET_CHAT`, `SEND_PREFIX`, `PANEL_USER`, `PANEL_PASSWORD`
- Фільтри: `SOURCE_FILTER_KEYWORDS`, `SOURCE_FILTER_FREQUENCIES`
- Signal: `SIGNAL_API_URL`, `SIGNAL_POLL_MS`

## Готовність до демо (чекліст)

- `http://localhost:3001/api/state` відповідає `ok`.
- `http://localhost:3002/health` відповідає `ok`.
- В `Інтеграція -> Signal` видно актуальні записи в debug-консолі.
- `/chats` для потрібної платформи повертає не порожній список.
