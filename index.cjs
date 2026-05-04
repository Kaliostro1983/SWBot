require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { exec, spawn } = require('child_process');
const { buildChatCandidates, buildFlowAliases, normalizeChatId } = require('./src/normalization/chatIdentity');
const chatDirectoryStore = require('./src/chat-directory/chatDirectory');

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
const SIGNAL_LINK_TIMEOUT_MS = Math.max(30000, Number(process.env.SIGNAL_LINK_TIMEOUT_MS || 120000));
const SIGNAL_CHATS_TIMEOUT_MS = Math.max(30000, Number(process.env.SIGNAL_CHATS_TIMEOUT_MS || 90000));
const SIGNAL_LINK_ALLOW_DOCKER_FALLBACK = String(
  process.env.SIGNAL_LINK_ALLOW_DOCKER_FALLBACK || '0'
).trim() === '1';
const AUTO_START_BOT_ON_SERVICE_START = String(
  process.env.AUTO_START_BOT_ON_SERVICE_START || '1'
).trim() !== '0';
const AUTO_SIGNAL_RELINK_ON_SERVICE_START = String(
  process.env.AUTO_SIGNAL_RELINK_ON_SERVICE_START || '0'
).trim() !== '0';
const AUTO_SIGNAL_SOURCE_AUTOREMAP = String(
  process.env.AUTO_SIGNAL_SOURCE_AUTOREMAP || '0'
).trim() === '1';
const CHROME_EXECUTABLE_PATH = String(process.env.CHROME_EXECUTABLE_PATH || '').trim();
const WA_LAUNCH_TIMEOUT_MS = Math.max(30000, Number(process.env.WA_LAUNCH_TIMEOUT_MS || 120000));
const WA_PROTOCOL_TIMEOUT_MS = Math.max(60000, Number(process.env.WA_PROTOCOL_TIMEOUT_MS || 180000));
const SIGNAL_RAW_CAPTURE = String(process.env.SIGNAL_RAW_CAPTURE || '0').trim() === '1';
const DEBUG_ROUTING = String(process.env.DEBUG_ROUTING || '0').trim() === '1';

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const SIGNAL_RAW_LOG_FILE = path.join(LOG_DIR, 'signal_raw.ndjson');
const HEALTH_FILE = path.join(LOG_DIR, 'health.json');
const AUTH_DIR = path.join(ROOT_DIR, '.wwebjs_auth');
const CACHE_DIR = path.join(ROOT_DIR, '.wwebjs_cache');

/**
 * 1. Вбиває orphaned Chrome-процеси що тримають наш профіль wwebjs_auth
 *    (тільки ті, де командний рядок містить 'wwebjs_auth' — регулярний браузер не чіпаємо).
 * 2. Видаляє Chrome SingletonLock / SingletonSocket / SingletonCookie.
 * Викликається перед кожним client.initialize() та при graceful shutdown.
 */
