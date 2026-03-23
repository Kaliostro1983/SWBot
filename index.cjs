require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { exec, spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3001);
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://127.0.0.1:8000/api/ingest/whatsapp';
const SOURCE_CHAT = process.env.SOURCE_CHAT || '';
const TARGET_CHAT = process.env.TARGET_CHAT || '';
const SEND_PREFIX = process.env.SEND_PREFIX || '#go';
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 2000);
const HEADLESS = String(process.env.HEADLESS || '1') === '1';
const PANEL_USER = String(process.env.PANEL_USER || '').trim();
const PANEL_PASSWORD = String(process.env.PANEL_PASSWORD || '').trim();
const SOURCE_FILTER_KEYWORDS = String(process.env.SOURCE_FILTER_KEYWORDS || '').trim();
const SOURCE_FILTER_FREQUENCIES = String(process.env.SOURCE_FILTER_FREQUENCIES || '').trim();
const SIGNAL_API_URL = String(process.env.SIGNAL_API_URL || '').trim();
const SIGNAL_POLL_MS = Number(process.env.SIGNAL_POLL_MS || 5000);

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const HEALTH_FILE = path.join(LOG_DIR, 'health.json');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth');
const CACHE_DIR = path.join(ROOT_DIR, '.wwebjs_cache');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const FLOWS_FILE = path.join(DATA_DIR, 'flows.json');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');

function readAppVersion() {
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf8');
    const line = raw.split(/\r?\n/)[0].trim();
    if (line) return line;
  } catch {
    /* ignore */
  }
  try {
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '0.0.0').trim();
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = readAppVersion();

