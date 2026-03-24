const fs = require('fs');
const path = require('path');
const { buildChatCandidates, normalizeChatId, withPrefix } = require('../normalization/chatIdentity');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CHAT_DIRECTORY_FILE = path.join(DATA_DIR, 'chat-directory.json');

let cache = null;

function nowIso() {
  return new Date().toISOString();
}

function normalizeAliases(aliases) {
  const out = new Set();
  for (const a of Array.isArray(aliases) ? aliases : []) {
    const n = normalizeChatId(a);
    if (n) out.add(n);
    const p = withPrefix(a);
    if (p) out.add(p);
  }
  return Array.from(out);
}

function inferChatTypeFromAliases(aliases) {
  const arr = Array.isArray(aliases) ? aliases : [];
  if (arr.some((a) => String(a || '').startsWith('phone:') || String(a || '').startsWith('+'))) {
    return 'direct';
  }
  return 'group';
}

function sanitizeEntry(entry) {
  const aliases = normalizeAliases(entry?.aliases || []);
  return {
    chatKey: String(entry?.chatKey || '').trim(),
    platform: String(entry?.platform || 'signal').trim() || 'signal',
    chatType: entry?.chatType === 'direct' ? 'direct' : 'group',
    displayName: String(entry?.displayName || '').trim(),
    manualLabel: String(entry?.manualLabel || '').trim(),
    aliases,
    lastSeenAt: String(entry?.lastSeenAt || '').trim() || null,
    lastMessagePreview: String(entry?.lastMessagePreview || '').trim()
  };
}

function emptyDirectory() {
  return { lastId: 0, entries: [] };
}

function upgradeLegacyFormat(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!raw.signal && !raw.whatsapp) return null;
  const out = emptyDirectory();
  for (const platform of ['signal', 'whatsapp']) {
    const map = raw?.[platform] && typeof raw[platform] === 'object' ? raw[platform] : {};
    for (const [alias, name] of Object.entries(map)) {
      out.lastId += 1;
      const normalizedAliases = normalizeAliases([alias]);
      out.entries.push({
        chatKey: `${platform}:chat:${String(out.lastId).padStart(3, '0')}`,
        platform,
        chatType: inferChatTypeFromAliases(normalizedAliases),
        displayName: String(name || '').trim(),
        manualLabel: '',
        aliases: normalizedAliases,
        lastSeenAt: null,
        lastMessagePreview: ''
      });
    }
  }
  return out;
}

function loadChatDirectory() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(CHAT_DIRECTORY_FILE)) {
      cache = emptyDirectory();
      return cache;
    }
    const raw = JSON.parse(fs.readFileSync(CHAT_DIRECTORY_FILE, 'utf8'));
    const upgraded = upgradeLegacyFormat(raw);
    if (upgraded) {
      cache = upgraded;
      saveChatDirectory(cache);
      return cache;
    }
    const entries = Array.isArray(raw?.entries) ? raw.entries.map(sanitizeEntry).filter((x) => x.chatKey) : [];
    const lastId = Math.max(
      Number(raw?.lastId || 0),
      ...entries.map((e) => Number(String(e.chatKey).split(':').pop() || 0)).filter(Number.isFinite),
      0
    );
    cache = { lastId, entries };
    return cache;
  } catch {
    cache = emptyDirectory();
    return cache;
  }
}

function saveChatDirectory(directory) {
  const dir = directory || loadChatDirectory();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CHAT_DIRECTORY_FILE, JSON.stringify(dir, null, 2), 'utf8');
  cache = dir;
  return dir;
}

function nextChatKey(platform, directory) {
  directory.lastId = Number(directory.lastId || 0) + 1;
  return `${platform}:chat:${String(directory.lastId).padStart(3, '0')}`;
}

function findChatByMessage(message) {
  const dir = loadChatDirectory();
  const platform = String(message?.platform || 'signal').trim() || 'signal';
  const candidates = new Set(buildChatCandidates(message));
  if (candidates.size === 0) return null;
  return (
    dir.entries.find((e) => {
      if (String(e.platform) !== platform) return false;
      const aliases = new Set(normalizeAliases(e.aliases));
      for (const c of candidates) {
        if (aliases.has(c)) return true;
      }
      return false;
    }) || null
  );
}

function upsertChatFromMessage(message) {
  const dir = loadChatDirectory();
  const platform = String(message?.platform || 'signal').trim() || 'signal';
  const candidates = normalizeAliases(buildChatCandidates(message));
  if (candidates.length === 0) {
    return { entry: null, created: false, mergedAliases: [] };
  }
  const existing = findChatByMessage({ ...message, platform });
  const preview = String(message?.text || '').trim().slice(0, 120);
  if (existing) {
    const before = new Set(normalizeAliases(existing.aliases));
    const merged = new Set([...before, ...candidates]);
    existing.aliases = Array.from(merged);
    existing.lastSeenAt = nowIso();
    existing.lastMessagePreview = preview;
    if (!existing.displayName) {
      existing.displayName = String(message?.chatName || message?.senderName || '').trim();
    }
    const mergedAliases = Array.from(merged).filter((x) => !before.has(x));
    saveChatDirectory(dir);
    return { entry: existing, created: false, mergedAliases };
  }

  const entry = sanitizeEntry({
    chatKey: nextChatKey(platform, dir),
    platform,
    chatType: inferChatTypeFromAliases(candidates),
    displayName: String(message?.chatName || message?.senderName || '').trim(),
    manualLabel: '',
    aliases: candidates,
    lastSeenAt: nowIso(),
    lastMessagePreview: preview
  });
  dir.entries.push(entry);
  saveChatDirectory(dir);
  return { entry, created: true, mergedAliases: [] };
}

function addAliasesToChat(chatKey, aliases) {
  const dir = loadChatDirectory();
  const key = String(chatKey || '').trim();
  const entry = dir.entries.find((e) => String(e.chatKey) === key);
  if (!entry) return null;
  const before = new Set(normalizeAliases(entry.aliases));
  const incoming = normalizeAliases(aliases);
  const merged = new Set([...before, ...incoming]);
  entry.aliases = Array.from(merged);
  saveChatDirectory(dir);
  return {
    entry,
    mergedAliases: Array.from(merged).filter((x) => !before.has(x))
  };
}

function listRecentChats(platform) {
  const dir = loadChatDirectory();
  const p = String(platform || '').trim();
  return dir.entries
    .filter((e) => !p || String(e.platform) === p)
    .sort((a, b) => {
      const ta = Date.parse(String(a.lastSeenAt || '')) || 0;
      const tb = Date.parse(String(b.lastSeenAt || '')) || 0;
      return tb - ta;
    });
}

function getChatByKey(chatKey) {
  const key = String(chatKey || '').trim();
  if (!key) return null;
  const dir = loadChatDirectory();
  return dir.entries.find((e) => String(e.chatKey) === key) || null;
}

module.exports = {
  loadChatDirectory,
  saveChatDirectory,
  upsertChatFromMessage,
  findChatByMessage,
  addAliasesToChat,
  listRecentChats,
  getChatByKey
};
