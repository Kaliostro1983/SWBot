const fs = require('fs');
const path = require('path');
const { buildChatCandidates, normalizeChatId } = require('../normalization/chatIdentity');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CHAT_DIRECTORY_FILE = path.join(DATA_DIR, 'chat-directory.json');

/** @type {object[]|null} null = not loaded yet */
let cache = null;

function nowIso() {
  return new Date().toISOString();
}

function sentAtToIso(message) {
  const s = message?.sentAt;
  if (s != null && s !== '') {
    if (typeof s === 'number' && Number.isFinite(s)) {
      return new Date(s).toISOString();
    }
    const str = String(s).trim();
    if (str) {
      const t = Date.parse(str);
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
  }
  return nowIso();
}

function isGroupAlias(alias) {
  return String(alias || '').startsWith('signal-group:');
}

function isPhoneLikeId(id) {
  return /^\+?\d{7,}$/.test(String(id || '').trim());
}

function isUuidLikeId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(id || '').trim()
  );
}

function looksLikeSignalGroupAlias(alias) {
  const a = String(alias || '').trim();
  if (!a) return false;
  // Per contract: Signal group == id startsWith "group."
  return a.startsWith('group.');
}

function detectChatTypeFromAliases(aliases) {
  const arr = Array.isArray(aliases) ? aliases : [];
  return arr.some((a) => looksLikeSignalGroupAlias(a)) ? 'group' : 'direct';
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateNextChatKey(directory, platform) {
  const p = String(platform || 'unknown').trim() || 'unknown';
  const arr = Array.isArray(directory) ? directory : [];
  const re = new RegExp(`^${escapeRegExp(p)}:chat:(\\d+)$`);
  let max = 0;
  for (const e of arr) {
    const m = String(e?.chatKey || '').match(re);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return `${p}:chat:${String(max + 1).padStart(3, '0')}`;
}

function findChatByCandidates(directory, candidates) {
  const arr = Array.isArray(directory) ? directory : [];
  const set = new Set(
    (Array.isArray(candidates) ? candidates : []).map((x) => String(x || '').trim()).filter(Boolean)
  );
  if (set.size === 0) return null;
  return (
    arr.find((chat) =>
      (Array.isArray(chat?.aliases) ? chat.aliases : []).some((a) => set.has(String(a || '').trim()))
    ) || null
  );
}

function mergeAliases(existingAliases, newAliases) {
  const seen = new Set();
  const out = [];
  for (const a of [...(Array.isArray(existingAliases) ? existingAliases : []), ...(Array.isArray(newAliases) ? newAliases : [])]) {
    const s = String(a || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function isLikelyTechnicalName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^group\./i.test(n)) return true;
  if (/^signal-group:/i.test(n)) return true;
  if (/^[0-9a-f-]{36}$/i.test(n)) return true;
  if (/^\+?\d{10,}$/.test(n)) return true;
  if (n.length > 48 && /^[A-Za-z0-9+/=_-]+$/.test(n)) return true;
  return false;
}

function parseTimeMs(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

function pickBetterName(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x) return y;
  if (!y) return x;
  const xt = isLikelyTechnicalName(x);
  const yt = isLikelyTechnicalName(y);
  if (xt && !yt) return y;
  if (!xt && yt) return x;
  // both same class: prefer longer non-empty (often more descriptive)
  return y.length > x.length ? y : x;
}

function mergeTwoEntries(kept, removed) {
  const k = kept || {};
  const r = removed || {};
  k.aliases = mergeAliases(k.aliases, r.aliases);
  k.manualLabel = String(k.manualLabel || '').trim() || String(r.manualLabel || '').trim();
  k.displayName = pickBetterName(k.displayName, r.displayName);

  const kt = parseTimeMs(k.lastSeenAt);
  const rt = parseTimeMs(r.lastSeenAt);
  if (rt > kt) {
    k.lastSeenAt = r.lastSeenAt;
    // take freshest preview together with freshest timestamp
    if (String(r.lastMessagePreview || '').trim()) k.lastMessagePreview = r.lastMessagePreview;
  } else if (!String(k.lastMessagePreview || '').trim() && String(r.lastMessagePreview || '').trim()) {
    k.lastMessagePreview = r.lastMessagePreview;
  }
  k.chatType = detectChatTypeFromAliases(k.aliases);
  return k;
}

function mergeDuplicateChatsInDirectory(directory) {
  const arr = Array.isArray(directory) ? directory : [];
  if (arr.length <= 1) return { directory: arr, mergedCount: 0 };

  // Build alias -> indices map
  const aliasToIdx = new Map();
  for (let i = 0; i < arr.length; i += 1) {
    const aliases = Array.isArray(arr[i]?.aliases) ? arr[i].aliases : [];
    for (const a of aliases) {
      const s = String(a || '').trim();
      if (!s) continue;
      const list = aliasToIdx.get(s) || [];
      list.push(i);
      aliasToIdx.set(s, list);
    }
  }

  // Union-Find indices connected by shared alias
  const parent = new Array(arr.length).fill(0).map((_, i) => i);
  const find = (x) => {
    let v = x;
    while (parent[v] !== v) v = parent[v];
    let cur = x;
    while (parent[cur] !== cur) {
      const p = parent[cur];
      parent[cur] = v;
      cur = p;
    }
    return v;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (const idxs of aliasToIdx.values()) {
    if (!idxs || idxs.length < 2) continue;
    const base = idxs[0];
    for (let j = 1; j < idxs.length; j += 1) union(base, idxs[j]);
  }

  // Group by root
  const groups = new Map();
  for (let i = 0; i < arr.length; i += 1) {
    const r = find(i);
    const g = groups.get(r) || [];
    g.push(i);
    groups.set(r, g);
  }

  let mergedCount = 0;
  const keepFlags = new Array(arr.length).fill(true);
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Choose kept entry: prefer one with manualLabel, else newest lastSeenAt, else lowest chatKey
    const sorted = idxs.slice().sort((i, j) => {
      const mi = String(arr[i]?.manualLabel || '').trim() ? 1 : 0;
      const mj = String(arr[j]?.manualLabel || '').trim() ? 1 : 0;
      if (mj !== mi) return mj - mi;
      const ti = parseTimeMs(arr[i]?.lastSeenAt);
      const tj = parseTimeMs(arr[j]?.lastSeenAt);
      if (tj !== ti) return tj - ti;
      return String(arr[i]?.chatKey || '').localeCompare(String(arr[j]?.chatKey || ''));
    });
    const keptIdx = sorted[0];
    for (let k = 1; k < sorted.length; k += 1) {
      const removedIdx = sorted[k];
      mergeTwoEntries(arr[keptIdx], arr[removedIdx]);
      keepFlags[removedIdx] = false;
      mergedCount += 1;
      console.log('[CHAT-DIR] merged duplicate chats', {
        aliases: Array.isArray(arr[keptIdx]?.aliases) ? arr[keptIdx].aliases.slice(0, 30) : [],
        kept: String(arr[keptIdx]?.chatKey || '').trim() || null,
        removed: String(arr[removedIdx]?.chatKey || '').trim() || null
      });
    }
  }

  const next = arr.filter((_, i) => keepFlags[i]).map(sanitizeEntry);
  return { directory: next, mergedCount };
}

function findAliasCollisions(directory) {
  const dir = Array.isArray(directory) ? directory : [];
  const aliasToKey = new Map();
  const collisions = [];
  for (const e of dir) {
    const chatKey = String(e?.chatKey || '').trim();
    const aliases = Array.isArray(e?.aliases) ? e.aliases : [];
    for (const a of aliases) {
      const s = String(a || '').trim();
      if (!s) continue;
      const prev = aliasToKey.get(s);
      if (!prev) {
        aliasToKey.set(s, chatKey);
      } else if (prev !== chatKey) {
        collisions.push({ alias: s, keys: [prev, chatKey] });
      }
    }
  }
  return collisions;
}

function dedupAndSaveChatDirectory() {
  const beforeRaw = loadChatDirectory();
  // Canonicalize existing rows before dedup so previously-imported variants can merge.
  const before = (Array.isArray(beforeRaw) ? beforeRaw : []).map(sanitizeEntry);
  const beforeCount = before.length;
  const res = mergeDuplicateChatsInDirectory(before);
  // Persist normalization even if no merges happened (important for future matching).
  saveChatDirectory(res.directory);
  const after = res.directory;
  const afterCount = Array.isArray(after) ? after.length : 0;
  const collisions = findAliasCollisions(after);
  if (collisions.length > 0) {
    console.warn('[CHAT-DIR] alias collision after dedup', {
      collisions: collisions.slice(0, 25),
      collisionsCount: collisions.length
    });
  }
  return { beforeCount, afterCount, mergedCount: res.mergedCount, collisionsCount: collisions.length };
}

function sanitizeEntry(entry) {
  const rawAliases = mergeAliases([], entry?.aliases || []);
  const platform = String(entry?.platform || 'signal').trim() || 'signal';
  // Canonicalize Signal aliases so group.<id> and group:<id> collapse to one.
  const aliases =
    platform === 'signal'
      ? (() => {
          const normalized = rawAliases
            .map((a) => String(normalizeChatId(String(a || '')) || String(a || '')).trim())
            .filter(Boolean);
          // Ensure group.<id> also carries <id> as alias, so different import shapes intersect.
          const enriched = [];
          for (const a of normalized) {
            enriched.push(a);
            if (a.startsWith('group.')) {
              const base = a.slice(6).trim();
              if (base) enriched.push(base);
            }
          }
          return mergeAliases([], enriched);
        })()
      : rawAliases;
  const chatType =
    platform === 'signal'
      ? detectChatTypeFromAliases(aliases)
      : entry?.chatType === 'direct'
        ? 'direct'
        : 'group';
  return {
    chatKey: String(entry?.chatKey || '').trim(),
    platform,
    chatType,
    displayName: String(entry?.displayName || '').trim(),
    manualLabel: String(entry?.manualLabel || '').trim(),
    aliases,
    lastSeenAt: entry?.lastSeenAt != null && entry.lastSeenAt !== '' ? String(entry.lastSeenAt) : '',
    lastMessagePreview: String(entry?.lastMessagePreview || '').trim().slice(0, 120)
  };
}

function migrateLegacyMaps(raw) {
  const entries = [];
  for (const platform of ['signal', 'whatsapp']) {
    const map = raw?.[platform] && typeof raw[platform] === 'object' ? raw[platform] : {};
    for (const [alias, name] of Object.entries(map)) {
      const aliases = mergeAliases([], [alias]);
      const chatKey = generateNextChatKey(entries, platform);
      entries.push({
        chatKey,
        platform,
        chatType: detectChatTypeFromAliases(aliases),
        displayName: String(name || '').trim(),
        manualLabel: '',
        aliases,
        lastSeenAt: '',
        lastMessagePreview: ''
      });
    }
  }
  return entries.map(sanitizeEntry).filter((e) => e.chatKey);
}

function parseRawToEntries(raw) {
  if (Array.isArray(raw)) {
    return raw.map(sanitizeEntry).filter((e) => e.chatKey);
  }
  if (raw && Array.isArray(raw.entries)) {
    return raw.entries.map(sanitizeEntry).filter((e) => e.chatKey);
  }
  if (raw && typeof raw === 'object' && (raw.signal || raw.whatsapp)) {
    return migrateLegacyMaps(raw);
  }
  return [];
}

function loadChatDirectory() {
  if (cache !== null) return cache;
  if (!fs.existsSync(CHAT_DIRECTORY_FILE)) {
    cache = [];
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_DIRECTORY_FILE, 'utf8'));
    const parsed = parseRawToEntries(raw);
    const deduped = mergeDuplicateChatsInDirectory(parsed);
    cache = deduped.directory;
    let shouldNormalizeFile = false;
    if (Array.isArray(raw)) shouldNormalizeFile = true;
    else if (raw && typeof raw === 'object' && (raw.signal || raw.whatsapp)) shouldNormalizeFile = true;
    else if (raw && Object.prototype.hasOwnProperty.call(raw, 'lastId')) shouldNormalizeFile = true;
    if (shouldNormalizeFile || deduped.mergedCount > 0) saveChatDirectory(cache);
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

function saveChatDirectory(directory) {
  const entries = Array.isArray(directory) ? directory : [];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CHAT_DIRECTORY_FILE, JSON.stringify({ entries }, null, 2), 'utf8');
  cache = entries;
  return entries;
}

const SKIP_UPSERT = { entry: null, created: false, mergedAliases: [] };

/** Temporary: only build directory from Signal traffic (debug). */
const SIGNAL_ONLY_UPSERT = true;

function logSkippedMessage(message, reason, extra = {}) {
  const textRaw = message?.text != null ? String(message.text) : '';
  const trimmedLen = textRaw.trim().length;
  console.log('[CHAT-DIR] skipped message', {
    platform: message?.platform ?? null,
    reason,
    chatId: message?.chatId ?? null,
    senderId: message?.senderId ?? null,
    text: textRaw.slice(0, 40),
    textLength: trimmedLen,
    ...extra
  });
}

function isSystemLikeChatText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return (
    t.startsWith('sent a message') ||
    t.startsWith('joined') ||
    t.startsWith('left')
  );
}

function isSentAtOlderThan24h(message) {
  const s = message?.sentAt;
  if (s == null || s === '') return false;

  let tsMs;
  if (typeof s === 'number' && Number.isFinite(s)) {
    tsMs = s < 1e12 ? s * 1000 : s;
  } else {
    const t = Date.parse(String(s));
    if (!Number.isFinite(t)) return false;
    tsMs = t;
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return tsMs < cutoff;
}

function upsertChatFromMessage(message) {
  if (SIGNAL_ONLY_UPSERT && String(message?.platform) !== 'signal') {
    logSkippedMessage(message, 'not_signal_platform');
    return SKIP_UPSERT;
  }

  if (message?.isEmptyMessage === true) {
    logSkippedMessage(message, 'empty_text', { note: 'isEmptyMessage' });
    return SKIP_UPSERT;
  }

  const trimmedText = String(message?.text ?? '').trim();
  const trimmedChatName = String(message?.chatName ?? '').trim();
  const trimmedLen = trimmedText.length;

  // Allow directory sync from chat-list calls where text may be empty but chatName/chatId is known.
  if (!trimmedText && !trimmedChatName) {
    logSkippedMessage(message, 'empty_text');
    return SKIP_UPSERT;
  }

  // Only length 0–1 after trim (e.g. "a"). "test", "450", etc. are length >= 2 and not text_too_short.
  if (trimmedText && trimmedLen < 2 && !trimmedChatName) {
    logSkippedMessage(message, 'text_too_short');
    return SKIP_UPSERT;
  }

  if (trimmedText && isSystemLikeChatText(trimmedText)) {
    logSkippedMessage(message, 'system_message');
    return SKIP_UPSERT;
  }

  if (isSentAtOlderThan24h(message)) {
    logSkippedMessage(message, 'old_message');
    return SKIP_UPSERT;
  }

  const directory = loadChatDirectory();
  const candidates = buildChatCandidates(message);
  if (!candidates.length) {
    return { entry: null, created: false, mergedAliases: [] };
  }

  // Hard rule: any shared alias means same chat; merge duplicates before continuing.
  const set = new Set(candidates.map((x) => String(x || '').trim()).filter(Boolean));
  const matches = directory
    .map((e, idx) => ({ e, idx }))
    .filter(({ e }) => (Array.isArray(e?.aliases) ? e.aliases : []).some((a) => set.has(String(a || '').trim())));
  let existing = matches.length ? matches[0].e : null;
  if (matches.length > 1) {
    // Merge all matches into the first (prefer manualLabel/newest handled by mergeDuplicate helper).
    const { directory: mergedDir } = mergeDuplicateChatsInDirectory(directory);
    // Replace underlying directory in memory/file to keep invariants.
    saveChatDirectory(mergedDir);
    existing = findChatByCandidates(mergedDir, candidates);
  }
  const preview = trimmedText ? trimmedText.slice(0, 120) : trimmedChatName.slice(0, 120);
  const lastSeenAt = sentAtToIso(message);
  const nextDisplayName =
    trimmedChatName && !isLikelyTechnicalName(trimmedChatName) ? trimmedChatName : '';
  const hintedTypeRaw = String(message?.chatType || '').trim();
  const hintedType =
    hintedTypeRaw === 'group' || hintedTypeRaw === 'direct' ? hintedTypeRaw : '';

  if (existing) {
    const oldAliases = existing.aliases.slice();
    existing.aliases = mergeAliases(existing.aliases, candidates);
    existing.lastSeenAt = lastSeenAt;
    existing.lastMessagePreview = preview;
    existing.chatType = hintedType || detectChatTypeFromAliases(existing.aliases);
    if (nextDisplayName) {
      existing.displayName = pickBetterName(existing.displayName, nextDisplayName);
    }
    saveChatDirectory(directory);
    const mergedAliases = existing.aliases.filter((a) => !oldAliases.includes(a));
    console.log('[CHAT-DIR] updated existing chat', {
      platform: existing.platform,
      chatKey: existing.chatKey,
      chatType: existing.chatType,
      aliasesCount: existing.aliases.length,
      preview: preview.slice(0, 40)
    });
    return { entry: existing, created: false, mergedAliases };
  }

  const platform = String(message?.platform || 'unknown').trim() || 'unknown';
  const chatKey = generateNextChatKey(directory, platform);
  const entry = sanitizeEntry({
    chatKey,
    platform,
    chatType: hintedType || detectChatTypeFromAliases(candidates),
    displayName: nextDisplayName,
    manualLabel: '',
    aliases: mergeAliases([], candidates),
    lastSeenAt,
    lastMessagePreview: preview
  });
  directory.push(entry);
  saveChatDirectory(directory);
  console.log('[CHAT-DIR] created new chat', {
    platform: entry.platform,
    chatKey: entry.chatKey,
    chatType: entry.chatType,
    aliasesCount: entry.aliases.length,
    preview: preview.slice(0, 40)
  });
  return { entry, created: true, mergedAliases: [] };
}

function listRecentChats(platform, limit = 20) {
  const directory = loadChatDirectory();
  const p = String(platform || '').trim();
  const filtered = p ? directory.filter((e) => String(e.platform) === p) : directory.slice();
  filtered.sort((a, b) => {
    const ta = Date.parse(String(a.lastSeenAt || '')) || 0;
    const tb = Date.parse(String(b.lastSeenAt || '')) || 0;
    return tb - ta;
  });
  const lim = Math.max(1, Number(limit) || 20);
  return filtered.slice(0, lim);
}

/** Prefer human-ish aliases over raw signal-group / UUID tokens for UI labels. */
function isTechnicalAliasForResolvedName(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (/^signal:/i.test(t)) return true;
  if (/^signal-group:/i.test(t)) return true;
  if (/^[0-9a-f-]{36}$/i.test(t)) return true;
  return false;
}

function firstMeaningfulAliasForDisplay(aliases) {
  const arr = Array.isArray(aliases) ? aliases : [];
  for (const a of arr) {
    const s = String(a || '').trim();
    if (s && !isTechnicalAliasForResolvedName(s)) return s;
  }
  for (const a of arr) {
    const s = String(a || '').trim();
    if (s) return s;
  }
  return '';
}

function resolvePanelResolvedName(entry) {
  const manual = String(entry?.manualLabel || '').trim();
  if (manual) return manual;
  const display = String(entry?.displayName || '').trim();
  if (display) return display;
  const fromAlias = firstMeaningfulAliasForDisplay(entry?.aliases);
  if (fromAlias) return fromAlias;
  return String(entry?.chatKey || '').trim() || '';
}

/**
 * @param {string} platform  '' = all platforms; else filter (e.g. signal, whatsapp)
 * @param {number} [maxEntries=10000]  max rows (≤10000); non-finite or ≤0 returns full filtered list
 */
function listAllChatsSortedByLastSeen(platform, maxEntries = 10000) {
  const directory = loadChatDirectory();
  const p = String(platform || '').trim();
  const filtered = p ? directory.filter((e) => String(e.platform) === p) : directory.slice();
  filtered.sort((a, b) => {
    const ta = Date.parse(String(a.lastSeenAt || '')) || 0;
    const tb = Date.parse(String(b.lastSeenAt || '')) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.chatKey || '').localeCompare(String(b.chatKey || ''));
  });
  const cap = Number(maxEntries);
  if (!Number.isFinite(cap) || cap <= 0) return filtered;
  return filtered.slice(0, Math.min(Math.floor(cap), 10000));
}

function findChatByMessage(message) {
  const directory = loadChatDirectory();
  const platform = String(message?.platform || 'signal').trim() || 'signal';
  const candidates = buildChatCandidates(message);
  const subset = directory.filter((e) => String(e.platform) === platform);

  // For group messages, prioritize group-type candidates so the group entry wins
  // over the sender's direct contact entry (which may appear earlier in the directory).
  const chatId = String(message?.chatId || '').trim();
  if (chatId.startsWith('group.')) {
    const groupCandidates = candidates.filter(
      (c) => c.startsWith('group.') || c.startsWith('signal-group:')
    );
    if (groupCandidates.length > 0) {
      const groupMatch = findChatByCandidates(subset, groupCandidates);
      if (groupMatch) return groupMatch;
    }
  }

  return findChatByCandidates(subset, candidates);
}

function getChatByKey(chatKey) {
  const key = String(chatKey || '').trim();
  if (!key) return null;
  const directory = loadChatDirectory();
  return directory.find((e) => String(e.chatKey) === key) || null;
}

/** Не перезаписує існуюче manualLabel. Не ставить «технічні» рядки (UUID, signal-group, = primary alias). */
function setManualLabelIfEmpty(chatKey, label) {
  const key = String(chatKey || '').trim();
  const name = String(label || '').trim();
  if (!key || !name) return null;
  const directory = loadChatDirectory();
  const entry = directory.find((e) => String(e.chatKey) === key);
  if (!entry) return null;
  if (String(entry.manualLabel || '').trim()) return entry;
  const primary =
    Array.isArray(entry.aliases) && entry.aliases.length
      ? String(entry.aliases[0] || '').trim()
      : '';
  if (primary && name === primary) return entry;
  if (isTechnicalAliasForResolvedName(name)) return entry;
  if (/^\+?\d{10,}$/.test(name)) return entry;
  entry.manualLabel = name;
  saveChatDirectory(directory);
  return entry;
}

function addAliasesToChat(chatKey, aliases) {
  const directory = loadChatDirectory();
  const key = String(chatKey || '').trim();
  const entry = directory.find((e) => String(e.chatKey) === key);
  if (!entry) return null;
  const before = entry.aliases.slice();
  entry.aliases = mergeAliases(entry.aliases, aliases);
  entry.chatType = detectChatTypeFromAliases(entry.aliases);
  saveChatDirectory(directory);
  return {
    entry,
    mergedAliases: entry.aliases.filter((a) => !before.includes(a))
  };
}

function removeAliasesFromChat(chatKey, aliases) {
  const directory = loadChatDirectory();
  const key = String(chatKey || '').trim();
  const entry = directory.find((e) => String(e.chatKey) === key);
  if (!entry) return null;
  const remove = new Set(
    (Array.isArray(aliases) ? aliases : []).map((a) => String(a || '').trim()).filter(Boolean)
  );
  if (remove.size === 0) return { entry, removedAliases: [] };
  const before = Array.isArray(entry.aliases) ? entry.aliases.slice() : [];
  entry.aliases = before.filter((a) => !remove.has(String(a || '').trim()));
  entry.chatType = detectChatTypeFromAliases(entry.aliases);
  saveChatDirectory(directory);
  return { entry, removedAliases: before.filter((a) => !entry.aliases.includes(a)) };
}

module.exports = {
  loadChatDirectory,
  saveChatDirectory,
  isGroupAlias,
  detectChatTypeFromAliases,
  generateNextChatKey,
  findChatByCandidates,
  mergeAliases,
  upsertChatFromMessage,
  dedupAndSaveChatDirectory,
  listRecentChats,
  listAllChatsSortedByLastSeen,
  resolvePanelResolvedName,
  findChatByMessage,
  getChatByKey,
  setManualLabelIfEmpty,
  addAliasesToChat,
  removeAliasesFromChat
};
