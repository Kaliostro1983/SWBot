# Журнал внесених правок

Формат записів: дата (ISO або зрозумілий текст), короткий опис, за потреби список файлів.

---

## 2026-03-24 — 1.0: реліз після фіксації змін

- Версія збірки: `VERSION` **1.0**, `package.json` / `package-lock.json` — **1.0.0**.
- У зведення включено Chat Directory layer, роутинг через `sourceChatKey`, API `GET /api/chat-directory/recent` та Signal source picker у панелі (обрання джерела за recent-записами без raw aliases в основному UI).

## 2026-03-23 — Signal link стабілізація (bridge-first)

- Додано endpoint `GET /api/chat-directory/recent` для отримання recent-чатів із chat-directory за платформою (`signal`/`whatsapp`) у безпечному UI-форматі без aliases за замовчуванням; aliases повертаються лише в debug-режимі (`?debug=1`).
- Модалка автоматизацій (`public/index.html`) для `sourcePlatform=signal` тепер використовує source picker із recent chat directory записів (`chatKey`) замість ручної роботи з raw aliases/ID.
- Для source picker Signal у dropdown додано картку чату: назва (`manualLabel/displayName`), платформа, тип (`direct/group`), `lastSeenAt`, короткий preview останнього повідомлення.
- При збереженні Signal-flow панель передає `sourceChatKey`; бекенд зберігає його в flow і використовує chat-directory для резолву джерела (backward compatibility з aliases збережено).

- Додано окремий backend-модуль каталогу чатів `src/chat-directory/chatDirectory.js` з персистентним форматом `data/chat-directory.json` (`entries[]` + `chatKey`), де внутрішній ключ чату не залежить від сирих Signal UUID/phone.
- У каталозі реалізовано API: `loadChatDirectory`, `saveChatDirectory`, `upsertChatFromMessage`, `findChatByMessage`, `addAliasesToChat`, `listRecentChats`; додано автоматичну міграцію legacy-формату `platform -> { chatId: name }`.
- Routing оновлено до режиму сумісності: якщо у flow є `sourceChatKey` — match виконується через aliases відповідного запису з chat-directory; якщо `sourceChatKey` відсутній — лишається fallback на aliases (`buildFlowAliases`).
- Для вхідних Signal/WhatsApp повідомлень додано авто-upsert у chat-directory до routing, щоб aliases накопичувалися з реального трафіку.
- Додано логи: створення нового запису chat-directory, merge нових aliases, та окремий лог успішного match по `sourceChatKey`.

