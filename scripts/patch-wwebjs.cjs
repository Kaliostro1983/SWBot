#!/usr/bin/env node
/**
 * Re-applies the __x_id media-send fix to the whatsapp-web.js fork after every
 * `npm install` (git-fork dependency, so patch-package is unusable — it diffs
 * against the official npm build, not the Eonus21 fork).
 *
 * Bug: processMediaData() returns a MediaData model whose enumerable private
 * `__x_id` gets spread into the outgoing Msg and overwrites its real MsgKey,
 * breaking getValidatedSender() → "Data passed to getter must include an id
 * property ... but got undefined" on WA Web 2.3000.x (wwebjs #201921).
 * Fix: `delete message.__x_id;` right after the `...extraOptions` spread in
 * src/util/Injected/Utils.js. Idempotent + non-fatal (never fails install).
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(
  __dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js'
);

const MARKER = 'delete message.__x_id;';
const ANCHOR =
  '            ...extraOptions,\n' +
  '        };\n\n' +
  '        // Bot\'s won\'t reply if canonicalUrl is set (linking)';
const REPLACEMENT =
  '            ...extraOptions,\n' +
  '        };\n\n' +
  '        // MediaData\'s private __x_id collides with Msg\'s internal id when\n' +
  '        // spread above, breaking getValidatedSender() on media send\n' +
  '        // (WA Web 2.3000.x, wwebjs #201921). Drop it. -- SWBot patch\n' +
  '        delete message.__x_id;\n\n' +
  '        // Bot\'s won\'t reply if canonicalUrl is set (linking)';

try {
  if (!fs.existsSync(FILE)) {
    console.warn('[patch-wwebjs] Utils.js not found, skipping:', FILE);
    process.exit(0);
  }
  const src = fs.readFileSync(FILE, 'utf8');
  if (src.includes(MARKER)) {
    console.log('[patch-wwebjs] __x_id fix already present — ok');
    process.exit(0);
  }
  if (!src.includes(ANCHOR)) {
    console.warn('[patch-wwebjs] anchor not found — fork structure changed? MANUAL CHECK NEEDED');
    process.exit(0);
  }
  fs.writeFileSync(FILE, src.replace(ANCHOR, REPLACEMENT), 'utf8');
  console.log('[patch-wwebjs] applied __x_id media-send fix');
} catch (e) {
  console.warn('[patch-wwebjs] non-fatal error:', e.message);
}
process.exit(0);
