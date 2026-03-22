require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT || 3001);
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://127.0.0.1:8000/api/ingest/whatsapp';
const SOURCE_CHAT = process.env.SOURCE_CHAT || '';
const TARGET_CHAT = process.env.TARGET_CHAT || '';
const SEND_PREFIX = process.env.SEND_PREFIX || '#go';
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 2000);
const HEADLESS = String(process.env.HEADLESS || '1') === '1';

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const HEALTH_FILE = path.join(LOG_DIR, 'health.json');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth');
const CACHE_DIR = path.join(ROOT_DIR, '.wwebjs_cache');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

let client = null;
let isStarting = false;
let isStopping = false;
let heartbeatTimer = null;
let lastQr = null;
let eventClients = [];
let lastSendTs = 0;

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
    qrAvailableData: lastQr
  };
}

function setStatus(status, patch = {}) {
  state.status = status;
  Object.assign(state, patch);
  state.lastPulseAt = nowIso();
  writeHealth();
  broadcastEvent('state', getPublicState());
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

async function postToFastAPI(payload) {
  const response = await axios.post(FASTAPI_URL, payload, { timeout: 30000 });
  state.lastPostAt = nowIso();
  state.counters.posted += 1;
  return response.data;
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

      if (chatId !== SOURCE_CHAT) {
        state.counters.ignored += 1;
        return;
      }

      state.counters.accepted += 1;

      const allowSend = rawText.startsWith(SEND_PREFIX);
      const normalizedText = stripPrefix(rawText, SEND_PREFIX);

      pushLog('INFO', 'Source message accepted', {
        chatId,
        fromMe: msg.fromMe,
        allowSend,
        startsWithPrefix: allowSend,
        textPreview: normalizedText.slice(0, 120),
        messageId: msg.id?._serialized || null
      });

      const payload = {
        platform: 'whatsapp',
        chat_id: chatId,
        chat_name: null,
        message_id: msg.id?._serialized || null,
        author: msg.author || msg.from || null,
        published_at_platform: msg.timestamp
          ? new Date(msg.timestamp * 1000).toISOString()
          : nowIso(),
        text: normalizedText,
        allow_send: allowSend
      };

      const apiResult = await postToFastAPI(payload);
      const actions = Array.isArray(apiResult?.actions) ? apiResult.actions : [];

      pushLog('INFO', 'FastAPI POST success', {
        allowSend,
        actionsCount: actions.length
      });

      if (!allowSend) {
        pushLog('INFO', 'Forward skipped: allowSend=false');
        return;
      }

      if (actions.length === 0) {
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

        await sendWithRateLimit(TARGET_CHAT, text);
      }
    } catch (error) {
      pushLog('ERROR', 'message_create handler failed', {
        message: error.message,
        stack: error.stack
      });
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

app.listen(PORT, () => {
  startHeartbeat();
  setStatus('idle');
  pushLog('INFO', `Control panel started at http://localhost:${PORT}`);
  pushLog('INFO', 'Browser auto-open disabled in server');
});