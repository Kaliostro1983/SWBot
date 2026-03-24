const express = require('express');
const axios = require('axios');

const PORT = Number(process.env.PORT || 3002);
const SIGNAL_CLI_BASE_URL = String(process.env.SIGNAL_CLI_BASE_URL || 'http://signal-cli-api:8080').trim();
const SIGNAL_ACCOUNT_NUMBER = String(process.env.SIGNAL_ACCOUNT_NUMBER || '').trim();
const SIGNAL_RECEIVE_TIMEOUT_SEC = Number(process.env.SIGNAL_RECEIVE_TIMEOUT_SEC || 1);
const SIGNAL_API_SLOW_TIMEOUT_MS = Math.max(30000, Number(process.env.SIGNAL_API_SLOW_TIMEOUT_MS || 90000));
const SIGNAL_INCLUDE_TECHNICAL_IDS = String(process.env.SIGNAL_INCLUDE_TECHNICAL_IDS || '0').trim() === '1';
const ACCOUNT_CACHE_TTL_MS = 30000;

if (!SIGNAL_ACCOUNT_NUMBER) {
  // eslint-disable-next-line no-console
  console.warn('[signal-bridge] SIGNAL_ACCOUNT_NUMBER is empty. Endpoints may return errors.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
let cachedResolvedAccount = null;
let cachedResolvedAt = 0;

function baseUrl() {
  return SIGNAL_CLI_BASE_URL.replace(/\/+$/, '');
}

function normalizeChatItem(id, name) {
  const chatId = String(id || '').trim();
  if (!chatId) return null;
  const label = String(name || '').trim();
  if (shouldSkipTechnicalChat(chatId, label)) return null;
  return {
    id: chatId,
    name: label || chatId
  };
}

function isPhoneLikeId(id) {
  return /^\+?\d{7,}$/.test(String(id || '').trim());
}

function isUuidLikeId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(id || '').trim()
  );
}

function shouldSkipTechnicalChat(chatId, label) {
  if (SIGNAL_INCLUDE_TECHNICAL_IDS) return false;
  if (isPhoneLikeId(chatId)) return false;
  const looksTechnical = isUuidLikeId(chatId) || /^\d{1,6}$/.test(chatId);
  const hasHumanLabel = Boolean(label && label !== chatId);
  return looksTechnical && !hasHumanLabel;
}

function normalizeIncomingMessages(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.messages)
      ? raw.messages
      : Array.isArray(raw?.data)
        ? raw.data
        : [];
  return arr
    .map((m) => {
      const source = m?.envelope?.source || m?.source || m?.chatId || m?.groupId || '';
      const groupId = m?.envelope?.groupInfo?.groupId || m?.groupId || '';
      const chatId = String(groupId || source || '').trim();
      if (!chatId) return null;
      const chatCandidates = [];
      const addCandidate = (v) => {
        const s = String(v || '').trim();
        if (!s) return;
        if (!chatCandidates.includes(s)) chatCandidates.push(s);
      };
      addCandidate(chatId);
      if (groupId) {
        const g = String(groupId).trim();
        addCandidate(g);
        if (!g.startsWith('group.')) addCandidate(`group.${g}`);
      }
      if (source) addCandidate(String(source).trim());
      const text = String(
        m?.envelope?.dataMessage?.message || m?.message || m?.text || ''
      ).trim();
      const id = String(m?.envelope?.timestamp || m?.timestamp || Date.now());
      return {
        id: `${chatId}_${id}`,
        chatId,
        chatCandidates,
        text,
        author: m?.envelope?.source || m?.source || null,
        timestamp: Number(m?.envelope?.timestamp || m?.timestamp || Date.now())
      };
    })
    .filter(Boolean);
}

async function listAccounts() {
  const apiRes = await axios.get(`${baseUrl()}/v1/accounts`, { timeout: SIGNAL_API_SLOW_TIMEOUT_MS });
  return Array.isArray(apiRes.data)
    ? apiRes.data.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
}

async function resolveAccount() {
  const now = Date.now();
  if (cachedResolvedAccount && now - cachedResolvedAt < ACCOUNT_CACHE_TTL_MS) {
    return cachedResolvedAccount;
  }
  const accounts = await listAccounts();
  let selected = null;
  if (SIGNAL_ACCOUNT_NUMBER) {
    selected =
      accounts.find((x) => x.replace(/\s+/g, '') === SIGNAL_ACCOUNT_NUMBER.replace(/\s+/g, '')) ||
      null;
  }
  if (!selected) {
    selected = accounts[0] || null;
  }
  if (!selected) {
    throw new Error('No linked Signal account found in signal-cli-api (/v1/accounts is empty)');
  }
  cachedResolvedAccount = selected;
  cachedResolvedAt = now;
  return selected;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'signal-bridge',
    signalCliBaseUrl: baseUrl(),
    hasAccount: Boolean(SIGNAL_ACCOUNT_NUMBER)
  });
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'signal-bridge',
    endpoints: ['/health', '/chats', '/messages', '/send', '/link', '/linked']
  });
});