- Додано діагностичний режим `SIGNAL_RAW_CAPTURE=1`: усі вхідні сирі Signal events пишуться в `logs/signal_raw.ndjson` (NDJSON, по одному JSON-рядку), включно з дубльованими полями `chatId`, `chatCandidates`, `message`, `sender`, `groupInfo`. Захоплення виконується до routing/filtering і не блокує сервіс при помилках файлу.
- Проведено структуризацію Signal-контуру в `index.cjs` без зміни поведінки: виділено явні функції `signalHealthCheck()`, `signalLinkedCheck()`, `fetchSignalChats()`, `fetchSignalMessages()`, `sendSignalMessage()`, `normalizeSignalMessage(raw)`; polling `/messages` переведено на новий intake-виклик.
- Для спрощення прив’язки source-чатів Signal додано список “нещодавно активних чатів” у state (`signal.recentIncomingChats`): у модалці `Звідки надсилати` ці чати підмішуються на початок списку, щоб вибирати джерело без ручного пошуку `chatId` у логах.
- Додано прапорець `AUTO_SIGNAL_SOURCE_AUTOREMAP` (за замовчуванням `0`). У стандартному режимі source-чати Signal не ремапляться автоматично, щоб пересилання було строго з чату, обраного користувачем у налаштуваннях automation.
- `Налаштування -> Безпека` спрощено до 2 полів (`Логін`, `Пароль`). Якщо обидва поля порожні, авторизація панелі вимикається (вхід без логіна/пароля); якщо заповнений лише один — повертається валідаційна помилка.
- Реалізовано dual-id/aliases структуру для Signal-джерел у flow: `sourceChatRefs[]` тепер зберігає `aliases[]`, а match вхідних Signal повідомлень виконується по alias-набору (а не лише по `sourceChatIds`).
- Додано міграцію старих flow-записів до alias-формату та розширено авто-ремап: при збагаченні/перемапі Signal-джерел формується повний alias-набір (`group.*`, raw-id та відомі варіанти з chat-directory).
- Змінено політику старту Signal: автоперелінкування за замовчуванням вимкнено (`AUTO_SIGNAL_RELINK_ON_SERVICE_START=0`). На старті виконується лише `linked`-перевірка з ретраями; якщо linked не підтверджено — лог-попередження, а перелінкування лишається ручним.
- Виправлено UX-статуси завантаження чатів у модалці automation: повідомлення тепер показуються окремо під полями `Звідки`/`Куди` відповідно до їхньої платформи (Signal/WhatsApp), без хибного тексту про Signal під WhatsApp-полем.
- Додано персистентний каталог чатів `data/chat-directory.json` (`chatId -> назва`) для WhatsApp і Signal; він оновлюється при `GET /api/chats` та фоновому prefetch.
- Під час збереження/міграції автоматизацій `sourceChatRefs`/`targetChatRef` тепер збагачуються назвами з каталогу чатів; у UI довгі технічні ID більше не показуються як fallback (показується `Невідомий чат`).
- Підвантаження чатів запускається у фоні одразу після старту сервісу (auto-init) і після готовності WhatsApp-сесії, без блокування інтерфейсу.
- Після фонового prefetch додано авто-збагачення `flows.json`: існуючі `sourceChatRefs`/`targetChatRef` оновлюються людськими назвами з `chat-directory`, щоб у картках/модалці не лишалися старі `group.*`-лейбли.
- Захист від деградації назв: технічні `id`-подібні лейбли (`group.*`, UUID, `name===id`) більше не перезаписують людські назви в `chat-directory`, а у flow refs такі лейбли ігноруються.
- Додано авто-ремап Signal source chat IDs: після фонового prefetch і при `no matching source chat` система пробує співставити `sourceChatRefs.name` з актуальним `chat-directory` і автоматично оновлює `sourceChatIds` у `flows.json`.
- Модалка редагування автоматизації тепер миттєво показує вже збережені source/target чати (чіпси з конфіга) до завершення фонового `loadChats`, щоб не було враження порожнього вибору під час довгого завантаження Signal чатів.
- Додано авто-ініціалізацію при старті сервісу: бот запускається автоматично (`AUTO_START_BOT_ON_SERVICE_START=1` за замовчуванням).
- Для Signal додано авто-початок перелінкування при старті (`AUTO_SIGNAL_RELINK_ON_SERVICE_START=1`): якщо акаунт ще не linked, бекенд автоматично генерує QR і віддає його в `state.signal.qrDataUrl` для миттєвого показу в UI.
- Виправлено крихкий match Signal source chat після relink: вхідні повідомлення тепер містять `chatCandidates`, а маршрутизація в `index.cjs` матчує за набором ID-кандидатів (`group.*` і raw-id), щоб різні формати ID не ламали flow.
- `Налаштування -> Безпека`: додано форму керування доступом до панелі (логін/пароль) з API `POST /api/panel-auth/settings`; дані авторизації зберігаються у `data/panel-auth.json` і мають пріоритет над `.env`.
- Оновлено стилі вкладок у блоці інтеграції: візуально оформлено як tab-панель (активна вкладка з верхнім акцентом), а не як набір кнопок.
- Flows зберігають `sourceChatRefs[]` і `targetChatRef` (`id + name`) у `data/flows.json`, щоб назви чатів відображались миттєво при відкритті автоматизації, навіть до завершення фонового `loadChats`.
- UI автоматизацій використовує назви з конфігурації як пріоритетне джерело (`chatId -> name`), а live-список чатів — як fallback.
- Для діагностики Signal-маршрутизації додано логи `Signal messages fetched` і `Signal message ignored: no matching source chat` (throttled) з `chatId` та переліком налаштованих `sourceChatIds`.
- Backend `POST /api/signal/link`: прибрано небезпечний автоматичний fallback на `docker exec signal-cli link` за замовчуванням, щоб не видавати QR з нестабільного сценарію лінкування.
- Додано керований fallback тільки через env-прапорець `SIGNAL_LINK_ALLOW_DOCKER_FALLBACK=1` (використовувати лише для діагностики).
- Якщо `signal-bridge /link` повертає невалідний payload або помилку, API тепер повертає `502` з явним повідомленням для перевірки `signal-bridge` / `signal-cli-api`.
- Панель `Інтеграція -> Signal`: додано діагностику `bridge /link` (поля `Останній /link` і `Помилка bridge /link`) без потреби дивитись `docker logs`.
- `signal-bridge`: новий endpoint `GET /linked` (перевірка, чи зареєстрований `SIGNAL_ACCOUNT_NUMBER` у `signal-cli-api /v1/accounts`).
- Панель `Інтеграція -> Signal`: додано індикатори `Прив'язано акаунт` і `Перевірка linked`; бекенд перевіряє статус лінку періодично.
- Панель `Інтеграція -> Signal`: додано авто-попередження, якщо після генерації QR стан `linked` лишається `false` понад 30 секунд.
- Docker Signal stack: `signal-cli-api` переведено в `MODE=normal` для стабільнішого лінкування пристрою через QR на актуальних версіях Signal.
- Зменшено ризик хибного алерту лінкування: прибрано фоновий частий polling `linked` у бекенді, додано `GET /api/signal/linked-check` для on-demand перевірки після скану QR; алерт у UI тепер показується після 45с і лише при явному `linked=false`.
- Панель `Інтеграція -> Signal`: додано status-badge підключення (`connected` / `not linked` / `checking`) за аналогією з WhatsApp.
- Зменшено шум логів Signal: повторні помилки `linked status check failed` і `polling failed` тепер логуються з throttling (не частіше разу на 60с); polling `/messages` не викликається, поки `linked !== true`.
- Стабілізація `POST /api/signal/link`: під час генерації QR тимчасово зупиняються linked/poll перевірки, таймаут на `/link` збільшено до 90с, додано один автоматичний retry при тимчасовому lock/timeout.
- `POST /api/signal/link`: прибрано довге очікування до ~3 хв. Тепер таймаут запиту до bridge ~35с, retry виконується лише для не-timeout помилок, а при паралельному натисканні повертається `409` (one-request-at-a-time).
- UI Signal: під час генерації QR блокуються обидві кнопки (`Увійти (QR)` і `Оновити QR`), щоб уникнути паралельних `link` запитів.
- `POST /api/signal/link`: відновлено більш надійний режим для повільних інстансів Signal — таймаут винесено в `SIGNAL_LINK_TIMEOUT_MS` (за замовчуванням 120с), retry знову виконується також при timeout.
- `POST /api/signal/link`: додано preflight `GET /health` (6с) перед генерацією QR. Якщо bridge недоступний (наприклад Docker Desktop зупинений), API повертає швидку і явну помилку замість довгого очікування.
- `signal-bridge`: для `/chats`, `/messages`, `/send` додано авто-визначення активного акаунта через `GET /v1/accounts` (з кешем 30с), щоб працювало навіть коли фактичний linked-акаунт не збігається з `SIGNAL_ACCOUNT_NUMBER`.
- `signal-bridge /messages`: повертає деталі `body` від signal-cli-api при помилці (краща діагностика 500/timeout).
- Підвищено таймаути для повільного Signal API: `index.cjs` (`/linked`, `/messages`) і `signal-bridge` (`/v1/accounts`, `/v1/contacts`, `/v1/groups`, `/v1/receive`) тепер працюють із довшими timeout, щоб уникати хибних 500/timeout у стані linked.
- `signal-bridge /chats`: запит контактів тепер пріоритетний (групи — best-effort з коротшим timeout), щоб список чатів повертався навіть при повільному `/v1/groups`.
- `index.cjs`: додано guard від накладання паралельних poll-запитів Signal (`signalPollInFlight`), щоб не створювати lock storm у signal-cli-api.
- `GET /api/chats?platform=signal` у `index.cjs`: збільшено таймаут виклику bridge `/chats` до 120с, щоб модалка автоматизації не падала з `timeout of 30000ms exceeded` на повільних інстансах Signal.
- `index.cjs` (WhatsApp/Puppeteer): додано авто-пошук системного Chrome/Edge на Windows і підтримку `CHROME_EXECUTABLE_PATH`, щоб уникати падіння bundled Chromium (`Invalid file descriptor to ICU data received`).
- UI Signal login: якщо акаунт вже `linked=true`, кнопка `Увійти (QR)` тепер питає підтвердження перед перелінкуванням (щоб не створювати враження, що потрібно логінитись при кожному запуску).
- UI автоматизацій: додано статус завантаження/помилки чатів Signal та retry-поведінку (довший timeout, повторна спроба), щоб список джерел не залишався "тихо порожнім" на повільному Signal API.
- UI Signal: кнопка `Увійти (QR)` динамічно перейменовується в `Перелінкувати`, коли `linked=true`.
- Стабілізація WhatsApp startup: додано `WA_LAUNCH_TIMEOUT_MS` і `WA_PROTOCOL_TIMEOUT_MS`, а також одноразовий retry `client.initialize()` з більшими таймаутами при `Page.navigate timed out`.
- `GET /api/chats?platform=signal`: додано фільтр `only_groups` (як і для WhatsApp); у панелі за замовчуванням показуються лише групи для обох платформ.
- Backend журнал: щохвилини пишеться `Minute activity` з дельтами і загальними лічильниками (`received/accepted/ignored/posted/sent/errors`), щоб бачити прогрес обробки в реальному часі.
- Панель `Інтеграція -> Загальні`: додано mini-віджет “Активність за останню хвилину” (received/accepted/ignored/posted/sent/errors) з timestamp останнього оновлення.
- `Minute activity` лог доповнено причинами `ignored` за хвилину (`ignoredReasonsMinute`) і накопиченим підсумком причин (`ignoredReasonsTotal`) для швидкої діагностики, чому повідомлення не проходять у маршрутизацію.
- Модалка автоматизацій: список джерел отримав пошук + чіпси вибраних чатів (швидше працювати з великим переліком Signal-чатів).
- Завантаження чатів у модалці оптимізовано: кеш на 5 хв, при відкритті форми використовується кеш, примусове оновлення — лише кнопкою `Оновити`.
- Перероблено UX вибору чатів у модалці: залишено 2 поля (`Звідки надсилати`, `Куди надсилати`) у форматі chat-picker з чіпсами всередині поля і випадаючим списком пошуку.
- `signal-bridge /chats`: за замовчуванням приховуються технічні Signal ID без читабельної назви (UUID/короткі числові), щоб список джерел був чистішим. Додано env-прапорець `SIGNAL_INCLUDE_TECHNICAL_IDS=1` для повернення повного сирого списку.
- Діагностика маршрутів Signal: у статистику додано причину `signal_no_flow_match` (раніше unmatched Signal повідомлення не потрапляли в `received/ignored` і це ускладнювало аналіз).
- KPI/`Minute activity` переведено на облік тільки релевантних джерел: `received` тепер рахує повідомлення лише після match на source chat flow (або `.env` SOURCE_CHAT), щоб статистика не змішувалась із сторонніми чатами.

