const signalAliases = require('../config/signalAliases');

/**
 * Нормалізує chatId до стабільного формату
 * - trim
 * - lowerCase
 * - прибирає зайві префікси
 */
function normalizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null;

  let id = chatId.trim().toLowerCase();

  // Signal іноді дає group.v2..., group....
  id = id.replace(/^group\./, 'group:');

  // прибираємо дублікати форматів
  id = id.replace(/^group:group:/, 'group:');

  return id;
}

function withPrefix(id) {
  if (!id || typeof id !== 'string') return null;
  const normalized = normalizeChatId(id);
  if (!normalized) return null;

  if (normalized.startsWith('+')) return `phone:${normalized}`;
  if (/^[0-9a-f-]{36}$/i.test(normalized)) return `signal-group:${normalized}`;

  return normalized;
}

/**
 * Формує набір можливих chatId для matching
 */
function buildChatCandidates(message) {
  const candidates = new Set();
  const addCandidatePair = (value) => {
    const norm = normalizeChatId(value);
    if (norm) candidates.add(norm);
    const pref = withPrefix(value);
    if (pref) candidates.add(pref);
  };
  const addAliasesFor = (value) => {
    const norm = normalizeChatId(value);
    if (!norm) return;
    const aliases = Array.isArray(signalAliases?.[norm]) ? signalAliases[norm] : [];
    for (const a of aliases) {
      const aliasNorm = normalizeChatId(a);
      if (aliasNorm) candidates.add(aliasNorm);
      const aliasPref = withPrefix(a);
      if (aliasPref) candidates.add(aliasPref);
    }
  };

  if (!message) return [];

  if (message.chatId) {
    addCandidatePair(message.chatId);
  }

  if (Array.isArray(message.chatCandidates)) {
    for (const c of message.chatCandidates) {
      addCandidatePair(c);
    }
  }

  // Signal-specific: sender іноді є chatId
  if (message.senderId) {
    addCandidatePair(message.senderId);
  }
  addAliasesFor(message.chatId);
  addAliasesFor(message.senderId);

  return Array.from(candidates).filter(Boolean);
}

/**
 * Нормалізує aliases з flows.json
 */
function buildFlowAliases(flow) {
  if (!flow) return [];

  if (Array.isArray(flow.aliases)) {
    return flow.aliases
      .map(normalizeChatId)
      .filter(Boolean);
  }

  if (flow.sourceChatId) {
    return [
      normalizeChatId(flow.sourceChatId),
      withPrefix(flow.sourceChatId)
    ].filter(Boolean);
  }

  return [];
}

module.exports = {
  normalizeChatId,
  withPrefix,
  buildChatCandidates,
  buildFlowAliases
};
