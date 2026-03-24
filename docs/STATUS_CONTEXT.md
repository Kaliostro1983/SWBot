# Статус проєкту та план робіт

Оновлено: 2026-03-23

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
  - `signal-bridge` (`/health`, `/chats`, `/messages`, `/send`, `/link`).

## Що робимо зараз

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
- У `Налаштування` додано блок `Безпека`: логін/пароль панелі можна змінювати з UI; нові креденшали зберігаються в `data/panel-auth.json` (пріоритет над `.env`).
- Сервіс запускає інтеграції автоматично: `startBot()` стартує при піднятті сервера, а для Signal (коли не linked) автоматично генерується QR для перелінкування.
- Додано персистентний кеш назв чатів (`data/chat-directory.json`) та фоновий prefetch чатів одразу після старту сервісу; automation UI будується з конфігурації без показу сирих довгих chat ID.
- Після прогріву chat-directory automation refs у `flows.json` автоматично збагачуються назвами чатів, тому старі записи поступово очищуються від технічних `group.*` назв без ручного редагування.
- Увімкнено авто-ремап Signal джерел: при зміні Signal ID після relink система намагається автоматично оновити `sourceChatIds` за назвами чатів із `chat-directory`, щоб уникати ручного перевибору в кожній automation.
- Стартова політика Signal переведена у безпечний режим: без автоперелінкування за замовчуванням, лише `linked`-перевірка з ретраями; новий QR запускається вручну.
- Структуру Signal-джерел у flow посилено до dual-id/aliases: для `sourceChatRefs` зберігаються `aliases[]`, а маршрутизація порівнює вхідні `chatCandidates` з alias-набором, що знижує ризик `no_flow_match` після relink/зміни формату Signal ID.

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