---

## 2026-03-23 — 0.6: Signal QR login

- Панель: вкладка **Інтеграція → Signal** отримала кнопку **«Увійти (QR)»** і QR-картинку.
- Backend: додано endpoint **`POST /api/signal/link`**, який запускає `signal-cli link` у контейнері `signal-cli-api` і повертає `uri` та `qrDataUrl`.

## 2026-03-23 — 0.5: основа Signal + новий селектор напрямку

- Панель: напрямок тепер задається двома випадаючими меню `Звідки` і `Куди` (WhatsApp/Signal -> WhatsApp/Signal/FastAPI) зі стрілкою між ними.
- Форма автоматизації: поля перейменовано на `Звідки надсилати` і `Куди надсилати`; блоки вибору чатів динамічно перемикаються за платформою.
- Додано сторінку `Налаштування` з контейнером `Налаштування чатів`: `Показувати ID` (off за замовчуванням) і `Показувати у WhatsApp лише групи` (on за замовчуванням).
- API `GET /api/chats`: додано параметри `platform` і `only_groups`; для `platform=signal` повертається список із Signal bridge API (`GET /chats`).
- Backend: у flow додано поля `sourcePlatform` / `targetPlatform`; маршрут визначається за платформами, з міграцією легасі `direction` (`wa_*`).
- Signal transport: polling `GET /messages` та надсилання `POST /send`; підтримано маршрути `Signal -> WhatsApp`, `Signal -> FastAPI`, `Signal -> Signal`, а також `WhatsApp -> Signal` (текст).
- Версія: `VERSION` 0.5, `package.json` 0.5.0.