async function cleanupChromeLocks() {
  const sessionDir = path.join(AUTH_DIR, 'session');
  let killedAny = false;

  // — Kill orphaned Chrome processes that hold our wwebjs_auth profile ——————
  if (process.platform === 'win32') {
    try {
      const { spawnSync } = require('child_process');
      // Find PIDs → kill → Wait-Process so OS releases handles before we continue
      const ps = [
        `$ids = (Get-WmiObject Win32_Process`,
        `| Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*wwebjs_auth*' }`,
        `).ProcessId;`,
        `if ($ids) {`,
        `  $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue;`,
        `    Write-Host "[WA] Killed orphaned Chrome PID=$_" };`,
        `  Wait-Process -Id $ids -Timeout 6 -ErrorAction SilentlyContinue`,
        `};`,
        `Write-Output $ids.Count`
      ].join(' ');
      const result = spawnSync('powershell', ['-NonInteractive', '-Command', ps],
        { encoding: 'utf8', timeout: 12000 });
      if (result.stdout) {
        const lines = result.stdout.trim().split('\n');
        lines.forEach(l => { if (l.trim().startsWith('[WA]')) console.log(l.trim()); });
        const count = parseInt(lines[lines.length - 1]);
        if (!isNaN(count) && count > 0) killedAny = true;
      }
    } catch { /* ignore */ }
  } else {
    // Linux / macOS
    try {
      require('child_process').spawnSync('pkill', ['-f', 'wwebjs_auth'],
        { stdio: 'ignore', timeout: 3000 });
      killedAny = true;
    } catch { /* ignore */ }
  }

  // After confirmed process death (Wait-Process), remove ONLY the Chrome lock/socket
  // files — NOT the entire session dir, because Default/ inside contains WhatsApp
  // authentication data that must survive restarts.
  // — Remove Singleton lock files ————————————————————————————————————————————
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const f of lockFiles) {
    const p = path.join(sessionDir, f);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[WA] Chrome lock removed: ${f}`);
      }
    } catch { /* ignore */ }
  }
}
const DATA_DIR = path.join(ROOT_DIR, 'data');
const FLOWS_FILE = path.join(DATA_DIR, 'flows.json');
const PANEL_AUTH_FILE = path.join(DATA_DIR, 'panel-auth.json');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
const SIGNAL_CHATS_CACHE_FILE = path.join(DATA_DIR, 'signal-chats-cache.json');
const WHATSAPP_CHATS_CACHE_FILE = path.join(DATA_DIR, 'whatsapp-chats-cache.json');
const MESSENGER_CHATS_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.MESSENGER_CHATS_CACHE_TTL_MS || 30 * 60 * 1000)
);

function safeFileStamp() {
  // Windows-safe timestamp for filenames.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function rotateAndClearFile(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Просто очищаємо поточний файл — старі ротовані файли прибирає cleanOldLogs().
    fs.writeFileSync(filePath, '', 'utf8');
  } catch {
    // Never break startup because of log rotation.
  }
}

function cleanOldLogs() {
  // Видаляємо всі ротовані файли логів попередніх сесій.
  // Залишаємо тільки bot.log, signal_raw.ndjson, health.json та server.log.
  try {
    const files = fs.readdirSync(LOG_DIR);
    for (const f of files) {
      // Ротовані файли мають вигляд: bot.2026-03-27T....log або signal_raw.2026-...ndjson
      if (/^bot\.\d{4}-/.test(f) || /^signal_raw\.\d{4}-/.test(f)) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch {
    // Never break startup because of log cleanup.
  }
}

function clearLogsOnStartup() {
  cleanOldLogs();
  rotateAndClearFile(LOG_FILE);
  rotateAndClearFile(SIGNAL_RAW_LOG_FILE);
}

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

function resolveChromeExecutablePath() {
  if (CHROME_EXECUTABLE_PATH && fs.existsSync(CHROME_EXECUTABLE_PATH)) {
    return CHROME_EXECUTABLE_PATH;
  }
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

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

function loadChatDirectory() {
  return chatDirectoryStore.loadChatDirectory();
}

function saveChatDirectory(dir) {
  return chatDirectoryStore.saveChatDirectory(dir);
}

function looksTechnicalChatName(id, name) {
  const chatId = String(id || '').trim();
  const label = String(name || '').trim();
  if (!label) return true;
  if (label === chatId) return true;
  if (label.startsWith('group.')) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(label)) return true;
  return false;
}

function upsertChatDirectory(platform, chats) {
  if (!['whatsapp', 'signal'].includes(String(platform || ''))) return;
  for (const c of Array.isArray(chats) ? chats : []) {
    const rawId = String(c?.id || '').trim();
    const name = String(c?.name || '').trim();
    if (!rawId) continue;
    const id = String(normalizeChatId(rawId) || rawId).trim();
    if (!id) continue;

    const candidates = [id];
    const isSignal = String(platform) === 'signal';
    const isSignalGroup = isSignal ? looksLikeSignalGroupId(id) : false;
    const chatType = isSignal ? (isSignalGroup ? 'group' : 'direct') : '';

    if (isSignal && isSignalGroup) {
      // For groups, include base-id candidate too (for incoming messages that may omit prefix).
      candidates.push(id.slice(6));
      // Backward compat: if signal-bridge now returns the correct single-encoded group ID
      // (after the double-encoding fix), we also add the base64-re-encoded form as a lookup
      // candidate.  This ensures the existing directory entry — which was created with the
      // double-encoded alias — can be found and updated with the new canonical alias.
      // We use rawId (original case, before normalization) to reproduce the exact bytes that
      // were used when the directory entry was first created.
      try {
        const rawGroupBase = rawId.startsWith('group.') ? rawId.slice(6) : rawId;
        if (rawGroupBase) {
          const doubleEncoded = `group.${Buffer.from(rawGroupBase).toString('base64')}`;
          const doubleEncodedNorm = String(normalizeChatId(doubleEncoded) || '').trim();
          if (doubleEncodedNorm && !candidates.includes(doubleEncodedNorm)) {
            candidates.push(doubleEncodedNorm);
            candidates.push(doubleEncodedNorm.slice(6)); // without group. prefix
          }
        }
      } catch (_) {
        // ignore
      }

      // ── Name-based fallback ──────────────────────────────────────────────────
      // When signal-bridge returns a group under a human-readable name but with
      // a new / different group ID, the ID-only candidates above won't find the
      // existing real directory entry → a ghost entry gets created.
      //
      // Algorithm: look for an entry that
      //   1. Has the same display/manual label as the incoming chat name, AND
      //   2. Has real message history (lastSeenAt is set — not a ghost itself).
      //
      // If such an entry is found, we inject ALL its aliases into `candidates`
      // so that `findChatByMessage` matches the real entry and
      // `upsertChatFromMessage` merges the new group ID into it rather than
      // creating a duplicate.
      if (name && !looksTechnicalChatName(id, name)) {
        const nameLower = name.toLowerCase();
        const allSignalEntries = chatDirectoryStore.listAllChatsSortedByLastSeen('signal', 10000);
        const realEntryByName = allSignalEntries.find((e) => {
          // Skip ghost entries (no real messages observed yet).
          if (!String(e?.lastSeenAt || '').trim()) return false;
          const manual = String(e?.manualLabel || '').trim().toLowerCase();
          const display = String(e?.displayName || '').trim().toLowerCase();
          return manual === nameLower || display === nameLower;
        });
        if (realEntryByName && Array.isArray(realEntryByName.aliases)) {
          for (const alias of realEntryByName.aliases) {
            const a = String(alias || '').trim();
            if (a && !candidates.includes(a)) candidates.push(a);
          }
        }
      }
      // ────────────────────────────────────────────────────────────────────────
    }
    const found = chatDirectoryStore.findChatByMessage({
      platform,
      chatId: id,
      chatCandidates: candidates
    });
    const existingName = String(found?.displayName || '').trim();
    const existingManual = String(found?.manualLabel || '').trim();
    const nextName =
      name && (!existingName || !looksTechnicalChatName(id, name) || looksTechnicalChatName(id, existingName))
        ? name
        : existingName;
    const res = chatDirectoryStore.upsertChatFromMessage({
      platform,
      chatId: id,
      chatName: nextName || existingManual || existingName || name,
      chatType,
      // Ensure chat-list refresh contributes a stable preview and passes "empty text" filters.
      text: name || '[sync]'
    });
    if (res?.entry?.chatKey) {
      const aliasesToAdd = [id];
      if (isSignal && isSignalGroup) {
        // Ensure base id is also present for matching.
        aliasesToAdd.push(id.slice(6));
      } else if (isSignal && !isSignalGroup) {
        // Cleanup: older imports mistakenly added group-aliases to direct chats, which breaks chatType.
        try {
          chatDirectoryStore.removeAliasesFromChat(res.entry.chatKey, [
            `group.${id}`,
            `group:${id}`,
            `signal-group:${id}`,
            `signal-group:group.${id}`,
            `signal-group:group:${id}`
          ]);
        } catch {
          // Never break refresh path on cleanup.
        }
      }
      chatDirectoryStore.addAliasesToChat(res.entry.chatKey, aliasesToAdd);
    }
  }
}

function resolveChatName(platform, id) {
  const p = String(platform || '').trim();
  const chatId = String(id || '').trim();
  if (!chatId || !['whatsapp', 'signal'].includes(p)) return '';
  const found = chatDirectoryStore.findChatByMessage({
    platform: p,
    chatId,
    chatCandidates: [chatId]
  });
  return String(found?.manualLabel || found?.displayName || '').trim();
}

function pickPreferredChatName(platform, id, currentName) {
  const known = resolveChatName(platform, id);
  if (known && !looksTechnicalChatName(id, known)) return known;
  const n = String(currentName || '').trim();
  if (n && !looksTechnicalChatName(id, n)) return n;
  return '';
}

function applyFlowManualLabelsToDirectory(flow) {
  try {
    const f = flow || {};
    if (String(f.sourcePlatform || '') !== 'signal') return;
    const chatKey = String(f.sourceChatKey || '').trim();
    if (!chatKey) return;
    const name = String(f.sourceChatRefs?.[0]?.name || '').trim();
    if (!name) return;
    // Never overwrite existing manualLabel; only fill when empty and non-technical.
    chatDirectoryStore.setManualLabelIfEmpty(chatKey, name);
  } catch {
    /* must never break flow save/load */
  }
}

function normalizeAliases(rawAliases) {
  const out = [];
  for (const a of Array.isArray(rawAliases) ? rawAliases : []) {
    const s = String(a || '').trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function buildSignalAliasList(id, rawAliases = []) {
  const out = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };
  for (const c of signalIdCandidates(id)) add(c);
  for (const a of normalizeAliases(rawAliases)) {
    for (const c of signalIdCandidates(a)) add(c);
  }
  return out;
}

/**
 * Вибирає "головний" аліас для Signal-чату з директорії.
 * Для груп надає перевагу аліасу з префіксом group. перед UUID/phone.
 * Це запобігає збереженню UUID як sourceChatId, коли реальні повідомлення
 * приходять з group.<base64>-ідентифікатором.
 */
function pickSignalPrimaryAlias(aliases) {
  const list = Array.isArray(aliases) ? aliases.map((x) => String(x || '').trim()).filter(Boolean) : [];
  // Пріоритет 1: group.<base64> — саме такий chatId приходить у реальних повідомленнях
  const groupAlias = list.find((a) => a.startsWith('group.') && !a.startsWith('group.signal') && !a.startsWith('group.phone'));
  if (groupAlias) return groupAlias;
  // Пріоритет 2: phone:+... або +... для прямих чатів
  const phoneAlias = list.find((a) => a.startsWith('+') || a.startsWith('phone:+'));
  if (phoneAlias) return phoneAlias;
  // Fallback: перший доступний
  return list[0] || '';
}

function getFlowSignalSourceAliases(flow) {
  const aliases = new Set();
  const refs = Array.isArray(flow?.sourceChatRefs) ? flow.sourceChatRefs : [];
  for (const r of refs) {
    for (const a of buildSignalAliasList(r?.id, r?.aliases || [])) aliases.add(a);
  }
  for (const sid of getSourceIds(flow)) {
    for (const a of signalIdCandidates(sid)) aliases.add(a);
  }
  return aliases;
}

function flowMatchesMessage(flow, message) {
  const messageCandidates = new Set(buildChatCandidates(message));
  const flowSourceChatKey = String(flow?.sourceChatKey || '').trim();
  const flowAliases = new Set(buildFlowAliases(flow));
  const flowId = String(flow?.id || '').trim() || 'unknown-flow';
  const flowName = String(flow?.name || '').trim() || flowId;
  const platform = String(message?.platform || '').trim() || 'unknown';
  const resolvedEntry = chatDirectoryStore.findChatByMessage(message);
  const incomingChatKey = resolvedEntry?.chatKey ? String(resolvedEntry.chatKey).trim() : null;

  if (flowSourceChatKey) {
    if (incomingChatKey && incomingChatKey === flowSourceChatKey) {
      // ── Group-flow guard ───────────────────────────────────────────────────
      // Signal group messages are ALWAYS normalized to "group.XXX" chatId by
      // signal-bridge.  If the flow targets a group-type directory entry but
      // the incoming chatId is NOT a group ID (phone number, bare UUID, etc.),
      // block the match — the chatId belongs to a personal contact whose
      // identifier leaked into the group's alias list via past directory merges.
      if (platform === 'signal') {
        const incomingChatId = String(message?.chatId || '').trim();
        const flowEntry = chatDirectoryStore.getChatByKey(flowSourceChatKey);
        if (String(flowEntry?.chatType || '') === 'group' && !incomingChatId.startsWith('group.')) {
          if (DEBUG_ROUTING) console.log('[ROUTING]', { platform, incomingChatKey, expectedSourceChatKey: flowSourceChatKey, flowId, flowName, incomingChatId, result: 'blocked-non-group-chatid' });
          return { matched: false, matchedBy: null };
        }
      }
      // ──────────────────────────────────────────────────────────────────────
      if (DEBUG_ROUTING) console.log('[ROUTING]', { platform, incomingChatKey, expectedSourceChatKey: flowSourceChatKey, flowId, flowName, result: 'matched' });
      return { matched: true, matchedBy: flowSourceChatKey };
    }
    if (DEBUG_ROUTING) console.log('[ROUTING]', { platform, incomingChatKey, expectedSourceChatKey: flowSourceChatKey, flowId, flowName, result: 'skipped' });
    return { matched: false, matchedBy: null };
  }

  if (flowAliases.size === 0) {
    if (DEBUG_ROUTING) console.warn('[ROUTING]', { platform, incomingChatKey, expectedSourceChatKey: null, flowId, flowName, result: 'skipped' });
    return { matched: false, matchedBy: null };
  }

  for (const alias of flowAliases) {
    if (messageCandidates.has(alias)) {
      if (DEBUG_ROUTING) console.log('[ROUTING]', { platform, incomingChatKey, expectedSourceChatKey: null, flowId, flowName, result: 'matched' });
      return { matched: true, matchedBy: alias };
    }
  }

  if (DEBUG_ROUTING) console.log('[ROUTING]', { platform, incomingChatKey, expectedSourceChatKey: null, flowId, flowName, result: 'skipped' });
  return { matched: false, matchedBy: null };
}

function noteSignalIncomingChat(chatId, rawText = '') {
  const id = String(chatId || '').trim();
  if (!id) return;
  const cur = Array.isArray(state.signal.recentIncomingChats) ? state.signal.recentIncomingChats : [];
  const prev = cur.find((x) => String(x?.id || '') === id);
  const name = resolveChatName('signal', id) || prev?.name || id;
  const item = {
    id,
    name,
    lastAt: nowIso(),
    hits: Number(prev?.hits || 0) + 1,
    preview: String(rawText || '').trim().slice(0, 80)
  };
  const next = [item, ...cur.filter((x) => String(x?.id || '') !== id)]
    .sort((a, b) => {
      const ta = Date.parse(String(a?.lastAt || '')) || 0;
      const tb = Date.parse(String(b?.lastAt || '')) || 0;
      return tb - ta;
    })
    .slice(0, 20);
  state.signal.recentIncomingChats = next;
}

function enrichFlowRefsFromDirectory() {
  let changed = false;
  flows = flows.map((f) => {
    const p = inferPlatforms(f);
    const next = { ...f };
    const srcIds = getSourceIds(next);
    const refsMap = new Map(
      Array.isArray(next.sourceChatRefs)
        ? next.sourceChatRefs
            .map((r) => [
              String(r?.id || '').trim(),
              {
                name: String(r?.name || '').trim(),
                aliases: normalizeAliases(r?.aliases)
              }
            ])
            .filter(([id]) => Boolean(id))
        : []
    );
    next.sourceChatRefs = srcIds.map((id) => {
      const cur = refsMap.get(id) || { name: '', aliases: [] };
      const current = cur.name || '';
      const resolved = pickPreferredChatName(p.sourcePlatform, id, current) || id;
      const aliases = p.sourcePlatform === 'signal' ? buildSignalAliasList(id, cur.aliases) : [];
      if (resolved !== current) changed = true;
      if (JSON.stringify(aliases) !== JSON.stringify(cur.aliases || [])) changed = true;
      return { id, name: resolved, aliases };
    });
    if (next.targetChatId) {
      const currentTargetName = String(next?.targetChatRef?.name || '').trim();
      const targetName =
        pickPreferredChatName(p.targetPlatform, next.targetChatId, currentTargetName) ||
        String(next.targetChatId).trim();
      if (!next.targetChatRef || next.targetChatRef.id !== next.targetChatId || targetName !== currentTargetName) {
        next.targetChatRef = { id: String(next.targetChatId).trim(), name: targetName };
        changed = true;
      }
    }
    return next;
  });
  if (changed) {
    saveFlowsToDisk(flows);
    writeHealth();
    broadcastEvent('state', getPublicState());
  }
}

function autoRemapSignalFlowsFromDirectory(force = false) {
  const now = Date.now();
  const minIntervalMs = 15000;
  if (!force) {
    const last = Number(state?.signal?.lastAutoRemapAtTs || 0);
    if (now - last < minIntervalMs) return false;
  }
  if (state?.signal?.autoRemapInFlight) return false;
  state.signal.autoRemapInFlight = true;
  state.signal.lastAutoRemapAtTs = now;
  try {
    const signalEntries = chatDirectoryStore.listRecentChats('signal', 10000);
    const signalDict = {};
    for (const entry of signalEntries) {
      const label = String(entry?.manualLabel || entry?.displayName || '').trim();
      if (!label) continue;
      for (const alias of Array.isArray(entry?.aliases) ? entry.aliases : []) {
        const key = normalizeChatId(alias);
        if (key && !signalDict[key]) signalDict[key] = label;
      }
    }
    const idsByHumanName = new Map();
    for (const [id, nameRaw] of Object.entries(signalDict)) {
      const idNorm = String(id || '').trim();
      const name = String(nameRaw || '').trim();
      if (!idNorm || !name || looksTechnicalChatName(idNorm, name)) continue;
      const arr = idsByHumanName.get(name) || [];
      arr.push(idNorm);
      idsByHumanName.set(name, arr);
    }

    let changed = false;
    flows = flows.map((f) => {
      const p = inferPlatforms(f);
      if (p.sourcePlatform !== 'signal') return f;
      const next = { ...f };
      const refs = Array.isArray(next.sourceChatRefs) ? next.sourceChatRefs : [];
      const remappedIds = [];
      const remappedRefs = [];
      for (const r of refs) {
        const oldId = String(r?.id || '').trim();
        const label = String(r?.name || '').trim();
        const candidates = idsByHumanName.get(label) || [];
        const newId = candidates.length === 1 ? candidates[0] : oldId;
        if (newId && !remappedIds.includes(newId)) remappedIds.push(newId);
        const aliases = buildSignalAliasList(newId || oldId, candidates);
        remappedRefs.push({
          id: newId || oldId,
          name: label || pickPreferredChatName('signal', newId || oldId, '') || (newId || oldId),
          aliases
        });
        if (newId && oldId && newId !== oldId) changed = true;
      }
      if (remappedIds.length > 0) {
        next.sourceChatIds = remappedIds;
        next.sourceChatId = remappedIds[0] || null;
        next.sourceChatRefs = remappedRefs;
      }
      return next;
    });

    if (changed) {
      saveFlowsToDisk(flows);
      writeHealth();
      broadcastEvent('state', getPublicState());
      pushLogThrottled(
        'signal_auto_remap_applied',
        10000,
        'INFO',
        'Signal source chats auto-remapped from directory'
      );
    }
    return changed;
  } finally {
    state.signal.autoRemapInFlight = false;
  }
}

function findSignalFlowsByIncomingCandidates(message) {
  if (DEBUG_ROUTING) console.log('[ROUTER CHECK]', { text: message.text, chatId: message.chatId, platform: message.platform, flowsCount: flows.length });
  const matched = flows.filter((f) => {
    const p = inferPlatforms(f);
    if (p.sourcePlatform !== 'signal') return false;
    if (f.debugCatchAllSignal === true) return false;
    // Primary rule for Signal routing: sourceChatKey is required.
    if (!String(f?.sourceChatKey || '').trim()) {
      if (DEBUG_ROUTING) console.warn('[ROUTING]', {
        platform: 'signal',
        incomingChatKey: chatDirectoryStore.findChatByMessage(message)?.chatKey || null,
        expectedSourceChatKey: null,
        flowId: String(f?.id || '').trim() || 'unknown-flow',
        flowName: String(f?.name || '').trim() || String(f?.id || '').trim() || 'unknown-flow',
        result: 'skipped'
      });
      return false;
    }
    return flowMatchesMessage(f, message).matched;
  });
  if (matched.length > 0) return matched;
  const debugFallback = flows.find(
    (f) => f.id === 'debug_signal' && f.debugCatchAllSignal === true && !f.paused
  );
  if (debugFallback) {
    if (DEBUG_ROUTING) console.log('[ROUTER CHECK]', { text: message.text, chatId: message.chatId, platform: message.platform, flowsCount: flows.length, matchedFallback: 'debug_signal' });
    return [debugFallback];
  }
  return [];
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

function evaluateFlowContentFilters(flow, rawMessageText) {
  const k = String(flow?.keywords || '').trim();
  const f = String(flow?.frequencies || '').trim();
  const tokK = splitFilterTokens(k);
  const tokF = splitFilterTokens(f);
  if (flowSkipsContentFilters(flow)) {
    return { passed: true, reason: 'wildcard', tokK, tokF };
  }
  // Contract: if both filter fields are empty -> allow message.
  if (tokK.length === 0 && tokF.length === 0) {
    return { passed: true, reason: 'empty_filters', tokK, tokF };
  }
  if (tokK.length > 0 && tokF.length === 0) {
    const ok = textMatchesFilterTokens(rawMessageText, k);
    return { passed: ok, reason: ok ? 'keywords_match' : 'keywords_miss', tokK, tokF };
  }
  if (tokK.length === 0 && tokF.length > 0) {
    const ok = textMatchesFilterTokens(rawMessageText, f);
    return { passed: ok, reason: ok ? 'frequencies_match' : 'frequencies_miss', tokK, tokF };
  }
  const ok =
    textMatchesFilterTokens(rawMessageText, k) ||
    textMatchesFilterTokens(rawMessageText, f);
  return { passed: ok, reason: ok ? 'keywords_or_frequencies_match' : 'keywords_or_frequencies_miss', tokK, tokF };
}

/**
 * Хоча б одне поле має містити токени.
 * Лише ключові слова або лише частоти — збіг по відповідному полю.
 * Обидва з токенами — достатньо збігу по тексту АБО по частотах (підрядки в повному тексті повідомлення).
 */
function passesFlowContentFilters(flow, rawMessageText) {
  return evaluateFlowContentFilters(flow, rawMessageText).passed;
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
  const p = inferPlatforms(out);
  if (out.keywords === undefined) out.keywords = '';
  if (out.frequencies === undefined) out.frequencies = '';
  if (out.sendAttachments === undefined) out.sendAttachments = false;
  if (out.coordinatesScreenshot === undefined) out.coordinatesScreenshot = false;
  if (out.analysisPlugin === undefined) out.analysisPlugin = null;
  if (out.outdatedDiff === undefined) out.outdatedDiff = null;
  if (out.paused === undefined) out.paused = false;
  if (!out.addons || typeof out.addons !== 'object') out.addons = {};
  if (!out.addons.delayMeter || typeof out.addons.delayMeter !== 'object') {
    out.addons.delayMeter = { enabled: false, thresholdSec: 60, alertChatId: null, alertPlatform: 'whatsapp' };
  }
  if (!out.addons.missingMessages || typeof out.addons.missingMessages !== 'object') {
    out.addons.missingMessages = { enabled: false, time1: '04:00', time2: '19:00', maxMinutes1: 3, maxMinutes2: 8, alertChatId: null, alertPlatform: 'whatsapp' };
  }
  if (!Array.isArray(out.sourceChatRefs)) {
    out.sourceChatRefs = getSourceIds(out).map((id) => ({
      id,
      name: pickPreferredChatName(p.sourcePlatform, id, '') || id,
      aliases: p.sourcePlatform === 'signal' ? buildSignalAliasList(id) : []
    }));
  } else {
    const validIds = new Set(getSourceIds(out));
    out.sourceChatRefs = out.sourceChatRefs
      .map((r) => ({
        id: String(r?.id || '').trim(),
        name: String(r?.name || '').trim(),
        aliases: normalizeAliases(r?.aliases)
      }))
      .filter((r) => r.id && validIds.has(r.id));
    if (out.sourceChatRefs.length === 0) {
      out.sourceChatRefs = getSourceIds(out).map((id) => ({
        id,
        name: pickPreferredChatName(p.sourcePlatform, id, '') || id,
        aliases: p.sourcePlatform === 'signal' ? buildSignalAliasList(id) : []
      }));
    } else {
      out.sourceChatRefs = out.sourceChatRefs.map((r) => ({
        id: r.id,
        name: pickPreferredChatName(p.sourcePlatform, r.id, r.name) || r.id,
        aliases: p.sourcePlatform === 'signal' ? buildSignalAliasList(r.id, r.aliases) : []
      }));
    }
  }
  if (out.targetChatId) {
    const preferredTargetName =
      pickPreferredChatName(p.targetPlatform, String(out.targetChatId).trim(), out.targetChatRef?.name) ||
      String(out.targetChatId).trim();
    if (!out.targetChatRef || String(out.targetChatRef.id || '').trim() !== String(out.targetChatId).trim()) {
      out.targetChatRef = { id: String(out.targetChatId).trim(), name: preferredTargetName };
    } else {
      out.targetChatRef = {
        id: String(out.targetChatRef.id || '').trim(),
        name: preferredTargetName
      };
    }
  } else {
    out.targetChatRef = null;
  }
  return inferSignalSourceChatKeyFromDirectory(out);
}

function resolveSignalSourceChatKeyFromFlowAliases(flow) {
  if (String(flow?.sourcePlatform) !== 'signal') return null;

  // ── Validate existing sourceChatKey ─────────────────────────────────────────
  // If the flow already has a sourceChatKey, only trust it when the corresponding
  // directory entry has real message history (lastSeenAt set).  Ghost entries
  // created by upsertChatDirectory from the /chats API have no lastSeenAt and
  // point to the wrong group ID.  In that case we fall through to alias-based
  // resolution so the correct (message-matched) entry is found automatically.
  const existingKey = String(flow?.sourceChatKey || '').trim();
  if (existingKey) {
    const existingEntry = chatDirectoryStore.getChatByKey(existingKey);
    if (existingEntry && String(existingEntry?.lastSeenAt || '').trim()) {
      // Real entry with message history — trust it.
      return existingKey;
    }
    // Ghost / missing entry — fall through to alias-based resolution below.
  }
  // ────────────────────────────────────────────────────────────────────────────

  const set = getFlowSignalSourceAliases(flow);
  if (set.size === 0) return null;
  const entries = chatDirectoryStore.listRecentChats('signal', 5000);
  for (const e of entries) {
    for (const a of e.aliases || []) {
      const s = String(a || '').trim();
      if (!s) continue;
      // Check both raw alias and its normalized form (group: ↔ group. conversion).
      if (set.has(s)) return String(e.chatKey || '').trim() || null;
      const norm = normalizeChatId(s);
      if (norm && norm !== s && set.has(norm)) return String(e.chatKey || '').trim() || null;
    }
  }
  return null;
}

function inferSignalSourceChatKeyFromDirectory(flow) {
  const key = resolveSignalSourceChatKeyFromFlowAliases(flow);
  if (!key) return flow;
  const next = { ...flow, sourceChatKey: key };
  const entry = chatDirectoryStore.getChatByKey(key);
  const aliases = Array.isArray(entry?.aliases) ? entry.aliases.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const primary = pickSignalPrimaryAlias(aliases);
  if (primary && (!Array.isArray(next.sourceChatIds) || next.sourceChatIds.length === 0)) {
    next.sourceChatIds = [primary];
    next.sourceChatId = primary;
    next.sourceChatRefs = [
      {
        id: primary,
        name: String(entry.manualLabel || entry.displayName || primary).trim(),
        aliases: buildSignalAliasList(primary, aliases)
      }
    ];
  }
  return next;
}

function loadAndMigrateFlows() {
  const raw = loadFlowsFromDisk();
  let needsSave = false;
  const migrated = raw.map((f) => {
    const before = JSON.stringify(f);
    const m = migrateFlowRecord(f);
    if (before !== JSON.stringify(m)) needsSave = true;
    applyFlowManualLabelsToDirectory(m);
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
  let sourceChatKey = String(body.sourceChatKey || ex?.sourceChatKey || '').trim();
  let sourceChatIds = [];
  if (Array.isArray(body.sourceChatIds)) {
    sourceChatIds = body.sourceChatIds.map((x) => String(x).trim()).filter(Boolean);
  } else if (body.sourceChatId) {
    const one = String(body.sourceChatId).trim();
    if (one) sourceChatIds = [one];
  }
  let sourceChatRefs = [];
  if (Array.isArray(body.sourceChatRefs)) {
    sourceChatRefs = body.sourceChatRefs
      .map((r) => ({
        id: String(r?.id || '').trim(),
        name: String(r?.name || '').trim(),
        aliases: normalizeAliases(r?.aliases)
      }))
      .filter((r) => r.id);
  } else if (ex && Array.isArray(ex.sourceChatRefs)) {
    sourceChatRefs = ex.sourceChatRefs
      .map((r) => ({
        id: String(r?.id || '').trim(),
        name: String(r?.name || '').trim(),
        aliases: normalizeAliases(r?.aliases)
      }))
      .filter((r) => r.id);
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
  if (sourcePlatform !== 'signal') sourceChatKey = '';
  const direction = sourcePlatform === 'whatsapp' && targetPlatform === 'whatsapp'
    ? 'wa_wa'
    : sourcePlatform === 'whatsapp' && targetPlatform === 'fastapi'
      ? 'wa_fastapi'
      : `${sourcePlatform}_${targetPlatform}`;

  let targetChatId = null;
  let targetChatRef = null;
  if (targetPlatform === 'whatsapp' || targetPlatform === 'signal') {
    if (body.targetChatId !== undefined && body.targetChatId !== null) {
      const t = String(body.targetChatId).trim();
      targetChatId = t || null;
    } else if (ex && ex.targetChatId) {
      targetChatId = String(ex.targetChatId).trim() || null;
    }
    if (body.targetChatRef && body.targetChatRef.id) {
      targetChatRef = {
        id: String(body.targetChatRef.id || '').trim(),
        name: String(body.targetChatRef.name || body.targetChatRef.id || '').trim()
      };
    } else if (ex && ex.targetChatRef && ex.targetChatRef.id) {
      targetChatRef = {
        id: String(ex.targetChatRef.id || '').trim(),
        name: String(ex.targetChatRef.name || ex.targetChatRef.id || '').trim()
      };
    }
  }
  const refsById = new Map(sourceChatRefs.map((r) => [r.id, { name: r.name || r.id, aliases: r.aliases || [] }]));
  let signalKeyHydrated = false;
  // For Signal, keep canonical chatId provided by UI selection.
  // Hydrate from directory aliases only when legacy payload has no sourceChatIds.
  if (sourcePlatform === 'signal' && sourceChatKey && sourceChatIds.length === 0) {
    const sourceEntry = chatDirectoryStore.getChatByKey(sourceChatKey);
    if (sourceEntry) {
      const aliases = Array.isArray(sourceEntry.aliases)
        ? sourceEntry.aliases.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      const primary = pickSignalPrimaryAlias(aliases);
      if (primary) {
        const dirManual = String(sourceEntry.manualLabel || '').trim();
        const dirDisplay = String(sourceEntry.displayName || '').trim();
        const panelRefName = String(body.sourceChatRefs?.[0]?.name || '').trim();
        const existingRefName = String(ex?.sourceChatRefs?.[0]?.name || '').trim();
        const resolved = String(chatDirectoryStore.resolvePanelResolvedName(sourceEntry) || '').trim();
        const refName =
          dirManual ||
          panelRefName ||
          existingRefName ||
          resolved ||
          dirDisplay ||
          primary;
        sourceChatIds = [primary];
        sourceChatRefs = [
          {
            id: primary,
            name: refName,
            aliases: buildSignalAliasList(primary, aliases)
          }
        ];
        signalKeyHydrated = true;
        if (!dirManual) {
          chatDirectoryStore.setManualLabelIfEmpty(sourceChatKey, refName);
        }
      }
    }
  }
  if (!signalKeyHydrated) {
    sourceChatRefs = sourceChatIds.map((id) => ({
      id,
      name: pickPreferredChatName(sourcePlatform, id, refsById.get(id)?.name || '') || id,
      aliases: sourcePlatform === 'signal' ? buildSignalAliasList(id, refsById.get(id)?.aliases || []) : []
    }));
  }

  // Перехресна валідація для Signal: якщо sourceChatKey не відповідає sourceChatIds —
  // перерезолвити ключ через директорію щоб уникнути розбіжності між UI-вибором і реальним chatId.
  if (sourcePlatform === 'signal' && sourceChatKey && sourceChatIds.length > 0) {
    const keyEntry = chatDirectoryStore.getChatByKey(sourceChatKey);
    if (keyEntry) {
      const keyAliases = new Set(
        (Array.isArray(keyEntry.aliases) ? keyEntry.aliases : [])
          .map((x) => String(x || '').trim().toLowerCase())
          .filter(Boolean)
      );
      const idMatchesKey = sourceChatIds.some((id) => {
        const norm = String(id || '').trim().toLowerCase();
        return keyAliases.has(norm) || keyAliases.has(`group.${norm}`) || keyAliases.has(norm.replace(/^group\./, ''));
      });
      if (!idMatchesKey) {
        // sourceChatKey вказує на інший чат ніж sourceChatIds — перерезолвити ключ з директорії
        const resolvedKey = resolveSignalSourceChatKeyFromFlowAliases({ sourcePlatform, sourceChatKey: '', sourceChatIds, sourceChatRefs });
        if (resolvedKey && resolvedKey !== sourceChatKey) {
          sourceChatKey = resolvedKey;
        }
      }
    }
  }
  if (targetChatId) {
    const preferredTargetName = pickPreferredChatName(targetPlatform, targetChatId, targetChatRef?.name) || targetChatId;
    if (!targetChatRef || targetChatRef.id !== targetChatId) {
      targetChatRef = { id: targetChatId, name: preferredTargetName };
    } else {
      targetChatRef = { id: targetChatId, name: preferredTargetName };
    }
  } else {
    targetChatRef = null;
  }

  return {
    id: existingId || generateFlowId(),
    name,
    direction,
    sourcePlatform,
    targetPlatform,
    sourceChatKey: sourceChatKey || null,
    sourceChatIds,
    sourceChatRefs,
    sourceChatId: sourceChatIds[0] || null,
    fastapiUrl: null,
    targetChatId,
    targetChatRef,
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
    outdatedDiff: body.outdatedDiff !== undefined ? body.outdatedDiff : ex ? ex.outdatedDiff : null,
    addons: mergeAddons(body.addons, ex?.addons),
    needsWaReconfigure: false
  };
}

function mergeAddons(incoming, existing) {
  const base = {
    delayMeter: { enabled: false, thresholdSec: 60, alertChatId: null, alertPlatform: 'whatsapp' },
    missingMessages: { enabled: false, time1: '04:00', time2: '19:00', maxMinutes1: 3, maxMinutes2: 8, alertChatId: null, alertPlatform: 'whatsapp' }
  };
  const src = (incoming && typeof incoming === 'object') ? incoming : (existing && typeof existing === 'object') ? existing : {};
  return {
    delayMeter: { ...base.delayMeter, ...(existing?.delayMeter || {}), ...(src.delayMeter || {}) },
    missingMessages: { ...base.missingMessages, ...(existing?.missingMessages || {}), ...(src.missingMessages || {}) }
  };
}

function validateAutomation(f, allFlows, excludeId) {
  if (!f.name) return 'Вкажіть назву автоматизації';
  const hasSourceKey = String(f.sourceChatKey || '').trim().length > 0;
  if ((!f.sourceChatIds || f.sourceChatIds.length === 0) && !hasSourceKey) {
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
  return null;
}

function isFastapiDirection(flow) {
  const p = inferPlatforms(flow);
  return p.sourcePlatform === 'whatsapp' && p.targetPlatform === 'fastapi';
}

let flows = [];

// ── Addon runtime state ────────────────────────────────────────────────────
const addonState = new Map(); // flowId → { delayMeter, missingMessages }

function getAddonState(flowId) {
  if (!addonState.has(flowId)) {
    addonState.set(flowId, {
      delayMeter: { pendingDelays: [] },
      missingMessages: { lastMessageTs: null, alertSentAt: null }
    });
  }
  return addonState.get(flowId);
}

// Parse "dd.mm.yyyy, hh:mm:ss" from the first line of message text.
// Returns UTC ms or null. Message time is assumed to be UTC+3.
function parseMessageTimestamp(text) {
  const firstLine = String(text || '').split('\n')[0].trim();
  const m = firstLine.match(/(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  return Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh) - 3, Number(mi), Number(ss));
}

function formatDuration(totalSec) {
  const s = Math.abs(Math.round(totalSec));
  const min = Math.floor(s / 60);
  const sec = s % 60;
  if (min === 0) return `${sec} сек`;
  if (sec === 0) return `${min} хв`;
  return `${min} хв ${sec} сек`;
}

// Returns max idle minutes for the current UTC+3 time based on flow config.
function getMaxIdleMinutes(cfg) {
  const nowUtc3 = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const nowMins = nowUtc3.getUTCHours() * 60 + nowUtc3.getUTCMinutes();
  const [h1 = 4, m1 = 0] = String(cfg.time1 || '04:00').split(':').map(Number);
  const [h2 = 19, m2 = 0] = String(cfg.time2 || '19:00').split(':').map(Number);
  const t1 = h1 * 60 + m1;
  const t2 = h2 * 60 + m2;
  // period1: time1..time2; period2: time2..time1 (may wrap midnight)
  const inPeriod1 = t1 <= t2
    ? (nowMins >= t1 && nowMins < t2)
    : (nowMins >= t1 || nowMins < t2);
  return inPeriod1 ? Number(cfg.maxMinutes1 || 3) : Number(cfg.maxMinutes2 || 8);
}

async function sendAddonAlert(platform, chatId, text) {
  if (!chatId) return;
  try {
    if (platform === 'signal') {
      await sendSignalMessage(chatId, text);
    } else {
      await sendWithRateLimit(chatId, text);
    }
  } catch (e) {
    pushLog('WARN', 'Addon alert send failed', { platform, chatId, error: e.message });
  }
}

function processDelayMeterAddon(flow, rawText, sentAtMs) {
  const cfg = flow?.addons?.delayMeter;
  if (!cfg?.enabled || !cfg.alertChatId) return;
  const msgTs = parseMessageTimestamp(rawText);
  if (msgTs === null || !Number.isFinite(msgTs)) return;
  const delaySec = Math.round((sentAtMs - msgTs) / 1000);
  if (delaySec <= 0) return; // future timestamp or clock skew
  const threshold = Number(cfg.thresholdSec || 60);
  if (delaySec > threshold) {
    getAddonState(flow.id).delayMeter.pendingDelays.push(delaySec);
  }
}

function processMissingMessagesAddon(flow) {
  const cfg = flow?.addons?.missingMessages;
  if (!cfg?.enabled || !cfg.alertChatId) return;
  const st = getAddonState(flow.id).missingMessages;
  st.lastMessageTs = Date.now();
  st.alertSentAt = null; // new message resets alert cooldown
}

let addonCheckTimer = null;

function startAddonCheckers() {
  if (addonCheckTimer) return;
  addonCheckTimer = setInterval(async () => {
    const now = Date.now();
    for (const flow of flows) {
      if (flow.paused) continue;

      // ── Delay Meter: flush per-minute buffer ─────────────────
      const dmCfg = flow?.addons?.delayMeter;
      if (dmCfg?.enabled && dmCfg.alertChatId) {
        const st = getAddonState(flow.id).delayMeter;
        if (st.pendingDelays.length > 0) {
          const maxDelay = Math.max(...st.pendingDelays);
          const chatName = flow.sourceChatRefs?.[0]?.name || flow.name;
          const text = `Перехоплення в чаті "${chatName}" приходять зі затримкою ${formatDuration(maxDelay)}`;
          await sendAddonAlert(dmCfg.alertPlatform || 'whatsapp', dmCfg.alertChatId, text);
          st.pendingDelays = [];
        }
      }

      // ── Missing Messages: idle check ─────────────────────────
      const mmCfg = flow?.addons?.missingMessages;
      if (mmCfg?.enabled && mmCfg.alertChatId) {
        const st = getAddonState(flow.id).missingMessages;
        if (st.lastMessageTs === null) continue;
        const maxIdleMs = getMaxIdleMinutes(mmCfg) * 60 * 1000;
        const idleMs = now - st.lastMessageTs;
        if (idleMs >= maxIdleMs) {
          if (st.alertSentAt === null || now - st.alertSentAt >= maxIdleMs) {
            const idleMin = Math.round(idleMs / 60000);
            const chatName = flow.sourceChatRefs?.[0]?.name || flow.name;
            const text = `Протягом ${idleMin} хв немає повідомлень із чату "${chatName}"`;
            await sendAddonAlert(mmCfg.alertPlatform || 'whatsapp', mmCfg.alertChatId, text);
            st.alertSentAt = now;
          }
        }
      }
    }
  }, 60000);
}

const panelSessions = new Map();
let panelAuthConfig = loadPanelAuthConfig();

function hashPassword(password, saltHex) {
  const salt = Buffer.from(String(saltHex || ''), 'hex');
  return crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
}

function buildPanelAuthRecord(user, password) {
  const username = String(user || '').trim();
  const pass = String(password || '').trim();
  if (!username || !pass) return null;
  const saltHex = crypto.randomBytes(16).toString('hex');
  return {
    user: username,
    salt: saltHex,
    passwordHash: hashPassword(pass, saltHex),
    updatedAt: nowIso()
  };
}

function loadPanelAuthConfig() {
  try {
    if (fs.existsSync(PANEL_AUTH_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PANEL_AUTH_FILE, 'utf8'));
      const user = String(raw?.user || '').trim();
      const salt = String(raw?.salt || '').trim();
      const passwordHash = String(raw?.passwordHash || '').trim();
      if (user && salt && passwordHash) {
        return { user, salt, passwordHash, source: 'file', updatedAt: raw?.updatedAt || null };
      }
    }
  } catch {
    /* ignore and fallback to env */
  }
  if (PANEL_USER && PANEL_PASSWORD) {
    const envRecord = buildPanelAuthRecord(PANEL_USER, PANEL_PASSWORD);
    if (envRecord) return { ...envRecord, source: 'env' };
  }
  return null;
}

function savePanelAuthConfig(user, password) {
  const record = buildPanelAuthRecord(user, password);
  if (!record) throw new Error('Логін і пароль не можуть бути порожніми');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PANEL_AUTH_FILE, JSON.stringify(record, null, 2), 'utf8');
  panelAuthConfig = { ...record, source: 'file' };
  return panelAuthConfig;
}

function clearPanelAuthConfig() {
  panelAuthConfig = null;
  try {
    if (fs.existsSync(PANEL_AUTH_FILE)) {
      fs.unlinkSync(PANEL_AUTH_FILE);
    }
  } catch {
    /* ignore */
  }
}

function verifyPanelCredentials(user, password) {
  if (!panelAuthConfig) return false;
  const username = String(user || '').trim();
  const providedHash = hashPassword(String(password || ''), panelAuthConfig.salt);
  return username === panelAuthConfig.user && providedHash === panelAuthConfig.passwordHash;
}

function isPanelAuthEnabled() {
  return Boolean(panelAuthConfig && panelAuthConfig.user && panelAuthConfig.passwordHash);
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
  if (verifyPanelCredentials(user, password)) {
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
    return res.json({ ok: true, auth: true, authDisabled: true, user: null, source: 'none', ...ver });
  }
  const tok = req.cookies?.wb_panel;
  res.json({
    ok: true,
    auth: Boolean(tok && panelSessions.has(tok)),
    authDisabled: false,
    user: panelAuthConfig?.user || null,
    source: panelAuthConfig?.source || 'env',
    ...ver
  });
});

app.post('/api/panel-auth/settings', (req, res) => {
  const { user, password } = req.body || {};
  const login = String(user || '').trim();
  const pass = String(password || '').trim();
  const bothEmpty = !login && !pass;
  if ((login && !pass) || (!login && pass)) {
    return res.status(400).json({ ok: false, message: 'Заповніть обидва поля: логін і пароль, або залиште обидва порожніми.' });
  }
  try {
    if (bothEmpty) {
      clearPanelAuthConfig();
      panelSessions.clear();
      res.clearCookie('wb_panel');
      pushLog('INFO', 'Panel auth disabled from settings');
      return res.json({ ok: true, authDisabled: true, user: null, source: 'none' });
    }
    const cfg = savePanelAuthConfig(login, pass);
    panelSessions.clear();
    const token = crypto.randomBytes(32).toString('hex');
    panelSessions.set(token, { created: Date.now() });
    res.cookie('wb_panel', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000
    });
    pushLog('INFO', 'Panel auth settings updated', { user: cfg.user, source: cfg.source });
    return res.json({ ok: true, user: cfg.user, source: cfg.source });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message || 'Не вдалося зберегти налаштування безпеки' });
  }
});

let client = null;
let isStarting = false;
let isStopping = false;
let heartbeatTimer = null;
let activityLogTimer = null;
let lastQr = null;
let eventClients = [];
let lastSendTs = 0;
let signalPollTimer = null;
let signalLastPollTs = 0;
let signalLastLinkedProbeTs = 0;
let signalLinkInProgress = false;
let signalPollInFlight = false;
const signalSeenMessageIds = new Set();
const throttledLogTs = new Map();
let activityCountersSnapshot = null;
let activityIgnoredReasonsSnapshot = null;

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
    running: false,
    lastLinkAt: null,
    lastLinkErrorAt: null,
    lastLinkError: null,
    qrDataUrl: null,
    linked: null,
    linkedAccounts: [],
    lastLinkedCheckAt: null,
    recentIncomingChats: []
  },
  activity: {
    lastMinute: {
      received: 0,
      accepted: 0,
      ignored: 0,
      posted: 0,
      sent: 0,
      errors: 0
    },
    lastMinuteAt: null
    ,
    ignoredReasonsTotal: {},
    ignoredReasonsLastMinute: {}
  },
  counters: {
    received: 0,
    accepted: 0,
    ignored: 0,
    posted: 0,
    sent: 0,
    errors: 0,
    // Per-platform breakdown for the activity monitor
    signalReceived: 0,
    waReceived: 0,
    waSent: 0,
    signalSent: 0
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
  try {
    truncateFileIfTooLarge(LOG_FILE, LOG_MAX_BYTES);
    fs.appendFileSync(LOG_FILE, printable, 'utf8');
  } catch {
    // Disk full — log file write is non-critical, never crash the process.
  }

  if (level === 'ERROR') {
    state.lastErrorAt = line.ts;
    state.lastError = `${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
    state.counters.errors += 1;
  }

  writeHealth();
  broadcastEvent('log', line);
}

