# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm start          # start the bot (node index.cjs)
run_bot.bat        # Windows: installs deps, opens browser, starts bot
reset_session.bat  # Windows: delete .wwebjs_auth + .wwebjs_cache (force new QR)
```

No linter or automated test suite is configured. Validation is manual via the web panel at `http://localhost:3001` and by checking `http://localhost:3001/api/state`.

For Signal infrastructure:
```bash
docker compose -f docker-compose.signal.yml up -d   # start Signal bridge
```

## File Reading Order

Before implementing changes, read these files in order:

1. `docs/STATUS_CONTEXT.md` — current state and in-progress work
2. `docs/PROJECT.md` — project goals and env variable reference
3. `docs/CHANGELOG.md` — history of changes
4. `index.cjs` — main process (4500+ lines, all core logic)
5. `public/index.html` — web panel (Ukrainian UI)
6. `docker-compose.signal.yml` — Signal infrastructure
7. `signal-bridge/server.cjs` — Signal API adapter
8. `data/flows.json` — saved automations

## Architecture

The bot is a Node.js (CommonJS) process with three core layers:

**1. Transport Layer (`index.cjs`)**
- WhatsApp via `whatsapp-web.js` (Puppeteer/Chromium), session saved in `.wwebjs_auth/`
- Signal via HTTP polling from a Docker bridge (`SIGNAL_API_URL`)
- Express server hosts the web panel on `PORT` (default 3001)
- SSE stream at `GET /api/events` for live UI updates

**2. Chat Directory (`src/chat-directory/chatDirectory.js`)**
- Persistent registry in `data/chat-directory.json`
- Stable internal key format: `<platform>:chat:<id>` (e.g. `signal:chat:group.v2...`)
- Upserts on every incoming message (currently Signal-only; WhatsApp gated)
- Provides `resolvedName`, `manualLabel`, `aliases`, `lastSeenAt` for UI and routing

**3. Normalization (`src/normalization/chatIdentity.js`)**
- Canonicalizes chat IDs (case-insensitive, group format variants)
- `buildChatCandidates()` generates the set of IDs used to match against flows

**Routing flow:**
1. Message arrives → upsert to chat-directory
2. `flowMatchesMessage()` tries `sourceChatKey` match first (stable `chatKey` from directory), then falls back to legacy `sourceChatIds[]` + `aliases[]` matching
3. If matched, apply `keywords`/`frequencies` text filters (substring match, `*` = pass all)
4. Forward to `targetPlatform`: WhatsApp send, Signal POST to bridge `/send`, or FastAPI POST

**Flows** are stored in `data/flows.json` and managed via `GET/POST/PUT/DELETE /api/flows`. Each flow has: `sourcePlatform`, `targetPlatform`, `sourceChatKey` (preferred) or `sourceChatIds[]`+`aliases[]`, `sourceChatRefs[]`, `targetChatRef`, `keywords`, `frequencies`, `paused`, `sendAttachments`.

**FastAPI contract (chat → GOI, via flow):** `POST FASTAPI_URL` with `{ chat_id, message_id, text, allow_send }`. See `docs/FASTAPI_INGEST.md`.

**Push API (GOI → chat, reverse direction, NO flow):** the external service (radio_63ombr) calls the bot directly — `GET /api/push/accounts`, `GET /api/push/chats`, `POST /api/push/send` (`{ platform, chat_id, text, image_base64 }`). See `docs/PUSH_API.md`. A legacy `sourcePlatform: 'http'` flow path was replaced by this API (leftover whitelist entries in `index.cjs` are orphaned).

**Signal bridge** (`signal-bridge/server.cjs`, port 3002 by default) adapts `signal-cli-rest-api` to bot expectations. Expected endpoints: `GET /health`, `GET /chats`, `GET /messages`, `POST /send`, `POST /link`, `GET /linked`.

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Panel HTTP port |
| `FASTAPI_URL` | `http://127.0.0.1:8000/api/ingest/whatsapp` | RER endpoint |
| `SOURCE_CHAT` / `TARGET_CHAT` | — | Fallback routing when no flows |
| `SEND_PREFIX` | `#go` | Message prefix that sets `allow_send=true` to FastAPI |
| `SEND_DELAY_MS` | `2000` | Delay between outgoing messages (ms) |
| `HEADLESS` | `1` | Puppeteer headless mode |
| `CHROME_EXECUTABLE_PATH` | — | Custom Chrome/Edge path (recommended on Windows) |
| `WA_LAUNCH_TIMEOUT_MS` | `120000` | Puppeteer init timeout |
| `PANEL_USER` / `PANEL_PASSWORD` | — | Panel auth (no auth if both empty) |
| `SIGNAL_API_URL` | — | Signal bridge URL |
| `SIGNAL_POLL_MS` | `5000` | Signal polling interval |
| `SIGNAL_INCLUDE_TECHNICAL_IDS` | `0` | Show raw UUID entries in `/chats` |
| `AUTO_START_BOT_ON_SERVICE_START` | `1` | Auto-start WhatsApp on `node index.cjs` |

Panel credentials can also be stored in `data/panel-auth.json` (takes priority over `.env`).

## Working Conventions

- **Routing freeze:** do not modify `flowMatchesMessage`, `sourceChatKey` vs alias logic, or Signal/WA source matching unless explicitly asked.
- **Minimal changes:** edit only what the task requires; no unrelated refactors.
- **Version bumps:** do not change `VERSION`, `package.json`, or `package-lock.json` unless the user explicitly asks to record a release.
- **After behavior changes:** update `docs/CHANGELOG.md` (what changed) and `docs/STATUS_CONTEXT.md` (current state).
- **UI language:** `public/index.html` is in Ukrainian — keep new UI text consistent.
- **Code style:** match existing `index.cjs` (CommonJS, `require`, no ES modules).

## Data Files (not committed)

- `data/flows.json` — automations
- `data/chat-directory.json` — chat registry
- `data/panel-auth.json` — panel credentials
- `.wwebjs_auth/` — WhatsApp session (delete to force new QR)
- `logs/` — runtime logs (`bot.log`, `health.json`, `signal_raw.ndjson`)