---

## 2025-03-22 — 0.4: WA→WA та медіа

- Напрямок **WhatsApp → WhatsApp** (`direction: wa_wa`): поле **цільовий чат** (`targetChatId`), без FastAPI; фільтри ключових слів/частот як раніше.
- Прапорець **«Пересилати зображення з повідомлення»** (`sendAttachments`): для WA→WA — пересилання медіа з підписом; для WA→FastAPI — додаткове пересилання зображення в цільовий чат (у т.ч. якщо з бекенду 0 `actions`, але є медіа та `#go`).
- Панель: вибір напрямку, цільовий чат для WA→WA, знято обмеження «легасі» на редагування/дублювання/паузу для `wa_wa`.
- Версія **0.4** / `package.json` **0.4.0**.

---

## 2025-03-22 — етап 3 (фільтри)

- **Фільтри тексту та частот** для кожної автоматизації: поля `keywords` та `frequencies` у `data/flows.json`; токени розділяються комою, крапкою з комою, новим рядком або `;`. Хоча б одне поле має містити токени; збіг — підрядок у **повному тексті** повідомлення (без окремої нормалізації). Якщо заповнені обидва поля — умова **АБО** між ними. Якщо в **будь-якому** полі є токен `*` — фільтри для цього запису не застосовуються (пересилання як раніше без відсіву).
- Режим лише `.env`: змінні **`SOURCE_FILTER_KEYWORDS`**, **`SOURCE_FILTER_FREQUENCIES`**; якщо обидві порожні — поведінка як `*` (усі повідомлення з `SOURCE_CHAT`).
- Міграція: старі записи з порожніми обома полями отримують `keywords: "*"`.
- Панель: увімкнені поля в модалці; підказки; рядок підсумку фільтрів на картці.
- Версія **0.3** / `package.json` **0.3.0**.