function loadFlowsFromDisk() {
  try {
    if (!fs.existsSync(FLOWS_FILE)) return [];
    const raw = fs.readFileSync(FLOWS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFlowsToDisk(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FLOWS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function generateFlowId() {
  return `flow_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getSourceIds(flow) {
  if (Array.isArray(flow.sourceChatIds) && flow.sourceChatIds.length > 0) {
    return flow.sourceChatIds;
  }
  if (flow.sourceChatId) {
    return [flow.sourceChatId];
  }
  return [];
}

function inferPlatforms(flow) {
  const d = String(flow?.direction || '').trim();
  if (d === 'wa_wa') return { sourcePlatform: 'whatsapp', targetPlatform: 'whatsapp' };
  if (d === 'wa_fastapi' || d === 'wa_rer') {
    return { sourcePlatform: 'whatsapp', targetPlatform: 'fastapi' };
  }
  return {
    sourcePlatform: String(flow?.sourcePlatform || 'whatsapp').trim() || 'whatsapp',
    targetPlatform: String(flow?.targetPlatform || 'fastapi').trim() || 'fastapi'
  };
}

function routeCode(flow) {
  const p = inferPlatforms(flow);
  return `${p.sourcePlatform}_${p.targetPlatform}`;
}

/** Токени фільтра: розділяються комою, крапкою з комою, новим рядком або ; */
function splitFilterTokens(s) {
  return String(s || '')
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function filterFieldHasWildcardToken(s) {
  return splitFilterTokens(s).some((t) => t === '*');
}

/** Якщо в будь-якому полі є токен * — не застосовуємо фільтри за текстом/частотами. */
function flowSkipsContentFilters(flow) {
  if (!flow) return true;
  return (
    filterFieldHasWildcardToken(flow.keywords) || filterFieldHasWildcardToken(flow.frequencies)
  );
}

function textMatchesFilterTokens(rawText, fieldValue) {
  const tokens = splitFilterTokens(fieldValue);
  if (tokens.length === 0) return true;
  if (tokens.some((t) => t === '*')) return true;
  const hay = String(rawText || '').toLowerCase();
  return tokens.some((t) => hay.includes(String(t).toLowerCase()));
}

/**
 * Хоча б одне поле має містити токени.
 * Лише ключові слова або лише частоти — збіг по відповідному полю.
 * Обидва з токенами — достатньо збігу по тексту АБО по частотах (підрядки в повному тексті повідомлення).
 */
function passesFlowContentFilters(flow, rawMessageText) {
  if (flowSkipsContentFilters(flow)) return true;
  const k = String(flow.keywords || '').trim();
  const f = String(flow.frequencies || '').trim();
  const tokK = splitFilterTokens(k);
  const tokF = splitFilterTokens(f);
  if (tokK.length === 0 && tokF.length === 0) return false;
  if (tokK.length > 0 && tokF.length === 0) {
    return textMatchesFilterTokens(rawMessageText, k);
  }
  if (tokK.length === 0 && tokF.length > 0) {
    return textMatchesFilterTokens(rawMessageText, f);
  }
  return (
    textMatchesFilterTokens(rawMessageText, k) ||
    textMatchesFilterTokens(rawMessageText, f)
  );
}

function migrateFlowRecord(f) {
  const out = { ...f };
  if (!Array.isArray(out.sourceChatIds) || out.sourceChatIds.length === 0) {
    if (out.sourceChatId) {
      out.sourceChatIds = [out.sourceChatId];
    } else {
      out.sourceChatIds = [];
    }
  }
  if (out.direction === 'wa_rer') {
    out.direction = 'wa_fastapi';
  }
  if (!out.direction) out.direction = 'wa_fastapi';
  if (out.sourcePlatform === undefined || out.targetPlatform === undefined) {
    const p = inferPlatforms(out);
    out.sourcePlatform = p.sourcePlatform;
    out.targetPlatform = p.targetPlatform;
  }
  if (out.keywords === undefined) out.keywords = '';
  if (out.frequencies === undefined) out.frequencies = '';
  if (out.sendAttachments === undefined) out.sendAttachments = false;
  if (out.coordinatesScreenshot === undefined) out.coordinatesScreenshot = false;
  if (out.analysisPlugin === undefined) out.analysisPlugin = null;
  if (out.outdatedDiff === undefined) out.outdatedDiff = null;
  if (out.paused === undefined) out.paused = false;
  if (
    splitFilterTokens(String(out.keywords || '')).length === 0 &&
    splitFilterTokens(String(out.frequencies || '')).length === 0
  ) {
    out.keywords = '*';
  }
  return out;
}

function loadAndMigrateFlows() {
  const raw = loadFlowsFromDisk();
  let needsSave = false;
  const migrated = raw.map((f) => {
    const before = JSON.stringify(f);
    const m = migrateFlowRecord(f);
    if (before !== JSON.stringify(m)) needsSave = true;
    return m;
  });
  if (needsSave && migrated.length > 0) {
    saveFlowsToDisk(migrated);
  }
  return migrated;
}

/** Нова автоматизація з панелі: WA → FastAPI або WA → WhatsApp */
function normalizeAutomation(body, existingId) {
  const ex = existingId ? flows.find((x) => x.id === existingId) : null;
  const name = String(body.name || '').trim();
  let sourceChatIds = [];
  if (Array.isArray(body.sourceChatIds)) {
    sourceChatIds = body.sourceChatIds.map((x) => String(x).trim()).filter(Boolean);
  } else if (body.sourceChatId) {
    const one = String(body.sourceChatId).trim();
    if (one) sourceChatIds = [one];
  }
  let paused = false;
  if (body.paused !== undefined) {
    paused = Boolean(body.paused);
  } else if (existingId && ex) {
    paused = Boolean(ex.paused);
  }
  const keywords =
    body.keywords !== undefined ? String(body.keywords) : ex ? String(ex.keywords ?? '') : '';
  const frequencies =
    body.frequencies !== undefined
      ? String(body.frequencies)
      : ex
        ? String(ex.frequencies ?? '')
        : '';

  let sourcePlatform = body.sourcePlatform !== undefined
    ? String(body.sourcePlatform).trim()
    : ex
      ? String(ex.sourcePlatform || '')
      : '';
  let targetPlatform = body.targetPlatform !== undefined
    ? String(body.targetPlatform).trim()
    : ex
      ? String(ex.targetPlatform || '')
      : '';
  if (!sourcePlatform || !targetPlatform) {
    const p = inferPlatforms({ ...(ex || {}), direction: body.direction || ex?.direction });
    if (!sourcePlatform) sourcePlatform = p.sourcePlatform;
    if (!targetPlatform) targetPlatform = p.targetPlatform;
  }
  if (!['whatsapp', 'signal'].includes(sourcePlatform)) sourcePlatform = 'whatsapp';
  if (!['whatsapp', 'signal', 'fastapi'].includes(targetPlatform)) targetPlatform = 'fastapi';
  const direction = sourcePlatform === 'whatsapp' && targetPlatform === 'whatsapp'
    ? 'wa_wa'
    : sourcePlatform === 'whatsapp' && targetPlatform === 'fastapi'
      ? 'wa_fastapi'
      : `${sourcePlatform}_${targetPlatform}`;

  let targetChatId = null;
  if (targetPlatform === 'whatsapp' || targetPlatform === 'signal') {
    if (body.targetChatId !== undefined && body.targetChatId !== null) {
      const t = String(body.targetChatId).trim();
      targetChatId = t || null;
    } else if (ex && ex.targetChatId) {
      targetChatId = String(ex.targetChatId).trim() || null;
    }
  }

  return {
    id: existingId || generateFlowId(),
    name,
    direction,
    sourcePlatform,
    targetPlatform,
    sourceChatIds,
    sourceChatId: sourceChatIds[0] || null,
    fastapiUrl: null,
    targetChatId,
    paused,
    keywords,
    frequencies,
    sendAttachments:
      body.sendAttachments !== undefined ? Boolean(body.sendAttachments) : ex
        ? Boolean(ex.sendAttachments)
        : false,
    coordinatesScreenshot:
      body.coordinatesScreenshot !== undefined
        ? Boolean(body.coordinatesScreenshot)
        : ex
          ? Boolean(ex.coordinatesScreenshot)
          : false,
    analysisPlugin:
      body.analysisPlugin !== undefined ? body.analysisPlugin : ex ? ex.analysisPlugin : null,
    outdatedDiff: body.outdatedDiff !== undefined ? body.outdatedDiff : ex ? ex.outdatedDiff : null
  };
}

function validateAutomation(f, allFlows, excludeId) {
  if (!f.name) return 'Вкажіть назву автоматизації';
  if (!f.sourceChatIds || f.sourceChatIds.length === 0) {
    return 'Оберіть хоча б один чат-джерело';
  }
  const p = inferPlatforms(f);
  if (p.targetPlatform === 'whatsapp' || p.targetPlatform === 'signal') {
    const tid = String(f.targetChatId || '').trim();
    if (!tid) return 'Оберіть цільовий чат для обраного напрямку';
    if (f.sourceChatIds.some((sid) => sid === tid)) {
      return 'Цільовий чат не може збігатися з чатом-джерелом';
    }
  }
  const hasKTok = splitFilterTokens(String(f.keywords || '')).length > 0;
  const hasFTok = splitFilterTokens(String(f.frequencies || '')).length > 0;
  if (!hasKTok && !hasFTok) {
    return 'Заповніть хоча б одне поле: ключові слова або частоти. Окремий рядок * — пропускати все без фільтрів.';
  }
  if (!f.paused) {
    const others = allFlows.filter((x) => x.id !== excludeId);
    for (const sid of f.sourceChatIds) {
      const conflict = others.find((o) => !o.paused && getSourceIds(o).includes(sid));
      if (conflict) {
        return `Чат уже в активній автоматизації «${conflict.name}» (на паузі — можна дублювати)`;
      }
    }
  }
  return null;
}

function isFastapiDirection(flow) {
  const p = inferPlatforms(flow);
  return p.sourcePlatform === 'whatsapp' && p.targetPlatform === 'fastapi';
}

let flows = [];

const panelSessions = new Map();

function isPanelAuthEnabled() {
  return Boolean(PANEL_USER && PANEL_PASSWORD);
}

function panelAuthMiddleware(req, res, next) {
  if (!isPanelAuthEnabled()) {
    return next();
  }
  const p = req.path.split('?')[0];
  if (p === '/login.html') return next();
  if (p === '/favicon.ico') return next();
  if (p === '/api/panel-auth/login' && req.method === 'POST') return next();
  if (p === '/api/panel-auth/logout' && req.method === 'POST') return next();
  if (p === '/api/panel-auth/me') return next();

  const tok = req.cookies?.wb_panel;
  if (tok && panelSessions.has(tok)) {
    return next();
  }

  if (p.startsWith('/api/')) {
    return res.status(401).json({
      ok: false,
      code: 'panel_auth',
      message: 'Потрібен вхід у панель керування'
    });
  }

  return res.redirect(302, '/login.html');
}

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
flows = loadAndMigrateFlows();

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(panelAuthMiddleware);

app.post('/api/panel-auth/login', (req, res) => {
  const { user, password } = req.body || {};
  if (!isPanelAuthEnabled()) {
    return res.json({ ok: true, authDisabled: true });
  }
  if (user === PANEL_USER && password === PANEL_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    panelSessions.set(token, { created: Date.now() });
    res.cookie('wb_panel', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: 'Невірний логін або пароль' });
});

app.post('/api/panel-auth/logout', (req, res) => {
  const tok = req.cookies?.wb_panel;
  if (tok) panelSessions.delete(tok);
  res.clearCookie('wb_panel');
  res.json({ ok: true });
});

app.get('/api/panel-auth/me', (req, res) => {
  const ver = { version: APP_VERSION };
  if (!isPanelAuthEnabled()) {
    return res.json({ ok: true, auth: true, authDisabled: true, ...ver });
  }
  const tok = req.cookies?.wb_panel;
  res.json({
    ok: true,
    auth: Boolean(tok && panelSessions.has(tok)),
    authDisabled: false,
    ...ver
  });
});

let client = null;
let isStarting = false;
let isStopping = false;
let heartbeatTimer = null;
let lastQr = null;
let eventClients = [];
let lastSendTs = 0;
let signalPollTimer = null;
let signalLastPollTs = 0;
const signalSeenMessageIds = new Set();

const state = {
  status: 'idle',
  authenticated: false,
  ready: false,
  qrAvailable: false,
  clientInfo: null,
  sourceChat: SOURCE_CHAT,
  targetChat: TARGET_CHAT,
  startedAt: null,
  lastPulseAt: null,
  lastEventAt: null,
  lastReadyAt: null,
  lastMessageAt: null,
  lastPostAt: null,
  lastSendAt: null,
  lastErrorAt: null,
  lastError: null,
  lastDisconnectReason: null,
  signal: {
    enabled: Boolean(SIGNAL_API_URL),
    lastPollAt: null,
    lastErrorAt: null,
    lastError: null,
    running: false
  },
  counters: {
    received: 0,
    accepted: 0,
    ignored: 0,
    posted: 0,
    sent: 0,
    errors: 0
  },
  logs: []
};

function parseSignalLinkUri(stdout) {
  // CLI prints sgnl://linkdevice?... as plain text.
  const m = String(stdout || '').match(/sgnl:\/\/[^\s'"]+/);
  return m ? m[0] : null;
}

function dockerExecSignalLink(deviceName) {
  const name = String(deviceName || 'wa-bridge').trim();
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', 'signal-cli-api', 'sh', '-lc', `signal-cli link -n ${JSON.stringify(name)}`], {
      windowsHide: true
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    let done = false;
    const failTimer = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill(); } catch {}
      reject(new Error('Таймаут генерації Signal link (не отримано sgnl:// URI)'));
    }, 20000);

    function finishOk(uri) {
      if (done) return;
      done = true;
      clearTimeout(failTimer);
      try { proc.kill(); } catch {}
      resolve(uri);
    }
    function finishErr(message) {
      if (done) return;
      done = true;
      clearTimeout(failTimer);
      try { proc.kill(); } catch {}
      reject(new Error(message));
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += String(chunk || '');
      const uri = parseSignalLinkUri(stdoutBuf);
      if (uri) finishOk(uri);
    });
    proc.stderr.on('data', (chunk) => {
      stderrBuf += String(chunk || '');
      const uri = parseSignalLinkUri(stderrBuf);
      if (uri) finishOk(uri);
    });
    proc.on('error', (err) => {
      finishErr(err.message || 'Помилка запуску docker exec signal-cli link');
    });
    proc.on('close', (code) => {
      if (done) return;
      const uri = parseSignalLinkUri(stdoutBuf || stderrBuf);
      if (uri) return finishOk(uri);
      finishErr(
        `signal-cli link завершився з кодом ${code}. ${stderrBuf || stdoutBuf || 'Без деталей'}`
      );
    });
  });
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function pushLog(level, message, meta = null) {
  const line = {
    ts: nowIso(),
    level,
    message,
    meta: safeJson(meta)
  };

  state.logs.push(line);
  if (state.logs.length > 400) {
    state.logs.shift();
  }

  const printable = `[${line.ts}] [${level}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
  fs.appendFileSync(LOG_FILE, printable, 'utf8');

  if (level === 'ERROR') {
    state.lastErrorAt = line.ts;
    state.lastError = `${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
    state.counters.errors += 1;
  }

  writeHealth();
  broadcastEvent('log', line);
}

function getPublicState() {
  return {
    status: state.status,
    authenticated: state.authenticated,
    ready: state.ready,
    qrAvailable: state.qrAvailable,
    clientInfo: state.clientInfo,
    sourceChat: state.sourceChat,
    targetChat: state.targetChat,
    startedAt: state.startedAt,
    lastPulseAt: state.lastPulseAt,
    lastEventAt: state.lastEventAt,
    lastReadyAt: state.lastReadyAt,
    lastMessageAt: state.lastMessageAt,
    lastPostAt: state.lastPostAt,
    lastSendAt: state.lastSendAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    lastDisconnectReason: state.lastDisconnectReason,
    counters: state.counters,
    qrAvailableData: lastQr,
    flows,
    routingMode: flows.length > 0 ? 'flows' : 'env',
    panel: {
      authRequired: isPanelAuthEnabled(),
      fastapiUrlDefault: FASTAPI_URL,
      targetChatDefault: TARGET_CHAT || null
    },
    signal: state.signal,
    version: APP_VERSION
  };
}

function setStatus(status, patch = {}) {
  state.status = status;
  Object.assign(state, patch);
  state.lastPulseAt = nowIso();
  writeHealth();
  broadcastEvent('state', getPublicState());
}

async function signalApiRequest(method, endpoint, data = undefined, params = undefined) {
  if (!SIGNAL_API_URL) {
    throw new Error('SIGNAL_API_URL is not configured');
  }
  const url = `${SIGNAL_API_URL.replace(/\/+$/, '')}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  const res = await axios({
    method,
    url,
    data,
    params,
    timeout: 30000
  });
  return res.data;
}

function normalizeSignalChatList(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.chats)
      ? raw.chats
      : Array.isArray(raw?.data)
        ? raw.data
        : [];
  return arr
    .map((x) => {
      const id = String(x.id || x.chatId || x.uuid || x.number || '').trim();
      const name = String(x.name || x.title || x.displayName || id).trim();
      return id ? { id, name: name || id } : null;
    })
    .filter(Boolean);
}

function normalizeSignalMessages(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.messages)
      ? raw.messages
      : Array.isArray(raw?.data)
        ? raw.data
        : [];
  return arr
    .map((m) => {
      const id = String(m.id || m.messageId || m.uuid || '').trim();
      const chatId = String(m.chatId || m.source || m.groupId || '').trim();
      const text = String(m.text || m.message || m.body || '').trim();
      const author = m.author || m.sender || null;
      const tsRaw = Number(m.timestamp || m.ts || Date.now());
      if (!chatId) return null;
      return {
        id: id || `signal_${chatId}_${tsRaw}_${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        text,
        author,
        timestamp: Number.isFinite(tsRaw) ? tsRaw : Date.now()
      };
    })
    .filter(Boolean);
}

async function fetchSignalChats() {
  const raw = await signalApiRequest('get', '/chats');
  return normalizeSignalChatList(raw);
}

async function sendSignalMessage(chatId, text) {
  await signalApiRequest('post', '/send', {
    chatId,
    text
  });
}

function writeHealth() {
  fs.writeFileSync(
    HEALTH_FILE,
    JSON.stringify(
      {
        ...getPublicState(),
        logsTail: state.logs.slice(-30)
      },
      null,
      2
    ),
    'utf8'
  );
}

function broadcastEvent(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

  eventClients = eventClients.filter((res) => {
    try {
      res.write(data);
      return true;
    } catch {
      return false;
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripPrefix(text, prefix) {
  if (!text) return '';
  return text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text;
}

function getChatId(msg) {
  return msg.fromMe ? msg.to : msg.from;
}

async function sendWithRateLimit(chatId, text) {
  const waitMs = Math.max(0, SEND_DELAY_MS - (Date.now() - lastSendTs));
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const chat = await client.getChatById(chatId);
  await chat.sendMessage(text);

  lastSendTs = Date.now();
  state.lastSendAt = nowIso();
  state.counters.sent += 1;

  pushLog('INFO', 'Forward sent', {
    targetChat: chatId,
    length: text.length
  });
}

async function sendMediaWithRateLimit(chatId, mimetype, data, filename, caption) {
  const waitMs = Math.max(0, SEND_DELAY_MS - (Date.now() - lastSendTs));
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const chat = await client.getChatById(chatId);
  const media = new MessageMedia(mimetype, data, filename || undefined);
  await chat.sendMessage(media, { caption: caption || undefined });

  lastSendTs = Date.now();
  state.lastSendAt = nowIso();
  state.counters.sent += 1;

  pushLog('INFO', 'Forward sent (media)', {
    targetChat: chatId,
    mimetype
  });
}

/**
 * WA → WhatsApp: текст і/або зображення (інші типи медіа — за потреби розширити).
 */
async function forwardWaToWa(flow, msg) {
  const target = flow.targetChatId;
  if (!target) {
    pushLog('ERROR', 'WA→WA: немає targetChatId', { flowId: flow.id });
    return;
  }
  const caption = String(msg.body || '').trim();
  const wantMedia = flow.sendAttachments && msg.hasMedia;

  if (wantMedia) {
    try {
      const dl = await msg.downloadMedia();
      if (dl && dl.data) {
        await sendMediaWithRateLimit(
          target,
          dl.mimetype,
          dl.data,
          dl.filename || undefined,
          caption || undefined
        );
        return;
      }
    } catch (err) {
      pushLog('ERROR', 'WA→WA: не вдалося завантажити медіа', {
        message: err.message
      });
    }
  }

  if (caption) {
    await sendWithRateLimit(target, caption);
  } else if (!wantMedia) {
    pushLog('INFO', 'WA→WA: немає тексту й медіа для пересилання', {
      flowId: flow.id
    });
  }
}

async function forwardWaToSignal(flow, msg) {
  const target = String(flow.targetChatId || '').trim();
  if (!target) {
    pushLog('ERROR', 'WA→Signal: немає targetChatId', { flowId: flow.id });
    return;
  }
  const text = String(msg.body || '').trim();
  if (!text) {
    pushLog('INFO', 'WA→Signal: порожній текст, пропуск', { flowId: flow.id });
    return;
  }
  await sendSignalMessage(target, text);
  state.lastSendAt = nowIso();
  state.counters.sent += 1;
  pushLog('INFO', 'Forward sent (signal)', { targetChat: target, length: text.length });
}

async function postToFastAPI(payload, url = FASTAPI_URL) {
  const response = await axios.post(url, payload, { timeout: 30000 });
  state.lastPostAt = nowIso();
  state.counters.posted += 1;
  return response.data;
}

async function processSignalIncomingMessage(message) {
  const chatId = message.chatId;
  const rawText = String(message.text || '').trim();
  const flow = flows.find((f) => {
    const p = inferPlatforms(f);
    return p.sourcePlatform === 'signal' && getSourceIds(f).includes(chatId);
  });
  if (!flow) return;

  state.lastEventAt = nowIso();
  state.lastMessageAt = nowIso();
  state.counters.received += 1;

  if (flow.paused) {
    state.counters.ignored += 1;
    return;
  }
  if (!passesFlowContentFilters(flow, rawText)) {
    state.counters.ignored += 1;
    return;
  }
  state.counters.accepted += 1;

  const p = inferPlatforms(flow);
  if (p.targetPlatform === 'signal') {
    const target = String(flow.targetChatId || '').trim();
    if (!target) return;
    if (!rawText) return;
    await sendSignalMessage(target, rawText);
    state.lastSendAt = nowIso();
    state.counters.sent += 1;
    pushLog('INFO', 'Signal→Signal sent', { flowId: flow.id, targetChat: target });
    return;
  }

  if (p.targetPlatform === 'whatsapp') {
    const target = String(flow.targetChatId || '').trim();
    if (!target) return;
    if (!rawText) return;
    if (!client || !state.ready) {
      pushLog('ERROR', 'Signal→WA: клієнт WhatsApp не готовий', { flowId: flow.id });
      return;
    }
    await sendWithRateLimit(target, rawText);
    pushLog('INFO', 'Signal→WA sent', { flowId: flow.id, targetChat: target });
    return;
  }

  if (p.targetPlatform === 'fastapi') {
    const ingestUrl = flow.fastapiUrl || FASTAPI_URL;
    const payload = {
      platform: 'signal',
      chat_id: chatId,
      chat_name: null,
      message_id: message.id,
      author: message.author || null,
      published_at_platform: new Date(message.timestamp).toISOString(),
      text: rawText,
      allow_send: true,
      flow_id: flow.id,
      flow_name: flow.name
    };
    let apiResult;
    try {
      apiResult = await postToFastAPI(payload, ingestUrl);
    } catch (err) {
      const ax = err.response;
      pushLog('ERROR', 'Signal→FastAPI POST failed', {
        message: err.message,
        status: ax?.status,
        body: ax?.data ?? null
      });
      return;
    }
    const actions = Array.isArray(apiResult?.actions) ? apiResult.actions : [];
    if (actions.length === 0) return;
    const targetChat = flow.targetChatId || TARGET_CHAT;
    if (!targetChat) return;
    if (!client || !state.ready) {
      pushLog('ERROR', 'Signal→FastAPI actions: клієнт WhatsApp не готовий', { flowId: flow.id });
      return;
    }
    for (const action of actions) {
      if (action?.type !== 'send_message') continue;
      const txt = String(action?.text || '').trim();
      if (!txt) continue;
      await sendWithRateLimit(targetChat, txt);
    }
  }
}

async function pollSignalMessages() {
  if (!SIGNAL_API_URL) return;
  try {
    const raw = await signalApiRequest('get', '/messages', undefined, {
      since: signalLastPollTs || undefined
    });
    const msgs = normalizeSignalMessages(raw);
    state.signal.lastPollAt = nowIso();
    signalLastPollTs = Date.now();
    for (const m of msgs) {
      if (signalSeenMessageIds.has(m.id)) continue;
      signalSeenMessageIds.add(m.id);
      if (signalSeenMessageIds.size > 5000) {
        const first = signalSeenMessageIds.values().next().value;
        signalSeenMessageIds.delete(first);
      }
      await processSignalIncomingMessage(m);
    }
  } catch (error) {
    state.signal.lastErrorAt = nowIso();
    state.signal.lastError = error.message;
    pushLog('ERROR', 'Signal polling failed', { message: error.message });
  }
}

function startSignalWorker() {
  if (!SIGNAL_API_URL || signalPollTimer) return;
  state.signal.running = true;
  pollSignalMessages().catch(() => {});
  signalPollTimer = setInterval(() => {
    pollSignalMessages().catch(() => {});
  }, Math.max(1000, SIGNAL_POLL_MS));
  pushLog('INFO', 'Signal worker started', { pollMs: Math.max(1000, SIGNAL_POLL_MS) });
}

function stopSignalWorker() {
  if (signalPollTimer) {
    clearInterval(signalPollTimer);
    signalPollTimer = null;
  }
  state.signal.running = false;
}

/** Пересилання вкладення у цільовий чат (FastAPI-гілка). */
async function forwardFlowMediaToTarget(flow, msg, caption) {
  const targetChat = flow.targetChatId || TARGET_CHAT;
  if (!targetChat) {
    pushLog('ERROR', 'Немає цільового чату для медіа (TARGET_CHAT / targetChatId)');
    return;
  }
  if (!flow.sendAttachments || !msg.hasMedia) return;
  const dl = await msg.downloadMedia();
  if (!dl || !dl.data) return;
  await sendMediaWithRateLimit(
    targetChat,
    dl.mimetype,
    dl.data,
    dl.filename || undefined,
    caption || undefined
  );
}

function deleteDirIfExists(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function attachClientEvents(instance) {
  instance.on('qr', async (qr) => {
    state.lastEventAt = nowIso();
    state.qrAvailable = true;
    state.authenticated = false;
    state.ready = false;
    lastQr = await QRCode.toDataURL(qr);

    setStatus('awaiting_qr');
    pushLog('INFO', 'QR received');
  });

  instance.on('authenticated', () => {
    state.lastEventAt = nowIso();
    state.authenticated = true;
    state.qrAvailable = false;
    lastQr = null;

    setStatus('authenticated');
    pushLog('INFO', 'Authenticated');
  });

  instance.on('auth_failure', (msg) => {
    state.lastEventAt = nowIso();
    state.authenticated = false;
    state.ready = false;

    setStatus('auth_failure');
    pushLog('ERROR', 'Authentication failed', { msg });
  });

  instance.on('ready', () => {
    state.lastEventAt = nowIso();
    state.lastReadyAt = nowIso();
    state.authenticated = true;
    state.ready = true;
    state.qrAvailable = false;
    lastQr = null;

    let clientInfo = null;
    try {
      clientInfo = instance.info
        ? {
            wid: instance.info.wid?._serialized || null,
            pushname: instance.info.pushname || null,
            platform: instance.info.platform || null
          }
        : null;
    } catch {
      clientInfo = null;
    }

    state.clientInfo = clientInfo;
    setStatus('ready');
    pushLog('INFO', 'Client ready', clientInfo);
  });

  instance.on('disconnected', (reason) => {
    state.lastEventAt = nowIso();
    state.authenticated = false;
    state.ready = false;
    state.lastDisconnectReason = String(reason || 'unknown');

    setStatus('disconnected');
    pushLog('ERROR', 'Disconnected', { reason: String(reason || 'unknown') });
  });

  instance.on('message_create', async (msg) => {
    try {
      state.lastEventAt = nowIso();
      state.lastMessageAt = nowIso();
      state.counters.received += 1;

      const chatId = getChatId(msg);
      const rawText = String(msg.body || '').trim();

      let flow = null;
      if (flows.length > 0) {
        flow = flows.find((f) => {
          const p = inferPlatforms(f);
          return p.sourcePlatform === 'whatsapp' && getSourceIds(f).includes(chatId);
        });
        if (!flow) {
          state.counters.ignored += 1;
          return;
        }
      } else {
        if (!SOURCE_CHAT || chatId !== SOURCE_CHAT) {
          state.counters.ignored += 1;
          return;
        }
        let kwE = SOURCE_FILTER_KEYWORDS;
        let frE = SOURCE_FILTER_FREQUENCIES;
        if (
          splitFilterTokens(kwE).length === 0 &&
          splitFilterTokens(frE).length === 0
        ) {
          kwE = '*';
        }
        flow = {
          id: '_env',
          name: 'Змінні середовища',
          direction: 'wa_fastapi',
          sourcePlatform: 'whatsapp',
          targetPlatform: 'fastapi',
          sourceChatId: SOURCE_CHAT,
          sourceChatIds: [SOURCE_CHAT],
          targetChatId: TARGET_CHAT || null,
          fastapiUrl: FASTAPI_URL,
          paused: false,
          keywords: kwE,
          frequencies: frE
        };
      }

      if (flow.paused === true) {
        state.counters.ignored += 1;
        pushLog('INFO', 'Автоматизація на паузі', {
          flowId: flow.id,
          name: flow.name
        });
        return;
      }

      if (!passesFlowContentFilters(flow, rawText)) {
        state.counters.ignored += 1;
        pushLog('INFO', 'Пропуск: не пройшли фільтри ключових слів / частот', {
          flowId: flow.id,
          name: flow.name
        });
        return;
      }

      state.counters.accepted += 1;

      const allowSend = rawText.startsWith(SEND_PREFIX);
      const normalizedText = stripPrefix(rawText, SEND_PREFIX);

      pushLog('INFO', 'Source message accepted', {
        flowId: flow.id,
        flowName: flow.name,
        direction: flow.direction,
        sourcePlatform: inferPlatforms(flow).sourcePlatform,
        targetPlatform: inferPlatforms(flow).targetPlatform,
        chatId,
        fromMe: msg.fromMe,
        allowSend,
        startsWithPrefix: allowSend,
        hasMedia: Boolean(msg.hasMedia),
        textPreview: normalizedText.slice(0, 120),
        messageId: msg.id?._serialized || null
      });

      const rCode = routeCode(flow);
      if (rCode === 'whatsapp_whatsapp') {
        await forwardWaToWa(flow, msg);
        return;
      }

      if (rCode === 'whatsapp_signal') {
        await forwardWaToSignal(flow, msg);
        return;
      }

      if (!isFastapiDirection(flow)) {
        pushLog('ERROR', 'Непідтримуваний напрямок для WA-події', {
          flowId: flow.id,
          direction: flow.direction
        });
        return;
      }

      const textForIngest = String(normalizedText).trim();
      if (!textForIngest) {
        if (allowSend && flow.sendAttachments && msg.hasMedia) {
          try {
            await forwardFlowMediaToTarget(flow, msg, '');
          } catch (err) {
            pushLog('ERROR', 'Медіа без тексту для інжесту', { message: err.message });
          }
          return;
        }
        pushLog('INFO', 'Пропуск FastAPI: порожній text після префікса (бекенд вимагає непорожній text)', {
          chatId,
          rawPreview: rawText.slice(0, 80)
        });
        return;
      }

      const messageId = msg.id?._serialized || null;
      if (!messageId) {
        pushLog('ERROR', 'Немає message_id для інжесту', { chatId });
        return;
      }

      const ingestUrl = flow.fastapiUrl || FASTAPI_URL;
      const payload = {
        platform: 'whatsapp',
        chat_id: chatId,
        chat_name: null,
        message_id: messageId,
        author: msg.author || msg.from || null,
        published_at_platform: msg.timestamp
          ? new Date(msg.timestamp * 1000).toISOString()
          : nowIso(),
        text: textForIngest,
        allow_send: allowSend,
        flow_id: flow.id,
        flow_name: flow.name
      };

      let apiResult;
      try {
        apiResult = await postToFastAPI(payload, ingestUrl);
      } catch (err) {
        const ax = err.response;
        pushLog('ERROR', 'FastAPI POST failed', {
          message: err.message,
          status: ax?.status,
          body: ax?.data ?? null
        });
        return;
      }
      const actions = Array.isArray(apiResult?.actions) ? apiResult.actions : [];

      pushLog('INFO', 'FastAPI POST success', {
        flowId: flow.id,
        allowSend,
        actionsCount: actions.length
      });

      if (!allowSend) {
        pushLog('INFO', 'Forward skipped: allowSend=false');
        return;
      }

      const targetChat = flow.targetChatId || TARGET_CHAT;
      if (!targetChat) {
        pushLog('ERROR', 'Немає цільового чату для відповідей (targetChatId / TARGET_CHAT)');
        return;
      }

      if (actions.length === 0) {
        if (flow.sendAttachments && msg.hasMedia) {
          try {
            await forwardFlowMediaToTarget(flow, msg, textForIngest);
          } catch (err) {
            pushLog('ERROR', 'Пересилання медіа без actions', { message: err.message });
          }
          return;
        }
        pushLog('ERROR', 'Forward skipped: backend returned 0 actions');
        return;
      }

      for (const action of actions) {
        if (action?.type !== 'send_message') {
          pushLog('INFO', 'Action ignored: unsupported type', { type: action?.type || null });
          continue;
        }

        const text = String(action?.text || '').trim();
        if (!text) {
          pushLog('INFO', 'Action ignored: empty text');
          continue;
        }

        await sendWithRateLimit(targetChat, text);
      }

      if (flow.sendAttachments && msg.hasMedia) {
        try {
          await forwardFlowMediaToTarget(flow, msg, textForIngest);
        } catch (err) {
          pushLog('ERROR', 'Додаткове медіа після actions', { message: err.message });
        }
      }
    } catch (error) {
      if (error.response) {
        pushLog('ERROR', 'message_create handler failed (HTTP)', {
          message: error.message,
          status: error.response.status,
          body: error.response.data
        });
      } else {
        pushLog('ERROR', 'message_create handler failed', {
          message: error.message,
          stack: error.stack
        });
      }
    }
  });
}

async function startBot() {
  if (client || isStarting) {
    return { ok: true, message: 'Bot already started or starting' };
  }

  isStarting = true;
  setStatus('starting', {
    startedAt: nowIso(),
    lastError: null,
    lastDisconnectReason: null
  });

  try {
    client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: HEADLESS,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    attachClientEvents(client);
    await client.initialize();
    startSignalWorker();

    pushLog('INFO', 'Bot initialize requested', { headless: HEADLESS });
    return { ok: true, message: 'Bot started' };
  } catch (error) {
    pushLog('ERROR', 'Failed to start bot', {
      message: error.message,
      stack: error.stack
    });

    client = null;
    setStatus('error');
    return { ok: false, message: error.message };
  } finally {
    isStarting = false;
  }
}

async function stopBot() {
  if (!client || isStopping) {
    return { ok: true, message: 'Bot already stopped or stopping' };
  }

  isStopping = true;
  try {
    await client.destroy();
    client = null;
    lastQr = null;

    state.authenticated = false;
    state.ready = false;
    state.qrAvailable = false;
    state.clientInfo = null;

    setStatus('stopped');
    stopSignalWorker();
    pushLog('INFO', 'Bot stopped');

    return { ok: true, message: 'Bot stopped' };
  } catch (error) {
    pushLog('ERROR', 'Failed to stop bot', {
      message: error.message,
      stack: error.stack
    });

    setStatus('error');
    return { ok: false, message: error.message };
  } finally {
    isStopping = false;
  }
}

async function logoutBot() {
  if (!client) {
    return { ok: false, message: 'Bot is not started' };
  }

  try {
    await client.logout();
    await client.destroy();

    client = null;
    lastQr = null;

    state.authenticated = false;
    state.ready = false;
    state.qrAvailable = false;
    state.clientInfo = null;

    setStatus('logged_out');
    stopSignalWorker();
    pushLog('INFO', 'Logged out');

    return { ok: true, message: 'Logged out' };
  } catch (error) {
    pushLog('ERROR', 'Logout failed', {
      message: error.message,
      stack: error.stack
    });

    setStatus('error');
    return { ok: false, message: error.message };
  }
}

async function resetSession() {
  try {
    if (client) {
      await stopBot();
    }
    stopSignalWorker();

    deleteDirIfExists(AUTH_DIR);
    deleteDirIfExists(CACHE_DIR);

    setStatus('session_reset');
    pushLog('INFO', 'Session reset completed');

    return { ok: true, message: 'Session reset complete' };
  } catch (error) {
    pushLog('ERROR', 'Session reset failed', {
      message: error.message,
      stack: error.stack
    });

    return { ok: false, message: error.message };
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    state.lastPulseAt = nowIso();
    writeHealth();
    broadcastEvent('state', getPublicState());
  }, 5000);
}

app.get('/api/state', (req, res) => {
  res.json(getPublicState());
});

app.get('/api/logs', (req, res) => {
  res.json(state.logs);
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  eventClients.push(res);

  res.write(`event: state\ndata: ${JSON.stringify(getPublicState())}\n\n`);
  for (const item of state.logs.slice(-100)) {
    res.write(`event: log\ndata: ${JSON.stringify(item)}\n\n`);
  }

  req.on('close', () => {
    eventClients = eventClients.filter((x) => x !== res);
  });
});

app.post('/api/start', async (req, res) => {
  res.json(await startBot());
});

app.post('/api/stop', async (req, res) => {
  res.json(await stopBot());
});

app.post('/api/login', async (req, res) => {
  res.json(await startBot());
});

app.post('/api/logout', async (req, res) => {
  res.json(await logoutBot());
});

app.post('/api/reset-session', async (req, res) => {
  res.json(await resetSession());
});

app.post('/api/signal/link', async (req, res) => {
  try {
    const deviceName = String(req.body?.name || 'wa-bridge').trim();
    pushLog('INFO', 'Signal link request', { deviceName });
    if (SIGNAL_API_URL) {
      try {
        const data = await signalApiRequest('post', '/link', { name: deviceName });
        if (data?.ok && data?.qrDataUrl) {
          return res.json({ ok: true, uri: null, qrDataUrl: data.qrDataUrl });
        }
        throw new Error(data?.message || 'Signal bridge /link returned invalid payload');
      } catch (e) {
        pushLog('ERROR', 'Signal link via bridge failed, fallback to docker exec', { message: e.message });
      }
    }
    const uri = await dockerExecSignalLink(deviceName);
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 420, margin: 2 });
    res.json({ ok: true, uri, qrDataUrl });
  } catch (error) {
    pushLog('ERROR', 'Signal link request failed', { message: error.message || String(error) });
    res.status(500).json({ ok: false, message: error.message || String(error) });
  }
});

app.get('/api/chats', async (req, res) => {
  const platform = String(req.query.platform || 'whatsapp').trim();
  if (platform !== 'whatsapp') {
    if (platform === 'signal') {
      if (!SIGNAL_API_URL) return res.json({ ok: true, chats: [] });
      try {
        const list = await fetchSignalChats();
        return res.json({ ok: true, chats: list });
      } catch (error) {
        return res.status(500).json({ ok: false, message: error.message });
      }
    }
    return res.json({ ok: true, chats: [] });
  }
  if (!client || !state.ready) {
    return res.status(503).json({ ok: false, message: 'Клієнт WhatsApp не готовий. Спочатку увійдіть через QR.' });
  }
  try {
    const onlyGroups = String(req.query.only_groups ?? '1') !== '0';
    const chats = await client.getChats();
    const list = chats
      .filter((c) => {
        if (!onlyGroups) return true;
        return String(c.id._serialized || '').endsWith('@g.us');
      })
      .map((c) => ({
        id: c.id._serialized,
        name: (c.name && String(c.name).trim()) || c.id.user || c.id._serialized
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    res.json({ ok: true, chats: list });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get('/api/flows', (req, res) => {
  res.json({ ok: true, flows });
});

app.post('/api/flows', (req, res) => {
  const normalized = normalizeAutomation(req.body || {});
  const err = validateAutomation(normalized, flows, null);
  if (err) {
    return res.status(400).json({ ok: false, message: err });
  }
  flows.push(normalized);
  saveFlowsToDisk(flows);
  writeHealth();
  broadcastEvent('state', getPublicState());
  res.json({ ok: true, flow: normalized });
});

app.put('/api/flows/:id', (req, res) => {
  const idx = flows.findIndex((f) => f.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ ok: false, message: 'Автоматизацію не знайдено' });
  }
  const normalized = normalizeAutomation({ ...flows[idx], ...req.body }, req.params.id);
  const err = validateAutomation(normalized, flows, req.params.id);
  if (err) {
    return res.status(400).json({ ok: false, message: err });
  }
  flows[idx] = normalized;
  saveFlowsToDisk(flows);
  writeHealth();
  broadcastEvent('state', getPublicState());
  res.json({ ok: true, flow: normalized });
});

app.post('/api/flows/:id/duplicate', (req, res) => {
  const src = flows.find((f) => f.id === req.params.id);
  if (!src) {
    return res.status(404).json({ ok: false, message: 'Автоматизацію не знайдено' });
  }
  const copy = migrateFlowRecord({
    ...src,
    id: generateFlowId(),
    name: `${src.name} (копія)`,
    paused: true
  });
  const err = validateAutomation(copy, flows, null);
  if (err) {
    return res.status(400).json({ ok: false, message: err });
  }
  flows.push(copy);
  saveFlowsToDisk(flows);
  writeHealth();
  broadcastEvent('state', getPublicState());
  res.json({ ok: true, flow: copy });
});

app.post('/api/flows/:id/pause', (req, res) => {
  const idx = flows.findIndex((f) => f.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ ok: false, message: 'Автоматизацію не знайдено' });
  }
  const nextPaused = !Boolean(flows[idx].paused);
  const test = { ...flows[idx], paused: nextPaused };
  const err = validateAutomation(test, flows, req.params.id);
  if (err) {
    return res.status(400).json({ ok: false, message: err });
  }
  flows[idx].paused = nextPaused;
  saveFlowsToDisk(flows);
  writeHealth();
  broadcastEvent('state', getPublicState());
  res.json({ ok: true, flow: flows[idx] });
});

app.delete('/api/flows/:id', (req, res) => {
  const before = flows.length;
  flows = flows.filter((f) => f.id !== req.params.id);
  if (flows.length === before) {
    return res.status(404).json({ ok: false, message: 'Автоматизацію не знайдено' });
  }
  saveFlowsToDisk(flows);
  writeHealth();
  broadcastEvent('state', getPublicState());
  res.json({ ok: true });
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  startHeartbeat();
  setStatus('idle');
  pushLog('INFO', `Control panel started at http://localhost:${PORT}`);
  if (!isPanelAuthEnabled()) {
    pushLog(
      'WARN',
      'Панель без пароля: додайте PANEL_USER і PANEL_PASSWORD у .env для захисту доступу'
    );
  }
  pushLog('INFO', 'Browser auto-open disabled in server');
  pushLog('INFO', `WA Bridge ${APP_VERSION}`);
});