function pushLogThrottled(key, minIntervalMs, level, message, meta = null) {
  const now = Date.now();
  const last = Number(throttledLogTs.get(key) || 0);
  if (now - last < Math.max(0, Number(minIntervalMs) || 0)) return;
  throttledLogTs.set(key, now);
  pushLog(level, message, meta);
}

function isIgnorableWaPuppeteerProtocolError(errLike) {
  const msg = String(errLike?.message || errLike || '');
  return (
    msg.includes('Protocol error (Network.getResponseBody): No data found for resource with given identifier') ||
    msg.includes('No data found for resource with given identifier')
  );
}

function noteIgnored(reason) {
  state.counters.ignored += 1;
  const key = String(reason || 'unknown');
  const cur = Number(state.activity.ignoredReasonsTotal[key] || 0);
  state.activity.ignoredReasonsTotal[key] = cur + 1;
}

function d(cur, prev, key) {
  return Math.max(0, Number(cur[key] || 0) - Number(prev[key] || 0));
}

function startActivitySummaryLogs() {
  if (activityLogTimer) return;
  activityCountersSnapshot = { ...state.counters };
  activityIgnoredReasonsSnapshot = { ...(state.activity.ignoredReasonsTotal || {}) };
  activityLogTimer = setInterval(() => {
    const cur = state.counters;
    const prev = activityCountersSnapshot || {};
    const delta = {
      received:       d(cur, prev, 'received'),
      accepted:       d(cur, prev, 'accepted'),
      ignored:        d(cur, prev, 'ignored'),
      posted:         d(cur, prev, 'posted'),
      sent:           d(cur, prev, 'sent'),
      errors:         d(cur, prev, 'errors'),
      signalReceived: d(cur, prev, 'signalReceived'),
      waReceived:     d(cur, prev, 'waReceived'),
      waSent:         d(cur, prev, 'waSent'),
      signalSent:     d(cur, prev, 'signalSent')
    };
    const reasonsNow = { ...(state.activity.ignoredReasonsTotal || {}) };
    const reasonsPrev = { ...(activityIgnoredReasonsSnapshot || {}) };
    const reasonKeys = new Set([...Object.keys(reasonsNow), ...Object.keys(reasonsPrev)]);
    const ignoredReasonsMinute = {};
    for (const k of reasonKeys) {
      const dd = Math.max(0, Number(reasonsNow[k] || 0) - Number(reasonsPrev[k] || 0));
      if (dd > 0) ignoredReasonsMinute[k] = dd;
    }
    state.activity.lastMinute = delta;
    state.activity.ignoredReasonsLastMinute = ignoredReasonsMinute;
    state.activity.lastMinuteAt = nowIso();
    activityCountersSnapshot = { ...cur };
    activityIgnoredReasonsSnapshot = reasonsNow;

    // Human-readable per-platform activity summary (ACTIVITY level — shown in monitor view)
    const anyActivity = delta.signalReceived || delta.waReceived || delta.waSent || delta.signalSent || delta.errors;
    if (anyActivity) {
      if (delta.signalReceived > 0) pushLog('ACTIVITY', `↓ Оброблено повідомлень Signal: ${delta.signalReceived}`);
      if (delta.waReceived > 0)     pushLog('ACTIVITY', `↓ Оброблено повідомлень WhatsApp: ${delta.waReceived}`);
      if (delta.waSent > 0)         pushLog('ACTIVITY', `↑ Надіслано повідомлень WhatsApp: ${delta.waSent}`);
      if (delta.signalSent > 0)     pushLog('ACTIVITY', `↑ Надіслано повідомлень Signal: ${delta.signalSent}`);
      if (delta.errors > 0)         pushLog('ACTIVITY', `⚠ Помилок за хвилину: ${delta.errors}`);
    } else {
      // Heartbeat once per minute so operator knows bot is alive
      pushLog('ACTIVITY', '— Активності немає');
    }
  }, 60000);
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

// ----------------------------
// Signal Transport Layer
// ----------------------------
async function signalApiRequest(
  method,
  endpoint,
  data = undefined,
  params = undefined,
  timeoutMs = 30000
) {
  if (!SIGNAL_API_URL) {
    throw new Error('SIGNAL_API_URL is not configured');
  }
  const url = `${SIGNAL_API_URL.replace(/\/+$/, '')}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  const reqTimeout = Math.max(1000, Number(timeoutMs) || 30000);
  try {
    const res = await axios({
      method,
      url,
      data,
      params,
      timeout: reqTimeout
    });
    return res.data;
  } catch (err) {
    const status = Number(err?.response?.status || 0) || null;
    const code = String(err?.code || '').trim() || null;
    const message = err?.message || String(err);
    const e = new Error(message);
    e.signalContext = {
      method: String(method || '').toUpperCase(),
      endpoint: String(endpoint || ''),
      url,
      status,
      code,
      timeoutMs: reqTimeout,
      params: params || null
    };
    throw e;
  }
}

async function signalHealthCheck(timeoutMs = 6000) {
  return signalApiRequest('get', '/health', undefined, undefined, timeoutMs);
}

async function signalLinkedCheck(timeoutMs = 12000) {
  const base = SIGNAL_API_URL.replace(/\/+$/, '');
  let rawRes;
  try {
    rawRes = await axios.get(`${base}/linked`, { timeout: Math.max(1000, Number(timeoutMs) || 12000) });
  } catch (axiosErr) {
    // Prefer the bridge's own error message over the generic axios status message
    const bridgeMsg = axiosErr?.response?.data?.message;
    if (bridgeMsg) {
      const e = new Error(bridgeMsg);
      e.response = axiosErr.response;
      throw e;
    }
    throw axiosErr;
  }
  const raw = rawRes.data;
  const accounts = Array.isArray(raw?.accounts)
    ? raw.accounts.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const linked = Boolean(raw?.linked);
  return { linked, accounts };
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

function isWhatsAppGroupId(id) {
  return String(id || '').trim().endsWith('@g.us');
}

function isWaTransientDetachedFrameError(error) {
  const msg = String(error?.message || error || '').trim();
  if (!msg) return false;
  return (
    msg.includes('Attempted to use detached Frame') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('Target closed') ||
    msg.includes('Session closed') ||
    msg.includes('Protocol error') ||
    msg.includes('frame was detached')
  );
}

function isPhoneLikeSignalId(id) {
  return /^\+?\d{7,}$/.test(String(id || '').trim());
}

function isUuidLikeSignalId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(id || '').trim()
  );
}

function looksLikeSignalGroupId(id) {
  const v = String(id || '').trim();
  if (!v) return false;
  if (v.startsWith('group.')) return true;
  return false;
}

function cacheFileForPlatform(platform) {
  const p = String(platform || '').trim();
  if (p === 'signal') return SIGNAL_CHATS_CACHE_FILE;
  if (p === 'whatsapp') return WHATSAPP_CHATS_CACHE_FILE;
  return '';
}

function readMessengerChatsCache(platform) {
  const file = cacheFileForPlatform(platform);
  if (!file || !fs.existsSync(file)) return { updatedAt: null, chats: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const chats = Array.isArray(raw?.chats) ? raw.chats : Array.isArray(raw) ? raw : [];
    const updatedAt = raw?.updatedAt ? String(raw.updatedAt) : null;
    const out = chats
      .map((c) => ({
        id: String(c?.id || '').trim(),
        name: String(c?.name || '').trim()
      }))
      .filter((c) => c.id);
    return { updatedAt, chats: out };
  } catch {
    return { updatedAt: null, chats: [] };
  }
}

function loadMessengerChatsCache(platform) {
  return readMessengerChatsCache(platform).chats;
}

function cacheAgeMs(updatedAt) {
  const ts = updatedAt ? Date.parse(String(updatedAt)) : NaN;
  if (!Number.isFinite(ts)) return Infinity;
  return Math.max(0, Date.now() - ts);
}

function isCacheFresh(updatedAt) {
  return cacheAgeMs(updatedAt) <= MESSENGER_CHATS_CACHE_TTL_MS;
}

function saveMessengerChatsCache(platform, chats) {
  const file = cacheFileForPlatform(platform);
  if (!file) return;
  const old = readMessengerChatsCache(platform);
  const oldRows = old.chats || [];
  const oldById = new Map(
    (oldRows || [])
      .map((r) => [String(r?.id || '').trim(), String(r?.name || '').trim()])
      .filter((x) => x[0])
  );

  const isTechnicalCacheName = (id, name) => {
    const n = String(name || '').trim();
    const i = String(id || '').trim();
    if (!n) return true;
    if (n === i) return true;
    if (platform === 'signal') {
      if (/^signal-group:/i.test(n)) return true;
      if (isUuidLikeSignalId(n)) return true;
      if (isPhoneLikeSignalId(n)) return true;
      if (looksLikeSignalGroupId(n)) return true;
      if (n.length > 48) return true;
    }
    if (platform === 'whatsapp') {
      if (/^[0-9a-f-]{8}-[0-9a-f-]{4}-[1-5][0-9a-f-]{3}-[89ab][0-9a-f-]{3}-[0-9a-f-]{12}$/i.test(n)) return true;
      if (n.length > 64) return true;
    }
    return false;
  };

  const rowsRaw = (Array.isArray(chats) ? chats : [])
    .map((c) => {
      const id = String(c?.id || '').trim();
      let name = String(c?.name || c?.id || '').trim();
      if (id && name) {
        const oldName = oldById.get(id) || '';
        const newIsTech = isTechnicalCacheName(id, name);
        const oldIsTech = isTechnicalCacheName(id, oldName);
        if (newIsTech && oldName && !oldIsTech) {
          name = oldName;
        }
      }
      return { id, name };
    })
    .filter((c) => c.id);

  // Dedup by id (stable output, avoid growth/noise).
  const byId = new Map();
  for (const r of rowsRaw) {
    const id = String(r.id || '').trim();
    if (!id) continue;
    const name = String(r.name || '').trim();
    if (!byId.has(id)) byId.set(id, { id, name });
    else if (name && !byId.get(id).name) byId.set(id, { id, name });
  }
  const rows = Array.from(byId.values());
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ platform, updatedAt: nowIso(), chats: rows }, null, 2),
    'utf8'
  );
}

function applyOnlyGroupsToLiveChats(platform, chats, onlyGroups) {
  if (!onlyGroups) return chats.slice();
  const p = String(platform || '').trim();
  if (p === 'whatsapp') return chats.filter((c) => isWhatsAppGroupId(c.id));
  if (p === 'signal') return chats.filter((c) => looksLikeSignalGroupId(c.id));
  return chats.slice();
}

function extractSignalRawMessages(raw) {
  return Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.messages)
      ? raw.messages
      : Array.isArray(raw?.data)
        ? raw.data
        : [];
}

function buildSignalFallbackMessageId(event) {
  const chatId = String(event?.chatId || '').trim();
  const ts = String(event?.sentAt || event?.timestamp || '').trim();
  const text = String(event?.text || '').trim();
  const basis = `${chatId}|${ts}|${text}`;
  return `signal_${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 20)}`;
}

function captureSignalRawEvent(rawEvent) {
  if (!SIGNAL_RAW_CAPTURE) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const normalized = normalizeSignalMessage(rawEvent);
    const row = {
      platform: 'signal',
      chatId: normalized?.chatId || null,
      rawConversationId: normalized?.rawConversationId ?? null,
      rawGroupId: normalized?.rawGroupId ?? null,
      rawAuthorId: normalized?.rawAuthorId ?? null,
      normalizedChatId: normalized?.chatId || null,
      normalizedSenderId: normalized?.senderId ?? null,
      chatCandidates: Array.isArray(normalized?.chatCandidates) ? normalized.chatCandidates : [],
      chatName: normalized?.chatName ?? null,
      senderId: normalized?.senderId ?? null,
      senderName: normalized?.senderName ?? null,
      messageId: normalized?.messageId || null,
      text: String(normalized?.text || ''),
      sentAt: normalized?.sentAt ?? null,
      attachments: Array.isArray(normalized?.attachments) ? normalized.attachments : [],
      isTextMessage: Boolean(normalized?.isTextMessage),
      isEmptyMessage: Boolean(normalized?.isEmptyMessage),
      raw: normalized?.raw || rawEvent || {}
    };
    const line = JSON.stringify(row) + '\n';
    truncateFileIfTooLarge(SIGNAL_RAW_LOG_FILE, SIGNAL_RAW_MAX_BYTES);
    fs.appendFile(SIGNAL_RAW_LOG_FILE, line, 'utf8', (err) => {
      if (!err) return;
      pushLogThrottled(
        'signal_raw_capture_write_failed',
        60000,
        'WARN',
        'Signal raw capture write failed',
        { message: err.message || String(err), file: SIGNAL_RAW_LOG_FILE }
      );
    });
  } catch (error) {
    // Diagnostic capture must never break routing path.
    pushLogThrottled(
      'signal_raw_capture_exception',
      60000,
      'WARN',
      'Signal raw capture exception',
      { message: error?.message || String(error), file: SIGNAL_RAW_LOG_FILE }
    );
  }
}

// ----------------------------
// Signal Normalization Layer
// ----------------------------
function normalizeSignalMessage(raw) {
  const m = raw || {};

  // Explicit identity separation:
  // - conversation/group/chat: where the message was posted
  // - sender/author: who posted it
  const rawGroupId = String(
    m.groupId ||
      m.envelope?.dataMessage?.groupInfo?.groupId ||
      m.envelope?.groupInfo?.groupId ||
      ''
  ).trim() || null;

  const rawAuthorId = String(
    m.author ||
      m.sender ||
      m.source ||
      m.envelope?.source ||
      ''
  ).trim() || null;

  // IMPORTANT:
  // For Signal group messages, groupId must win over m.chatId.
  // Some bridge/event shapes put sender-like value into m.chatId,
  // which breaks flow matching if it overrides the real group identity.
  const rawConversationId =
    String(rawGroupId ? `group.${rawGroupId}` : '').trim() ||
    String(m.chatId || '').trim() ||
    (rawAuthorId ? String(rawAuthorId).trim() : '') ||
    null;

  const normalizedChatId = rawConversationId
    ? String(normalizeChatId(rawConversationId) || rawConversationId).trim()
    : null;

  const normalizedSenderId = rawAuthorId
    ? String(normalizeChatId(rawAuthorId) || rawAuthorId).trim()
    : null;

  const chatCandidatesSet = new Set();

  const addCandidate = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    chatCandidatesSet.add(s);
  };

  const addNormalizedCandidate = (v) => {
    const s = String(v || '').trim();
    if (!s) return;

    const low = s.toLowerCase();
    chatCandidatesSet.add(low);

    if (low.startsWith('group.')) {
      const stripped = low.slice(6).trim();
      if (stripped) chatCandidatesSet.add(stripped);
    }
  };

  const rawCandidates = Array.isArray(m.chatCandidates) ? m.chatCandidates : [];
  for (const rc of rawCandidates) {
    addCandidate(rc);
    addNormalizedCandidate(rc);
  }

  if (rawConversationId) {
    addCandidate(rawConversationId);
    addNormalizedCandidate(rawConversationId);
  }

  if (rawGroupId) {
    addCandidate(rawGroupId);
    addNormalizedCandidate(rawGroupId);
    addCandidate(`group.${rawGroupId}`);
    addNormalizedCandidate(`group.${rawGroupId}`);
  }

  const chatCandidates = Array.from(chatCandidatesSet);

  const text = String(
    m.message ||
      m.text ||
      m.body ||
      m.envelope?.dataMessage?.message ||
      ''
  );

  const tsRaw = Number(m.timestamp || m.ts || m.envelope?.timestamp);
  const sentAt = Number.isFinite(tsRaw) ? tsRaw : null;

  const attachmentsRaw =
    (Array.isArray(m.attachments) && m.attachments) ||
    (Array.isArray(m.envelope?.dataMessage?.attachments) && m.envelope.dataMessage.attachments) ||
    [];

  const attachments = Array.isArray(attachmentsRaw) ? attachmentsRaw : [];

  const canonical = {
    platform: 'signal',
    chatId: normalizedChatId || null,
    rawConversationId,
    rawGroupId,
    rawAuthorId,
    chatCandidates,
    chatName: null,
    senderId: normalizedSenderId,
    senderName: null,
    messageId: String(m.id || m.messageId || m.uuid || '').trim() || null,
    text,
    sentAt,
    attachments,
    isTextMessage: text.trim().length > 0,
    isEmptyMessage: text.trim().length === 0,
    raw: m
  };

  if (!canonical.messageId) {
    canonical.messageId = buildSignalFallbackMessageId({
      chatId: canonical.chatId || '',
      sentAt: canonical.sentAt || '',
      text: canonical.text || ''
    });
  }

  // Backward-compatible aliases for current routing path.
  canonical.id = canonical.messageId;
  canonical.author = canonical.senderId;
  canonical.timestamp = canonical.sentAt || Date.now();

  return canonical;
}

function normalizeSignalMessages(raw) {
  const arr = extractSignalRawMessages(raw);
  let droppedNoChatId = 0;
  const normalized = arr
    .map((message) => {
      const normalizedOne = normalizeSignalMessage(message);
      return normalizedOne;
    })
    .filter((x) => {
      const ok = Boolean(x && x.chatId);
      if (!ok) droppedNoChatId += 1;
      return ok;
    });
  if (droppedNoChatId > 0) {
    pushLogThrottled(
      'signal_dropped_before_routing_missing_chatid',
      15000,
      'WARN',
      'Signal messages dropped before routing',
      { reason: 'missing_chat_id', dropped: droppedNoChatId, rawEvents: arr.length }
    );
  }
  for (const message of normalized) {
    message.chatCandidates = buildChatCandidates(message);
    // For group messages, log explicit identity mapping (conversation vs author)
    const looksGroup =
      Boolean(String(message?.rawGroupId || '').trim()) || String(message?.chatId || '').startsWith('group.');
    if (looksGroup) {
      const resolvedEntry = chatDirectoryStore.findChatByMessage(message);
      const resolvedChatKey = resolvedEntry?.chatKey ? String(resolvedEntry.chatKey).trim() : null;
      const resolvedChatName = String(
        resolvedEntry?.manualLabel ||
          resolvedEntry?.displayName ||
          chatDirectoryStore.resolvePanelResolvedName(resolvedEntry) ||
          ''
      ).trim() || null;
      pushLogThrottled(
        `signal_group_identity_${String(message.chatId || '').slice(0, 24)}`,
        2000,
        'INFO',
        'Signal group identity',
        {
          rawConversationId: message.rawConversationId || null,
          rawGroupId: message.rawGroupId || null,
          rawAuthorId: message.rawAuthorId || null,
          normalizedChatId: message.chatId || null,
          normalizedSenderId: message.senderId || null,
          resolvedChatKey,
          resolvedChatName
        }
      );
    }
  }
  for (const message of normalized) {
    chatDirectoryStore.upsertChatFromMessage(message);
  }
  return normalized;
}

function signalIdCandidates(value) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };
  const v = String(value || '').trim();
  if (!v) return out;
  push(v);
  if (v.startsWith('group.')) push(v.slice(6));
  else {
    push(`group.${v}`);
  }
  return out;
}

async function fetchSignalChats() {
  const raw = await signalApiRequest('get', '/chats', undefined, undefined, SIGNAL_CHATS_TIMEOUT_MS);
  const list = normalizeSignalChatList(raw);
  upsertChatDirectory('signal', list);
  chatDirectoryStore.dedupAndSaveChatDirectory();
  return list;
}

// ----------------------------
// Signal Event Intake Layer
// ----------------------------
async function fetchSignalMessages(sinceTs = 0) {
  const raw = await signalApiRequest(
    'get',
    '/messages',
    undefined,
    { since: sinceTs || undefined },
    90000
  );
  const rawEvents = extractSignalRawMessages(raw);
  if (SIGNAL_RAW_CAPTURE) {
    pushLogThrottled(
      'signal_raw_capture_active',
      15000,
      'INFO',
      'Signal raw capture active',
      { events: rawEvents.length, file: SIGNAL_RAW_LOG_FILE }
    );
  }
  for (const e of rawEvents) {
    captureSignalRawEvent(e);
  }
  const normalized = normalizeSignalMessages(raw);
  if (normalized.length > 0) {
    const samples = normalized.slice(0, 3).map((m) => ({
      platform: m.platform,
      chatId: m.chatId,
      chatCandidates: m.chatCandidates,
      senderId: m.senderId,
      messageId: m.messageId,
      text: String(m.text || '').slice(0, 80),
      isTextMessage: m.isTextMessage,
      isEmptyMessage: m.isEmptyMessage
    }));
    pushLogThrottled(
      'signal_normalized_samples',
      15000,
      'INFO',
      'Signal normalized samples',
      { count: normalized.length, samples }
    );
  }
  return normalized;
}

async function checkSignalLinkedStatus() {
  if (!SIGNAL_API_URL) return null;
  if (signalLinkInProgress) return null;
  try {
    const { linked, accounts } = await signalLinkedCheck(12000);
    // Only write to state if the worker is still running.
    // This prevents an in-flight check from overwriting a manual logout.
    if (state.signal.running) {
      state.signal.linked = linked;
      state.signal.linkedAccounts = accounts;
      state.signal.lastLinkedCheckAt = nowIso();
      if (linked) {
        state.signal.qrDataUrl = null;
      }
      broadcastEvent('state', getPublicState());
    }
    return { linked, accounts };
  } catch (error) {
    if (error?.response?.status === 404) {
      // Old bridge versions may not support /linked yet.
      return null;
    }
    if (state.signal.running) {
      state.signal.lastLinkedCheckAt = nowIso();
      state.signal.linked = null;
      state.signal.linkedAccounts = [];
      state.signal.lastErrorAt = nowIso();
      state.signal.lastError = error.message;
      broadcastEvent('state', getPublicState());
    }
    pushLogThrottled(
      'signal_linked_status_failed',
      60000,
      'ERROR',
      'Signal linked status check failed',
      { message: error.message }
    );
    return null;
  }
}

async function sendSignalMessage(chatId, text, base64Attachments = []) {
  await signalApiRequest('post', '/send', {
    chatId,
    text,
    base64Attachments
  });
}

async function downloadSignalAttachment(attachmentId) {
  return signalApiRequest('get', `/attachment/${encodeURIComponent(attachmentId)}`, undefined, undefined, 60000);
}

async function requestSignalLinkQr(deviceName, options = {}) {
  const allowDockerFallback =
    options.allowDockerFallback !== undefined
      ? Boolean(options.allowDockerFallback)
      : SIGNAL_LINK_ALLOW_DOCKER_FALLBACK;
  const reqLabel = options.auto ? 'Signal auto-link request' : 'Signal link request';
  const name = String(deviceName || 'wa-bridge').trim() || 'wa-bridge';
  pushLog('INFO', reqLabel, { deviceName: name });
  if (SIGNAL_API_URL) {
    try {
      await signalHealthCheck(6000);
    } catch (healthErr) {
      state.signal.lastLinkErrorAt = nowIso();
      state.signal.lastLinkError = healthErr.message || 'Signal bridge health check failed';
      throw new Error(
        'Signal bridge недоступний (health check). Перевірте, що Docker Desktop запущений і сервіси signal-cli-api/signal-bridge працюють.'
      );
    }
    try {
      let data;
      try {
        data = await signalApiRequest(
          'post',
          '/link',
          { name },
          undefined,
          SIGNAL_LINK_TIMEOUT_MS
        );
      } catch (_firstErr) {
        await sleep(1500);
        data = await signalApiRequest(
          'post',
          '/link',
          { name },
          undefined,
          SIGNAL_LINK_TIMEOUT_MS
        );
      }
      if (data?.ok && data?.qrDataUrl) {
        state.signal.lastLinkAt = nowIso();
        state.signal.lastLinkErrorAt = null;
        state.signal.lastLinkError = null;
        state.signal.qrDataUrl = data.qrDataUrl;
        checkSignalLinkedStatus().catch(() => {});
        return { ok: true, uri: null, qrDataUrl: data.qrDataUrl };
      }
      throw new Error(
        data?.message ||
          `Signal bridge /link returned invalid payload: ${JSON.stringify({
            ok: data?.ok,
            hasQrDataUrl: Boolean(data?.qrDataUrl)
          })}`
      );
    } catch (e) {
      state.signal.lastLinkErrorAt = nowIso();
      state.signal.lastLinkError = e.message || 'Signal bridge /link failed';
      if (!allowDockerFallback) {
        throw new Error(
          'Signal bridge /link повернув помилку. Повторіть QR або перевірте signal-bridge/signal-cli-api логи.'
        );
      }
      pushLog('WARN', 'Signal link fallback to docker exec enabled', {
        env: 'SIGNAL_LINK_ALLOW_DOCKER_FALLBACK=1'
      });
    }
  }
  const uri = await dockerExecSignalLink(name);
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 420, margin: 2 });
  state.signal.lastLinkAt = nowIso();
  state.signal.lastLinkErrorAt = null;
  state.signal.lastLinkError = null;
  state.signal.qrDataUrl = qrDataUrl;
  checkSignalLinkedStatus().catch(() => {});
  return { ok: true, uri, qrDataUrl };
}

// Maximum log file sizes before auto-truncation (prevents ENOSPC crashes).
const LOG_MAX_BYTES = 20 * 1024 * 1024;        // 20 MB — bot.log
const SIGNAL_RAW_MAX_BYTES = 50 * 1024 * 1024; // 50 MB — signal_raw.ndjson

function truncateFileIfTooLarge(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      fs.writeFileSync(
        filePath,
        `[auto-truncated at ${new Date().toISOString()} — file exceeded ${Math.round(maxBytes / 1024 / 1024)} MB]\n`,
        'utf8'
      );
    }
  } catch {
    // File might not exist yet — that's fine.
  }
}

function writeHealth() {
  try {
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
  } catch {
    // Disk full or other I/O error — health file is non-critical, never crash the process.
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
// При Ctrl+C або зупинці сервісу — правильно закриваємо Chrome/Puppeteer,
// щоб не залишати процеси в пам'яті та не блокувати .wwebjs_auth при наступному старті.
let shutdownInProgress = false;
async function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`\n[SHUTDOWN] ${signal} received — closing Chrome...`);
  if (client) {
    try { await Promise.race([client.destroy(), new Promise(r => setTimeout(r, 5000))]); }
    catch { /* ignore */ }
  }
  await cleanupChromeLocks();
  console.log('[SHUTDOWN] Done.');
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// ──────────────────────────────────────────────────────────────────────────

process.on('uncaughtException', (error) => {
  if (isIgnorableWaPuppeteerProtocolError(error)) {
    pushLogThrottled(
      'wa_puppeteer_protocol_ignorable_uncaught',
      60000,
      'WARN',
      'Ignored non-fatal WA Puppeteer protocol error',
      { message: error?.message || String(error) }
    );
    return;
  }
  pushLog('ERROR', 'Uncaught exception', {
    message: error?.message || String(error),
    stack: error?.stack || null
  });
});

process.on('unhandledRejection', (reason) => {
  if (isIgnorableWaPuppeteerProtocolError(reason)) {
    pushLogThrottled(
      'wa_puppeteer_protocol_ignorable_rejection',
      60000,
      'WARN',
      'Ignored non-fatal WA Puppeteer rejection',
      { message: reason?.message || String(reason) }
    );
    return;
  }
  pushLog('ERROR', 'Unhandled promise rejection', {
    message: reason?.message || String(reason),
    stack: reason?.stack || null
  });
});

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
  state.counters.waSent += 1;

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
  state.counters.waSent += 1;

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

  // Download WA media attachment if enabled
  const base64Attachments = [];
  if (flow.sendAttachments && msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media?.data) {
        const mime = String(media.mimetype || 'application/octet-stream').trim();
        base64Attachments.push(`data:${mime};base64,${media.data}`);
      }
    } catch (e) {
      pushLog('WARN', 'WA→Signal: не вдалося завантажити медіа', {
        flowId: flow.id,
        error: e.message
      });
    }
  }

  if (!text && base64Attachments.length === 0) {
    pushLog('INFO', 'WA→Signal: порожній текст і немає вкладень, пропуск', { flowId: flow.id });
    return;
  }

  await sendSignalMessage(target, text, base64Attachments);
  state.lastSendAt = nowIso();
  state.counters.sent += 1;
  state.counters.signalSent += 1;
  pushLog('INFO', 'WA→Signal sent', {
    targetChat: target,
    textLen: text.length,
    attachmentsCount: base64Attachments.length
  });
}

async function postToFastAPI(payload, url = FASTAPI_URL) {
  const response = await axios.post(url, payload, { timeout: 30000 });
  state.lastPostAt = nowIso();
  state.counters.posted += 1;
  return response.data;
}

async function processSignalIncomingMessage(message) {
  const chatId = message.chatId;
  const resolvedEntry = chatDirectoryStore.findChatByMessage(message);
  const incomingChatKey = resolvedEntry?.chatKey ? String(resolvedEntry.chatKey).trim() : null;
  const incomingResolvedName = String(
    resolvedEntry?.manualLabel || resolvedEntry?.displayName || chatDirectoryStore.resolvePanelResolvedName(resolvedEntry) || ''
  ).trim();
  const incomingCandidates = new Set(
    (Array.isArray(message.chatCandidates) ? message.chatCandidates : [])
      .flatMap((x) => signalIdCandidates(x))
  );
  for (const x of signalIdCandidates(chatId)) incomingCandidates.add(x);
  const rawText = String(message.text || '').trim();
  noteSignalIncomingChat(chatId, rawText);
  pushLog('INFO', 'Signal message received', {
    platform: 'signal',
    chatId,
    incomingChatKey,
    incomingResolvedName: incomingResolvedName || null,
    messageId: message.id || null,
    textLen: rawText.length
  });
  if (/галявина/i.test(incomingResolvedName)) {
    pushLogThrottled(
      'signal_galyavyna_ingest_seen',
      5000,
      'INFO',
      'Signal ingest seen for Галявина',
      { chatId, incomingChatKey, incomingResolvedName }
    );
  }
  const isTestProbe = /\btest\b/i.test(rawText);
  let matchedFlows = findSignalFlowsByIncomingCandidates(message);
  if (isTestProbe) {
    pushLogThrottled(
      `signal_test_probe_pre_${chatId}`,
      2000,
      'INFO',
      'Signal test probe received',
      {
        text: rawText.slice(0, 120),
        chatId,
        chatCandidates: Array.from(incomingCandidates).slice(0, 12),
        matchedFlows: matchedFlows.map((f) => ({ id: f.id, name: f.name }))
      }
    );
  }
  if (matchedFlows.length === 0 && AUTO_SIGNAL_SOURCE_AUTOREMAP) {
    autoRemapSignalFlowsFromDirectory(false);
    matchedFlows = findSignalFlowsByIncomingCandidates(message);
    if (isTestProbe) {
      pushLogThrottled(
        `signal_test_probe_post_${chatId}`,
        2000,
        'INFO',
        'Signal test probe after remap check',
        {
          chatId,
          matchedFlows: matchedFlows.map((f) => ({ id: f.id, name: f.name }))
        }
      );
    }
  }
  if (matchedFlows.length === 0) {
    const configuredSignalSources = flows
      .filter((f) => inferPlatforms(f).sourcePlatform === 'signal')
      .flatMap((f) => getSourceIds(f));
    pushLogThrottled(
      `signal_no_flow_match_${chatId}`,
      60000,
      'INFO',
      'Signal message ignored: no matching source chat',
      {
        chatId,
        chatCandidates: Array.from(incomingCandidates).slice(0, 8),
        configuredSources: configuredSignalSources.slice(0, 20),
        configuredSourcesCount: configuredSignalSources.length
      }
    );
    return;
  }

  state.lastEventAt = nowIso();
  state.lastMessageAt = nowIso();
  state.counters.received += 1;
  state.counters.signalReceived += 1;

  pushLog('INFO', 'Signal flows matched', {
    platform: 'signal',
    chatId,
    incomingChatKey,
    matchedCount: matchedFlows.length,
    flows: matchedFlows.map((f) => ({ id: f.id, name: f.name }))
  });

  await Promise.all(matchedFlows.map(async (flow) => {
  if (flow.paused) {
    pushLog('INFO', 'Signal skipped: flow paused', { flowId: flow.id, flowName: flow.name });
    noteIgnored('signal_paused');
    return;
  }
  const filt = evaluateFlowContentFilters(flow, rawText);
  pushLog('INFO', 'Signal filter decision', {
    flowId: flow.id,
    flowName: flow.name,
    passed: filt.passed,
    reason: filt.reason,
    keywordsTokens: filt.tokK.slice(0, 20),
    frequenciesTokens: filt.tokF.slice(0, 20)
  });
  if (!filt.passed) {
    noteIgnored('signal_filter_miss');
    return;
  }
  state.counters.accepted += 1;

  const signalSentAtMs = typeof message.sentAt === 'number' ? message.sentAt : Date.now();
  processDelayMeterAddon(flow, rawText, signalSentAtMs);
  processMissingMessagesAddon(flow);

  const p = inferPlatforms(flow);
  if (p.targetPlatform === 'signal') {
    const target = String(flow.targetChatId || '').trim();
    if (!target) return;
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    if (!rawText && !(flow.sendAttachments && hasAttachments)) return;

    let base64Attachments = [];
    if (flow.sendAttachments && hasAttachments) {
      for (const att of message.attachments) {
        if (!att.id) continue;
        try {
          const dl = await downloadSignalAttachment(att.id);
          if (dl?.ok && dl.base64) {
            const mime = String(dl.contentType || att.contentType || 'application/octet-stream').trim();
            base64Attachments.push(`data:${mime};base64,${dl.base64}`);
          }
        } catch (e) {
          pushLog('WARN', 'Signal attachment download failed', {
            attachmentId: att.id,
            error: e.message || String(e)
          });
        }
      }
    }

    await sendSignalMessage(target, rawText, base64Attachments);
    state.lastSendAt = nowIso();
    state.counters.sent += 1;
    state.counters.signalSent += 1;
    pushLog('INFO', 'Signal→Signal sent', {
      flowId: flow.id,
      targetChat: target,
      attachmentsCount: base64Attachments.length
    });
    return;
  }

  if (p.targetPlatform === 'whatsapp') {
    const target = String(flow.targetChatId || '').trim();
    if (!target) return;

    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    const canSendAttachments = flow.sendAttachments && hasAttachments;

    if (!rawText && !canSendAttachments) {
      pushLog('WARN', 'Signal→WA: повідомлення без тексту — нічого не пересилається', {
        flowId: flow.id,
        flowName: flow.name,
        hasAttachments,
        tip: hasAttachments
          ? 'Увімкніть "Пересилати зображення" в налаштуваннях автоматизації'
          : 'Повідомлення не містить тексту'
      });
      return;
    }
    if (!client || !state.ready) {
      pushLog('ERROR', 'Signal→WA: клієнт WhatsApp не готовий', { flowId: flow.id });
      return;
    }
    try {
      if (canSendAttachments) {
        // Download Signal attachments and send to WA; first attachment gets text as caption
        let captionUsed = false;
        for (const att of message.attachments) {
          if (!att.id) continue;
          try {
            const dl = await downloadSignalAttachment(att.id);
            if (dl?.ok && dl.base64) {
              const mime = String(dl.contentType || att.contentType || 'application/octet-stream').trim();
              const filename = String(att.filename || '').trim() || undefined;
              const caption = !captionUsed ? rawText : undefined;
              await sendMediaWithRateLimit(target, mime, dl.base64, filename, caption);
              captionUsed = true;
            }
          } catch (e) {
            pushLog('WARN', 'Signal→WA: не вдалося завантажити вкладення', {
              attachmentId: att.id,
              error: e.message || String(e)
            });
          }
        }
        // If all attachment downloads failed but there is text — send text only
        if (!captionUsed && rawText) {
          await sendWithRateLimit(target, rawText);
        }
      } else {
        await sendWithRateLimit(target, rawText);
      }
      pushLog('INFO', 'Signal→WA sent', {
        flowId: flow.id,
        targetChat: target,
        attachmentsCount: canSendAttachments ? message.attachments.length : 0
      });
    } catch (err) {
      if (isWaTransientDetachedFrameError(err)) {
        pushLog('ERROR', 'Signal→WA failed: detached frame, restarting WA', {
          flowId: flow.id,
          targetChat: target
        });
        handleWaDetachedFrame('Signal→WA send').catch(() => {});
      } else {
        pushLog('ERROR', 'Signal→WA failed', {
          flowId: flow.id,
          targetChat: target,
          message: err?.message || String(err)
        });
      }
    }
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
  })); // end Promise.all matchedFlows
}

async function pollSignalMessages() {
  if (!SIGNAL_API_URL) return;
  if (signalLinkInProgress) return;
  if (signalPollInFlight) return;
  signalPollInFlight = true;
  const pollStartedAt = Date.now();
  pushLogThrottled(
    'signal_poll_start',
    5000,
    'INFO',
    'Signal poll start',
    { endpoint: '/messages', sinceTs: signalLastPollTs || 0 }
  );
  // Do not hammer /messages until account is linked.
  if (state.signal.linked !== true) {
    const now = Date.now();
    if (now - signalLastLinkedProbeTs >= 5000) {
      signalLastLinkedProbeTs = now;
      await checkSignalLinkedStatus();
    }
    signalPollInFlight = false;
    return;
  }
  try {
    const msgs = await fetchSignalMessages(signalLastPollTs || 0);
    pushLogThrottled(
      'signal_poll_success',
      5000,
      'INFO',
      'Signal poll success',
      {
        endpoint: '/messages',
        count: msgs.length,
        elapsedMs: Date.now() - pollStartedAt
      }
    );
    state.signal.lastPollAt = nowIso();
    signalLastPollTs = Date.now();
    for (const m of msgs) {
      if (signalSeenMessageIds.has(m.id)) {
        pushLogThrottled(
          `signal_msg_skip_seen_${m.id}`,
          10000,
          'INFO',
          'Signal message skipped before routing',
          { reason: 'already_seen_message_id', messageId: m.id || null, chatId: m.chatId || null }
        );
        continue;
      }
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
    const ctx = error?.signalContext || {};
    pushLogThrottled(
      'signal_polling_failed',
      60000,
      'ERROR',
      'Signal polling failed',
      {
        message: error.message,
        method: ctx.method || 'GET',
        endpoint: ctx.endpoint || '/messages',
        url: ctx.url || null,
        status: ctx.status || null,
        code: ctx.code || null,
        timeoutMs: ctx.timeoutMs || null,
        elapsedMs: Date.now() - pollStartedAt
      }
    );
  } finally {
    signalPollInFlight = false;
  }
}

function startSignalWorker() {
  if (!SIGNAL_API_URL || signalPollTimer) return;
  state.signal.running = true;
  // Reset linked to null so the UI shows "checking" immediately on restart.
  state.signal.linked = null;
  state.signal.linkedAccounts = [];
  checkSignalLinkedStatus().catch(() => {});
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
    setTimeout(() => {
      prefetchChatsInBackground().catch(() => {});
    }, 400);
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

      const chatId = getChatId(msg);
      const rawText = String(msg.body || '').trim();
      chatDirectoryStore.upsertChatFromMessage({
        platform: 'whatsapp',
        chatId,
        chatCandidates: [chatId],
        chatName: null,
        senderId: msg.author || msg.from || null,
        senderName: null,
        text: rawText
      });

      let matchedWaFlows = [];
      if (flows.length > 0) {
        const routeMessage = {
          platform: 'whatsapp',
          chatId,
          chatCandidates: [chatId],
          senderId: msg.author || msg.from || null
        };
        matchedWaFlows = flows.filter((f) => {
          const p = inferPlatforms(f);
          if (p.sourcePlatform !== 'whatsapp') return false;
          return flowMatchesMessage(f, routeMessage).matched;
        });
        if (matchedWaFlows.length === 0) return;
      } else {
        if (!SOURCE_CHAT || chatId !== SOURCE_CHAT) return;
        let kwE = SOURCE_FILTER_KEYWORDS;
        let frE = SOURCE_FILTER_FREQUENCIES;
        if (
          splitFilterTokens(kwE).length === 0 &&
          splitFilterTokens(frE).length === 0
        ) {
          kwE = '*';
        }
        matchedWaFlows = [{
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
        }];
      }

      // KPI statistics count only messages that match configured source chats.
      state.counters.received += 1;
      state.counters.waReceived += 1;

      await Promise.all(matchedWaFlows.map(async (flow) => {
      if (flow.paused === true) {
        noteIgnored('wa_paused');
        pushLog('INFO', 'Автоматизація на паузі', {
          flowId: flow.id,
          name: flow.name
        });
        return;
      }

      if (!passesFlowContentFilters(flow, rawText)) {
        noteIgnored('wa_filter_miss');
        pushLog('INFO', 'Пропуск: не пройшли фільтри ключових слів / частот', {
          flowId: flow.id,
          name: flow.name
        });
        return;
      }

      state.counters.accepted += 1;

      const waSentAtMs = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
      processDelayMeterAddon(flow, rawText, waSentAtMs);
      processMissingMessagesAddon(flow);

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
      })); // end Promise.all matchedWaFlows
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
    const browserExecutable = resolveChromeExecutablePath();
    const buildPuppeteerOptions = () => ({
      headless: HEADLESS,
      timeout: WA_LAUNCH_TIMEOUT_MS,
      protocolTimeout: WA_PROTOCOL_TIMEOUT_MS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    let puppeteerOptions = buildPuppeteerOptions();
    if (browserExecutable) {
      puppeteerOptions.executablePath = browserExecutable;
      pushLog('INFO', 'Using system browser for Puppeteer', { executablePath: browserExecutable });
    } else {
      pushLog('WARN', 'System browser not found, using bundled Chromium');
    }

    const makeClient = (options) =>
      new Client({
        authStrategy: new LocalAuth(),
        puppeteer: options
      });

    client = makeClient(puppeteerOptions);
    attachClientEvents(client);
    await cleanupChromeLocks();
    try {
      await client.initialize();
    } catch (firstErr) {
      const msg = String(firstErr?.message || '');
      const isNavigateTimeout =
        msg.includes('Page.navigate timed out') || msg.includes('protocolTimeout');
      if (!isNavigateTimeout) throw firstErr;
      pushLog('WARN', 'WA init timeout, retrying once with larger timeouts', {
        message: firstErr.message
      });
      try { await client.destroy(); } catch {}
      client = null;
      await cleanupChromeLocks(); // ensure Chrome is dead before retry
      puppeteerOptions = {
        ...buildPuppeteerOptions(),
        timeout: WA_LAUNCH_TIMEOUT_MS * 2,
        protocolTimeout: WA_PROTOCOL_TIMEOUT_MS * 2
      };
      if (browserExecutable) puppeteerOptions.executablePath = browserExecutable;
      client = makeClient(puppeteerOptions);
      attachClientEvents(client);
      await client.initialize();
    }
    startSignalWorker();

    pushLog('INFO', 'Bot initialize requested', { headless: HEADLESS });
    return { ok: true, message: 'Bot started' };
  } catch (error) {
    pushLog('ERROR', 'Failed to start bot', {
      message: error.message,
      stack: error.stack
    });

    if (client) { try { await client.destroy(); } catch {} }
    await cleanupChromeLocks(); // kill Chrome left behind by failed initialize
    client = null;
    setStatus('error');
    return { ok: false, message: error.message };
  } finally {
    isStarting = false;
  }
}

let waDetachedRecoveryScheduled = false;
async function handleWaDetachedFrame(source) {
  if (waDetachedRecoveryScheduled) return;
  waDetachedRecoveryScheduled = true;
  pushLog('WARN', 'WA detached frame — scheduling restart', { source });
  state.ready = false;
  setStatus('disconnected');
  try { await client.destroy(); } catch {}
  client = null;
  setTimeout(() => {
    waDetachedRecoveryScheduled = false;
    startBot().catch((e) =>
      pushLog('ERROR', 'WA restart after detached frame failed', { message: e?.message || String(e) })
    );
  }, 3000);
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
  } catch (logoutErr) {
    pushLog('WARN', 'client.logout() threw (likely detached frame), forcing destroy', {
      message: logoutErr.message
    });
  }

  // Always destroy the client and clean up state, regardless of logout success
  try { await client.destroy(); } catch {}
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

async function changeWaAccount() {
  try {
    if (client) {
      await stopBot();
    }

    deleteDirIfExists(AUTH_DIR);
    deleteDirIfExists(CACHE_DIR);

    const deleteFileIfExists = (filePath) => {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    };
    deleteFileIfExists(WHATSAPP_CHATS_CACHE_FILE);

    // Clear WA entries from chat-directory
    const dir = chatDirectoryStore.loadChatDirectory();
    const filtered = dir.filter((e) => e.platform !== 'whatsapp');
    if (filtered.length !== dir.length) {
      chatDirectoryStore.saveChatDirectory(filtered);
    }

    // Mark affected flows
    let flowsChanged = false;
    flows = flows.map((f) => {
      if (f.sourcePlatform === 'whatsapp' || f.targetPlatform === 'whatsapp') {
        flowsChanged = true;
        return { ...f, needsWaReconfigure: true };
      }
      return f;
    });
    if (flowsChanged) {
      saveFlowsToDisk(flows);
      broadcastEvent('state', getPublicState());
    }

    setStatus('logged_out');
    pushLog('INFO', 'WhatsApp account change: auth/cache cleared, affected flows flagged');
    return { ok: true, message: 'Акаунт WhatsApp скинуто. Відскануйте QR для нового акаунта.' };
  } catch (error) {
    pushLog('ERROR', 'changeWaAccount failed', { message: error.message });
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

app.post('/api/wa/change-account', async (req, res) => {
  res.json(await changeWaAccount());
});

app.post('/api/signal/start', async (req, res) => {
  try {
    if (!SIGNAL_API_URL) {
      return res.json({ ok: false, message: 'SIGNAL_API_URL not configured' });
    }
    stopSignalWorker(); // ensure clean state before starting
    startSignalWorker();
    pushLog('INFO', 'Signal worker restarted via API');
    res.json({ ok: true, message: 'Signal worker started' });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || String(error) });
  }
});

app.post('/api/signal/logout', async (req, res) => {
  try {
    stopSignalWorker();
    state.signal.linked = false;
    state.signal.linkedAccounts = [];
    state.signal.qrDataUrl = null;
    broadcastEvent('state', getPublicState());
    pushLog('INFO', 'Signal disconnected from service (worker stopped)');
    res.json({ ok: true, message: 'Signal disconnected' });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || String(error) });
  }
});

app.post('/api/signal/link', async (req, res) => {
  if (signalLinkInProgress) {
    return res.status(409).json({
      ok: false,
      message: 'Генерація QR вже виконується. Дочекайтесь завершення поточного запиту.'
    });
  }
  try {
    const deviceName = String(req.body?.name || 'wa-bridge').trim();
    signalLinkInProgress = true;
    const out = await requestSignalLinkQr(deviceName, { auto: false });
    res.json(out);
  } catch (error) {
    state.signal.lastLinkErrorAt = nowIso();
    state.signal.lastLinkError = error.message || String(error);
    pushLog('ERROR', 'Signal link request failed', { message: error.message || String(error) });
    res.status(500).json({ ok: false, message: error.message || String(error) });
  } finally {
    signalLinkInProgress = false;
  }
});

app.get('/api/signal/linked-check', async (_req, res) => {
  try {
    if (signalLinkInProgress) {
      return res.json({ ok: true, busy: true, signal: state.signal, result: null });
    }
    const result = await checkSignalLinkedStatus();
    return res.json({ ok: true, signal: state.signal, result });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || String(error) });
  }
});

/**
 * Force-refresh Signal chats from bridge, upsert each into chatDirectory,
 * then return directory-backed list for UI (no direct cache rendering).
 */
app.get('/api/signal/chats/refresh', async (req, res) => {
  if (!SIGNAL_API_URL) return res.json({ ok: true, chats: [], refreshed: false });
  try {
    await fetchSignalChats(); // also upserts into directory + dedups
    const maxEntries = 10000;
    const decodeBase64Utf8 = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const txt = Buffer.from(padded, 'base64').toString('utf8').trim();
        if (!txt) return '';
        // Reject clearly binary garbage.
        if (/[\u0000-\u0008\u000E-\u001F]/.test(txt)) return '';
        return txt;
      } catch {
        return '';
      }
    };
    const buildSignalIdKeys = (id) => {
      const out = new Set();
      const add = (v) => {
        const s = String(v || '').trim();
        if (!s) return;
        out.add(s);
        out.add(s.toLowerCase());
      };
      const raw = String(id || '').trim();
      if (!raw) return out;
      add(raw);
      add(normalizeChatId(raw) || '');
      const low = raw.toLowerCase();
      if (low.startsWith('group.')) {
        const payload = raw.slice('group.'.length).trim();
        if (payload) add(payload);
      } else {
        add(`group.${raw}`);
      }
      return out;
    };
    const signalCacheRows = loadMessengerChatsCache('signal')
      .map((c) => ({
        id: String(c?.id || '').trim(),
        normId: String(normalizeChatId(String(c?.id || '').trim()) || '').trim(),
        name: String(c?.name || '').trim()
      }))
      .filter((x) => x.id);
    const cacheSignalByKey = new Map();
    for (const row of signalCacheRows) {
      for (const k of buildSignalIdKeys(row.id)) {
        const kk = String(k || '').trim().toLowerCase();
        if (!kk || cacheSignalByKey.has(kk)) continue;
        cacheSignalByKey.set(kk, row);
      }
      if (row.normId) {
        const nk = String(row.normId || '').trim().toLowerCase();
        if (nk && !cacheSignalByKey.has(nk)) cacheSignalByKey.set(nk, row);
      }
    }
    function resolveCacheMatchForEntry(entry) {
      const aliases = Array.isArray(entry?.aliases) ? entry.aliases : [];
      const addAliasVariants = (value, outSet) => {
        const raw = String(value || '').trim();
        if (!raw) return;
        outSet.add(raw);
        const norm = String(normalizeChatId(raw) || '').trim();
        if (norm) outSet.add(norm);
        if (raw.startsWith('group.')) outSet.add(raw.slice(6));
        if (norm.startsWith('group.')) outSet.add(norm.slice(6));
        if (!raw.startsWith('group.')) outSet.add('group.' + raw);
        if (norm && !norm.startsWith('group.')) outSet.add('group.' + norm);
      };
      const tryResolve = (k) => {
        const key = String(k || '').trim();
        if (!key) return null;
        const byAny = cacheSignalByKey.get(key.toLowerCase());
        if (byAny) return { id: byAny.id, name: byAny.name };
        return null;
      };
      for (const a of aliases) {
        const variants = new Set();
        addAliasVariants(a, variants);
        for (const v of variants) {
          const match = tryResolve(v);
          if (match) return match;
        }
      }
      // Fallback for Signal only: if alias chain failed, try unique human-name match in cache.
      // Still uses signal-chats-cache as source of truth for canonical chat id.
      const nameCandidates = [
        String(entry?.manualLabel || '').trim(),
        String(entry?.displayName || '').trim(),
        String(chatDirectoryStore.resolvePanelResolvedName(entry) || '').trim()
      ].filter(Boolean);
      for (const n of nameCandidates) {
        const needle = n.toLowerCase();
        if (!needle) continue;
        const byName = signalCacheRows.filter((r) => String(r?.name || '').trim().toLowerCase() === needle);
        if (byName.length === 1) {
          return { id: byName[0].id, name: byName[0].name };
        }
      }
      return { id: '', name: '' };
    }
    const entries = chatDirectoryStore.listAllChatsSortedByLastSeen('signal', maxEntries);
    const chats = entries.map((entry) => {
      const cacheMatch = resolveCacheMatchForEntry(entry);
      return {
        chatKey: String(entry.chatKey || '').trim(),
        // For Signal, source of truth for chatId is messenger cache match only.
        // Never fallback to chat-directory aliases[0], because it may contain non-canonical IDs.
        chatId: String(cacheMatch.id || '').trim() || null,
        platform: String(entry.platform || '').trim(),
        chatType: entry.chatType === 'direct' ? 'direct' : 'group',
        displayName: String(entry.displayName || '').trim(),
        manualLabel: String(entry.manualLabel || '').trim(),
        resolvedName: chatDirectoryStore.resolvePanelResolvedName(entry),
        name: String(cacheMatch.name || '').trim(),
        lastSeenAt: entry.lastSeenAt || null,
        lastMessagePreview: String(entry.lastMessagePreview || '').trim()
      };
    });
    console.log(`[API] /api/signal/chats/refresh count=${chats.length}`);
    return res.json({ ok: true, refreshed: true, chats });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || String(error) });
  }
});

app.get('/api/chats', async (req, res) => {
  const useLive = String(req.query.live || '').trim() === '1';

  if (useLive) {
    const platform = String(req.query.platform || 'whatsapp').trim();
    if (platform !== 'whatsapp') {
      if (platform === 'signal') {
        if (!SIGNAL_API_URL) return res.json({ ok: true, chats: [] });
        try {
          const onlyGroups = String(req.query.only_groups ?? '1') !== '0';
          const list = await fetchSignalChats();
          const chats = onlyGroups
            ? list.filter((c) => looksLikeSignalGroupId(c.id))
            : list;
          return res.json({ ok: true, chats });
        } catch (error) {
          return res.status(500).json({ ok: false, message: error.message });
        }
      }
      return res.json({ ok: true, chats: [] });
    }
    if (!client || !state.ready) {
      return res
        .status(503)
        .json({ ok: false, message: 'Клієнт WhatsApp не готовий. Спочатку увійдіть через QR.' });
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
      upsertChatDirectory('whatsapp', list);
      return res.json({ ok: true, chats: list });
    } catch (error) {
      return res.status(500).json({ ok: false, message: error.message });
    }
  }

  const rawPlat = req.query.platform;
  const platformFilter =
    rawPlat === undefined || rawPlat === null || String(rawPlat).trim() === ''
      ? ''
      : String(rawPlat).trim();
  if (platformFilter && !['whatsapp', 'signal'].includes(platformFilter)) {
    return res.status(400).json({
      ok: false,
      message: 'platform must be "signal", "whatsapp", or omitted (all chats from directory)'
    });
  }

  const rawLimit = req.query.limit;
  let maxEntries = 10000;
  if (rawLimit !== undefined && rawLimit !== null && String(rawLimit).trim() !== '') {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ ok: false, message: 'limit must be a positive number' });
    }
    maxEntries = Math.min(10000, Math.floor(n));
  }

  // Resolve human names from messenger caches into directory rows for UI labels.
  const decodeBase64Utf8 = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const txt = Buffer.from(padded, 'base64').toString('utf8').trim();
      if (!txt) return '';
      if (/[\u0000-\u0008\u000E-\u001F]/.test(txt)) return '';
      return txt;
    } catch {
      return '';
    }
  };
  const buildSignalIdKeys = (id) => {
    const out = new Set();
    const add = (v) => {
      const s = String(v || '').trim();
      if (!s) return;
      out.add(s);
      out.add(s.toLowerCase());
    };
    const raw = String(id || '').trim();
    if (!raw) return out;
    add(raw);
    add(normalizeChatId(raw) || '');
    const low = raw.toLowerCase();
    if (low.startsWith('group.')) {
      const payload = raw.slice('group.'.length).trim();
      if (payload) add(payload);
    } else {
      add(`group.${raw}`);
    }
    return out;
  };
  const signalCacheRows = loadMessengerChatsCache('signal')
    .map((c) => ({
      id: String(c?.id || '').trim(),
      normId: String(normalizeChatId(String(c?.id || '').trim()) || '').trim(),
      name: String(c?.name || '').trim()
    }))
    .filter((x) => x.id);
  const cacheSignalByKey = new Map();
  for (const row of signalCacheRows) {
    for (const k of buildSignalIdKeys(row.id)) {
      const kk = String(k || '').trim().toLowerCase();
      if (!kk || cacheSignalByKey.has(kk)) continue;
      cacheSignalByKey.set(kk, row);
    }
    if (row.normId) {
      const nk = String(row.normId || '').trim().toLowerCase();
      if (nk && !cacheSignalByKey.has(nk)) cacheSignalByKey.set(nk, row);
    }
  }
  const cacheWhatsapp = new Map(
    loadMessengerChatsCache('whatsapp')
      .map((c) => [String(c?.id || '').trim(), String(c?.name || '').trim()])
      .filter((x) => x[0])
  );

  function resolveCacheMatchForEntry(entry) {
    const e = entry || {};
    const platform = String(e?.platform || '').trim();
    const cache = platform === 'whatsapp' ? cacheWhatsapp : null;
    if (!cache && platform !== 'signal') return { id: '', name: '' };
    const aliases = Array.isArray(e?.aliases) ? e.aliases : [];
    const addAliasVariants = (value, outSet) => {
      const raw = String(value || '').trim();
      if (!raw) return;
      outSet.add(raw);
      const norm = String(normalizeChatId(raw) || '').trim();
      if (norm) outSet.add(norm);
      if (raw.startsWith('group.')) outSet.add(raw.slice(6));
      if (norm.startsWith('group.')) outSet.add(norm.slice(6));
      if (!raw.startsWith('group.')) outSet.add('group.' + raw);
      if (norm && !norm.startsWith('group.')) outSet.add('group.' + norm);
    };

    function tryResolveFromKey(key) {
      const k = String(key || '').trim();
      if (!k) return null;
      if (platform === 'signal') {
        const byAny = cacheSignalByKey.get(k.toLowerCase());
        if (byAny) return { id: byAny.id, name: byAny.name };
        return null;
      }
      const n = cache.get(k) || '';
      if (!n) return null;
      return { id: k, name: n };
    }

    for (const a of aliases) {
      const variants = new Set();
      addAliasVariants(a, variants);
      for (const v of variants) {
        const match = tryResolveFromKey(v);
        if (match) return match;
      }
    }
    if (platform === 'signal') {
      // Fallback for Signal only: unique exact name match in cache.
      // Canonical id still comes from signal-chats-cache.json.
      const nameCandidates = [
        String(e?.manualLabel || '').trim(),
        String(e?.displayName || '').trim(),
        String(chatDirectoryStore.resolvePanelResolvedName(e) || '').trim()
      ].filter(Boolean);
      for (const n of nameCandidates) {
        const needle = n.toLowerCase();
        if (!needle) continue;
        const byName = signalCacheRows.filter((r) => String(r?.name || '').trim().toLowerCase() === needle);
        if (byName.length === 1) {
          return { id: byName[0].id, name: byName[0].name };
        }
      }
    }
    return { id: '', name: '' };
  }

  const entries = chatDirectoryStore.listAllChatsSortedByLastSeen(platformFilter, maxEntries);
  const chats = entries.map((entry) => {
    const cacheMatch = resolveCacheMatchForEntry(entry);
    const rowPlatform = String(entry.platform || '').trim();
    const chatId =
      rowPlatform === 'signal'
        ? String(cacheMatch.id || '').trim() || null
        : String(cacheMatch.id || '').trim() || String(entry.aliases?.[0] || '').trim() || null;
    return {
      chatKey: String(entry.chatKey || '').trim(),
      // For Signal, return only canonical id resolved from signal-chats-cache.
      // If unresolved, return null (UI should ask user to refresh), never aliases[0].
      chatId,
      platform: String(entry.platform || '').trim(),
      chatType: entry.chatType === 'direct' ? 'direct' : 'group',
      displayName: String(entry.displayName || '').trim(),
      manualLabel: String(entry.manualLabel || '').trim(),
      resolvedName: chatDirectoryStore.resolvePanelResolvedName(entry),
      // Human label from messenger cache (Signal contacts/groups list).
      name: String(cacheMatch.name || '').trim(),
      lastSeenAt: entry.lastSeenAt || null,
      lastMessagePreview: String(entry.lastMessagePreview || '').trim()
    };
  });

  const logPlatform = platformFilter || 'all';
  console.log(`[API] /api/chats platform=${logPlatform} count=${chats.length}`);
  return res.json({ ok: true, chats });
});

/**
 * Debug resolver for Signal chat-id mapping:
 * shows how chat-directory aliases are normalized and matched to signal cache ids.
 */
app.get('/api/chats/debug-resolve', (req, res) => {
  const platform = String(req.query.platform || '').trim();
  const chatKey = String(req.query.chatKey || '').trim();
  if (platform !== 'signal') {
    return res.status(400).json({ ok: false, message: 'platform must be "signal"' });
  }
  if (!chatKey) {
    return res.status(400).json({ ok: false, message: 'chatKey is required' });
  }
  const entry = chatDirectoryStore.getChatByKey(chatKey);
  if (!entry) {
    return res.status(404).json({ ok: false, message: 'Chat not found in chat-directory' });
  }

  const decodeBase64Utf8 = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const txt = Buffer.from(padded, 'base64').toString('utf8').trim();
      if (!txt) return '';
      if (/[\u0000-\u0008\u000E-\u001F]/.test(txt)) return '';
      return txt;
    } catch {
      return '';
    }
  };
  const buildSignalIdKeys = (id) => {
    const out = new Set();
    const add = (v) => {
      const s = String(v || '').trim();
      if (!s) return;
      out.add(s);
      out.add(s.toLowerCase());
    };
    const raw = String(id || '').trim();
    if (!raw) return out;
    add(raw);
    add(normalizeChatId(raw) || '');
    const low = raw.toLowerCase();
    if (low.startsWith('group.')) {
      const payload = raw.slice('group.'.length).trim();
      if (payload) add(payload);
    } else {
      add(`group.${raw}`);
    }
    return Array.from(out);
  };

  const signalCacheRows = loadMessengerChatsCache('signal')
    .map((c) => ({
      id: String(c?.id || '').trim(),
      name: String(c?.name || '').trim(),
      keys: buildSignalIdKeys(String(c?.id || '').trim())
    }))
    .filter((x) => x.id);

  const aliasKeys = new Set();
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  for (const a of aliases) {
    for (const k of buildSignalIdKeys(a)) aliasKeys.add(String(k || '').trim().toLowerCase());
  }
  const aliasKeyList = Array.from(aliasKeys).filter(Boolean);

  const matchedById = signalCacheRows.filter((row) =>
    row.keys.some((k) => aliasKeys.has(String(k || '').trim().toLowerCase()))
  );

  const nameCandidates = [
    String(entry.manualLabel || '').trim(),
    String(entry.displayName || '').trim(),
    String(chatDirectoryStore.resolvePanelResolvedName(entry) || '').trim()
  ].filter(Boolean);
  let matchedByName = [];
  for (const n of nameCandidates) {
    const needle = n.toLowerCase();
    const found = signalCacheRows.filter((r) => String(r.name || '').trim().toLowerCase() === needle);
    if (found.length) {
      matchedByName = found;
      break;
    }
  }

  return res.json({
    ok: true,
    entry: {
      chatKey: String(entry.chatKey || '').trim(),
      displayName: String(entry.displayName || '').trim(),
      manualLabel: String(entry.manualLabel || '').trim(),
      resolvedName: String(chatDirectoryStore.resolvePanelResolvedName(entry) || '').trim(),
      aliases
    },
    debug: {
      aliasKeys: aliasKeyList,
      matchedByIdCount: matchedById.length,
      matchedById: matchedById.slice(0, 20).map((x) => ({ id: x.id, name: x.name })),
      matchedByNameCount: matchedByName.length,
      matchedByName: matchedByName.slice(0, 20).map((x) => ({ id: x.id, name: x.name })),
      signalCacheCount: signalCacheRows.length
    }
  });
});

app.get('/api/messenger-chats', async (req, res) => {
  const platform = String(req.query.platform || '').trim();
  if (!['signal', 'whatsapp'].includes(platform)) {
    return res.status(400).json({ ok: false, message: 'platform must be "signal" or "whatsapp"' });
  }
  const onlyGroups = String(req.query.only_groups ?? '1') !== '0';
  const refresh = String(req.query.refresh || '').trim() === '1';
  try {
    const cached = readMessengerChatsCache(platform);
    let chats = cached.chats || [];
    const cachedUpdatedAt = cached.updatedAt;
    const stale = !isCacheFresh(cachedUpdatedAt);
    const shouldRefresh = refresh || stale;

    if (refresh) {
      console.log(`[CACHE] messenger-chats forced refresh platform=${platform}`);
    } else if (stale) {
      console.log(
        `[CACHE] messenger-chats cache expired platform=${platform} ageMs=${cacheAgeMs(cachedUpdatedAt)} ttlMs=${MESSENGER_CHATS_CACHE_TTL_MS}`
      );
    } else {
      console.log(
        `[CACHE] messenger-chats cache hit platform=${platform} ageMs=${cacheAgeMs(cachedUpdatedAt)} ttlMs=${MESSENGER_CHATS_CACHE_TTL_MS}`
      );
    }

    let stats = { added: 0, updated: 0, total: chats.length };

    // When the user didn't explicitly request a refresh and we have cached data,
    // serve it immediately (even if stale) so the UI never blocks on a live fetch.
    // Explicit ?refresh=1 (Оновити button) still triggers a full live fetch.
    const serveStaleCache = !refresh && stale && chats.length > 0;
    if (serveStaleCache) {
      const out = applyOnlyGroupsToLiveChats(platform, chats, onlyGroups);
      console.log(
        `[CACHE] messenger-chats serving stale cache immediately (background refresh skipped) platform=${platform} ageMs=${cacheAgeMs(cachedUpdatedAt)}`
      );
      return res.json({
        ok: true,
        chats: out,
        source: 'cache',
        refreshed: false,
        cache: { updatedAt: cachedUpdatedAt, ttlMs: MESSENGER_CHATS_CACHE_TTL_MS, stale: true },
        stats
      });
    }

    if (shouldRefresh) {
      if (platform === 'signal') {
        if (!SIGNAL_API_URL) {
          // Cannot refresh; serve whatever cache we have without breaking UI.
          const out = applyOnlyGroupsToLiveChats(platform, chats, onlyGroups);
          return res.json({
            ok: true,
            chats: out,
            source: 'cache',
            refreshed: false,
            cache: { updatedAt: cachedUpdatedAt, ttlMs: MESSENGER_CHATS_CACHE_TTL_MS, stale },
            stats
          });
        }
        const before = new Map(chats.map((c) => [String(c.id || '').trim(), String(c.name || '').trim()]).filter((x) => x[0]));
        let fresh;
        try {
          fresh = await fetchSignalChats();
        } catch (err) {
          // Signal bridge is temporarily unavailable; serve cache instead of breaking UI.
          const out = applyOnlyGroupsToLiveChats(platform, chats, onlyGroups);
          const warn = err?.message || String(err);
          console.warn('[CACHE] messenger-chats signal refresh failed; serving cache', { message: warn });
          return res.json({
            ok: true,
            message: warn,
            chats: out,
            source: 'cache',
            refreshed: false,
            cache: { updatedAt: cachedUpdatedAt, ttlMs: MESSENGER_CHATS_CACHE_TTL_MS, stale },
            stats
          });
        }
        const after = new Map(fresh.map((c) => [String(c.id || '').trim(), String(c.name || '').trim()]).filter((x) => x[0]));
        let added = 0;
        let updated = 0;
        for (const [id, name] of after.entries()) {
          if (!before.has(id)) added += 1;
          else if (String(before.get(id) || '').trim() !== String(name || '').trim()) updated += 1;
        }
        chats = fresh;
        stats = { added, updated, total: fresh.length };
      } else {
        if (!client || !state.ready) {
          // Cannot refresh; serve cache if any, without breaking UI.
          const out = applyOnlyGroupsToLiveChats(platform, chats, onlyGroups);
          return res.status(chats.length > 0 ? 200 : 503).json({
            ok: chats.length > 0,
            message: chats.length > 0 ? undefined : 'Клієнт WhatsApp не готовий. Спочатку увійдіть через QR.',
            chats: out,
            source: 'cache',
            refreshed: false,
            cache: { updatedAt: cachedUpdatedAt, ttlMs: MESSENGER_CHATS_CACHE_TTL_MS, stale },
            stats
          });
        }
        const before = new Map(chats.map((c) => [String(c.id || '').trim(), String(c.name || '').trim()]).filter((x) => x[0]));
        let waChats;
        try {
          waChats = await client.getChats();
        } catch (err) {
          // WhatsApp Web sometimes reloads; serve cache instead of breaking UI.
          const out = applyOnlyGroupsToLiveChats(platform, chats, onlyGroups);
          const warn = isWaTransientDetachedFrameError(err)
            ? 'WhatsApp Web перезапускається (detached frame). Спробуйте «Оновити» ще раз через кілька секунд.'
            : (err?.message || String(err));
          console.warn('[CACHE] messenger-chats whatsapp refresh failed; serving cache', { message: warn });
          return res.json({
            ok: true,
            message: warn,
            chats: out,
            source: 'cache',
            refreshed: false,
            cache: { updatedAt: cachedUpdatedAt, ttlMs: MESSENGER_CHATS_CACHE_TTL_MS, stale },
            stats
          });
        }
        const fresh = waChats
          .map((c) => ({
            id: c.id._serialized,
            name: (c.name && String(c.name).trim()) || c.id.user || c.id._serialized
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
        const after = new Map(fresh.map((c) => [String(c.id || '').trim(), String(c.name || '').trim()]).filter((x) => x[0]));
        let added = 0;
        let updated = 0;
        for (const [id, name] of after.entries()) {
          if (!before.has(id)) added += 1;
          else if (String(before.get(id) || '').trim() !== String(name || '').trim()) updated += 1;
        }
        chats = fresh;
        stats = { added, updated, total: fresh.length };
        upsertChatDirectory('whatsapp', fresh);
      }
      saveMessengerChatsCache(platform, chats);
      console.log(
        `[CACHE] messenger-chats refreshed platform=${platform} total=${stats.total} added=${stats.added} updated=${stats.updated}`
      );
    }
    const out = applyOnlyGroupsToLiveChats(platform, chats, onlyGroups);
    return res.json({
      ok: true,
      chats: out,
      source: 'cache',
      refreshed: refresh,
      cache: {
        updatedAt: (shouldRefresh ? nowIso() : cachedUpdatedAt) || null,
        ttlMs: MESSENGER_CHATS_CACHE_TTL_MS,
        stale: !isCacheFresh(cachedUpdatedAt)
      },
      stats
    });
  } catch (error) {
    // Last-resort: do not kill UI if we have cached WA chats.
    try {
      if (String(req.query.platform || '').trim() === 'whatsapp') {
        const cached = readMessengerChatsCache('whatsapp');
        const chats = cached.chats || [];
        if (chats.length > 0 && isWaTransientDetachedFrameError(error)) {
          const out = applyOnlyGroupsToLiveChats('whatsapp', chats, String(req.query.only_groups ?? '1') !== '0');
          const warn =
            'WhatsApp Web перезапускається (detached frame). Показую останній кеш; натисніть «Оновити» пізніше.';
          console.warn('[CACHE] messenger-chats transient failure; serving cache', { message: warn });
          return res.json({
            ok: true,
            message: warn,
            chats: out,
            source: 'cache',
            refreshed: false,
            cache: { updatedAt: cached.updatedAt, ttlMs: MESSENGER_CHATS_CACHE_TTL_MS, stale: !isCacheFresh(cached.updatedAt) },
            stats: { total: chats.length, added: 0, updated: 0 }
          });
        }
      }
    } catch {
      /* ignore */
    }
    return res.status(500).json({ ok: false, message: error.message || String(error) });
  }
});

app.get('/api/chat-directory/recent', (req, res) => {
  const platform = String(req.query.platform || '').trim();
  const includeAliases = String(req.query.debug || '0').trim() === '1';
  const allowed = ['whatsapp', 'signal'];
  if (platform && !allowed.includes(platform)) {
    return res.status(400).json({ ok: false, message: 'Unsupported platform' });
  }
  const lim = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const list = chatDirectoryStore.listRecentChats(platform || '', lim);
  const chats = list.map((entry) => {
    const safe = {
      chatKey: String(entry.chatKey || '').trim(),
      platform: String(entry.platform || '').trim(),
      chatType: entry.chatType === 'direct' ? 'direct' : 'group',
      displayName: String(entry.displayName || '').trim(),
      manualLabel: String(entry.manualLabel || '').trim(),
      lastSeenAt: entry.lastSeenAt || null,
      lastMessagePreview: String(entry.lastMessagePreview || '').trim()
    };
    if (includeAliases) {
      safe.aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    }
    return safe;
  });
  return res.json({ ok: true, chats });
});

app.get('/api/chat-directory/resolve-source', (req, res) => {
  const flowId = String(req.query.flowId || '').trim();
  if (!flowId) return res.status(400).json({ ok: false, message: 'flowId required' });
  const f = flows.find((x) => x.id === flowId);
  if (!f) return res.status(404).json({ ok: false, message: 'Flow not found' });
  const p = inferPlatforms(f);
  if (p.sourcePlatform !== 'signal') return res.json({ ok: true, chatKey: null });
  const existing = String(f.sourceChatKey || '').trim();
  if (existing) {
    return res.json({
      ok: true,
      chatKey: existing,
      displayName: String(f.sourceChatRefs?.[0]?.name || '').trim() || null
    });
  }
  const key = resolveSignalSourceChatKeyFromFlowAliases(f);
  if (!key) return res.json({ ok: true, chatKey: null });
  const entry = chatDirectoryStore.getChatByKey(key);
  return res.json({
    ok: true,
    chatKey: key,
    displayName: entry
      ? String(entry.manualLabel || entry.displayName || '').trim() || null
      : null
  });
});

// ── Admin: remove alias pollution from a group chat directory entry ────────
// POST /api/admin/chat-directory/:key/clean-group-aliases
// Strips every alias that is NOT a group. or signal-group: prefixed ID.
// Use this to clean up entries that accumulated phone numbers / UUIDs of group
// members, which causes personal messages to be mis-routed as group messages.
app.post('/api/admin/chat-directory/:key/clean-group-aliases', (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, message: 'chatKey required' });
  const entry = chatDirectoryStore.getChatByKey(key);
  if (!entry) return res.status(404).json({ ok: false, message: 'Chat entry not found' });
  if (String(entry.chatType || '') !== 'group') {
    return res.status(400).json({ ok: false, message: `Entry ${key} is chatType:${entry.chatType || 'unknown'}, not group` });
  }
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  const toRemove = aliases.filter((a) => {
    const s = String(a || '').trim().toLowerCase();
    return !s.startsWith('group.') && !s.startsWith('signal-group:');
  });
  if (toRemove.length === 0) {
    return res.json({ ok: true, removed: [], total: aliases.length, message: 'Already clean — no non-group aliases found' });
  }
  chatDirectoryStore.removeAliasesFromChat(key, toRemove);
  return res.json({ ok: true, removed: toRemove, remaining: aliases.length - toRemove.length, message: `Removed ${toRemove.length} non-group alias(es)` });
});
// ───────────────────────────────────────────────────────────────────────────

// POST /api/admin/chat-directory/:key/remove-aliases
// Body: { aliases: ["alias1", "alias2", ...] }
// Removes specific aliases from any chatKey (group or direct).
app.post('/api/admin/chat-directory/:key/remove-aliases', (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, message: 'chatKey required' });
  const entry = chatDirectoryStore.getChatByKey(key);
  if (!entry) return res.status(404).json({ ok: false, message: 'Chat entry not found' });
  const toRemove = Array.isArray(req.body?.aliases)
    ? req.body.aliases.map((a) => String(a || '').trim()).filter(Boolean)
    : [];
  if (toRemove.length === 0) return res.status(400).json({ ok: false, message: 'aliases array required in body' });
  chatDirectoryStore.removeAliasesFromChat(key, toRemove);
  const updated = chatDirectoryStore.getChatByKey(key);
  return res.json({ ok: true, removed: toRemove, remaining: (updated?.aliases || []).length });
});

// POST /api/admin/chat-directory/:key/set-label
// Body: { label: "New Name" }
// Force-sets manualLabel on a chatKey (bypasses the "empty-only" restriction).
app.post('/api/admin/chat-directory/:key/set-label', (req, res) => {
  const key = String(req.params.key || '').trim();
  const label = String(req.body?.label || '').trim();
  if (!key) return res.status(400).json({ ok: false, message: 'chatKey required' });
  if (!label) return res.status(400).json({ ok: false, message: 'label required in body' });
  const directory = chatDirectoryStore.loadChatDirectory();
  const entry = directory.find((e) => String(e.chatKey) === key);
  if (!entry) return res.status(404).json({ ok: false, message: 'Chat entry not found' });
  entry.manualLabel = label;
  chatDirectoryStore.saveChatDirectory(directory);
  return res.json({ ok: true, chatKey: key, manualLabel: label });
});
// ───────────────────────────────────────────────────────────────────────────

app.get('/api/flows', (req, res) => {
  res.json({ ok: true, flows });
});

app.post('/api/flows', (req, res) => {
  const body = req.body || {};
  console.log('[API /api/flows body]', JSON.stringify(body, null, 2));
  const normalized = normalizeAutomation(body);
  const err = validateAutomation(normalized, flows, null);
  if (err) {
    return res.status(400).json({ ok: false, message: err });
  }
  applyFlowManualLabelsToDirectory(normalized);
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
  const body = req.body || {};
  console.log('[API /api/flows body]', JSON.stringify(body, null, 2));
  const normalized = normalizeAutomation({ ...flows[idx], ...body }, req.params.id);
  const err = validateAutomation(normalized, flows, req.params.id);
  if (err) {
    return res.status(400).json({ ok: false, message: err });
  }
  applyFlowManualLabelsToDirectory(normalized);
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

async function prefetchChatsInBackground() {
  try {
    if (SIGNAL_API_URL) {
      const signalList = await fetchSignalChats();
      saveMessengerChatsCache('signal', signalList);
      enrichFlowRefsFromDirectory();
      if (AUTO_SIGNAL_SOURCE_AUTOREMAP) {
        autoRemapSignalFlowsFromDirectory(true);
      }
      pushLogThrottled(
        'signal_chats_prefetched',
        120000,
        'INFO',
        'Signal chats prefetched in background',
        { count: signalList.length }
      );
    }
  } catch (e) {
    pushLogThrottled(
      'signal_chats_prefetch_failed',
      120000,
      'WARN',
      'Signal chats prefetch failed',
      { message: e.message || String(e) }
    );
  }
  try {
    if (client && state.ready) {
      const chats = await client.getChats();
      const list = chats
        .map((c) => ({
          id: c.id._serialized,
          name: (c.name && String(c.name).trim()) || c.id.user || c.id._serialized
        }))
        .filter((x) => x.id && x.name);
      upsertChatDirectory('whatsapp', list);
      saveMessengerChatsCache('whatsapp', list);
      enrichFlowRefsFromDirectory();
      pushLogThrottled(
        'wa_chats_prefetched',
        120000,
        'INFO',
        'WhatsApp chats prefetched in background',
        { count: list.length }
      );
    }
  } catch (e) {
    pushLogThrottled(
      'wa_chats_prefetch_failed',
      120000,
      'WARN',
      'WhatsApp chats prefetch failed',
      { message: e.message || String(e) }
    );
  }
}

async function startupAutoInit() {
  if (!AUTO_START_BOT_ON_SERVICE_START) {
    pushLog('INFO', 'Auto-start disabled by AUTO_START_BOT_ON_SERVICE_START=0');
    return;
  }
  const started = await startBot();
  if (!started.ok) {
    pushLog('ERROR', 'Auto-start failed', { message: started.message || 'unknown error' });
    return;
  }
  if (!SIGNAL_API_URL) {
    prefetchChatsInBackground().catch(() => {});
    return;
  }
  // Quick startup check — just 2 fast probes, then hand off to the worker's own polling.
  // The worker (startSignalWorker) is already running and will keep checking every 5 s.
  // Heavy blocking retries here cause 5+ minute stalls when signal-cli is slow to warm up.
  for (let i = 0; i < 2; i += 1) {
    try {
      const linkedStatus = await checkSignalLinkedStatus();
      if (linkedStatus?.linked === true) {
        pushLog('INFO', 'Signal already linked, startup check passed');
        prefetchChatsInBackground().catch(() => {});
        return;
      }
    } catch {
      // ignore — worker will retry
    }
    if (i === 0) await sleep(3000);
  }
  pushLog(
    'INFO',
    'Signal linked state not confirmed at startup; worker will keep polling'
  );
  if (!AUTO_SIGNAL_RELINK_ON_SERVICE_START) {
    prefetchChatsInBackground().catch(() => {});
    return;
  }
  try {
    if (signalLinkInProgress) return;
    signalLinkInProgress = true;
    const out = await requestSignalLinkQr('wa-bridge', { auto: true });
    pushLog('INFO', 'Signal relink QR generated automatically', {
      hasQrDataUrl: Boolean(out?.qrDataUrl)
    });
  } catch (error) {
    pushLog('ERROR', 'Signal auto-relink failed', { message: error.message || String(error) });
  } finally {
    signalLinkInProgress = false;
    prefetchChatsInBackground().catch(() => {});
  }
}

// Keep runtime logs scoped to current service session.
clearLogsOnStartup();

app.listen(PORT, () => {
  startHeartbeat();
  startActivitySummaryLogs();
  startAddonCheckers();
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
  pushLog('INFO', 'Signal raw capture mode', {
    enabled: SIGNAL_RAW_CAPTURE,
    file: SIGNAL_RAW_LOG_FILE
  });
  setTimeout(() => {
    startupAutoInit().catch((e) => {
      pushLog('ERROR', 'Startup auto-init failed', { message: e.message || String(e) });
    });
  }, 1200);
});