app.get('/linked', async (_req, res) => {
  try {
    const accounts = await listAccounts();
    const normalizedTarget = SIGNAL_ACCOUNT_NUMBER.replace(/\s+/g, '');
    const targetMatched = normalizedTarget
      ? accounts.some((acc) => String(acc).replace(/\s+/g, '') === normalizedTarget)
      : null;
    const linked = accounts.length > 0;
    res.json({
      ok: true,
      linked,
      targetMatched,
      account: SIGNAL_ACCOUNT_NUMBER || null,
      accounts
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    res.status(status).json({
      ok: false,
      message: error.message,
      body: error?.response?.data || null
    });
  }
});

app.get('/chats', async (_req, res) => {
  try {
    const account = await resolveAccount();
    // Contacts are more important for UI availability; groups are best-effort.
    const contactsRes = await axios.get(
      `${baseUrl()}/v1/contacts/${encodeURIComponent(account)}`,
      { timeout: SIGNAL_API_SLOW_TIMEOUT_MS }
    );
    const groupsRes = await axios
      .get(`${baseUrl()}/v1/groups/${encodeURIComponent(account)}`, { timeout: 15000 })
      .catch((err) => ({ __error: err }));

    const chats = [];
    let groupsError = null;
    const contacts = Array.isArray(contactsRes.data) ? contactsRes.data : [];
    for (const c of contacts) {
      const item = normalizeChatItem(c?.number || c?.uuid || c?.id, c?.name || c?.number);
      if (item) chats.push(item);
    }
    if (!groupsRes?.__error) {
      const groups = Array.isArray(groupsRes.data) ? groupsRes.data : [];
      for (const g of groups) {
        const item = normalizeChatItem(g?.id || g?.groupId, g?.name || g?.id);
        if (item) chats.push(item);
      }
    } else {
      groupsError = groupsRes.__error?.message || 'groups request failed';
    }
    const dedup = new Map();
    for (const c of chats) dedup.set(c.id, c);
    const out = Array.from(dedup.values()).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, chats: out, groupsError });
  } catch (error) {
    const status = error?.response?.status || 500;
    res.status(status).json({ ok: false, message: error.message, body: error?.response?.data || null });
  }
});

app.get('/messages', async (_req, res) => {
  try {
    const account = await resolveAccount();
    const apiRes = await axios.get(
      `${baseUrl()}/v1/receive/${encodeURIComponent(account)}`,
      {
        params: { timeout: SIGNAL_RECEIVE_TIMEOUT_SEC },
        timeout: SIGNAL_API_SLOW_TIMEOUT_MS
      }
    );
    const messages = normalizeIncomingMessages(apiRes.data);
    res.json({ ok: true, messages });
  } catch (error) {
    const status = error?.response?.status || 500;
    res.status(status).json({
      ok: false,
      message: error.message,
      body: error?.response?.data || null
    });
  }
});

app.post('/send', async (req, res) => {
  try {
    const account = await resolveAccount();
    const chatId = String(req.body?.chatId || '').trim();
    const text = String(req.body?.text || '').trim();
    if (!chatId) return res.status(400).json({ ok: false, message: 'chatId is required' });
    if (!text) return res.status(400).json({ ok: false, message: 'text is required' });

    const payload = {
      message: text,
      number: account
    };
    // Групи мають id, звичайні чати — номер.
    if (/^\+?\d+$/.test(chatId)) {
      payload.recipients = [chatId];
    } else {
      payload.groupId = chatId;
    }

    await axios.post(`${baseUrl()}/v2/send`, payload, { timeout: 20000 });
    res.json({ ok: true });
  } catch (error) {
    const status = error?.response?.status || 500;
    res.status(status).json({
      ok: false,
      message: error.message,
      body: error?.response?.data || null
    });
  }
});

app.post('/link', async (req, res) => {
  try {
    const deviceName = String(req.body?.name || 'wa-bridge').trim();
    const apiRes = await axios.get(`${baseUrl()}/v1/qrcodelink`, {
      params: { device_name: deviceName },
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const contentType = String(apiRes.headers['content-type'] || 'image/png');
    const b64 = Buffer.from(apiRes.data).toString('base64');
    const qrDataUrl = `data:${contentType};base64,${b64}`;
    res.json({ ok: true, qrDataUrl });
  } catch (error) {
    const status = error?.response?.status || 500;
    res.status(status).json({
      ok: false,
      message: error.message,
      body: error?.response?.data ? Buffer.from(error.response.data).toString('utf8') : null
    });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[signal-bridge] listening on http://0.0.0.0:${PORT}`);
});