---

## 2025-03-22 (пізніше)

- Автоматизації: поле **`paused`** у `data/flows.json`; на паузі повідомлення не маршрутизуються (ігнор у `message_create`). Валідація конфлікту джерел лише між **активними** записами (на паузі можна дублювати з тими самими чатами).
- API: **`POST /api/flows/:id/duplicate`** (копія з `paused: true`, відкриття форми в UI), **`POST /api/flows/:id/pause`** (перемикач паузи з перевіркою конфліктів при «запуску»).
- **`GET /api/chats`:** лише групи — id закінчуються на **`@g.us`**.
- Панель: картки автоматизацій — **іконки** дублювати · пауза/запуск · редагувати · видалити; підпис **«Пауза»**; перемикач **«Показувати ID чатів»** (localStorage `wb_showChatIds`), за замовчуванням у списку джерел і в картці — **назви**, ID опційно.
- Версія: **`VERSION` 0.2**, `package.json` **0.2.0**.

---

## 2025-03-22

- Документація інжесту: **`docs/FASTAPI_INGEST.md`** (узгодження з `radio_63ombr/docs/BOT_INGEST_API.md`); поля `flow_id` / `flow_name` лише для бота; пояснення **`#go`** та **`allow_send`** (безпека на тестах).
- **`index.cjs`:** не викликати FastAPI, якщо після префікса **порожній `text`** або немає `message_id`; логування тіла відповіді при помилках HTTP; окремий `try/catch` навколо `postToFastAPI`.
- Версія проєкту: **`VERSION` = 0.1**; правило релізів — після кожного завершеного етапу додавати **+0.1**; `package.json` узгоджено як **0.1.0**.
- Файл **`VERSION`** у корені; версія читається при старті, передається в `GET /api/state` та `/api/panel-auth/me`, показується зліва знизу в сайдбарі та на `login.html`.
- `docs/PROJECT.md`: підрозділ **«Етап 1 — інтеграція WhatsApp (критерії завершення)»** — фіксація приймання першого етапу (панель, QR, вихід, скидання, відновлення після зупинки).
- Автоматизації **WA → FastAPI**: кілька чатів-джерел на запис (`sourceChatIds`), endpoint і чат для `actions` — з `.env` (`FASTAPI_URL`, `TARGET_CHAT`). Міграція старих `flows.json` (поле `sourceChatIds`, `wa_rer` → `wa_fastapi`).
- Веб-панель: обов’язковий вхід за `PANEL_USER` / `PANEL_PASSWORD` (`/login.html`, cookie-сесія), кнопка «Вийти з панелі». Залежність `cookie-parser`.
- UI автоматизацій: розділи як у референсі; активні лише назва та мультивибір джерел; інші поля вимкнені до наступних етапів.
- `docs/PROJECT.md`: додано розділ **«Принципи архітектури»** (транспорт vs RER, еволюція функцій, стек панелі).
- Панель: трьохколонковий layout (референс S-Wapp), розділи **Інтеграція** та **Потоки**; модальне вікно створення/редагування потоку; список чатів з `GET /api/chats` (після готовності клієнта).
- Потоки зберігаються в `data/flows.json`; CRUD `GET/POST/PUT/DELETE /api/flows`. Напрямки: `wa_wa` (пересилання в інший чат), `wa_rer` (POST на FastAPI + відповіді в обраний чат). Якщо потоків немає — використовується колишня логіка `.env` (`SOURCE_CHAT` / `TARGET_CHAT` / `FASTAPI_URL`).
- Підключено Git: `git init`, початковий коміт. Додано `.gitignore` (сесія WA, кеш, `logs/`, `node_modules/`, `.env`) та `.env.example` як шаблон без секретів.
- Додано вступну документацію: `docs/PROJECT.md` (структура, змінні середовища, правила), цей файл `docs/CHANGELOG.md` для подальших правок.

---

<!-- Нова запис додавати зверху під заголовком дати, наприклад:

## 2025-03-23

- Опис зміни (`index.cjs`, `public/index.html`).

-->
