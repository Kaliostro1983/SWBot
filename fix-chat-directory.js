/**
 * One-time fix: move the correct single-encoded Signal group ID aliases
 * from the merged "junk" entry (signal:chat:001) into the real "Галявина"
 * entry (signal:chat:011), then restart the bot.
 *
 * Usage:  node fix-chat-directory.js [path-to-chat-directory.json]
 * Default path: data/chat-directory.json (relative to this script's location)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'data', 'chat-directory.json');

if (!fs.existsSync(FILE)) {
  console.error('File not found:', FILE);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const entries = Array.isArray(data.entries) ? data.entries : [];

// ── Find the two entries ──────────────────────────────────────────────────────
// "source" = the merged junk entry that accidentally got the real Галявина ID
// "target" = the entry the flow was created from (has the double-encoded alias)
const source = entries.find(
  (e) => e.chatKey === 'signal:chat:001' &&
         (e.aliases || []).includes('group.q62jykxv2cyvcjj/u3ehqbm7niwiydniweasxocq0eq=')
);
const target = entries.find(
  (e) => e.chatKey === 'signal:chat:011' &&
         (e.aliases || []).some((a) => a.includes('ctyysllrwfyyq1l2q0pkl3uzrwhxym03tml3axlkbkl3z'))
);

if (!source) {
  console.error('❌  signal:chat:001 з group.q62j... не знайдено (можливо, вже виправлено або chatKey інший).');
  console.log('Поточні chatKey у файлі:', entries.map((e) => e.chatKey).join(', '));
  process.exit(1);
}
if (!target) {
  console.error('❌  signal:chat:011 з ctyy... не знайдено.');
  console.log('Поточні chatKey у файлі:', entries.map((e) => e.chatKey).join(', '));
  process.exit(1);
}

// ── Aliases to move ───────────────────────────────────────────────────────────
const toMove = [
  'group.q62jykxv2cyvcjj/u3ehqbm7niwiydniweasxocq0eq=',
  'q62jykxv2cyvcjj/u3ehqbm7niwiydniweasxocq0eq=',
  'signal-group:q62jykxv2cyvcjj/u3ehqbm7niwiydniweasxocq0eq=',
];

// Remove from source
const before001 = source.aliases.length;
source.aliases = source.aliases.filter((a) => !toMove.includes(a));
console.log(`signal:chat:001 aliases: ${before001} → ${source.aliases.length} (removed ${before001 - source.aliases.length})`);

// Add to target (prepend so they're tried first)
const before011 = target.aliases.length;
for (const a of [...toMove].reverse()) {
  if (!target.aliases.includes(a)) target.aliases.unshift(a);
}
console.log(`signal:chat:011 aliases: ${before011} → ${target.aliases.length} (added ${target.aliases.length - before011})`);

// ── Save ──────────────────────────────────────────────────────────────────────
const backup = FILE + '.bak';
fs.copyFileSync(FILE, backup);
console.log('Backup saved to', backup);

fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
console.log('✅  chat-directory.json оновлено. Перезапусти бот.');
