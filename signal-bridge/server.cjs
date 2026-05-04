const express = require('express');
const axios = require('axios');

const PORT = Number(process.env.PORT || 3002);
const SIGNAL_CLI_BASE_URL = String(process.env.SIGNAL_CLI_BASE_URL || 'http://signal-cli-api:8080').trim();
const SIGNAL_ACCOUNT_NUMBER = String(process.env.SIGNAL_ACCOUNT_NUMBER || '').trim();
const SIGNAL_RECEIVE_TIMEOUT_SEC = Number(process.env.SIGNAL_RECEIVE_TIMEOUT_SEC || 20);
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

/**
 * signal-cli-api /v1/groups returns group IDs that are themselves base64-encoded:
 * the raw binary group ID is base64-encoded to get the "canonical" form used in
 * /v1/receive messages, but /v1/groups wraps that string in a second layer of base64.
 *
 * This function attempts to decode one layer.  Returns the decoded string when the
 * result is a valid base64 value (i.e. still within the base64 alphabet and looks
 * like the single-encoded canonical ID), or null if the input is already
 * single-encoded (decoding would produce binary bytes, not a base64 string).
 */
function tryDecodeBase64Id(id) {
  if (!id || typeof id !== 'string') return null;
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    if (
      decoded &&
      decoded !== id &&
      decoded.length >= 4 &&
      decoded.length <= 256 &&
      /^[A-Za-z0-9+/]+=*$/.test(decoded)
    ) {
      return decoded;
    }
  } catch (_) {
    // ignore
  }
  return null;
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
      const env = m?.envelope || {};

      // Пропускаємо службові повідомлення без контенту
      if (env.typingMessage || env.receiptMessage) return null;

      // signal-cli-api може повертати повідомлення двох типів:
      // 1. dataMessage — повідомлення від іншого учасника
      // 2. syncMessage.sentMessage — повідомлення надіслане самим акаунтом (з іншого девайсу)
      const dataMsg = env.dataMessage || env.syncMessage?.sentMessage || {};

      const source = env.source || m?.source || m?.chatId || m?.groupId || '';
      const groupId =
        dataMsg?.groupInfo?.groupId ||
        dataMsg?.groupV2?.id ||
        env.groupInfo?.groupId ||
        m?.groupId ||
        '';
      const rawChatId = String(groupId || source || '').trim();
      const chatId = groupId ? `group.${String(groupId).trim()}` : rawChatId;
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
        addCandidate(g);              // raw group id
        addCandidate(`group.${g}`);  // canonical group id used across the app
      }
      // For group messages, "source" is the sender, not the chat.
      // Adding sender UUID/phone as a chat candidate for groups causes
      // unrelated group entries to merge via shared participants.
      if (source && !groupId) addCandidate(String(source).trim());

      const text = String(dataMsg?.message || m?.message || m?.text || '').trim();
      const id = String(env.timestamp || m?.timestamp || Date.now());

      // Collect attachment metadata so callers can download via GET /attachment/:id
      const rawAttachments = Array.isArray(dataMsg?.attachments)
        ? dataMsg.attachments
        : Array.isArray(m?.attachments)
          ? m.attachments
          : [];
      const attachments = rawAttachments
        .map((a) => ({
          id: String(a?.id || '').trim(),
          contentType: String(a?.contentType || a?.content_type || 'application/octet-stream').trim(),
          filename: String(a?.filename || '').trim()
        }))
        .filter((a) => a.id);

      return {
        id: `${chatId}_${id}`,
        chatId,
        chatCandidates,
        text,
        attachments,
        author: env.source || m?.source || null,
        timestamp: Number(env.timestamp || m?.timestamp || Date.now())
      };
    })
    .filter(Boolean);
}

async function listAccounts(timeoutMs) {
  const t = Math.max(1000, Number(timeoutMs) || SIGNAL_API_SLOW_TIMEOUT_MS);
  const apiRes = await axios.get(`${baseUrl()}/v1/accounts`, { timeout: t });
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
    endpoints: ['/health', '/chats', '/messages', '/send', '/attachment/:id', '/link', '/linked']
  });
});

app.get('/linked', async (_req, res) => {
  try {
    // Use a short timeout — /linked is a quick presence check, not a long-poll.
    // The main slow timeout is reserved for /messages (receive long-poll).
    const accounts = await listAccounts(10000);
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
      .get(`${baseUrl()}/v1/groups/${encodeURIComponent(account)}`, { timeout: SIGNAL_API_SLOW_TIMEOUT_MS })
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
        let gid = String(g?.id || g?.groupId || '').trim();
        // signal-cli-api may already include a 'group.' prefix — strip it so we
        // always store IDs as "group.<rawId>", matching the format used in /messages.
        while (gid.toLowerCase().startsWith('group.')) gid = gid.slice(6).trim();
        // signal-cli-api /v1/groups returns IDs double-encoded (base64 of base64).
        // Decode once to get the canonical single-encoded form that /v1/receive uses.
        const decodedGid = tryDecodeBase64Id(gid);
        if (decodedGid) gid = decodedGid;
        const prefixedId = gid ? `group.${gid}` : '';
        const item = normalizeChatItem(prefixedId, g?.name || gid);
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

app.get('/attachment/:id', async (req, res) => {
  try {
    const attachId = String(req.params.id || '').trim();
    if (!attachId) return res.status(400).json({ ok: false, message: 'id is required' });
    const apiRes = await axios.get(
      `${baseUrl()}/v1/attachments/${encodeURIComponent(attachId)}`,
      { responseType: 'arraybuffer', timeout: SIGNAL_API_SLOW_TIMEOUT_MS }
    );
    const contentType = String(apiRes.headers['content-type'] || 'application/octet-stream');
    const b64 = Buffer.from(apiRes.data).toString('base64');
    res.json({ ok: true, base64: b64, contentType });
  } catch (error) {
    const status = error?.response?.status || 500;
    res.status(status).json({ ok: false, message: error.message, body: null });
  }
});

app.post('/send', async (req, res) => {
  try {
    const account = await resolveAccount();
    const chatId = String(req.body?.chatId || '').trim();
    const text = String(req.body?.text || '').trim();
    const base64Attachments = Array.isArray(req.body?.base64Attachments) ? req.body.base64Attachments : [];
    if (!chatId) return res.status(400).json({ ok: false, message: 'chatId is required' });
    if (!text && base64Attachments.length === 0) return res.status(400).json({ ok: false, message: 'text or base64Attachments is required' });

    const payload = { number: account, recipients: [chatId] };
    // /v2/send приймає recipients для будь-якого типу адресата:
    // для груп — повний group.* ID, для особистих — номер телефону.
    if (text) payload.message = text;
    if (base64Attachments.length > 0) payload.base64_attachments = base64Attachments;

    await axios.post(`${baseUrl()}/v2/send`, payload, { timeout: 60000 });
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

app.post('/unlink', async (req, res) => {
  try {
    const accounts = await listAccounts(10000);
    if (accounts.length === 0) {
      return res.json({ ok: true, message: 'No account to unlink' });
    }
    const number = accounts[0];
    cachedResolvedAccount = null; // invalidate cache
    cachedResolvedAt = 0;
    await axios.delete(`${baseUrl()}/v1/accounts/${encodeURIComponent(number)}`, { timeout: 15000 });
    res.json({ ok: true, message: `Unlinked ${number}` });
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
